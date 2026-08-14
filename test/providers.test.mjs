import assert from "node:assert/strict";
import { test } from "node:test";

import { createOrcaRouterProvider } from "../lib/providers/orcarouter.mjs";
import { SttProviderError, createSttProvider } from "../lib/providers/stt.mjs";
import {
  DEMO_FAULT_MODES,
  MediaProviderError,
  createMediaProvider,
  isMediaBundleReady,
} from "../lib/providers/media.mjs";

const validOrcaResponse = {
  safetyLevel: "normal",
  supportMode: "celebrate",
  emotion: ["joy"],
  reasonCodes: ["POSITIVE_ACHIEVEMENT"],
  replyText: "できたね。いっしょに喜ぼう。",
  voiceTone: "bright",
  expression: "smiling",
};

test("OrcaRouter uses injected local functions without an API key", async () => {
  let fetchCalls = 0;
  const provider = createOrcaRouterProvider({
    env: {},
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("must not be called");
    },
    localClassifier: () => ({
      safetyLevel: "normal",
      supportMode: "celebrate",
      emotion: ["joy"],
      reasonCodes: ["LOCAL_CLASSIFIER"],
    }),
    localReplyBuilder: () => "できたね。うれしいね。",
  });
  const result = await provider.classifyAndReply("できたよ");
  assert.equal(fetchCalls, 0);
  assert.equal(result.safetyLevel, "normal");
  assert.equal(result.supportMode, "celebrate");
  assert.equal(result.metadata.provider, "local");
});

test("OrcaRouter demo mode never sends externally even when a key exists", async () => {
  let fetchCalls = 0;
  const provider = createOrcaRouterProvider({
    env: { ROUTER_PROVIDER: "demo", ORCAROUTER_API_KEY: "secret" },
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("must not be called");
    },
    localClassifier: () => ({
      safetyLevel: "normal",
      supportMode: "celebrate",
      emotion: ["joy"],
      reasonCodes: ["LOCAL_CLASSIFIER"],
    }),
    localReplyBuilder: () => "できたね。うれしいね。",
  });
  const result = await provider.classifyAndReply("できたよ");
  assert.equal(fetchCalls, 0);
  assert.equal(provider.available, false);
  assert.equal(result.error.code, "ORCAROUTER_DISABLED");
  assert.equal(result.metadata.provider, "local");
});

test("OrcaRouter demo mode passes bounded conversation history to the reply builder", async () => {
  let receivedHistory;
  const provider = createOrcaRouterProvider({
    env: { ROUTER_PROVIDER: "demo" },
    localClassifier: () => ({
      safetyLevel: "normal",
      supportMode: "celebrate",
      emotion: ["joy"],
      reasonCodes: ["LOCAL_CLASSIFIER"],
    }),
    localReplyBuilder: (_decision, transcript, history) => {
      receivedHistory = history;
      return `さっきのおうちの続きだね。${transcript}`;
    },
  });
  const history = [
    { role: "user", content: "ブロックでおうちを作ったよ" },
    { role: "assistant", content: "できたこと、ちゃんと伝わったよ。" },
  ];
  const result = await provider.classifyAndReply({ transcript: "こんどは庭も作ったよ", history });
  assert.deepEqual(receivedHistory, history);
  assert.match(result.replyText, /おうちの続き/);
  assert.equal(result.metadata.historyMessages, 2);
});

test("OrcaRouter sends strict structured output and captures metadata", async () => {
  let request;
  const provider = createOrcaRouterProvider({
    env: { ROUTER_PROVIDER: "orcarouter", ORCAROUTER_API_KEY: "secret" },
    fetchImpl: async (url, init) => {
      request = { url, init, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({
        model: "provider/resolved-model",
        choices: [{ message: { content: JSON.stringify(validOrcaResponse) } }],
        usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 },
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "X-Orca-Resolved-Model": "provider/header-model",
          "X-Orca-Request-Id": "orca-request-1",
        },
      });
    },
  });
  const result = await provider.classifyAndReply({
    transcript: "ブロックでおうちを作れたよ",
    history: [
      { role: "user", content: "きのうはタワーを作ったよ" },
      { role: "assistant", content: "高くできたんだね。" },
    ],
  });
  assert.equal(request.url, "https://api.orcarouter.ai/v1/chat/completions");
  assert.equal(request.init.headers.authorization, "Bearer secret");
  assert.equal(request.body.model, "orcarouter/auto");
  assert.equal(request.body.response_format.type, "json_schema");
  assert.equal(request.body.response_format.json_schema.strict, true);
  assert.equal(request.body.response_format.json_schema.schema.additionalProperties, false);
  assert.deepEqual(request.body.response_format.json_schema.schema.required, Object.keys(validOrcaResponse));
  assert.deepEqual(request.body.messages.slice(1), [
    { role: "user", content: "きのうはタワーを作ったよ" },
    { role: "assistant", content: "高くできたんだね。" },
    { role: "user", content: "ブロックでおうちを作れたよ" },
  ]);
  assert.equal(result.replyText, validOrcaResponse.replyText);
  assert.equal(result.metadata.resolvedModel, "provider/header-model");
  assert.equal(result.metadata.usage.total_tokens, 50);
  assert.equal(result.metadata.headers["x-orca-request-id"], "orca-request-1");
});

