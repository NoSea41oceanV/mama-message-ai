import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  GuardianVideoError,
  createGuardianVideoService,
  downloadGeneratedVideo,
} from "../lib/guardian-video-service.mjs";
import { createPersistentGuardianSamplingStore } from "../lib/persistent-guardian-sampling.mjs";

const profileId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("video-service-photo"),
]);
const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt voice")]);

function registration() {
  return {
    photoBase64: png.toString("base64"),
    photoType: "image/png",
    voiceBase64: wav.toString("base64"),
    voiceType: "audio/wav",
    voiceDurationSeconds: 5,
    faceApproved: true,
    voiceApproved: true,
  };
}

test("guardian video service submits, polls, downloads promptly, and supports regeneration", async () => {
  const root = mkdtempSync(join(tmpdir(), "guardian-video-service-"));
  try {
    const store = createPersistentGuardianSamplingStore({
      directory: join(root, "samples"),
      encryptionKey: Buffer.alloc(32, 3),
    });
    store.register(profileId, registration());
    let submittedImage;
    let pollCount = 0;
    let downloadCount = 0;
    let localJobCount = 0;
    const provider = {
      createTask: async ({ imageBase64 }) => {
        submittedImage = imageBase64;
        return { taskId: "provider-task-1", status: "queued", videoUrl: null };
      },
      getTask: async () => {
        pollCount += 1;
        return pollCount === 1
          ? { taskId: "provider-task-1", status: "processing", videoUrl: null }
          : { taskId: "provider-task-1", status: "ready", videoUrl: "https://signed.example/video.mp4" };
      },
    };
    const generatedBytes = Buffer.from("generated-mp4-payload");
    const service = createGuardianVideoService({
      samplingStore: store,
      provider,
      idFactory: () => `local-job-${++localJobCount}`,
      schedule: () => {},
      fetchImpl: async () => {
        downloadCount += 1;
        return new Response(generatedBytes, {
          status: 200,
          headers: { "content-type": "video/mp4", "content-length": String(generatedBytes.length) },
        });
      },
    });

    const queued = service.start(profileId);
    assert.deepEqual(queued, {
      status: "queued",
      jobId: "video_local-job-1",
      message: "Video generation queued.",
    });
    await service.advance(profileId, queued.jobId);
    assert.equal(submittedImage, png.toString("base64"));
    assert.equal(submittedImage.startsWith("data:"), false);
    await service.advance(profileId, queued.jobId);
    assert.equal(service.status(profileId, queued.jobId).status, "processing");
    await service.advance(profileId, queued.jobId);
    const ready = service.status(profileId, queued.jobId);
    assert.equal(ready.status, "ready");
    assert.match(ready.videoUrl, /^\/api\/sampling\/assets\/video\//);
    assert.equal(downloadCount, 1);
    const token = decodeURIComponent(ready.videoUrl.split("/").at(-1));
    assert.deepEqual(service.readVideo(token).bytes, generatedBytes);

    const regenerated = service.start(profileId);
    assert.equal(regenerated.status, "queued");
    assert.notEqual(regenerated.jobId, queued.jobId);
    assert.equal(service.status(profileId, queued.jobId), null);
    assert.equal(service.readVideo(token), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("guardian video service records provider failure without leaking details", async () => {
  const root = mkdtempSync(join(tmpdir(), "guardian-video-failure-"));
  try {
    const store = createPersistentGuardianSamplingStore({
      directory: join(root, "samples"),
      encryptionKey: Buffer.alloc(32, 4),
    });
    store.register(profileId, registration());
    const service = createGuardianVideoService({
      samplingStore: store,
      provider: { createTask: async () => { throw new Error("secret upstream response"); } },
      idFactory: () => "failed-job",
      schedule: () => {},
    });
    const queued = service.start(profileId);
    await service.advance(profileId, queued.jobId);
    const failed = service.status(profileId, queued.jobId);
    assert.equal(failed.status, "failed");
    assert.match(failed.message, /try again/i);
    assert.doesNotMatch(failed.message, /secret upstream response/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("guardian video service marks a reusable avatar ready without requiring a preview video", async () => {
  const root = mkdtempSync(join(tmpdir(), "guardian-avatar-service-"));
  try {
    const store = createPersistentGuardianSamplingStore({
      directory: join(root, "samples"),
      encryptionKey: Buffer.alloc(32, 5),
    });
    store.register(profileId, registration());
    const deletedAssets = [];
    const provider = {
      name: "heygen",
      createTask: async () => ({
        taskId: "avatar-1",
        providerAssetId: "photo-asset-1",
        status: "ready",
        prepared: true,
        videoUrl: null,
      }),
      deleteAsset: async (assetId) => {
        deletedAssets.push(assetId);
        return true;
      },
      deleteTask: async () => true,
    };
    const service = createGuardianVideoService({
      samplingStore: store,
      provider,
      idFactory: () => "avatar-job",
      schedule: () => {},
    });
    const queued = service.start(profileId);
    await service.advance(profileId, queued.jobId);
    assert.deepEqual(service.profileStatus(profileId), {
      status: "ready",
      jobId: "video_avatar-job",
    });
    assert.equal(service.profileProviderTaskId(profileId), "avatar-1");
    assert.equal(service.profileProviderAssetId(profileId), "photo-asset-1");
    assert.deepEqual(deletedAssets, []);
    assert.equal(store.videoJob(profileId, queued.jobId).provider, "heygen");
    assert.equal(store.videoJob(profileId, queued.jobId).providerAssetId, "photo-asset-1");
    assert.equal(await service.deleteRemote(profileId), true);
    assert.deepEqual(deletedAssets, ["photo-asset-1"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("guardian video service resumes a long-running Tavus Face after the legacy timeout", () => {
  const root = mkdtempSync(join(tmpdir(), "guardian-tavus-resume-"));
  try {
    const store = createPersistentGuardianSamplingStore({
      directory: join(root, "samples"),
      encryptionKey: Buffer.alloc(32, 6),
    });
    store.register(profileId, registration());
    const createdAt = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const queued = store.createVideoJob(profileId, {
      jobId: "video-tavus-face",
      provider: "tavus",
      createdAt,
    });
    store.updateVideoJob(profileId, queued.jobId, {
      status: "processing",
      providerTaskId: "face-training",
    });
    store.updateVideoJob(profileId, queued.jobId, {
      status: "failed",
      message: "Video generation timed out. You can try again.",
    });
    const scheduled = [];
    const service = createGuardianVideoService({
      samplingStore: store,
      provider: {
        name: "tavus",
        taskPollTimeoutMs: 5 * 60 * 60 * 1000,
        recoverTimedOutTasks: true,
      },
      schedule: (action) => scheduled.push(action),
    });

    assert.deepEqual(service.profileStatus(profileId), {
      status: "processing",
      jobId: queued.jobId,
      message: "Video generation is processing.",
    });
    assert.equal(scheduled.length, 1);
    assert.equal(store.videoJob(profileId, queued.jobId).providerTaskId, "face-training");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generated video download enforces HTTPS, type, and byte cap", async () => {
  await assert.rejects(
    downloadGeneratedVideo("http://signed.example/video.mp4"),
    (error) => error instanceof GuardianVideoError && error.code === "VIDEO_RESULT_URL_INSECURE",
  );
  await assert.rejects(
    downloadGeneratedVideo("https://signed.example/video.mp4", {
      fetchImpl: async () => new Response("not video", { headers: { "content-type": "text/html" } }),
    }),
    (error) => error instanceof GuardianVideoError && error.code === "VIDEO_CONTENT_TYPE_UNSUPPORTED",
  );
  await assert.rejects(
    downloadGeneratedVideo("https://signed.example/video.mp4", {
      maximumBytes: 4,
      fetchImpl: async () => new Response("12345", { headers: { "content-type": "video/mp4" } }),
    }),
    (error) => error instanceof GuardianVideoError && error.code === "VIDEO_TOO_LARGE",
  );
});
