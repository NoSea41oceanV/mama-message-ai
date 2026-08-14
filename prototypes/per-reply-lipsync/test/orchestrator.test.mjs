import assert from "node:assert/strict";
import test from "node:test";

import { PrototypeError } from "../src/errors.mjs";
import { createPerReplyLipsyncOrchestrator } from "../src/orchestrator.mjs";
import { assertNoSeparateTtsPlayback } from "../src/playback-policy.mjs";

const EXACT_REPLY = "だいじょうぶ。\nいっしょに、ゆっくりしよう。";
const pendingTests = [];
const trackedTest = (name, implementation) => {
  const pending = test(name, implementation);
  pendingTests.push(pending);
  return pending;
};

function allowedRequest(overrides = {}) {
  const base = {
    profileId: "profile-001",
    conversationId: "conversation-001",
    replyText: EXACT_REPLY,
    replyFinal: true,
    route: "generate_guardian_message",
    safetyDecision: "ALLOW_GUARDIAN_VIDEO",
    profile: {
      id: "profile-001",
      status: "active",
      photoApproved: true,
      sourceImageUrl: "https://profiles.example/guardian.jpg",
      consent: {
        orcarouterTts: true,
        guardianPhotoToDid: true,
        replyAudioToDid: true,
        syntheticGuardianVideo: true,
        revokedAt: null,
      },
    },
    tts: { voice: "alloy", responseFormat: "mp3" },
  };
  return {
    ...base,
    ...overrides,
    profile: { ...base.profile, ...(overrides.profile ?? {}) },
    tts: { ...base.tts, ...(overrides.tts ?? {}) },
  };
}

function storedAsset() {
  return {
    assetId: "asset-001",
    assetRef: "/api/lipsync/assets/asset-001",
    encryptedAtRest: true,
    encryptedAt: "2026-08-14T01:02:03.000Z",
    contentType: "video/mp4",
  };
}

function createMocks({
  pollError = null,
  assetError = null,
  deleteAudioError = null,
  deleteTalkError = null,
  ingest = null,
} = {}) {
  const calls = {
    tts: 0,
    upload: 0,
    create: 0,
    poll: 0,
    asset: 0,
    deleteAudio: 0,
    deleteTalk: 0,
  };
  const ttsClient = {
    async synthesize() {
      calls.tts += 1;
      return {
        bytes: Uint8Array.from([9, 8, 7, 6]),
        contentType: "audio/mpeg",
        responseFormat: "mp3",
      };
    },
  };
  const didClient = {
    async uploadAudio() {
      calls.upload += 1;
      return { id: "audio-1", audioUrl: "https://d-id.example/audio.wav" };
    },
    async createTalk(input) {
      calls.create += 1;
      assert.equal(input.audioUrl, "https://d-id.example/audio.wav");
      return { talkId: "talk-1", status: "processing", videoUrl: null };
    },
    async pollTalk() {
      calls.poll += 1;
      if (pollError) throw pollError;
      return { talkId: "talk-1", status: "ready", videoUrl: "https://cdn.example/reply.mp4" };
    },
    async deleteAudio() {
      calls.deleteAudio += 1;
      if (deleteAudioError) throw deleteAudioError;
      return true;
    },
    async deleteTalk() {
      calls.deleteTalk += 1;
      if (deleteTalkError) throw deleteTalkError;
      return true;
    },
  };
  const videoAssetService = {
    async ingest(input) {
      calls.asset += 1;
      assert.equal(input.sourceUrl, "https://cdn.example/reply.mp4");
      if (assetError) throw assetError;
      if (ingest) return ingest(input);
      return storedAsset();
    },
  };
  return { calls, ttsClient, didClient, videoAssetService };
}

function zeroCalls() {
  return {
    tts: 0,
    upload: 0,
    create: 0,
    poll: 0,
    asset: 0,
    deleteAudio: 0,
    deleteTalk: 0,
  };
}

