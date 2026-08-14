import { PrototypeError, asPrototypeError } from "./errors.mjs";
import { VIDEO_OWNS_AUDIO_PLAYBACK } from "./playback-policy.mjs";
import { createFinalJobKey, createPreflightKey } from "./request-key.mjs";
import { evaluateGenerationGate } from "./safety-gate.mjs";
import { JobStateMachine } from "./state-machine.mjs";

function terminalStateFor(error) {
  return /TIMEOUT/.test(String(error?.code ?? "")) ? "timed_out" : "failed";
}

function publicFailure(error) {
  return Object.freeze({
    code: String(error.code ?? "LIPSYNC_FAILED"),
    message: String(error.message ?? "per-reply lipsync generation failed"),
  });
}

function audioFilename(responseFormat) {
  const extension = ["mp3", "opus", "aac", "flac", "wav"].includes(responseFormat)
    ? responseFormat
    : "bin";
  return `reply.${extension}`;
}

function emptyCleanup() {
  return Object.freeze({
    audio: Object.freeze({ attempted: false, deleted: false, warning: null }),
    talk: Object.freeze({ attempted: false, deleted: false, warning: null }),
  });
}

function contextFor(request, jobKey = null) {
  return Object.freeze({
    conversationId: request.conversationId ?? null,
    profileId: request.profileId ?? null,
    jobKey,
    canContinue: Boolean(request.conversationId && jobKey),
  });
}

function withRequestContext(result, request) {
  return Object.freeze({
    ...result,
    replyText: result.status === "ready" ? request.replyText : null,
    subtitle: result.status === "ready" ? request.replyText : null,
    conversationId: request.conversationId ?? null,
    continuation: contextFor(request, result.status === "ready" ? result.jobKey : null),
  });
}

function validateStoredAsset(asset) {
  const assetId = String(asset?.assetId ?? "").trim();
  const assetRef = String(asset?.assetRef ?? "").trim();
  if (
    !assetId
    || asset.encryptedAtRest !== true
    || asset.contentType !== "video/mp4"
    || assetRef !== `/api/lipsync/assets/${encodeURIComponent(assetId)}`
  ) {
    throw new PrototypeError("ASSET_STORE_RESULT_INVALID", "secure video asset store returned an invalid result");
  }
  return Object.freeze({ ...asset, assetId, assetRef });
}

