import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { buildReply, classifyTranscript, createAppServer, replyIsAllowed } from "../server.mjs";

let server;
let baseUrl;

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

async function createAndWait(overrides = {}) {
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
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const pending = await create.json();
  assert.equal(create.status, 202);
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const result = await (await fetch(`${baseUrl}/api/responses/${pending.requestId}`)).json();
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
    headers: { "content-type": "application/json" },
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
    "voiceApproved",
    "voicePreviewUrl",
  ].sort());
  assert.equal(created.configured, true);
  assert.equal(created.active, true);
  assert.equal(created.faceApproved, true);
  assert.equal(created.voiceApproved, true);
  assert.doesNotMatch(JSON.stringify(created), /server-test-(photo|voice)/);

  const status = await (await fetch(`${baseUrl}/api/sampling`)).json();
  assert.deepEqual(status, created);
  const consent = await (await fetch(`${baseUrl}/api/consent`)).json();
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
  });
  assert.equal(result.status, "READY");
  assert.equal(result.responseBundle.fallbackLevel, 3);
  assert.equal(result.responseBundle.posterUrl, created.posterUrl);
  assert.equal(result.responseBundle.audioUrl, created.voicePreviewUrl);
  assert.equal(result.responseBundle.subtitle, "お話ししてくれてありがとう。いつも応援しているよ。");
  assert.equal(result.responseBundle.replyText, "お話ししてくれてありがとう。いつも応援しているよ。");
  assert.equal(result.replyText, "お話ししてくれてありがとう。いつも応援しているよ。");
  assert.equal(result.responseBundle.guardianSampling.photoUsed, true);
  assert.equal(result.responseBundle.guardianSampling.voiceSampleRegistered, true);
  assert.equal(result.responseBundle.guardianSampling.voiceUsed, true);

  const { result: safetyResult } = await createAndWait({
    confirmedTranscript: "知らない人がいて怖い、助けて",
    consentId: created.consentId,
    avatarAssetId: created.avatarAssetId,
  });
  assert.equal(safetyResult.status, "ADULT_HANDOFF");
  assert.equal(safetyResult.responseBundle, null);
  assert.equal(JSON.stringify(safetyResult).includes(created.posterUrl), false);
  assert.equal(JSON.stringify(safetyResult).includes(created.voicePreviewUrl), false);

  const deletedResponse = await fetch(`${baseUrl}/api/sampling`, { method: "DELETE" });
  assert.equal(deletedResponse.status, 200);
  const deleted = await deletedResponse.json();
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.configured, false);
  assert.equal((await fetch(`${baseUrl}${created.posterUrl}`)).status, 404);
  assert.equal((await fetch(`${baseUrl}${created.voicePreviewUrl}`)).status, 404);
  assert.equal((await (await fetch(`${baseUrl}/api/consent`)).json()).consentId, "demo-consent-001");
});

test("sampling API rejects missing consent, MIME spoofing, and cross-site mutation", async () => {
  const missingConsent = await fetch(`${baseUrl}/api/sampling`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(samplingRegistration({ voiceApproved: false })),
  });
  assert.equal(missingConsent.status, 422);
  assert.equal((await missingConsent.json()).error, "EXPLICIT_CONSENT_REQUIRED");

  const spoofed = await fetch(`${baseUrl}/api/sampling`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(samplingRegistration({ photoBase64: samplingVoice.toString("base64") })),
  });
  assert.equal(spoofed.status, 400);
  assert.equal((await spoofed.json()).error, "PHOTO_CONTENT_INVALID");

  const crossSite = await fetch(`${baseUrl}/api/sampling`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://attacker.example",
    },
    body: JSON.stringify(samplingRegistration()),
  });
  assert.equal(crossSite.status, 403);
  assert.equal((await crossSite.json()).error, "CROSS_SITE_REQUEST_FORBIDDEN");
});

test("revoking consent erases an active custom sample", async () => {
  const created = await (await fetch(`${baseUrl}/api/sampling`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(samplingRegistration()),
  })).json();

  const revoke = await fetch(`${baseUrl}/api/consent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "revoke" }),
  });
  assert.equal(revoke.status, 200);
  assert.equal((await revoke.json()).active, false);
  assert.equal((await (await fetch(`${baseUrl}/api/sampling`)).json()).configured, false);
  assert.equal((await fetch(`${baseUrl}${created.posterUrl}`)).status, 404);
  assert.equal((await fetch(`${baseUrl}${created.voicePreviewUrl}`)).status, 404);

  await fetch(`${baseUrl}/api/consent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
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
