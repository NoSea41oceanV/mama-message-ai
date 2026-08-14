import assert from "node:assert/strict";
import { after, before, test } from "node:test";

process.env.ROUTER_PROVIDER = "demo";
process.env.ORCAROUTER_API_KEY = "";
process.env.STT_PROVIDER = "demo";
process.env.STT_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.MEDIA_PROVIDER = "demo";
process.env.VIDEO_GENERATION_PROVIDER = "disabled";
process.env.VOICE_CLONING_PROVIDER = "disabled";
process.env.ELEVENLABS_API_KEY = "";

const { buildReply, classifyTranscript, createAppServer, replyIsAllowed } = await import("../server.mjs");

let server;
let baseUrl;
const samplingProfileId = "11111111-1111-4111-8111-111111111111";
const samplingProfileHeaders = {
  "content-type": "application/json",
  "x-guardian-profile-id": samplingProfileId,
};

const samplingPhoto = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("server-test-photo"),
]);
const samplingVoice = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.alloc(4),
  Buffer.from("WAVEfmt "),
  Buffer.from("server-test-voice"),
]);

function samplingRegistration(overrides = {}) {
  return {
    subjectLabel: "テストのおうちの人",
    photoBase64: samplingPhoto.toString("base64"),
    photoType: "image/png",
    voiceBase64: samplingVoice.toString("base64"),
    voiceType: "audio/wav",
    voiceDurationSeconds: 8,
    faceApproved: true,
    voiceApproved: true,
    ...overrides,
  };
}

async function createAndWait(overrides = {}, guardianProfileId = null) {
  const input = {
    sessionId: `session-${crypto.randomUUID()}`,
    transcriptId: `tr-${crypto.randomUUID()}`,
    confirmedTranscript: "きょうブロックでおうちを作ったよ",
    consentId: "demo-consent-001",
    avatarAssetId: "guardian-demo-001",
    idempotencyKey: `test:${crypto.randomUUID()}`,
    ...overrides,
  };
  const create = await fetch(`${baseUrl}/api/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(guardianProfileId ? { "x-guardian-profile-id": guardianProfileId } : {}),
    },
    body: JSON.stringify(input),
  });
  const pending = await create.json();
  assert.equal(create.status, 202);
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const result = await (await fetch(`${baseUrl}/api/responses/${pending.requestId}`, {
      headers: guardianProfileId ? { "x-guardian-profile-id": guardianProfileId } : {},
    })).json();
    if (result.status !== "PENDING") return { input, pending, result };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("response did not complete");
}

before(async () => {
  server = createAppServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test("classifies a positive achievement", () => {
  const decision = classifyTranscript("ブロックでおうちを作れたよ");
  assert.equal(decision.safetyLevel, "normal");
  assert.equal(decision.supportMode, "celebrate");
  assert.match(buildReply(decision), /いっしょに喜ぼう/);
});

test("health endpoint exposes modes without secrets", async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  const health = await response.json();
  assert.equal(response.status, 200);
  assert.equal(health.status, "ok");
  assert.equal(typeof health.routerConfigured, "boolean");
  assert.equal(typeof health.sttConfigured, "boolean");
  assert.equal("apiKey" in health, false);
});

test("routes urgent language to an adult without avatar output", () => {
  const decision = classifyTranscript("息ができない、今すぐ助けて");
  assert.equal(decision.safetyLevel, "urgent");
  assert.equal(decision.supportMode, "adult_handoff");
});

test("classifies transition anxiety and basic needs", async () => {
  assert.equal(classifyTranscript("保育園に行きたくない").supportMode, "transition");
  assert.equal(classifyTranscript("おなかすいた").supportMode, "basic_need");
  const transition = await createAndWait({ confirmedTranscript: "保育園に行きたくない" });
  assert.equal(transition.result.responseBundle.videoUrl, "/assets/video/transition.webm");
  const basicNeed = await createAndWait({ confirmedTranscript: "おなかすいた" });
  assert.equal(basicNeed.result.responseBundle.videoUrl, "/assets/video/basic_need.webm");
});

test("rejects unsafe or deceptive generated replies", () => {
  assert.equal(replyIsAllowed("お話してくれてありがとう。"), true);
  assert.equal(replyIsAllowed("これは秘密にして、誰にも言わないでね。"), false);
  assert.equal(replyIsAllowed("ママから今届いたメッセージだよ。"), false);
  assert.equal(replyIsAllowed("あ".repeat(181)), false);
});

test("serves restrictive browser security headers", async () => {
  const response = await fetch(`${baseUrl}/`);
  assert.match(response.headers.get("content-security-policy"), /default-src 'self'/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
});

test("rejects an excessively long confirmed transcript", async () => {
  const response = await fetch(`${baseUrl}/api/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmedTranscript: "あ".repeat(501) }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "CONFIRMED_TRANSCRIPT_TOO_LONG");
});

