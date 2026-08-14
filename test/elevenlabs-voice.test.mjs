import assert from "node:assert/strict";
import { test } from "node:test";
import { createElevenLabsVoiceService } from "../lib/providers/elevenlabs-voice.mjs";

const configured = {
  ELEVENLABS_API_KEY: "test-key",
  ELEVENLABS_VOICE_ID: "voice123456",
  ELEVENLABS_TTS_MODEL: "eleven_flash_v2_5",
};

test("ElevenLabs voice requires both server-side credentials", () => {
  assert.equal(createElevenLabsVoiceService({ env: {} }).available, false);
  assert.equal(createElevenLabsVoiceService({ env: { ELEVENLABS_API_KEY: "x" } }).available, true);
});

test("ElevenLabs creates a clone only with explicit external-processing consent", async () => {
  let calls = 0;
  const service = createElevenLabsVoiceService({
    env: { ELEVENLABS_API_KEY: "test-key" },
    fetchImpl: async (url, request) => {
      calls += 1;
      assert.match(url, /\/voices\/add$/);
      assert.equal(request.headers["xi-api-key"], "test-key");
      return Response.json({ voice_id: "newVoice123" });
    },
  });
  const sample = { bytes: Buffer.from("voice"), mimeType: "audio/webm", name: "Guardian" };
  assert.equal(await service.createClone(sample), null);
  assert.equal(calls, 0);
  assert.deepEqual(await service.createClone({ ...sample, externalProcessingApproved: true }), {
    voiceId: "newVoice123",
    provider: "elevenlabs",
  });
  assert.equal(calls, 1);
});

test("ElevenLabs never runs for unsafe or invalid-consent requests", async () => {
  let calls = 0;
  const service = createElevenLabsVoiceService({
    env: configured,
    fetchImpl: async () => { calls += 1; throw new Error("must not run"); },
  });
  assert.equal(await service.synthesize({ text: "助けて", safetyLevel: "urgent", consentValid: true }), null);
  assert.equal(await service.synthesize({ text: "こんにちは", safetyLevel: "normal", consentValid: false }), null);
  assert.equal(calls, 0);
});

test("ElevenLabs Flash generates private audio and deduplicates identical replies", async () => {
  let calls = 0;
  let requestedUrl;
  let requestedHeaders;
  let requestedBody;
  const audio = Buffer.from("eleven-audio");
  const service = createElevenLabsVoiceService({
    env: configured,
    fetchImpl: async (url, request) => {
      calls += 1;
      requestedUrl = url;
      requestedHeaders = request.headers;
      requestedBody = JSON.parse(request.body);
      return new Response(audio, { status: 200, headers: { "content-type": "audio/mpeg" } });
    },
  });
  const input = { text: "よくできたね", safetyLevel: "normal", consentValid: true };
  const first = await service.synthesize(input);
  const second = await service.synthesize(input);
  assert.equal(calls, 1);
  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, true);
  assert.equal(first.audioUrl, second.audioUrl);
  assert.match(requestedUrl, /\/text-to-speech\/voice123456\?output_format=mp3_44100_128$/);
  assert.equal(requestedHeaders["xi-api-key"], "test-key");
  assert.deepEqual(requestedBody, { text: "よくできたね", model_id: "eleven_flash_v2_5" });
  const token = decodeURIComponent(first.audioUrl.split("/").at(-1));
  assert.deepEqual(service.read(token), { bytes: audio, mimeType: "audio/mpeg" });
});

test("ElevenLabs rejects failed, oversized, and non-audio responses", async () => {
  const failed = createElevenLabsVoiceService({
    env: configured,
    fetchImpl: async () => new Response("quota", { status: 429 }),
  });
  assert.equal(await failed.synthesize({ text: "x", safetyLevel: "normal", consentValid: true }), null);
  const invalid = createElevenLabsVoiceService({
    env: configured,
    maximumBytes: 2,
    fetchImpl: async () => new Response("html", { status: 200, headers: { "content-type": "text/html" } }),
  });
  assert.equal(await invalid.synthesize({ text: "x", safetyLevel: "normal", consentValid: true }), null);
});
