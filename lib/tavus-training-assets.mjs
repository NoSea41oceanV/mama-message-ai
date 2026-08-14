import { randomUUID } from "node:crypto";

const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const PRIVATE_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

function validPublicBaseUrl(value) {
  try {
    const parsed = new URL(String(value ?? ""));
    if (parsed.protocol !== "https:" || PRIVATE_HOSTS.has(parsed.hostname.toLowerCase())) return null;
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function createTavusTrainingAssetStore(options = {}) {
  const publicBaseUrl = validPublicBaseUrl(options.publicBaseUrl);
  const ttlMs = Math.max(60_000, Number(options.ttlMs) || 30 * 60 * 1000);
  const maximumBytes = Math.max(1, Number(options.maximumBytes) || 8 * 1024 * 1024);
  const idFactory = options.idFactory ?? randomUUID;
  const now = options.now ?? Date.now;
  const assets = new Map();

  function purge() {
    const timestamp = now();
    for (const [assetId, asset] of assets) {
      if (asset.expiresAt <= timestamp) {
        asset.bytes.fill(0);
        assets.delete(assetId);
      }
    }
  }

  async function publish({ imageBase64, mimeType } = {}) {
    purge();
    if (!publicBaseUrl) throw Object.assign(new Error("TAVUS_PUBLIC_URL_REQUIRED"), { code: "TAVUS_PUBLIC_URL_REQUIRED", statusCode: 400 });
    const type = String(mimeType ?? "").split(";", 1)[0].trim().toLowerCase();
    if (!ALLOWED_IMAGE_TYPES.has(type)) throw Object.assign(new Error("TAVUS_IMAGE_TYPE_UNSUPPORTED"), { code: "TAVUS_IMAGE_TYPE_UNSUPPORTED", statusCode: 400 });
    const bytes = Buffer.from(String(imageBase64 ?? ""), "base64");
    if (!bytes.length || bytes.length > maximumBytes) {
      bytes.fill(0);
      throw Object.assign(new Error("TAVUS_IMAGE_SIZE_INVALID"), { code: "TAVUS_IMAGE_SIZE_INVALID", statusCode: 400 });
    }
    const assetId = idFactory();
    assets.set(assetId, { bytes, mimeType: type, expiresAt: now() + ttlMs });
    return Object.freeze({
      assetId,
      url: `${publicBaseUrl}/api/tavus/training-assets/${encodeURIComponent(assetId)}`,
    });
  }

  function read(assetId) {
    purge();
    const asset = assets.get(String(assetId ?? ""));
    return asset ? { bytes: asset.bytes, mimeType: asset.mimeType } : null;
  }

  async function deleteAsset(assetId) {
    const key = String(assetId ?? "");
    const asset = assets.get(key);
    if (!asset) return false;
    asset.bytes.fill(0);
    assets.delete(key);
    return true;
  }

  return Object.freeze({
    configured: Boolean(publicBaseUrl),
    publicBaseUrl,
    publish,
    read,
    deleteAsset,
    purge,
  });
}