test("OrcaRouter fails closed on invalid JSON", async () => {
  const provider = createOrcaRouterProvider({
    env: { ROUTER_PROVIDER: "orcarouter", ORCAROUTER_API_KEY: "secret" },
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { content: "not-json" } }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  const result = await provider.classifyAndReply("よく分からない話");
  assert.equal(result.safetyLevel, "uncertain");
  assert.equal(result.supportMode, "adult_handoff");
  assert.deepEqual(result.reasonCodes, ["ORCAROUTER_INVALID_RESPONSE"]);
  assert.equal(result.metadata.fallback, true);
});

test("OrcaRouter timeout fails closed to adult handoff", async () => {
  const provider = createOrcaRouterProvider({
    env: { ROUTER_PROVIDER: "orcarouter", ORCAROUTER_API_KEY: "secret" },
    timeoutMs: 5,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }),
  });
  const result = await provider.classifyAndReply("待っている入力");
  assert.equal(result.safetyLevel, "uncertain");
  assert.equal(result.supportMode, "adult_handoff");
  assert.deepEqual(result.reasonCodes, ["ORCAROUTER_TIMEOUT"]);
});

test("STT demo transcript bypasses external sending", async () => {
  let fetchCalls = 0;
  const provider = createSttProvider({
    env: { STT_PROVIDER: "openai", STT_API_KEY: "secret" },
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("must not be called");
    },
    idFactory: () => "tr_demo",
  });
  const result = await provider.transcribe({
    demoTranscript: "きょう、できたよ",
    audioBase64: Buffer.from("private audio").toString("base64"),
  });
  assert.equal(fetchCalls, 0);
  assert.equal(result.transcript, "きょう、できたよ");
  assert.equal(result.provider, "demo-stt");
  assert.equal(result.rawAudioStored, false);
});

