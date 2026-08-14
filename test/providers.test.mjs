import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ORCAROUTER_SYSTEM_PROMPT,
  createOrcaRouterProvider,
} from "../lib/providers/orcarouter.mjs";
import {
  DidVideoProviderError,
  createDidVideoProvider,
} from "../lib/providers/did-video.mjs";
import {
  KlingVideoProviderError,
  createKlingVideoProvider,
} from "../lib/providers/kling-video.mjs";
import { SttProviderError, createSttProvider } from "../lib/providers/stt.mjs";
import { ElevenLabsError, createElevenLabsProvider } from "../lib/providers/elevenlabs.mjs";
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

const rawPngBase64 = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
]).toString("base64");

test("ElevenLabs clones a sample and synthesizes Japanese reply audio", async () => {
  const requests = [];
  const provider = createElevenLabsProvider({
    env: {
      VOICE_CLONING_PROVIDER: "elevenlabs",
      ELEVENLABS_API_KEY: "test-key",
      ELEVENLABS_BASE_URL: "https://api.elevenlabs.test/v1",
      ELEVENLABS_MODEL: "eleven_multilingual_v2",
    },
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith("/voices/add")) {
        return new Response(JSON.stringify({ voice_id: "voice-test-123" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(Buffer.from("ID3-elevenlabs-audio"), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      });
    },
  });

  const cloned = await provider.cloneVoice({
    bytes: Buffer.from("RIFF....WAVE sample"),
    mimeType: "audio/wav",
    name: "Mama Message test",
  });
  const audio = await provider.synthesize({
    voiceId: cloned.voiceId,
    text: "おはなししてくれてありがとう。",
    speed: 0.7,
  });

  assert.equal(provider.available, true);
  assert.equal(cloned.voiceId, "voice-test-123");
  assert.equal(requests[0].init.headers["xi-api-key"], "test-key");
  assert.ok(requests[0].init.body instanceof FormData);
  assert.ok(requests[0].init.body.get("files") instanceof Blob);
  assert.match(requests[1].url, /text-to-speech\/voice-test-123/);
  const speechBody = JSON.parse(requests[1].init.body);
  assert.equal(speechBody.language_code, "ja");
  assert.equal(speechBody.voice_settings.stability, 0.45);
  assert.equal(speechBody.voice_settings.similarity_boost, 0.85);
  assert.equal(speechBody.voice_settings.style, 0.2);
  assert.equal(speechBody.voice_settings.use_speaker_boost, true);
  assert.equal(speechBody.voice_settings.speed, 0.7);
  assert.equal(audio.mimeType, "audio/mpeg");
  assert.match(audio.bytes.toString(), /^ID3/);
});

test("ElevenLabs failures are typed and do not expose configuration", async () => {
  const provider = createElevenLabsProvider({
    env: { VOICE_CLONING_PROVIDER: "elevenlabs", ELEVENLABS_API_KEY: "test-key" },
    fetchImpl: async () => new Response(JSON.stringify({ detail: { message: "quota exceeded" } }), {
      status: 429,
      headers: { "content-type": "application/json" },
    }),
  });
  await assert.rejects(
    provider.synthesize({ voiceId: "voice-id", text: "こんにちは" }),
    (error) => error instanceof ElevenLabsError
      && error.code === "ELEVENLABS_TTS_FAILED"
      && error.status === 429,
  );
});

test("D-ID uploads a raw image then creates a silent idle talk", async () => {
  const requests = [];
  const provider = createDidVideoProvider({
    env: {
      VIDEO_GENERATION_PROVIDER: "did",
      DID_API_KEY: "dashboard-user:dashboard-password",
      DID_BASE_URL: "https://api.d-id.test",
    },
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith("/images")) {
        return new Response(JSON.stringify({ url: "https://uploads.d-id.test/guardian.png" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ id: "talk-1", status: "created" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const task = await provider.createTask({ imageBase64: rawPngBase64 });
  assert.deepEqual(task, { taskId: "talk-1", status: "queued", videoUrl: null });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "https://api.d-id.test/images");
  assert.equal(
    requests[0].init.headers.authorization,
    `Basic ${Buffer.from("dashboard-user:dashboard-password").toString("base64")}`,
  );
  assert.equal(requests[0].init.headers["content-type"], undefined);
  assert.ok(requests[0].init.body instanceof FormData);
  const image = requests[0].init.body.get("image");
  assert.ok(image instanceof Blob);
  assert.equal(image.type, "image/png");
  assert.equal(image.size, 9);

  assert.equal(requests[1].url, "https://api.d-id.test/talks");
  const talk = JSON.parse(requests[1].init.body);
  assert.deepEqual(talk, {
    source_url: "https://uploads.d-id.test/guardian.png",
    driver_url: "bank://lively/driver-06",
    script: {
      type: "text",
      ssml: true,
      input: '<break time="5000ms"/>',
      provider: { type: "microsoft", voice_id: "ja-JP-NanamiNeural" },
    },
    config: { fluent: true },
  });
});

test("D-ID preserves an already-prefixed Basic authorization value", async () => {
  let authorization;
  const provider = createDidVideoProvider({
    env: { VIDEO_GENERATION_PROVIDER: "did", DID_API_KEY: "Basic already-encoded" },
    fetchImpl: async (_url, init) => {
      authorization = init.headers.authorization;
      return new Response(JSON.stringify({ id: "talk-1", status: "started" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  await provider.getTask("talk-1");
  assert.equal(authorization, "Basic already-encoded");
});

test("D-ID accepts an S3 image URL returned by its upload API", async () => {
  const requests = [];
  const provider = createDidVideoProvider({
    env: {
      VIDEO_GENERATION_PROVIDER: "did",
      DID_API_KEY: "user:password",
    },
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith("/images")) {
        return new Response(JSON.stringify({ url: "s3://d-id-private/guardian.png" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ id: "talk-s3", status: "created" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal((await provider.createTask({ imageBase64: rawPngBase64 })).taskId, "talk-s3");
  assert.equal(JSON.parse(requests[1].init.body).source_url, "s3://d-id-private/guardian.png");
});

test("D-ID reports an ID-only upload response without attempting a talk", async () => {
  let requestCount = 0;
  const provider = createDidVideoProvider({
    env: {
      VIDEO_GENERATION_PROVIDER: "did",
      DID_API_KEY: "user:password",
    },
    fetchImpl: async () => {
      requestCount += 1;
      return new Response(JSON.stringify({ id: "uploaded-image-id" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    },
  });

  await assert.rejects(
    provider.createTask({ imageBase64: rawPngBase64 }),
    (error) => error instanceof DidVideoProviderError
      && error.code === "DID_VIDEO_IMAGE_URL_MISSING"
      && !error.message.includes("uploaded-image-id"),
  );
  assert.equal(requestCount, 1);
});

test("D-ID polls and normalizes talk statuses and result URLs", async () => {
  const cases = [
    ["created", "queued", null],
    ["started", "processing", null],
    ["done", "ready", "https://results.d-id.test/talk.mp4"],
    ["error", "failed", null],
  ];
  for (const [providerStatus, expectedStatus, resultUrl] of cases) {
    let requestedUrl;
    const provider = createDidVideoProvider({
      env: { VIDEO_GENERATION_PROVIDER: "did", DID_API_KEY: "user:password" },
      fetchImpl: async (url) => {
        requestedUrl = url;
        return new Response(JSON.stringify({ id: "talk/with spaces", status: providerStatus, result_url: resultUrl }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    assert.deepEqual(await provider.getTask("talk/with spaces"), {
      taskId: "talk/with spaces",
      status: expectedStatus,
      videoUrl: resultUrl,
    });
    assert.equal(requestedUrl, "https://api.d-id.com/talks/talk%2Fwith%20spaces");
  }
});

test("D-ID exposes sanitized typed failures without credentials or response bodies", async () => {
  const provider = createDidVideoProvider({
    env: { VIDEO_GENERATION_PROVIDER: "did", DID_API_KEY: "sensitive-user:sensitive-password" },
    fetchImpl: async () => new Response(JSON.stringify({
      error: { kind: "InsufficientCreditsError", description: "sensitive upstream body" },
    }), { status: 402, headers: { "content-type": "application/json" } }),
  });
  await assert.rejects(
    provider.getTask("talk-1"),
    (error) => error instanceof DidVideoProviderError
      && error.code === "DID_VIDEO_HTTP_ERROR"
      && error.status === 402
      && error.providerCode === "InsufficientCreditsError"
      && !error.message.includes("sensitive upstream body")
      && !error.message.includes("sensitive-password"),
  );
});

test("D-ID is available only when selected with an HTTPS endpoint and key", async () => {
  assert.equal(createDidVideoProvider({ env: {} }).available, false);
  assert.equal(createDidVideoProvider({
    env: { VIDEO_GENERATION_PROVIDER: "kling", DID_API_KEY: "user:password" },
  }).available, false);
  assert.equal(createDidVideoProvider({
    env: { VIDEO_GENERATION_PROVIDER: "did", DID_API_KEY: "user:password" },
  }).available, true);
  const disabled = createDidVideoProvider({
    env: { VIDEO_GENERATION_PROVIDER: "disabled", DID_API_KEY: "user:password" },
  });
  await assert.rejects(
    disabled.getTask("talk-1"),
    (error) => error instanceof DidVideoProviderError && error.code === "DID_VIDEO_NOT_CONFIGURED",
  );
});

test("Kling submits raw-base64 image-to-video defaults without a paid call", async () => {
  const requests = [];
  const provider = createKlingVideoProvider({
    env: {
      VIDEO_GENERATION_PROVIDER: "kling",
      ORCAROUTER_API_KEY: "test-secret",
      ORCAROUTER_BASE_URL: "https://api.orcarouter.test/v1",
    },
    fetchImpl: async (url, init) => {
      requests.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
      return new Response(JSON.stringify({ task_id: "task-1", status: "queued" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const imageBase64 = Buffer.from("guardian-photo").toString("base64");
  const task = await provider.createTask({ imageBase64 });
  assert.equal(task.taskId, "task-1");
  assert.equal(task.status, "queued");
  assert.equal(requests[0].url, "https://api.orcarouter.test/v1/video/generations");
  assert.equal(requests[0].init.headers.authorization, "Bearer test-secret");
  assert.equal(requests[0].body.model, "kling/kling-v3");
  assert.equal(requests[0].body.image, imageBase64);
  assert.deepEqual(requests[0].body.metadata, {
    mode: "std",
    duration: "5",
    sound: "off",
  });
  assert.equal(requests[0].body.image.startsWith("data:"), false);
  assert.doesNotMatch(requests[0].body.prompt, /<<<image_1>>>/);
  assert.doesNotMatch(requests[0].body.prompt, /child/i);
  assert.match(requests[0].body.prompt, /stationary/i);
  assert.match(requests[0].body.prompt, /exactly one person/i);
});

test("Kling polls task state and extracts the signed result URL", async () => {
  let requestedUrl;
  const provider = createKlingVideoProvider({
    env: { VIDEO_GENERATION_PROVIDER: "kling", ORCAROUTER_API_KEY: "test-secret" },
    fetchImpl: async (url) => {
      requestedUrl = url;
      return new Response(JSON.stringify({
        data: {
          task_id: "task/with spaces",
          status: "SUCCESS",
          result_url: "https://signed.example.test/result.mp4",
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const task = await provider.getTask("task/with spaces");
  assert.equal(requestedUrl, "https://api.orcarouter.ai/v1/video/generations/task%2Fwith%20spaces");
  assert.deepEqual(task, {
    taskId: "task/with spaces",
    status: "ready",
    videoUrl: "https://signed.example.test/result.mp4",
  });
});

test("Kling exposes typed provider failures without response bodies", async () => {
  const provider = createKlingVideoProvider({
    env: { VIDEO_GENERATION_PROVIDER: "kling", ORCAROUTER_API_KEY: "test-secret" },
    fetchImpl: async () => new Response(JSON.stringify({
      error: { code: "access_denied", message: "sensitive upstream details" },
    }), { status: 503, headers: { "content-type": "application/json" } }),
  });
  await assert.rejects(
    provider.getTask("task-1"),
    (error) => error instanceof KlingVideoProviderError
      && error.code === "KLING_VIDEO_HTTP_ERROR"
      && error.status === 503
      && error.providerCode === "access_denied"
      && !error.message.includes("sensitive upstream details"),
  );
});

test("Kling captures OrcaRouter top-level quota error codes", async () => {
  const provider = createKlingVideoProvider({
    env: { VIDEO_GENERATION_PROVIDER: "kling", ORCAROUTER_API_KEY: "test-secret" },
    fetchImpl: async () => new Response(JSON.stringify({
      code: "insufficient_user_quota",
      message: "sensitive billing details",
      data: null,
    }), { status: 403, headers: { "content-type": "application/json" } }),
  });
  await assert.rejects(
    provider.getTask("task-1"),
    (error) => error instanceof KlingVideoProviderError
      && error.status === 403
      && error.providerCode === "insufficient_user_quota"
      && !error.message.includes("sensitive billing details"),
  );
});

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
    favoriteTopics: ["恐竜", "電車"],
    childName: "ひなたちゃん",
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
  assert.equal(request.body.messages[0].content, ORCAROUTER_SYSTEM_PROMPT);
  assert.match(request.body.messages[0].content, /「今日暇？」→ normal/);
  assert.match(request.body.messages[0].content, /短い、くだけている、意図が少し曖昧という理由だけで/);
  assert.match(request.body.messages[0].content, /質問は多くても1つ/);
  assert.match(request.body.messages[0].content, /分離不安だけを理由に adult_handoff にしない/);
  assert.match(request.body.messages[0].content, /「すぐ迎えに行く」「もうすぐ着く」/);
  assert.match(request.body.messages[0].content, /ひらがなと句読点だけ/);
  assert.deepEqual(request.body.messages.slice(1), [
    { role: "system", content: "登録された好きなもの: 恐竜、電車。必要なときだけ、この中から一つを自然な安心材料や遊びの話題として使ってください。" },
    { role: "system", content: "こどものよびかた: ひなたちゃん。必要なときだけ、この呼び方で自然に呼びかけてください。" },
    { role: "user", content: "きのうはタワーを作ったよ" },
    { role: "assistant", content: "高くできたんだね。" },
    { role: "user", content: "ブロックでおうちを作れたよ" },
  ]);
  assert.equal(result.replyText, validOrcaResponse.replyText);
  assert.equal(result.metadata.resolvedModel, "provider/header-model");
  assert.equal(result.metadata.usage.total_tokens, 50);
  assert.equal(result.metadata.favoriteTopicsCount, 2);
  assert.equal(result.metadata.childNameConfigured, true);
  assert.equal(result.metadata.headers["x-orca-request-id"], "orca-request-1");
});

test("OrcaRouter uses the Responses API for GPT-5.6 models", async () => {
  let request;
  const provider = createOrcaRouterProvider({
    env: {
      ROUTER_PROVIDER: "orcarouter",
      ORCAROUTER_API_KEY: "secret",
      ORCAROUTER_MODEL: "openai/gpt-5.6-luna",
    },
    fetchImpl: async (url, init) => {
      request = { url, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({
        id: "resp_luna_1",
        model: "openai/gpt-5.6-luna",
        output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(validOrcaResponse) }] }],
        usage: { input_tokens: 24, output_tokens: 32 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const result = await provider.classifyAndReply("ママに会いたい");
  assert.equal(request.url, "https://api.orcarouter.ai/v1/responses");
  assert.equal(request.body.model, "openai/gpt-5.6-luna");
  assert.equal(request.body.text.format.type, "json_schema");
  assert.equal(request.body.text.format.strict, true);
  assert.equal(request.body.reasoning.effort, "low");
  assert.equal(result.ok, true);
  assert.equal(result.metadata.resolvedModel, "openai/gpt-5.6-luna");
});

test("OrcaRouter falls back from unavailable Luna to GPT-5.6 Terra", async () => {
  const requestedModels = [];
  const provider = createOrcaRouterProvider({
    env: {
      ROUTER_PROVIDER: "orcarouter",
      ORCAROUTER_API_KEY: "secret",
      ORCAROUTER_MODEL: "openai/gpt-5.6-luna",
      ORCAROUTER_FALLBACK_MODEL: "openai/gpt-5.6-terra",
    },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      requestedModels.push(body.model);
      if (body.model.endsWith("luna")) {
        return new Response(JSON.stringify({ error: { message: "temporarily unavailable" } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        model: "openai/gpt-5.6-terra",
        output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(validOrcaResponse) }] }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const result = await provider.classifyAndReply("ママに会いたい");
  assert.deepEqual(requestedModels, ["openai/gpt-5.6-luna", "openai/gpt-5.6-terra"]);
  assert.equal(result.ok, true);
  assert.equal(result.metadata.fallback, true);
  assert.equal(result.metadata.primaryModel, "openai/gpt-5.6-luna");
  assert.equal(result.metadata.resolvedModel, "openai/gpt-5.6-terra");
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
