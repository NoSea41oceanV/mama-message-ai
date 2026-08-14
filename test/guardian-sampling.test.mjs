import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GuardianSamplingError,
  createGuardianSamplingStore,
} from "../lib/guardian-sampling.mjs";

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("private-photo"),
]);
const wav = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.alloc(4),
  Buffer.from("WAVEfmt "),
  Buffer.from("private-voice"),
]);

function validRegistration(overrides = {}) {
  return {
    subjectLabel: "テスト保護者",
    photoBase64: png.toString("base64"),
    photoType: "image/png",
    voiceBase64: wav.toString("base64"),
    voiceType: "audio/wav",
    faceApproved: true,
    voiceApproved: true,
    voiceDurationSeconds: 8,
    ...overrides,
  };
}

test("sampling registration requires both explicit approvals and hides raw media", () => {
  const store = createGuardianSamplingStore();
  assert.throws(
    () => store.register(validRegistration({ voiceApproved: false })),
    (error) => error instanceof GuardianSamplingError
      && error.code === "EXPLICIT_CONSENT_REQUIRED"
      && error.statusCode === 422,
  );

  const status = store.register(validRegistration());
  assert.equal(status.configured, true);
  assert.equal(status.active, true);
  assert.equal(status.photo.mimeType, "image/png");
  assert.equal(status.voice.mimeType, "audio/wav");
  assert.equal(JSON.stringify(status).includes(png.toString("base64")), false);
  assert.equal(JSON.stringify(status).includes(wav.toString("base64")), false);
});

test("trusted ElevenLabs clone metadata is available without exposing the voice ID", () => {
  const store = createGuardianSamplingStore();
  const status = store.register(validRegistration(), {
    voiceClone: { provider: "elevenlabs", voiceId: "private-voice-id" },
  });
  assert.equal(status.voiceCloningAvailable, true);
  assert.doesNotMatch(JSON.stringify(status), /private-voice-id/);
  const resolved = store.resolve(status.consentId, status.avatarAssetId);
  assert.deepEqual(resolved.voiceClone, { provider: "elevenlabs", voiceId: "private-voice-id" });
});

test("favorite topics are normalized and update without replacing guardian media", () => {
  const store = createGuardianSamplingStore();
  const first = store.register(validRegistration({
    favoriteTopics: ["恐竜", " 電車 ", "恐竜", "", "プリキュア"],
  }));
  const before = store.resolve(first.consentId, first.avatarAssetId);
  assert.deepEqual(first.favoriteTopics, ["恐竜", "電車", "プリキュア"]);
  const updated = store.updatePreferences({
    favoriteTopics: "ブロック、動物\n絵本",
    childName: " ひなたちゃん ",
    speechRate: 0.7,
  });
  const after = store.resolve(updated.consentId, updated.avatarAssetId);
  assert.deepEqual(updated.favoriteTopics, ["ブロック", "動物", "絵本"]);
  assert.deepEqual(after.favoriteTopics, ["ブロック", "動物", "絵本"]);
  assert.equal(updated.childName, "ひなたちゃん");
  assert.equal(after.childName, "ひなたちゃん");
  assert.equal(updated.speechRate, 0.7);
  assert.equal(after.speechRate, 0.7);
  assert.equal(after.photo, before.photo);
  assert.equal(after.voice, before.voice);
  assert.equal(updated.consentId, first.consentId);
});

test("child calling name and speech rate use safe bounded defaults", () => {
  const store = createGuardianSamplingStore();
  const first = store.register(validRegistration({ childName: "あおいちゃん", speechRate: 99 }));
  assert.equal(first.childName, "あおいちゃん");
  assert.equal(first.speechRate, 1.2);
  const updated = store.updatePreferences({ speechRate: "invalid" });
  assert.equal(updated.childName, "あおいちゃん");
  assert.equal(updated.speechRate, 0.82);
});

test("voice-only replacement preserves the guardian photo and consent identifiers", () => {
  const store = createGuardianSamplingStore();
  const first = store.register(validRegistration(), {
    voiceClone: { provider: "elevenlabs", voiceId: "voice-old" },
  });
  const before = store.resolve(first.consentId, first.avatarAssetId);
  const previousVoice = before.voice.bytes;
  const updated = store.replaceVoice({
    voiceBase64: wav.toString("base64"),
    voiceType: "audio/wav",
    voiceDurationSeconds: 30,
    voiceApproved: true,
  }, {
    voiceClone: { provider: "elevenlabs", voiceId: "voice-new" },
  });
  const after = store.resolve(updated.consentId, updated.avatarAssetId);
  assert.equal(updated.consentId, first.consentId);
  assert.equal(updated.avatarAssetId, first.avatarAssetId);
  assert.equal(after.photo, before.photo);
  assert.equal(after.voice.durationSeconds, 30);
  assert.equal(after.voiceClone.voiceId, "voice-new");
  assert.equal(previousVoice.every((byte) => byte === 0), true);
});

test("sampling registration rejects MIME spoofing and long voice samples", () => {
  const store = createGuardianSamplingStore();
  assert.throws(
    () => store.register(validRegistration({ photoBase64: wav.toString("base64") })),
    (error) => error.code === "PHOTO_CONTENT_INVALID",
  );
  assert.throws(
    () => store.register(validRegistration({ voiceDurationSeconds: 31 })),
    (error) => error.code === "VOICE_DURATION_INVALID",
  );
  assert.throws(
    () => store.register(validRegistration({ voiceDurationSeconds: undefined })),
    (error) => error.code === "VOICE_DURATION_INVALID",
  );
  assert.equal(store.status().configured, false);
});

test("failed replacement preserves the active sample", () => {
  let sequence = 0;
  const store = createGuardianSamplingStore({ idFactory: () => `id-${sequence += 1}` });
  const first = store.register(validRegistration());
  assert.throws(() => store.register(validRegistration({ voiceType: "audio/x-unknown" })));
  assert.equal(store.status().consentId, first.consentId);
  assert.ok(store.resolve(first.consentId, first.avatarAssetId));
});

test("delete zeroes retained media and invalidates capability URLs", () => {
  const store = createGuardianSamplingStore();
  const status = store.register(validRegistration());
  const internal = store.resolve(status.consentId, status.avatarAssetId);
  const photoToken = decodeURIComponent(status.posterUrl.split("/").at(-1));
  const voiceToken = decodeURIComponent(status.voicePreviewUrl.split("/").at(-1));
  assert.ok(store.readPhoto(photoToken));
  assert.ok(store.readVoice(voiceToken));

  const removed = store.delete();
  assert.equal(removed.deleted, true);
  assert.equal(internal.photo.bytes.every((byte) => byte === 0), true);
  assert.equal(internal.voice.bytes.every((byte) => byte === 0), true);
  assert.equal(store.readPhoto(photoToken), null);
  assert.equal(store.readVoice(voiceToken), null);
  assert.equal(store.resolve(status.consentId, status.avatarAssetId), null);
});