trackedTest("safety or consent route blocks before every external call", async () => {
  const mocks = createMocks();
  const orchestrator = createPerReplyLipsyncOrchestrator(mocks);
  const request = allowedRequest({
    safetyDecision: "ADULT_HANDOFF",
    profile: {
      consent: {
        orcarouterTts: false,
        guardianPhotoToDid: false,
        replyAudioToDid: false,
        syntheticGuardianVideo: false,
      },
    },
  });

  const result = await orchestrator.generate(request);

  assert.equal(result.status, "blocked");
  assert.equal(result.gate.allowed, false);
  assert.deepEqual(mocks.calls, zeroCalls());
  assert.deepEqual(result.state.history.map(({ state }) => state), ["created", "blocked"]);
});

trackedTest("an unfinalized reply is blocked before every external call", async () => {
  const mocks = createMocks();
  const orchestrator = createPerReplyLipsyncOrchestrator(mocks);
  const result = await orchestrator.generate(allowedRequest({ replyFinal: false }));

  assert.equal(result.status, "blocked");
  assert.ok(result.gate.reasons.includes("reply_not_final"));
  assert.deepEqual(mocks.calls, zeroCalls());
});

trackedTest("identical concurrent and repeated requests create and store only one video", async () => {
  const mocks = createMocks();
  const orchestrator = createPerReplyLipsyncOrchestrator(mocks);
  const request = allowedRequest();

  const [first, second] = await Promise.all([
    orchestrator.generate(request),
    orchestrator.generate(request),
  ]);
  const third = await orchestrator.generate(request);

  assert.strictEqual(first, second);
  assert.strictEqual(first, third);
  assert.equal(first.status, "ready");
  assert.deepEqual(mocks.calls, {
    tts: 1,
    upload: 1,
    create: 1,
    poll: 1,
    asset: 1,
    deleteAudio: 1,
    deleteTalk: 1,
  });
  assert.equal(orchestrator.inspectRegistry().completedFinalJobs, 1);
});

trackedTest("profile + text + equal audio hash deduplicates D-ID and secure storage", async () => {
  const mocks = createMocks();
  const orchestrator = createPerReplyLipsyncOrchestrator(mocks);
  const [first, second] = await Promise.all([
    orchestrator.generate(allowedRequest({ tts: { voice: "alloy" } })),
    orchestrator.generate(allowedRequest({ tts: { voice: "nova" } })),
  ]);

  assert.equal(first.jobKey, second.jobKey);
  assert.equal(first.videoAssetId, second.videoAssetId);
  assert.equal(mocks.calls.tts, 2);
  assert.equal(mocks.calls.create, 1);
  assert.equal(mocks.calls.asset, 1);
});

trackedTest("shared media dedup preserves each conversation continuation context", async () => {
  const mocks = createMocks();
  const orchestrator = createPerReplyLipsyncOrchestrator(mocks);
  const first = await orchestrator.generate(allowedRequest({ conversationId: "conversation-001" }));
  const second = await orchestrator.generate(allowedRequest({ conversationId: "conversation-002" }));

  assert.equal(first.videoAssetId, second.videoAssetId);
  assert.equal(first.conversationId, "conversation-001");
  assert.equal(second.conversationId, "conversation-002");
  assert.equal(second.continuation.conversationId, "conversation-002");
  assert.equal(second.continuation.jobKey, second.jobKey);
  assert.equal(mocks.calls.tts, 2);
  assert.equal(mocks.calls.create, 1);
  assert.equal(mocks.calls.asset, 1);
});

