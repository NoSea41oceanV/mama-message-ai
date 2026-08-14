import { createCipheriv, createDecipheriv, randomBytes as cryptoRandomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, chmod } from "node:fs/promises";
import { resolve, join } from "node:path";
import { PrototypeError } from "./errors.mjs";

const MAGIC = Buffer.from("LSE1", "ascii");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ASSET_ID_PATTERN = /^[a-f0-9]{32}$/;

function requiredString(value, field) {
  const normalized = String(value ?? "");
  if (!normalized.trim()) throw new PrototypeError("ASSET_CONTEXT_INVALID", `${field} is required`);
  return normalized;
}

function encryptionKey(value) {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new PrototypeError("ASSET_KEY_INVALID", "AES-256-GCM key must be an explicitly injected 32-byte value");
  }
  return Buffer.from(value);
}

function aadFor({ profileId, jobKey, contentType }) {
  return Buffer.from(JSON.stringify([
    requiredString(profileId, "profileId"),
    requiredString(jobKey, "jobKey"),
    requiredString(contentType, "contentType"),
  ]), "utf8");
}

function assetPath(storageDir, assetId) {
  if (!ASSET_ID_PATTERN.test(String(assetId ?? ""))) {
    throw new PrototypeError("ASSET_ID_INVALID", "encrypted video asset ID is invalid");
  }
  return join(storageDir, `${assetId}.lsev`);
}

export function createEncryptedVideoStore(options = {}) {
  const key = encryptionKey(options.encryptionKey);
  const storageDir = resolve(requiredString(options.storageDir, "storageDir"));
  const randomBytes = cryptoRandomBytes;
  const now = options.now ?? (() => new Date());

  async function saveEncrypted({ bytes, profileId, jobKey, contentType = "video/mp4" } = {}) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
      throw new PrototypeError("ASSET_PLAINTEXT_INVALID", "non-empty MP4 bytes are required");
    }
    if (contentType !== "video/mp4") {
      throw new PrototypeError("ASSET_CONTENT_TYPE_INVALID", "encrypted video content type must be video/mp4");
    }
    const aad = aadFor({ profileId, jobKey, contentType });
    const assetId = Buffer.from(randomBytes(16)).toString("hex");
    if (!ASSET_ID_PATTERN.test(assetId)) {
      throw new PrototypeError("ASSET_RANDOM_INVALID", "random generator did not return 16 bytes");
    }
    const iv = Buffer.from(randomBytes(IV_BYTES));
    if (iv.byteLength !== IV_BYTES) {
      throw new PrototypeError("ASSET_RANDOM_INVALID", "random generator did not return a 12-byte IV");
    }
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const envelope = Buffer.concat([MAGIC, iv, authTag, ciphertext]);

    await mkdir(storageDir, { recursive: true, mode: 0o700 });
    const finalPath = assetPath(storageDir, assetId);
    const temporaryPath = join(storageDir, `.${assetId}.${Buffer.from(randomBytes(8)).toString("hex")}.tmp`);
    let handle;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(envelope);
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporaryPath, finalPath);
      await chmod(finalPath, 0o600);
    } catch (error) {
      await handle?.close().catch(() => {});
      await rm(temporaryPath, { force: true }).catch(() => {});
      if (error instanceof PrototypeError) throw error;
      throw new PrototypeError("ASSET_STORE_FAILED", "encrypted video asset could not be stored", { cause: error });
    }

    return Object.freeze({
      assetId,
      encryptedAt: now().toISOString(),
      encryptedAtRest: true,
      contentType,
      byteLength: bytes.byteLength,
    });
  }

  async function readDecrypted({ assetId, profileId, jobKey, contentType = "video/mp4" } = {}) {
    const aad = aadFor({ profileId, jobKey, contentType });
    let envelope;
    try {
      envelope = await readFile(assetPath(storageDir, assetId));
    } catch (error) {
      throw new PrototypeError("ASSET_READ_FAILED", "encrypted video asset could not be read", { cause: error });
    }
    if (
      envelope.byteLength <= MAGIC.byteLength + IV_BYTES + TAG_BYTES
      || !envelope.subarray(0, MAGIC.byteLength).equals(MAGIC)
    ) {
      throw new PrototypeError("ASSET_ENVELOPE_INVALID", "encrypted video asset envelope is invalid");
    }
    const ivStart = MAGIC.byteLength;
    const tagStart = ivStart + IV_BYTES;
    const ciphertextStart = tagStart + TAG_BYTES;
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        envelope.subarray(ivStart, tagStart),
      );
      decipher.setAAD(aad);
      decipher.setAuthTag(envelope.subarray(tagStart, ciphertextStart));
      const bytes = Buffer.concat([
        decipher.update(envelope.subarray(ciphertextStart)),
        decipher.final(),
      ]);
      return Object.freeze({ bytes, contentType });
    } catch (error) {
      throw new PrototypeError("ASSET_DECRYPT_FAILED", "encrypted video asset authentication failed", { cause: error });
    }
  }

  return Object.freeze({ saveEncrypted, readDecrypted });
}
