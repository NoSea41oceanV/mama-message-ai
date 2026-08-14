import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createEncryptedVideoStore } from "../src/encrypted-video-store.mjs";
import { createSecureMp4Downloader } from "../src/secure-mp4-downloader.mjs";
import { createSecureVideoAssetService } from "../src/secure-video-asset-service.mjs";

const pendingTests = [];
const trackedTest = (name, implementation) => {
  const pending = test(name, implementation);
  pendingTests.push(pending);
  return pending;
};

function mp4Response(bytes, {
  contentType = "video/mp4",
  contentLength = bytes.byteLength,
  status = 200,
} = {}) {
  return new Response(bytes, {
    status,
    headers: {
      "content-type": contentType,
      "content-length": String(contentLength),
    },
  });
}

trackedTest("encrypted store roundtrips with bound AAD and never writes plaintext MP4", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lipsync-secure-store-"));
  const plaintext = Buffer.from("....ftypPLAINTEXT-MP4-SECRET....", "utf8");
  try {
    const store = createEncryptedVideoStore({
      storageDir: directory,
      encryptionKey: randomBytes(32),
      now: () => new Date("2026-08-14T01:02:03.000Z"),
    });
    const saved = await store.saveEncrypted({
      bytes: plaintext,
      profileId: "profile-001",
      jobKey: "job-001",
      contentType: "video/mp4",
    });

    const files = await readdir(directory);
    assert.deepEqual(files, [`${saved.assetId}.lsev`]);
    assert.equal(files.some((name) => name.endsWith(".mp4") || name.endsWith(".tmp")), false);
    const encryptedBytes = await readFile(join(directory, files[0]));
    assert.equal(encryptedBytes.includes(Buffer.from("PLAINTEXT-MP4-SECRET")), false);
    assert.notDeepEqual(encryptedBytes, plaintext);

    const roundtrip = await store.readDecrypted({
      assetId: saved.assetId,
      profileId: "profile-001",
      jobKey: "job-001",
      contentType: "video/mp4",
    });
    assert.deepEqual(roundtrip.bytes, plaintext);
    assert.equal(saved.encryptedAtRest, true);
    assert.equal(saved.encryptedAt, "2026-08-14T01:02:03.000Z");

    await assert.rejects(
      store.readDecrypted({
        assetId: saved.assetId,
        profileId: "different-profile",
        jobKey: "job-001",
        contentType: "video/mp4",
      }),
      (error) => error.code === "ASSET_DECRYPT_FAILED",
    );
    if (platform() !== "win32") {
      const fileStat = await stat(join(directory, files[0]));
      assert.equal(fileStat.mode & 0o777, 0o600);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

trackedTest("encrypted store requires an explicitly injected 32-byte key", () => {
  assert.throws(
    () => createEncryptedVideoStore({ storageDir: "unused", encryptionKey: new Uint8Array(31) }),
    (error) => error.code === "ASSET_KEY_INVALID",
  );
  assert.throws(
    () => createEncryptedVideoStore({ storageDir: "unused" }),
    (error) => error.code === "ASSET_KEY_INVALID",
  );
});

trackedTest("secure downloader accepts only exact allowed HTTPS host and requests no redirects", async () => {
  const bytes = Uint8Array.from([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70]);
  let captured;
  const downloader = createSecureMp4Downloader({
    allowedHosts: ["cdn.example.test"],
    maxBytes: 64,
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return mp4Response(bytes);
    },
  });

  const downloaded = await downloader.download("https://cdn.example.test/video.mp4?signature=mock");

  assert.deepEqual(downloaded.bytes, Buffer.from(bytes));
  assert.equal(downloaded.contentType, "video/mp4");
  assert.equal(captured.init.redirect, "error");
  assert.equal(captured.init.headers.accept, "video/mp4");
});

trackedTest("secure downloader rejects non-allowlisted hosts before fetch", async () => {
  let fetchCalls = 0;
  const downloader = createSecureMp4Downloader({
    allowedHosts: ["cdn.example.test"],
    fetchImpl: async () => {
      fetchCalls += 1;
      return mp4Response(Uint8Array.from([1]));
    },
  });

  await assert.rejects(
    downloader.download("https://evil.example.test/video.mp4"),
    (error) => error.code === "MP4_URL_NOT_ALLOWED",
  );
  await assert.rejects(
    downloader.download("http://cdn.example.test/video.mp4"),
    (error) => error.code === "MP4_URL_NOT_ALLOWED",
  );
  assert.equal(fetchCalls, 0);
});

trackedTest("secure downloader rejects wrong MIME and invalid or oversized Content-Length", async () => {
  const wrongMime = createSecureMp4Downloader({
    allowedHosts: ["cdn.example.test"],
    maxBytes: 8,
    fetchImpl: async () => mp4Response(Uint8Array.from([1, 2]), { contentType: "text/html" }),
  });
  await assert.rejects(
    wrongMime.download("https://cdn.example.test/video.mp4"),
    (error) => error.code === "MP4_CONTENT_TYPE_INVALID",
  );

  const oversized = createSecureMp4Downloader({
    allowedHosts: ["cdn.example.test"],
    maxBytes: 8,
    fetchImpl: async () => mp4Response(Uint8Array.from([1]), { contentLength: 9 }),
  });
  await assert.rejects(
    oversized.download("https://cdn.example.test/video.mp4"),
    (error) => error.code === "MP4_CONTENT_LENGTH_REJECTED",
  );

  const missingLength = createSecureMp4Downloader({
    allowedHosts: ["cdn.example.test"],
    fetchImpl: async () => new Response(Uint8Array.from([1]), {
      status: 200,
      headers: { "content-type": "video/mp4" },
    }),
  });
  await assert.rejects(
    missingLength.download("https://cdn.example.test/video.mp4"),
    (error) => error.code === "MP4_CONTENT_LENGTH_INVALID",
  );
});

trackedTest("secure downloader enforces actual byte limit and exact declared length", async () => {
  const actualTooLarge = createSecureMp4Downloader({
    allowedHosts: ["cdn.example.test"],
    maxBytes: 4,
    fetchImpl: async () => mp4Response(
      Uint8Array.from([1, 2, 3, 4, 5]),
      { contentLength: 4 },
    ),
  });
  await assert.rejects(
    actualTooLarge.download("https://cdn.example.test/video.mp4"),
    (error) => error.code === "MP4_BODY_TOO_LARGE",
  );

  const mismatch = createSecureMp4Downloader({
    allowedHosts: ["cdn.example.test"],
    maxBytes: 8,
    fetchImpl: async () => mp4Response(Uint8Array.from([1, 2]), { contentLength: 3 }),
  });
  await assert.rejects(
    mismatch.download("https://cdn.example.test/video.mp4"),
    (error) => error.code === "MP4_CONTENT_LENGTH_MISMATCH",
  );
});

trackedTest("secure downloader converts an aborted mock fetch into timeout", async () => {
  const downloader = createSecureMp4Downloader({
    allowedHosts: ["cdn.example.test"],
    timeoutMs: 5,
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("mock abort")), { once: true });
    }),
  });
  await assert.rejects(
    downloader.download("https://cdn.example.test/video.mp4"),
    (error) => error.code === "MP4_DOWNLOAD_TIMEOUT",
  );
});

