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
    const savedA = first.register(profileA, registration("Aのおうちの人"));
    first.register(profileB, registration("Bのおうちの人"));

    const encryptedSource = readFileSync(join(directory, `${profileA}.sample`), "utf8");
    assert.doesNotMatch(encryptedSource, /Aのおうちの人/);
    assert.doesNotMatch(encryptedSource, new RegExp(png.toString("base64")));

    const restarted = createPersistentGuardianSamplingStore({ directory, encryptionKey });
    assert.equal(restarted.status(profileA).subjectLabel, "Aのおうちの人");
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
