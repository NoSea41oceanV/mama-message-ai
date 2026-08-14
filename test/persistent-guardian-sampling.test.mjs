import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPersistentGuardianSamplingStore } from "../lib/persistent-guardian-sampling.mjs";

const profileA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const profileB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("persistent-private-photo"),
]);
const wav = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.alloc(4),
  Buffer.from("WAVEfmt persistent-private-voice"),
]);

function registration(subjectLabel) {
  return {
    subjectLabel,
    photoBase64: png.toString("base64"),
    photoType: "image/png",
    voiceBase64: wav.toString("base64"),
    voiceType: "audio/wav",
    voiceDurationSeconds: 8,
    faceApproved: true,
    voiceApproved: true,
  };
}

test("persistent samples survive restart, stay encrypted, and remain profile-isolated", () => {
  const root = mkdtempSync(join(tmpdir(), "guardian-sampling-"));
  const directory = join(root, "samples");
  const encryptionKey = Buffer.alloc(32, 7);
  try {
    const first = createPersistentGuardianSamplingStore({ directory, encryptionKey });
    const savedA = first.register(profileA, registration("Aのおうちの人"), {
      voiceClone: { provider: "elevenlabs", voiceId: "private-elevenlabs-id" },
    });
    first.updatePreferences(profileA, { favoriteTopics: ["恐竜", "電車"] });
    first.register(profileB, registration("Bのおうちの人"));

    const encryptedSource = readFileSync(join(directory, `${profileA}.sample`), "utf8");
    assert.doesNotMatch(encryptedSource, /Aのおうちの人/);
    assert.doesNotMatch(encryptedSource, new RegExp(png.toString("base64")));

    const restarted = createPersistentGuardianSamplingStore({ directory, encryptionKey });
    assert.equal(restarted.status(profileA).subjectLabel, "Aのおうちの人");
    assert.equal(restarted.status(profileA).voiceCloningAvailable, true);
    assert.deepEqual(restarted.status(profileA).favoriteTopics, ["恐竜", "電車"]);
    assert.equal(restarted.resolve(profileA, savedA.consentId, savedA.avatarAssetId).voiceClone.voiceId, "private-elevenlabs-id");
    assert.equal(restarted.status(profileB).subjectLabel, "Bのおうちの人");
    assert.equal(restarted.resolve(profileB, savedA.consentId, savedA.avatarAssetId), null);

    const photoToken = decodeURIComponent(savedA.posterUrl.split("/").at(-1));
    assert.deepEqual(restarted.readPhoto(photoToken).bytes, png);
    restarted.delete(profileA);
    assert.equal(restarted.status(profileA).configured, false);
    assert.equal(restarted.status(profileB).configured, true);
    assert.equal(restarted.readPhoto(photoToken), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generated guardian video is encrypted, profile-bound, restart-safe, and erased with consent", () => {
  const root = mkdtempSync(join(tmpdir(), "guardian-video-persistence-"));
  const directory = join(root, "samples");
  const encryptionKey = Buffer.alloc(32, 9);
  const video = Buffer.concat([Buffer.from("....ftypisom"), Buffer.from("private-generated-video")]);
  try {
    const first = createPersistentGuardianSamplingStore({ directory, encryptionKey });
    first.register(profileA, registration("Guardian A"));
    first.register(profileB, registration("Guardian B"));
    const queued = first.createVideoJob(profileA, { jobId: "video-job-a" });
    assert.deepEqual(queued, {
      status: "queued",
      jobId: "video-job-a",
      message: "Video generation queued.",
    });
    first.updateVideoJob(profileA, "video-job-a", {
      status: "processing",
      providerTaskId: "provider-task-private",
      message: "Video generation is processing.",
    });
    const ready = first.storeVideo(profileA, "video-job-a", { bytes: video, mimeType: "video/mp4" });
    assert.equal(ready.status, "ready");
    assert.match(ready.videoUrl, /^\/api\/sampling\/assets\/video\//);

    const encryptedSource = readFileSync(join(directory, `${profileA}.sample`), "utf8");
    assert.doesNotMatch(encryptedSource, /private-generated-video/);
    assert.doesNotMatch(encryptedSource, /provider-task-private/);

    const restarted = createPersistentGuardianSamplingStore({ directory, encryptionKey });
    assert.deepEqual(restarted.status(profileA).videoGeneration, ready);
    assert.equal(restarted.status(profileB).videoGeneration.status, "not_started");
    const token = decodeURIComponent(ready.videoUrl.split("/").at(-1));
    assert.deepEqual(restarted.readVideo(token).bytes, video);
    restarted.revoke(profileA);
    assert.equal(restarted.status(profileA).videoGeneration.status, "not_started");
    assert.equal(restarted.readVideo(token), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
