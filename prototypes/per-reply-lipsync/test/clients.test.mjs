import assert from "node:assert/strict";
import test from "node:test";

import { createDidClient } from "../src/did-client.mjs";
import { createOrcaRouterTtsClient } from "../src/orcarouter-tts-client.mjs";

const pendingTests = [];
const trackedTest = (name, implementation) => {
  const pending = test(name, implementation);
  pendingTests.push(pending);
  return pending;
};

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

trackedTest("OrcaRouter TTS posts OpenAI-compatible /v1/audio/speech JSON and returns bytes", async () => {
  let captured;
  const client = createOrcaRouterTtsClient({
    apiKey: "test-orca-key",
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return new Response(Uint8Array.from([1, 2, 3, 4]), {
        status: 200,
        headers: { "content-type": "audio/mpeg", "content-length": "4" },
      });
    },
  });

  const result = await client.synthesize({
    input: "おかえり。ゆっくりでいいよ。",
    voice: "alloy",
    responseFormat: "mp3",
    speed: 0.95,
  });

  assert.equal(captured.url, "https://api.orcarouter.ai/v1/audio/speech");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers.authorization, "Bearer test-orca-key");
  assert.deepEqual(JSON.parse(captured.init.body), {
    model: "openai/gpt-4o-mini-tts",
    input: "おかえり。ゆっくりでいいよ。",
    voice: "alloy",
    response_format: "mp3",
    speed: 0.95,
  });
  assert.deepEqual([...result.bytes], [1, 2, 3, 4]);
  assert.equal(result.contentType, "audio/mpeg");
});

trackedTest("D-ID client uploads audio, uses AudioScript, polls ready, and deletes audio plus talk", async () => {
  const calls = [];
  const statuses = [
    { id: "talk_1", status: "started" },
    { id: "talk_1", status: "done", result_url: "https://cdn.example/reply.mp4" },
  ];
  let clock = 0;
  const client = createDidClient({
    apiKey: "user:secret",
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    pollIntervalMs: 10,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const path = new URL(url).pathname;
      if (path === "/audios" && init.method === "POST") {
        assert.ok(init.body instanceof FormData);
        const audio = init.body.get("audio");
        assert.equal(audio.name, "reply.mp3");
        assert.equal(audio.type, "audio/mpeg");
        assert.equal(audio.size, 4);
        return jsonResponse({
          id: "audio_1",
          url: "https://d-id.example/audio_1.wav",
        }, 201);
      }
      if (path === "/talks" && init.method === "POST") {
        return jsonResponse({ id: "talk_1", status: "created" }, 201);
      }
      if (path === "/talks/talk_1" && init.method === "GET") {
        return jsonResponse(statuses.shift());
      }
      if (path === "/audios/audio_1" && init.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      if (path === "/talks/talk_1" && init.method === "DELETE") {
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected mock call: ${init.method} ${path}`);
    },
  });

  const uploaded = await client.uploadAudio({
    bytes: Uint8Array.from([1, 2, 3, 4]),
    contentType: "audio/mpeg",
    filename: "reply.mp3",
  });
  const talk = await client.createTalk({
    sourceImageUrl: "https://profiles.example/guardian.jpg",
    audioUrl: uploaded.audioUrl,
  });
  const ready = await client.pollTalk(talk.talkId, { timeoutMs: 100, intervalMs: 10 });
  await client.deleteAudio(uploaded.id);
  await client.deleteTalk(talk.talkId);

  const talkCall = calls.find(({ url, init }) => new URL(url).pathname === "/talks" && init.method === "POST");
  assert.deepEqual(JSON.parse(talkCall.init.body), {
    source_url: "https://profiles.example/guardian.jpg",
    script: {
      type: "audio",
      audio_url: "https://d-id.example/audio_1.wav",
    },
  });
  assert.equal(ready.status, "ready");
  assert.equal(ready.videoUrl, "https://cdn.example/reply.mp4");
  assert.deepEqual(
    calls.filter(({ init }) => init.method === "DELETE").map(({ url }) => new URL(url).pathname),
    ["/audios/audio_1", "/talks/talk_1"],
  );
  assert.equal(
    calls[0].init.headers.authorization,
    `Basic ${Buffer.from("user:secret").toString("base64")}`,
  );
});

trackedTest("D-ID poll normalizes provider failure", async () => {
  const client = createDidClient({
    apiKey: "test-key",
    fetchImpl: async () => jsonResponse({ id: "talk_failed", status: "error" }),
  });
  await assert.rejects(
    client.pollTalk("talk_failed", { timeoutMs: 100, intervalMs: 0 }),
    (error) => error.code === "DID_TALK_FAILED",
  );
});

trackedTest("clients reject insecure base URLs before any fetch", () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; };
  assert.throws(
    () => createOrcaRouterTtsClient({ apiKey: "x", baseUrl: "http://example.test/v1", fetchImpl }),
    (error) => error.code === "ORCAROUTER_INSECURE_BASE_URL",
  );
  assert.throws(
    () => createDidClient({ apiKey: "x", baseUrl: "http://example.test", fetchImpl }),
    (error) => error.code === "DID_INSECURE_BASE_URL",
  );
  assert.equal(calls, 0);
});

export const completion = Promise.all(pendingTests);
export const testCount = pendingTests.length;