test("STT converts base64 audio to external multipart form data", async () => {
  let request;
  const provider = createSttProvider({
    env: {
      STT_PROVIDER: "openai",
      OPENAI_API_KEY: "openai-secret",
      STT_BASE_URL: "https://stt.example.test/transcriptions",
    },
    fetchImpl: async (url, init) => {
      request = { url, init };
      return new Response(JSON.stringify({ text: "こんにちは" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    idFactory: () => "tr_external",
  });
  const result = await provider.transcribe({
    audioBase64: Buffer.from([0, 1, 2, 3]).toString("base64"),
    mimeType: "audio/webm",
  });
  assert.equal(request.url, "https://stt.example.test/transcriptions");
  assert.equal(request.init.headers.authorization, "Bearer openai-secret");
  assert.equal(request.init.headers["content-type"], undefined);
  assert.ok(request.init.body instanceof FormData);
  assert.equal(request.init.body.get("model"), "gpt-4o-mini-transcribe");
  assert.equal(request.init.body.get("language"), "ja");
  const file = request.init.body.get("file");
  assert.ok(file instanceof Blob);
  assert.equal(file.type, "audio/webm");
  assert.equal(file.size, 4);
  assert.equal(result.transcript, "こんにちは");
  assert.equal(result.rawAudioStored, false);
});

test("STT external failure throws a typed error", async () => {
  const provider = createSttProvider({
    env: { STT_PROVIDER: "openai", STT_API_KEY: "secret" },
    fetchImpl: async () => new Response("unavailable", { status: 503 }),
  });
  await assert.rejects(
    provider.transcribe({ audioBase64: Buffer.from([1]).toString("base64") }),
    (error) => error instanceof SttProviderError
      && error.code === "STT_HTTP_ERROR"
      && error.status === 503,
  );
});

test("demo media degrades through all four ready levels", async () => {
  const cases = [
    [createMediaProvider({
      generatedVideoProvider: { name: "test-video", generate: async () => ({ videoUrl: "/generated.mp4", audioInVideo: true }) },
      preRecordedVideoUrl: "/prerecorded.mp4",
    }), DEMO_FAULT_MODES.NONE, 1],
    [createMediaProvider({
      generatedVideoProvider: { name: "test-video", generate: async () => ({ videoUrl: "/generated.mp4" }) },
      preRecordedVideoUrl: "/prerecorded.mp4",
    }), DEMO_FAULT_MODES.GENERATED_VIDEO_FAILURE, 2],
    [createMediaProvider({ env: { MEDIA_PROVIDER: "demo" } }), DEMO_FAULT_MODES.VIDEO_FAILURE, 3],
    [createMediaProvider({ env: { MEDIA_PROVIDER: "demo" } }), DEMO_FAULT_MODES.SPEECH_FAILURE, 4],
  ];
  for (const [provider, faultMode, fallbackLevel] of cases) {
    const bundle = await provider.generate({
      safetyLevel: "normal",
      consentValid: true,
      replyText: "だいじょうぶ。いっしょにやってみよう。",
      faultMode,
    });
    assert.equal(bundle.fallbackLevel, fallbackLevel);
    assert.equal(isMediaBundleReady(bundle), true);
  }
});

test("LEVEL 1 requires explicit embedded audio", async () => {
  const provider = createMediaProvider({
    generatedVideoProvider: async () => ({ videoUrl: "/silent-generated.mp4" }),
  });
  const bundle = await provider.generate({
    safetyLevel: "normal",
    consentValid: true,
    replyText: "字幕と音声をそろえるよ。",
  });
  assert.equal(bundle.fallbackLevel, 3);
  assert.equal(bundle.videoUrl, null);
});

test("generated media timeout falls through to LEVEL 3", async () => {
  const provider = createMediaProvider({
    generatedVideoProvider: () => new Promise(() => {}),
    timeoutMs: 5,
  });
  const bundle = await provider.generate({
    safetyLevel: "normal",
    consentValid: true,
    replyText: "待ちすぎずに返すよ。",
  });
  assert.equal(bundle.fallbackLevel, 3);
  assert.equal(bundle.ready, true);
});

test("LEVEL 3 can use a prepared audio file instead of browser speech", async () => {
  const provider = createMediaProvider({
    audioUrlForDecision: (decision) => `/audio/${decision.supportMode}.wav`,
  });
  const bundle = await provider.generate({
    decision: {
      safetyLevel: "normal",
      supportMode: "comfort",
      emotion: ["sadness"],
      reasonCodes: ["COMFORT_NEEDED"],
      replyText: "そばにいるよ。",
    },
    consentValid: true,
  });
  assert.equal(bundle.fallbackLevel, 3);
  assert.equal(bundle.audioUrl, "/audio/comfort.wav");
  assert.equal(bundle.speechSynthesis, false);
  assert.equal(isMediaBundleReady(bundle), true);
});

test("LEVEL 3 does not play a registered sample when its text differs from the reply", async () => {
  const provider = createMediaProvider({ env: { MEDIA_PROVIDER: "demo" } });
  const bundle = await provider.generate({
    safetyLevel: "normal",
    consentValid: true,
    replyText: "庭も作れたんだね。すてきだよ。",
    posterUrl: "/private/guardian.png",
    audioUrl: "/private/sampling.wav",
    recordedAudioText: "お話ししてくれてありがとう。いつも応援しているよ。",
    guardianSampling: {
      configured: true,
      photoUsed: true,
      voiceSampleRegistered: true,
    },
  });
  assert.equal(bundle.fallbackLevel, 3);
  assert.equal(bundle.posterUrl, "/private/guardian.png");
  assert.equal(bundle.audioUrl, null);
  assert.equal(bundle.speechSynthesis, true);
  assert.equal(bundle.guardianSampling.voiceSamplePurpose, "sampling-confirmation");
  assert.equal(bundle.guardianSampling.voiceSampleMatchesReply, false);
  assert.equal(bundle.guardianSampling.voiceUsed, false);
  assert.equal(bundle.guardianSampling.voiceCloningUsed, false);
  assert.equal(bundle.guardianSampling.voiceFallback, "dynamic-tts");
});

test("media is forbidden for non-normal safety or invalid consent", async () => {
  const provider = createMediaProvider({ env: { MEDIA_PROVIDER: "demo" } });
  await assert.rejects(
    provider.generate({ safetyLevel: "urgent", consentValid: true, replyText: "x" }),
    (error) => error instanceof MediaProviderError
      && error.code === "ADULT_HANDOFF_REQUIRED"
      && error.adultHandoff === true
      && error.responseBundle === null,
  );
  await assert.rejects(
    provider.generate({ safetyLevel: "normal", consentValid: false, replyText: "x" }),
    (error) => error instanceof MediaProviderError && error.code === "ADULT_HANDOFF_REQUIRED",
  );
});