export function createPerReplyLipsyncOrchestrator({
  ttsClient,
  didClient,
  videoAssetService,
  now = () => Date.now(),
  gate = evaluateGenerationGate,
} = {}) {
  if (typeof ttsClient?.synthesize !== "function") {
    throw new PrototypeError("TTS_CLIENT_REQUIRED", "a TTS client is required");
  }
  if (
    typeof didClient?.uploadAudio !== "function"
    || typeof didClient?.createTalk !== "function"
    || typeof didClient?.pollTalk !== "function"
    || typeof didClient?.deleteAudio !== "function"
    || typeof didClient?.deleteTalk !== "function"
  ) {
    throw new PrototypeError("DID_CLIENT_REQUIRED", "a complete D-ID client is required");
  }
  if (typeof videoAssetService?.ingest !== "function") {
    throw new PrototypeError("VIDEO_ASSET_SERVICE_REQUIRED", "a secure video asset service is required");
  }

  const inFlightRequests = new Map();
  const completedRequests = new Map();
  const inFlightFinalJobs = new Map();
  const completedFinalJobs = new Map();

  async function runDidStage({ request, audio, finalKey, state, signal }) {
    let uploadedAudioId = null;
    let talkId = null;
    let storedAsset = null;
    let failure = null;
    const cleanup = {
      audio: { attempted: false, deleted: false, warning: null },
      talk: { attempted: false, deleted: false, warning: null },
    };

    try {
      state.transition("uploading_audio");
      const uploaded = await didClient.uploadAudio({
        bytes: audio.bytes,
        contentType: audio.contentType,
        filename: audioFilename(audio.responseFormat),
        signal,
      });
      uploadedAudioId = uploaded.id;

      state.transition("creating_talk");
      const talk = await didClient.createTalk({
        sourceImageUrl: request.profile.sourceImageUrl,
        audioUrl: uploaded.audioUrl,
        name: `reply-${finalKey.key.slice(0, 16)}`,
        signal,
      });
      talkId = talk.talkId;

      state.transition("polling");
      if (talk.status === "failed") {
        throw new PrototypeError("DID_TALK_FAILED", "D-ID talk generation failed");
      }
      const readyTalk = talk.status === "ready"
        ? talk
        : await didClient.pollTalk(talk.talkId, {
          timeoutMs: request.did?.pollTimeoutMs,
          intervalMs: request.did?.pollIntervalMs,
          signal,
        });
      if (!readyTalk.videoUrl) {
        throw new PrototypeError("DID_RESULT_URL_MISSING", "D-ID completed without a result video URL");
      }

      state.transition("downloading_and_encrypting");
      storedAsset = validateStoredAsset(await videoAssetService.ingest({
        sourceUrl: readyTalk.videoUrl,
        profileId: request.profileId,
        jobKey: finalKey.key,
        signal,
      }));
    } catch (error) {
      failure = asPrototypeError(error, "LIPSYNC_FAILED", "per-reply lipsync generation failed");
    } finally {
      const cleanupTasks = [];
      if (talkId) {
        cleanup.talk.attempted = true;
        cleanupTasks.push((async () => {
          try {
            await didClient.deleteTalk(talkId);
            cleanup.talk.deleted = true;
          } catch (error) {
            cleanup.talk.warning = String(error?.code ?? "DID_TALK_CLEANUP_FAILED");
          }
        })());
      }
      if (uploadedAudioId) {
        cleanup.audio.attempted = true;
        cleanupTasks.push((async () => {
          try {
            await didClient.deleteAudio(uploadedAudioId);
            cleanup.audio.deleted = true;
          } catch (error) {
            cleanup.audio.warning = String(error?.code ?? "DID_AUDIO_CLEANUP_FAILED");
          }
        })());
      }
      await Promise.all(cleanupTasks);
    }

    if (failure) {
      const terminalState = terminalStateFor(failure);
      state.transition(terminalState, failure.code);
      return Object.freeze({
        status: terminalState,
        jobKey: finalKey.key,
        audioHash: finalKey.audioHash,
        videoAssetId: null,
        videoAssetRef: null,
        videoUrl: null,
        encryptedAtRest: false,
        encryptedAt: null,
        playback: null,
        cleanup: Object.freeze({
          audio: Object.freeze({ ...cleanup.audio }),
          talk: Object.freeze({ ...cleanup.talk }),
        }),
        error: publicFailure(failure),
        state: state.snapshot(),
      });
    }

    state.transition("ready");
    return Object.freeze({
      status: "ready",
      jobKey: finalKey.key,
      audioHash: finalKey.audioHash,
      videoAssetId: storedAsset.assetId,
      videoAssetRef: storedAsset.assetRef,
      videoUrl: storedAsset.assetRef,
      encryptedAtRest: true,
      encryptedAt: storedAsset.encryptedAt,
      contentType: storedAsset.contentType,
      playback: VIDEO_OWNS_AUDIO_PLAYBACK,
      cleanup: Object.freeze({
        audio: Object.freeze({ ...cleanup.audio }),
        talk: Object.freeze({ ...cleanup.talk }),
      }),
      error: null,
      state: state.snapshot(),
    });
  }

  async function runAllowed(request) {
    const state = new JobStateMachine({ now });
    state.transition("gated");
    state.transition("synthesizing");

    let audio;
    try {
      audio = await ttsClient.synthesize({
        input: request.replyText,
        ...(request.tts ?? {}),
      });
      state.transition("audio_ready");
    } catch (error) {
      const normalized = asPrototypeError(error, "TTS_FAILED", "reply TTS generation failed");
      const terminalState = terminalStateFor(normalized);
      state.transition(terminalState, normalized.code);
      return withRequestContext(Object.freeze({
        status: terminalState,
        jobKey: null,
        audioHash: null,
        videoAssetId: null,
        videoAssetRef: null,
        videoUrl: null,
        encryptedAtRest: false,
        encryptedAt: null,
        playback: null,
        cleanup: emptyCleanup(),
        error: publicFailure(normalized),
        state: state.snapshot(),
      }), request);
    }

    const finalKey = createFinalJobKey({
      profileId: request.profileId,
      replyText: request.replyText,
      audioBytes: audio.bytes,
    });
    let coreResult;
    if (completedFinalJobs.has(finalKey.key)) {
      coreResult = completedFinalJobs.get(finalKey.key);
    } else if (inFlightFinalJobs.has(finalKey.key)) {
      coreResult = await inFlightFinalJobs.get(finalKey.key);
    } else {
      const finalPromise = runDidStage({ request, audio, finalKey, state, signal: request.signal });
      inFlightFinalJobs.set(finalKey.key, finalPromise);
      try {
        coreResult = await finalPromise;
        if (coreResult.status === "ready") completedFinalJobs.set(finalKey.key, coreResult);
      } finally {
        if (inFlightFinalJobs.get(finalKey.key) === finalPromise) {
          inFlightFinalJobs.delete(finalKey.key);
        }
      }
    }
    return withRequestContext(coreResult, request);
  }

  async function generate(request = {}) {
    const gateResult = gate(request);
    if (!gateResult.allowed) {
      const state = new JobStateMachine({ now });
      state.transition("blocked", gateResult.reasons.join(","));
      return Object.freeze({
        status: "blocked",
        gate: gateResult,
        jobKey: null,
        audioHash: null,
        videoAssetId: null,
        videoAssetRef: null,
        videoUrl: null,
        encryptedAtRest: false,
        encryptedAt: null,
        replyText: null,
        subtitle: null,
        conversationId: request.conversationId ?? null,
        continuation: contextFor(request),
        playback: null,
        cleanup: emptyCleanup(),
        error: null,
        state: state.snapshot(),
      });
    }

    const preflightKey = createPreflightKey(request);
    if (completedRequests.has(preflightKey)) return completedRequests.get(preflightKey);
    if (inFlightRequests.has(preflightKey)) return inFlightRequests.get(preflightKey);

    const requestPromise = runAllowed(request);
    inFlightRequests.set(preflightKey, requestPromise);
    try {
      const result = await requestPromise;
      if (result.status === "ready") completedRequests.set(preflightKey, result);
      return result;
    } finally {
      if (inFlightRequests.get(preflightKey) === requestPromise) {
        inFlightRequests.delete(preflightKey);
      }
    }
  }

  return Object.freeze({
    generate,
    inspectRegistry() {
      return Object.freeze({
        inFlightRequests: inFlightRequests.size,
        completedRequests: completedRequests.size,
        inFlightFinalJobs: inFlightFinalJobs.size,
        completedFinalJobs: completedFinalJobs.size,
      });
    },
  });
}