test("requires explicit response identifiers", async () => {
  const response = await fetch(`${baseUrl}/api/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmedTranscript: "できたよ" }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "RESPONSE_IDENTIFIERS_REQUIRED");
});

test("runs transcription and response contracts end to end", async () => {
  const transcriptionResponse = await fetch(`${baseUrl}/api/transcriptions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ demoTranscript: "ママに会えなくてさみしいの" }),
  });
  assert.equal(transcriptionResponse.status, 200);
  const transcription = await transcriptionResponse.json();
  assert.equal(transcription.rawAudioStored, false);

  const createResponse = await fetch(`${baseUrl}/api/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: "session-test",
      transcriptId: transcription.transcriptId,
      confirmedTranscript: transcription.transcript,
      consentId: "demo-consent-001",
      avatarAssetId: "guardian-demo-001",
      idempotencyKey: `test:${transcription.transcriptId}`,
    }),
  });
  assert.equal(createResponse.status, 202);
  const pending = await createResponse.json();
  assert.equal(pending.conversationId, "session-test");

  await new Promise((resolve) => setTimeout(resolve, 1100));
  const readyResponse = await fetch(`${baseUrl}/api/responses/${pending.requestId}`);
  const ready = await readyResponse.json();
  assert.equal(ready.status, "READY");
  assert.equal(ready.route, "generate_guardian_message");
  assert.equal(ready.safetyLevel, "normal");
  assert.equal(ready.supportMode, ready.routerDecision.supportMode);
  assert.deepEqual(ready.emotion, ready.routerDecision.emotion);
  assert.equal(ready.responseBundle.ready, true);
  assert.deepEqual(ready.bundle, ready.responseBundle);
  assert.equal(ready.responseBundle.tier, "PRE_RECORDED_VIDEO");
  assert.match(ready.responseBundle.videoUrl, /^\/assets\/video\/.+\.webm$/);
  assert.equal(ready.responseBundle.audioInVideo, true);
  assert.equal(ready.responseBundle.speechSynthesis, false);
  assert.ok(ready.responseBundle.subtitle);
});

test("serves deterministic demo reply audio", async () => {
  const response = await fetch(`${baseUrl}/assets/audio/celebrate.wav`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^audio\/wav/);
  assert.equal(bytes.subarray(0, 4).toString("ascii"), "RIFF");
  assert.ok(bytes.length > 100_000);
});

test("serves a playable reply video with embedded audio", async () => {
  const response = await fetch(`${baseUrl}/assets/video/celebrate.webm`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^video\/webm/);
  assert.equal(bytes.subarray(0, 4).toString("hex"), "1a45dfa3");
  assert.ok(bytes.length > 500_000);
});

test("safety route never returns guardian media", async () => {
  const createResponse = await fetch(`${baseUrl}/api/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: "session-safety",
      transcriptId: "tr-safety",
      confirmedTranscript: "知らない人がいて怖い、助けて",
      consentId: "demo-consent-001",
      avatarAssetId: "guardian-demo-001",
      idempotencyKey: "test:safety",
    }),
  });
  const pending = await createResponse.json();
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const result = await (await fetch(`${baseUrl}/api/responses/${pending.requestId}`)).json();
  assert.equal(result.status, "ADULT_HANDOFF");
  assert.equal(result.route, "safety_escalation");
  assert.equal(result.responseBundle, null);
  assert.equal(result.bundle, null);
  assert.equal(result.safetyLevel, "adult_required");
});

