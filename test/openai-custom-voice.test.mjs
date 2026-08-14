import assert from "node:assert/strict";
import { test } from "node:test";
import { createOpenAICustomVoiceService } from "../lib/providers/openai-custom-voice.mjs";

const configured = {
  OPENAI_API_KEY: "test-key",
  OPENAI_CUSTOM_VOICE_ID: "voice_guardian123",
  OPENAI_TTS_MODEL: "gpt-4o-mini-tts-2025-12-15",
};

test("custom voice is unavailable without both server-side credentials", () => {
  assert.equal(createOpenAICustomVoiceService({ env: {} }).available, false);
  assert.equal(createOpenAICustomVoiceService({ env: { OPENAI_API_KEY: "x" } }).available, false);
});

test("custom voice skips unsafe and invalid-consent requests without calling OpenAI", async () => {
  let calls = 0;
  const service = createOpenAICustomVoiceService({
    env: configured,
    fetchImpl: async () => { calls += 1; throw new Error("must not be called"); },
  });
  assert.equal(await service.synthesize({ text: "help", safetyLevel: "urgent", consentValid: true }), null);
  assert.equal(await service.synthesize({ text: "hello", safetyLevel: "normal", consentValid: false }), null);
  assert.equal(calls, 0);
});

test("custom voice uses a short-lived private URL and deduplicates identical speech", async () => {
  let calls = 0;
  let requestBody;
  const audio = Buffer.from("synthetic-audio");
  const service = createOpenAICustomVoiceService({
    env: configured,
    fetchImpl: async (_url, request) => {
      calls += 1;
      requestBody = JSON.parse(request.body);
      return new Response(audio, { status: 200, headers: { "content-type": "audio/mpeg" } });
    },
  });
  const first = await service.synthesize({ text: "よくできたね", safetyLevel: "normal", consentValid: true });
  const second = await service.synthesize({ text: "よくできたね", safetyLevel: "normal", consentValid: true });
  assert.equal(calls, 1);
  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, true);
  assert.equal(first.audioUrl, second.audioUrl);
  assert.deepEqual(requestBody.voice, { id: "voice_guardian123" });
  const token = decodeURIComponent(first.audioUrl.split("/").at(-1));
  assert.deepEqual(service.read(token), { bytes: audio, mimeType: "audio/mpeg" });
  assert.equal(service.read("not-a-token"), null);
});

test("custom voice rejects oversized or unexpected provider responses", async () => {
  const service = createOpenAICustomVoiceService({
    env: configured,
    maximumBytes: 4,
    fetchImpl: async () => new Response(Buffer.from("12345"), {
      status: 200,
      headers: { "content-type": "text/html" },
    }),
  });
  assert.equal(await service.synthesize({ text: "hello", safetyLevel: "normal", consentValid: true }), null);
});
