import { PrototypeError } from "./errors.mjs";

export function createSecureVideoAssetService({ downloader, encryptedStore } = {}) {
  if (typeof downloader?.download !== "function") {
    throw new PrototypeError("MP4_DOWNLOADER_REQUIRED", "a secure MP4 downloader is required");
  }
  if (typeof encryptedStore?.saveEncrypted !== "function") {
    throw new PrototypeError("ENCRYPTED_STORE_REQUIRED", "an encrypted video store is required");
  }

  async function ingest({ sourceUrl, profileId, jobKey, signal } = {}) {
    const downloaded = await downloader.download(sourceUrl, { signal });
    const stored = await encryptedStore.saveEncrypted({
      bytes: downloaded.bytes,
      profileId,
      jobKey,
      contentType: downloaded.contentType,
    });
    const assetRef = `/api/lipsync/assets/${encodeURIComponent(stored.assetId)}`;
    return Object.freeze({
      ...stored,
      assetRef,
    });
  }

  return Object.freeze({ ingest });
}