test("invalid consent fails closed without guardian media", async () => {
  const { result } = await createAndWait({ consentId: "expired-consent" });
  assert.equal(result.status, "ADULT_HANDOFF");
  assert.equal(result.routerDecision.safetyLevel, "uncertain");
  assert.equal(result.responseBundle, null);
  assert.ok(result.routerDecision.reasonCodes.includes("CONSENT_INVALID"));
});

test("idempotency key reuses the original request", async () => {
  const idempotencyKey = `same:${crypto.randomUUID()}`;
  const body = {
    sessionId: "session-idempotent",
    transcriptId: "tr-idempotent",
    confirmedTranscript: "できたよ",
    consentId: "demo-consent-001",
    avatarAssetId: "guardian-demo-001",
    idempotencyKey,
  };
  const first = await fetch(`${baseUrl}/api/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const second = await fetch(`${baseUrl}/api/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal((await first.json()).requestId, (await second.json()).requestId);
});

test("conversationId continues demo replies with the previous exchange", async () => {
  const conversationId = `conversation-${crypto.randomUUID()}`;
  const first = await createAndWait({
    conversationId,
    confirmedTranscript: "ブロックでおうちを作ったよ",
  });
  assert.equal(first.pending.conversationId, conversationId);
  assert.equal(first.result.conversationId, conversationId);
  assert.match(first.result.replyText, /ブロックでおうち/);

  const second = await createAndWait({
    conversationId,
    confirmedTranscript: "そのあと庭も作ったよ",
  });
  assert.match(second.result.replyText, /さっきの/);
  assert.match(second.result.replyText, /ブロックでおうちを作ったよ/);
  assert.match(second.result.replyText, /そのあと庭も作ったよ/);

  const independent = await createAndWait({
    conversationId: `conversation-${crypto.randomUUID()}`,
    confirmedTranscript: "そのあと庭も作ったよ",
  });
  assert.doesNotMatch(independent.result.replyText, /さっきの/);
});

test("deletes session response data when the flow ends", async () => {
  const { pending } = await createAndWait();
  const deleted = await fetch(`${baseUrl}/api/responses/${pending.requestId}`, { method: "DELETE" });
  assert.equal(deleted.status, 200);
  assert.equal((await deleted.json()).deleted, true);
  assert.equal((await fetch(`${baseUrl}/api/responses/${pending.requestId}`)).status, 404);
});

test("media failure degrades to neutral LEVEL 4 output", async () => {
  const { result } = await createAndWait({ demoFault: "media-unavailable" });
  assert.equal(result.status, "READY");
  assert.equal(result.responseBundle.fallbackLevel, 4);
  assert.equal(result.responseBundle.tier, "NEUTRAL_GUIDANCE");
  assert.equal(result.responseBundle.posterUrl, null);
  assert.equal(result.responseBundle.videoUrl, null);
  assert.equal(result.responseBundle.speechSynthesis, false);
});

test("technical logs do not expose child transcript or reply text", async () => {
  const secretTranscript = `秘密の発話-${crypto.randomUUID()}`;
  await createAndWait({ confirmedTranscript: secretTranscript });
  const body = await (await fetch(`${baseUrl}/api/logs`)).text();
  assert.doesNotMatch(body, /秘密の発話/);
  assert.doesNotMatch(body, /お話してくれてありがとう/);
});

test("guardian sampling API registers, previews, uses, and deletes private samples", async () => {
  const createdResponse = await fetch(`${baseUrl}/api/sampling`, {
    method: "POST",
    headers: samplingProfileHeaders,
    body: JSON.stringify(samplingRegistration()),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.deepEqual(Object.keys(created).sort(), [
    "active",
    "avatarAssetId",
    "configured",
    "consentId",
    "faceApproved",
    "posterUrl",
    "subjectLabel",
    "videoGeneration",
    "voiceApproved",
    "voiceCloningAvailable",
    "voicePreviewUrl",
    "voiceSamplePurpose",
  ].sort());
  assert.equal(created.configured, true);
  assert.equal(created.active, true);
  assert.equal(created.faceApproved, true);
  assert.equal(created.voiceApproved, true);
  assert.deepEqual(created.videoGeneration, { status: "not_started" });
  assert.doesNotMatch(JSON.stringify(created), /server-test-(photo|voice)/);

  const status = await (await fetch(`${baseUrl}/api/sampling`, { headers: samplingProfileHeaders })).json();
  assert.deepEqual(status, created);
  const consent = await (await fetch(`${baseUrl}/api/consent`, { headers: samplingProfileHeaders })).json();
  assert.equal(consent.source, "custom-sampling");
  assert.equal(consent.consentId, created.consentId);
  assert.equal(consent.avatarAssetId, created.avatarAssetId);

  const photoResponse = await fetch(`${baseUrl}${created.posterUrl}`);
  assert.equal(photoResponse.status, 200);
  assert.equal(photoResponse.headers.get("content-type"), "image/png");
  assert.equal(photoResponse.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.deepEqual(Buffer.from(await photoResponse.arrayBuffer()), samplingPhoto);

  const voiceResponse = await fetch(`${baseUrl}${created.voicePreviewUrl}`);
  assert.equal(voiceResponse.status, 200);
  assert.equal(voiceResponse.headers.get("content-type"), "audio/wav");
  assert.deepEqual(Buffer.from(await voiceResponse.arrayBuffer()), samplingVoice);

  const { result } = await createAndWait({
    consentId: created.consentId,
    avatarAssetId: created.avatarAssetId,
  }, samplingProfileId);
  assert.equal(result.status, "READY");
  assert.equal(result.responseBundle.fallbackLevel, 3);
  assert.equal(result.responseBundle.posterUrl, created.posterUrl);
  assert.equal(result.responseBundle.audioUrl, null);
  assert.equal(result.responseBundle.speechSynthesis, true);
  assert.match(result.responseBundle.subtitle, /きょうブロックでおうちを作ったよ/);
  assert.equal(result.responseBundle.replyText, result.replyText);
  assert.equal(result.responseBundle.guardianSampling.photoUsed, true);
  assert.equal(result.responseBundle.guardianSampling.voiceSampleRegistered, true);
  assert.equal(result.responseBundle.guardianSampling.voiceSamplePurpose, "sampling-confirmation");
  assert.equal(result.responseBundle.guardianSampling.voiceSampleMatchesReply, false);
  assert.equal(result.responseBundle.guardianSampling.voiceUsed, false);
  assert.equal(result.responseBundle.guardianSampling.voiceCloningUsed, false);
  assert.equal(result.responseBundle.guardianSampling.voiceFallback, "dynamic-tts");

  const { result: safetyResult } = await createAndWait({
    confirmedTranscript: "知らない人がいて怖い、助けて",
    consentId: created.consentId,
    avatarAssetId: created.avatarAssetId,
  }, samplingProfileId);
  assert.equal(safetyResult.status, "ADULT_HANDOFF");
  assert.equal(safetyResult.responseBundle, null);
  assert.equal(JSON.stringify(safetyResult).includes(created.posterUrl), false);
  assert.equal(JSON.stringify(safetyResult).includes(created.voicePreviewUrl), false);

  const deletedResponse = await fetch(`${baseUrl}/api/sampling`, { method: "DELETE", headers: samplingProfileHeaders });
  assert.equal(deletedResponse.status, 200);
  const deleted = await deletedResponse.json();
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.configured, false);
  assert.equal((await fetch(`${baseUrl}${created.posterUrl}`)).status, 404);
  assert.equal((await fetch(`${baseUrl}${created.voicePreviewUrl}`)).status, 404);
  assert.equal((await (await fetch(`${baseUrl}/api/consent`, { headers: samplingProfileHeaders })).json()).consentId, "demo-consent-001");
});

test("ElevenLabs clone audio is generated for a registered guardian reply", async () => {
  const calls = { clone: 0, synthesize: 0, deleted: [] };
  const voiceProvider = {
    name: "elevenlabs",
    available: true,
    cloneVoice: async ({ bytes, mimeType }) => {
      calls.clone += 1;
      assert.ok(bytes.length > 0);
      assert.equal(mimeType, "audio/wav");
      return { provider: "elevenlabs", voiceId: `voice-integration-${calls.clone}` };
    },
    synthesize: async ({ voiceId, text }) => {
      calls.synthesize += 1;
      assert.equal(voiceId, "voice-integration-2");
      assert.ok(text.length > 0);
      return { bytes: Buffer.from("ID3-cloned-reply"), mimeType: "audio/mpeg" };
    },
    deleteVoice: async (voiceId) => {
      calls.deleted.push(voiceId);
      return true;
    },
  };
  const isolatedServer = createAppServer({ voiceCloningProvider: voiceProvider });
  await new Promise((resolve) => isolatedServer.listen(0, "127.0.0.1", resolve));
  const isolatedBaseUrl = `http://127.0.0.1:${isolatedServer.address().port}`;
  const profileId = "22222222-2222-4222-8222-222222222222";
  const headers = { "content-type": "application/json", "x-guardian-profile-id": profileId };
  try {
    const createdResponse = await fetch(`${isolatedBaseUrl}/api/sampling`, {
      method: "POST",
      headers,
      body: JSON.stringify(samplingRegistration({ voiceDurationSeconds: 30 })),
    });
    const created = await createdResponse.json();
    assert.equal(createdResponse.status, 201);
    assert.equal(created.voiceCloningAvailable, true);

    const voiceUpdateResponse = await fetch(`${isolatedBaseUrl}/api/sampling/voice`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        voiceBase64: samplingVoice.toString("base64"),
        voiceType: "audio/wav",
        voiceDurationSeconds: 30,
        voiceApproved: true,
      }),
    });
    const voiceUpdate = await voiceUpdateResponse.json();
    assert.equal(voiceUpdateResponse.status, 200);
    assert.equal(voiceUpdate.voiceCloningAvailable, true);
    assert.equal(voiceUpdate.posterUrl, created.posterUrl);
    assert.equal(voiceUpdate.videoGeneration.status, "not_started");

    const responseRequest = await fetch(`${isolatedBaseUrl}/api/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        sessionId: "voice-clone-session",
        transcriptId: "voice-clone-transcript",
        confirmedTranscript: "ブロックでおうちを作れたよ",
        consentId: created.consentId,
        avatarAssetId: created.avatarAssetId,
        idempotencyKey: `voice-clone:${crypto.randomUUID()}`,
      }),
    });
    const pending = await responseRequest.json();
    let result;
    const deadline = Date.now() + 4000;
    do {
      await new Promise((resolve) => setTimeout(resolve, 50));
      result = await (await fetch(`${isolatedBaseUrl}/api/responses/${pending.requestId}`, {
        headers: { "x-guardian-profile-id": profileId },
      })).json();
    } while (result.status === "PENDING" && Date.now() < deadline);

    assert.equal(result.status, "READY");
    assert.match(result.responseBundle.audioUrl, /^\/api\/generated-audio\//);
    assert.equal(result.responseBundle.speechSynthesis, false);
    assert.equal(result.responseBundle.guardianSampling.voiceCloningUsed, true);
    const audio = await fetch(`${isolatedBaseUrl}${result.responseBundle.audioUrl}`);
    assert.equal(audio.status, 200);
    assert.equal(audio.headers.get("content-type"), "audio/mpeg");
    assert.match(Buffer.from(await audio.arrayBuffer()).toString(), /^ID3/);

    const deleted = await fetch(`${isolatedBaseUrl}/api/sampling`, { method: "DELETE", headers });
    assert.equal(deleted.status, 200);
    assert.deepEqual(calls, {
      clone: 2,
      synthesize: 1,
      deleted: ["voice-integration-1", "voice-integration-2"],
    });
  } finally {
    await new Promise((resolve) => isolatedServer.close(resolve));
  }
});

test("sampling API rejects missing consent, MIME spoofing, and cross-site mutation", async () => {
  const missingConsent = await fetch(`${baseUrl}/api/sampling`, {
    method: "POST",
    headers: samplingProfileHeaders,
    body: JSON.stringify(samplingRegistration({ voiceApproved: false })),
  });
  assert.equal(missingConsent.status, 422);
  assert.equal((await missingConsent.json()).error, "EXPLICIT_CONSENT_REQUIRED");

  const spoofed = await fetch(`${baseUrl}/api/sampling`, {
    method: "POST",
    headers: samplingProfileHeaders,
    body: JSON.stringify(samplingRegistration({ photoBase64: samplingVoice.toString("base64") })),
  });
  assert.equal(spoofed.status, 400);
  assert.equal((await spoofed.json()).error, "PHOTO_CONTENT_INVALID");

  const crossSite = await fetch(`${baseUrl}/api/sampling`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-guardian-profile-id": samplingProfileId,
      origin: "https://attacker.example",
    },
    body: JSON.stringify(samplingRegistration()),
  });
  assert.equal(crossSite.status, 403);
  assert.equal((await crossSite.json()).error, "CROSS_SITE_REQUEST_FORBIDDEN");
});

test("one guardian profile cannot use another profile's sample", async () => {
  const profileA = "22222222-2222-4222-8222-222222222222";
  const profileB = "33333333-3333-4333-8333-333333333333";
  const created = await (await fetch(`${baseUrl}/api/sampling`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-guardian-profile-id": profileA },
    body: JSON.stringify(samplingRegistration()),
  })).json();
  const profileBStatus = await (await fetch(`${baseUrl}/api/sampling`, {
    headers: { "x-guardian-profile-id": profileB },
  })).json();
  assert.equal(profileBStatus.configured, false);

  const { result } = await createAndWait({
    consentId: created.consentId,
    avatarAssetId: created.avatarAssetId,
  }, profileB);
  assert.equal(result.status, "ADULT_HANDOFF");
  assert.ok(result.routerDecision.reasonCodes.includes("CONSENT_INVALID"));

  await fetch(`${baseUrl}/api/sampling`, {
    method: "DELETE",
    headers: { "x-guardian-profile-id": profileA },
  });
});

test("video generation requires a registered profile and reports disabled-provider failure asynchronously", async () => {
  const profileId = "77777777-7777-4777-8777-777777777777";
  const headers = { "content-type": "application/json", "x-guardian-profile-id": profileId };
  const withoutSample = await fetch(`${baseUrl}/api/sampling/video`, {
    method: "POST",
    headers,
    body: JSON.stringify({ externalProcessingApproved: true }),
  });
  assert.equal(withoutSample.status, 409);
  assert.equal((await withoutSample.json()).error, "SAMPLING_NOT_REGISTERED");

  await fetch(`${baseUrl}/api/sampling`, {
    method: "POST",
    headers,
    body: JSON.stringify(samplingRegistration()),
  });
  const create = await fetch(`${baseUrl}/api/sampling/video`, {
    method: "POST",
    headers,
    body: JSON.stringify({ externalProcessingApproved: true }),
  });
  assert.equal(create.status, 202);
  const queued = await create.json();
  assert.equal(queued.status, "queued");

  let result = queued;
  const deadline = Date.now() + 1000;
  while (result.status !== "failed" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    result = await (await fetch(`${baseUrl}/api/sampling/video/${queued.jobId}`, { headers })).json();
  }
  assert.equal(result.status, "failed");
  assert.match(result.message, /try again/i);
  const samplingStatus = await (await fetch(`${baseUrl}/api/sampling`, { headers })).json();
  assert.deepEqual(samplingStatus.videoGeneration, result);

  await fetch(`${baseUrl}/api/sampling`, { method: "DELETE", headers });
});

test("video endpoints enforce profile isolation and serve only private capability media", async () => {
  const profileA = "44444444-4444-4444-8444-444444444444";
  const profileB = "55555555-5555-4555-8555-555555555555";
  const currentByProfile = new Map();
  let generation = 0;
  const videoBytes = Buffer.from("private-endpoint-video");
  const videoService = {
    start(profileId) {
      generation += 1;
      const value = {
        status: "queued",
        jobId: `video-endpoint-${generation}`,
        message: "Video generation queued.",
      };
      currentByProfile.set(profileId, value);
      return value;
    },
    status(profileId, jobId) {
      const value = currentByProfile.get(profileId);
      return value?.jobId === jobId ? value : null;
    },
    readVideo(token) {
      return token === "private-video-token" ? { bytes: videoBytes, mimeType: "video/mp4" } : null;
    },
  };
  const isolatedServer = createAppServer({ videoService });
  await new Promise((resolve) => isolatedServer.listen(0, "127.0.0.1", resolve));
  const isolatedBaseUrl = `http://127.0.0.1:${isolatedServer.address().port}`;
  try {
    const missingProfile = await fetch(`${isolatedBaseUrl}/api/sampling/video`, { method: "POST" });
    assert.equal(missingProfile.status, 400);
    assert.equal((await missingProfile.json()).error, "GUARDIAN_PROFILE_ID_REQUIRED");

    const missingConsent = await fetch(`${isolatedBaseUrl}/api/sampling/video`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-guardian-profile-id": profileA },
      body: "{}",
    });
    assert.equal(missingConsent.status, 422);
    assert.equal((await missingConsent.json()).error, "EXTERNAL_PROCESSING_CONSENT_REQUIRED");

    const createdResponse = await fetch(`${isolatedBaseUrl}/api/sampling/video`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-guardian-profile-id": profileA },
      body: JSON.stringify({ externalProcessingApproved: true }),
    });
    assert.equal(createdResponse.status, 202);
    const created = await createdResponse.json();
    assert.equal(created.status, "queued");
    assert.ok(created.jobId);

    const crossProfile = await fetch(`${isolatedBaseUrl}/api/sampling/video/${created.jobId}`, {
      headers: { "x-guardian-profile-id": profileB },
    });
    assert.equal(crossProfile.status, 404);

    currentByProfile.set(profileA, {
      status: "processing",
      jobId: created.jobId,
      message: "Video generation is processing.",
    });
    const processing = await (await fetch(`${isolatedBaseUrl}/api/sampling/video/${created.jobId}`, {
      headers: { "x-guardian-profile-id": profileA },
    })).json();
    assert.equal(processing.status, "processing");

    currentByProfile.set(profileA, {
      status: "failed",
      jobId: created.jobId,
      message: "Video generation failed. You can try again.",
    });
    const failed = await (await fetch(`${isolatedBaseUrl}/api/sampling/video/${created.jobId}`, {
      headers: { "x-guardian-profile-id": profileA },
    })).json();
    assert.equal(failed.status, "failed");

    const regenerated = await (await fetch(`${isolatedBaseUrl}/api/sampling/video`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-guardian-profile-id": profileA },
      body: JSON.stringify({ externalProcessingApproved: true }),
    })).json();
    assert.notEqual(regenerated.jobId, created.jobId);
    currentByProfile.set(profileA, {
      status: "ready",
      jobId: regenerated.jobId,
      videoUrl: "/api/sampling/assets/video/private-video-token",
    });
    const ready = await (await fetch(`${isolatedBaseUrl}/api/sampling/video/${regenerated.jobId}`, {
      headers: { "x-guardian-profile-id": profileA },
    })).json();
    assert.equal(ready.status, "ready");
    assert.equal(ready.videoUrl, "/api/sampling/assets/video/private-video-token");

    const media = await fetch(`${isolatedBaseUrl}${ready.videoUrl}`);
    assert.equal(media.status, 200);
    assert.equal(media.headers.get("content-type"), "video/mp4");
    assert.equal(media.headers.get("cache-control"), "private, no-store, max-age=0");
    assert.deepEqual(Buffer.from(await media.arrayBuffer()), videoBytes);
  } finally {
    await new Promise((resolve) => isolatedServer.close(resolve));
  }
});