trackedTest("secure video asset service binds downloaded bytes to profile and job context", async () => {
  const bytes = Uint8Array.from([1, 2, 3, 4]);
  let storedInput;
  const service = createSecureVideoAssetService({
    downloader: {
      async download(sourceUrl) {
        assert.equal(sourceUrl, "https://cdn.example.test/video.mp4");
        return { bytes, contentType: "video/mp4", byteLength: bytes.byteLength };
      },
    },
    encryptedStore: {
      async saveEncrypted(input) {
        storedInput = input;
        return {
          assetId: "00112233445566778899aabbccddeeff",
          encryptedAt: "2026-08-14T01:02:03.000Z",
          encryptedAtRest: true,
          contentType: "video/mp4",
        };
      },
    },
  });
  const result = await service.ingest({
    sourceUrl: "https://cdn.example.test/video.mp4",
    profileId: "profile-001",
    jobKey: "job-001",
  });

  assert.deepEqual(storedInput, {
    bytes,
    profileId: "profile-001",
    jobKey: "job-001",
    contentType: "video/mp4",
  });
  assert.equal(
    result.assetRef,
    "/api/lipsync/assets/00112233445566778899aabbccddeeff",
  );
});

export const completion = Promise.all(pendingTests);
export const testCount = pendingTests.length;
