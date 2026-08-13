import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { buildReply, classifyTranscript, createAppServer } from "../server.mjs";

let server;
let baseUrl;

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
  assert.equal(ready.responseBundle.ready, true);
  assert.equal(ready.responseBundle.tier, "STILL_AUDIO");
  assert.ok(ready.responseBundle.subtitle);
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