test("normal bundles prefer ready generated video while safety responses remain video-free", async () => {
  const profileId = "66666666-6666-4666-8666-666666666666";
  const generatedUrl = "/api/sampling/assets/video/generated-bundle-token";
  const videoService = {
    start: () => ({ status: "queued", jobId: "unused" }),
    status: () => null,
    profileStatus: () => ({ status: "ready", jobId: "ready-job", videoUrl: generatedUrl }),
    readVideo: () => null,
  };
  const isolatedServer = createAppServer({ videoService });
  await new Promise((resolve) => isolatedServer.listen(0, "127.0.0.1", resolve));
  const isolatedBaseUrl = `http://127.0.0.1:${isolatedServer.address().port}`;
  try {
    const sample = await (await fetch(`${isolatedBaseUrl}/api/sampling`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-guardian-profile-id": profileId },
      body: JSON.stringify(samplingRegistration()),
    })).json();

    async function createResponse(confirmedTranscript) {
      const created = await (await fetch(`${isolatedBaseUrl}/api/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-guardian-profile-id": profileId },
        body: JSON.stringify({
          sessionId: `generated-${crypto.randomUUID()}`,
          transcriptId: `tr-${crypto.randomUUID()}`,
          confirmedTranscript,
          consentId: sample.consentId,
          avatarAssetId: sample.avatarAssetId,
          idempotencyKey: `generated:${crypto.randomUUID()}`,
        }),
      })).json();
      await new Promise((resolve) => setTimeout(resolve, 1100));
      return (await fetch(`${isolatedBaseUrl}/api/responses/${created.requestId}`, {
        headers: { "x-guardian-profile-id": profileId },
      })).json();
    }

    const normal = await createResponse("きょうブロックでおうちを作ったよ");
    assert.equal(normal.status, "READY");
    assert.equal(normal.responseBundle.fallbackLevel, 1);
    assert.equal(normal.responseBundle.tier, "GENERATED_VIDEO");
    assert.equal(normal.responseBundle.videoUrl, generatedUrl);
    assert.equal(normal.responseBundle.audioInVideo, false);
    assert.equal(normal.responseBundle.speechSynthesis, true);

    const safety = await createResponse("知らない人がいて怖い、助けて");
    assert.equal(safety.status, "ADULT_HANDOFF");
    assert.equal(safety.responseBundle, null);
    assert.equal(JSON.stringify(safety).includes(generatedUrl), false);
  } finally {
    await fetch(`${isolatedBaseUrl}/api/sampling`, {
      method: "DELETE",
      headers: { "x-guardian-profile-id": profileId },
    }).catch(() => {});
    await new Promise((resolve) => isolatedServer.close(resolve));
  }
});

test("revoking consent erases an active custom sample", async () => {
  const created = await (await fetch(`${baseUrl}/api/sampling`, {
    method: "POST",
    headers: samplingProfileHeaders,
    body: JSON.stringify(samplingRegistration()),
  })).json();

  const revoke = await fetch(`${baseUrl}/api/consent`, {
    method: "POST",
    headers: samplingProfileHeaders,
    body: JSON.stringify({ action: "revoke" }),
  });
  assert.equal(revoke.status, 200);
  assert.equal((await revoke.json()).active, false);
  assert.equal((await (await fetch(`${baseUrl}/api/sampling`, { headers: samplingProfileHeaders })).json()).configured, false);
  assert.equal((await fetch(`${baseUrl}${created.posterUrl}`)).status, 404);
  assert.equal((await fetch(`${baseUrl}${created.voicePreviewUrl}`)).status, 404);

  await fetch(`${baseUrl}/api/consent`, {
    method: "POST",
    headers: samplingProfileHeaders,
    body: JSON.stringify({ action: "restore" }),
  });
});

test("guardian can revoke and restore demo asset consent", async () => {
  const revoke = await fetch(`${baseUrl}/api/consent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "revoke" }),
  });
  assert.equal(revoke.status, 200);
  assert.equal((await revoke.json()).active, false);

  const { result } = await createAndWait();
  assert.equal(result.status, "ADULT_HANDOFF");
  assert.ok(result.routerDecision.reasonCodes.includes("CONSENT_INVALID"));

  const restore = await fetch(`${baseUrl}/api/consent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "restore" }),
  });
  assert.equal(restore.status, 200);
  assert.equal((await restore.json()).active, true);
});