trackedTest("ready is returned only after encrypted storage and contains internal media plus exact subtitle", async () => {
  let releaseStorage;
  const storagePending = new Promise((resolve) => { releaseStorage = resolve; });
  const mocks = createMocks({ ingest: async () => storagePending });
  const orchestrator = createPerReplyLipsyncOrchestrator(mocks);
  let settled = false;
  const generation = orchestrator.generate(allowedRequest()).then((result) => {
    settled = true;
    return result;
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(mocks.calls.asset, 1);
  assert.equal(settled, false);
  assert.equal(mocks.calls.deleteAudio, 0);
  assert.equal(mocks.calls.deleteTalk, 0);

  releaseStorage(storedAsset());
  const result = await generation;

  assert.equal(result.status, "ready");
  assert.equal(result.videoAssetId, "asset-001");
  assert.equal(result.videoAssetRef, "/api/lipsync/assets/asset-001");
  assert.equal(result.videoUrl, "/api/lipsync/assets/asset-001");
  assert.equal(result.videoUrl.startsWith("https://cdn.example"), false);
  assert.equal(result.encryptedAtRest, true);
  assert.equal(result.replyText, EXACT_REPLY);
  assert.equal(result.subtitle, EXACT_REPLY);
  assert.equal(result.conversationId, "conversation-001");
  assert.deepEqual(result.continuation, {
    conversationId: "conversation-001",
    profileId: "profile-001",
    jobKey: result.jobKey,
    canContinue: true,
  });
  assert.equal(assertNoSeparateTtsPlayback(result.playback), true);
  assert.equal(result.cleanup.audio.deleted, true);
  assert.equal(result.cleanup.talk.deleted, true);
  assert.deepEqual(result.state.history.map(({ state }) => state), [
    "created",
    "gated",
    "synthesizing",
    "audio_ready",
    "uploading_audio",
    "creating_talk",
    "polling",
    "downloading_and_encrypting",
    "ready",
  ]);
});

trackedTest("D-ID terminal failure becomes failed and deletes audio plus talk", async () => {
  const mocks = createMocks({
    pollError: new PrototypeError("DID_TALK_FAILED", "D-ID talk generation failed"),
  });
  const result = await createPerReplyLipsyncOrchestrator(mocks).generate(allowedRequest());

  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "DID_TALK_FAILED");
  assert.equal(result.videoAssetRef, null);
  assert.equal(mocks.calls.asset, 0);
  assert.equal(mocks.calls.deleteAudio, 1);
  assert.equal(mocks.calls.deleteTalk, 1);
  assert.equal(result.cleanup.audio.deleted, true);
  assert.equal(result.cleanup.talk.deleted, true);
});

trackedTest("D-ID timeout becomes timed_out and deletes audio plus talk", async () => {
  const mocks = createMocks({
    pollError: new PrototypeError("DID_POLL_TIMEOUT", "D-ID talk generation timed out"),
  });
  const result = await createPerReplyLipsyncOrchestrator(mocks).generate(allowedRequest());

  assert.equal(result.status, "timed_out");
  assert.equal(result.error.code, "DID_POLL_TIMEOUT");
  assert.equal(mocks.calls.deleteAudio, 1);
  assert.equal(mocks.calls.deleteTalk, 1);
  assert.equal(result.state.state, "timed_out");
});

trackedTest("download or encrypted-store failure never becomes ready and still cleans D-ID resources", async () => {
  const mocks = createMocks({
    assetError: new PrototypeError("MP4_CONTENT_TYPE_INVALID", "MP4 response must use video/mp4"),
  });
  const result = await createPerReplyLipsyncOrchestrator(mocks).generate(allowedRequest());

  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "MP4_CONTENT_TYPE_INVALID");
  assert.equal(result.videoAssetId, null);
  assert.equal(result.encryptedAtRest, false);
  assert.equal(mocks.calls.deleteAudio, 1);
  assert.equal(mocks.calls.deleteTalk, 1);
  assert.equal(result.state.history.some(({ state }) => state === "ready"), false);
});

trackedTest("cleanup failures are reported without discarding a securely stored ready asset", async () => {
  const mocks = createMocks({
    deleteAudioError: new PrototypeError("DID_AUDIO_CLEANUP_FAILED", "mock cleanup"),
    deleteTalkError: new PrototypeError("DID_TALK_CLEANUP_FAILED", "mock cleanup"),
  });
  const result = await createPerReplyLipsyncOrchestrator(mocks).generate(allowedRequest());

  assert.equal(result.status, "ready");
  assert.equal(result.encryptedAtRest, true);
  assert.equal(result.cleanup.audio.deleted, false);
  assert.equal(result.cleanup.audio.warning, "DID_AUDIO_CLEANUP_FAILED");
  assert.equal(result.cleanup.talk.deleted, false);
  assert.equal(result.cleanup.talk.warning, "DID_TALK_CLEANUP_FAILED");
});

export const completion = Promise.all(pendingTests);
export const testCount = pendingTests.length;
