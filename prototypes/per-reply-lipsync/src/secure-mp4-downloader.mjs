import { PrototypeError } from "./errors.mjs";

function positiveNumber(value, fallback) {
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized > 0 ? normalized : fallback;
}

function normalizeAllowedHost(value) {
  const host = String(value ?? "").trim().toLowerCase();
  const dnsName = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  if (!dnsName.test(host)) {
    throw new PrototypeError("MP4_ALLOWED_HOST_INVALID", "MP4 allowlist entries must be exact DNS hostnames");
  }
  return host;
}

function validatedDownloadUrl(value, allowedHosts) {
  let url;
  try {
    url = new URL(String(value ?? ""));
  } catch {
    throw new PrototypeError("MP4_URL_INVALID", "MP4 URL is invalid");
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || (url.port && url.port !== "443")
    || !allowedHosts.has(url.hostname.toLowerCase())
  ) {
    throw new PrototypeError("MP4_URL_NOT_ALLOWED", "MP4 URL is not an allowed HTTPS origin");
  }
  return url.toString();
}

async function readBoundedBody(response, maxBytes) {
  if (!response.body || typeof response.body.getReader !== "function") {
    throw new PrototypeError("MP4_BODY_UNREADABLE", "MP4 response body is not stream-readable");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new PrototypeError("MP4_BODY_TOO_LARGE", "MP4 body exceeds the configured byte limit");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  if (byteLength === 0) {
    throw new PrototypeError("MP4_BODY_EMPTY", "MP4 response body is empty");
  }
  return Buffer.concat(chunks, byteLength);
}

export function createSecureMp4Downloader(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = positiveNumber(options.timeoutMs, 30_000);
  const maxBytes = positiveNumber(options.maxBytes, 25 * 1024 * 1024);
  if (!Array.isArray(options.allowedHosts)) {
    throw new PrototypeError("MP4_ALLOWED_HOSTS_REQUIRED", "exact MP4 host allowlist is required");
  }
  const allowedHosts = new Set(options.allowedHosts.map(normalizeAllowedHost));

  if (typeof fetchImpl !== "function") {
    throw new PrototypeError("MP4_FETCH_REQUIRED", "fetch implementation is required");
  }
  if (allowedHosts.size === 0) {
    throw new PrototypeError("MP4_ALLOWED_HOSTS_REQUIRED", "at least one exact MP4 host is required");
  }

  async function download(sourceUrl, { signal } = {}) {
    const url = validatedDownloadUrl(sourceUrl, allowedHosts);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const abortFromParent = () => controller.abort();
    signal?.addEventListener("abort", abortFromParent, { once: true });
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        redirect: "error",
        headers: { accept: "video/mp4" },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new PrototypeError(
          "MP4_DOWNLOAD_HTTP_ERROR",
          `MP4 download returned HTTP ${response.status}`,
          { status: response.status },
        );
      }
      const contentType = String(response.headers?.get?.("content-type") ?? "")
        .split(";", 1)[0]
        .trim()
        .toLowerCase();
      if (contentType !== "video/mp4") {
        throw new PrototypeError("MP4_CONTENT_TYPE_INVALID", "MP4 response must use video/mp4");
      }
      const rawLength = String(response.headers?.get?.("content-length") ?? "").trim();
      if (!/^\d+$/.test(rawLength)) {
        throw new PrototypeError("MP4_CONTENT_LENGTH_INVALID", "MP4 response requires a valid Content-Length");
      }
      const declaredLength = Number(rawLength);
      if (!Number.isSafeInteger(declaredLength) || declaredLength <= 0 || declaredLength > maxBytes) {
        throw new PrototypeError("MP4_CONTENT_LENGTH_REJECTED", "MP4 Content-Length exceeds the allowed range");
      }
      const bytes = await readBoundedBody(response, maxBytes);
      if (bytes.byteLength !== declaredLength) {
        throw new PrototypeError("MP4_CONTENT_LENGTH_MISMATCH", "MP4 byte length does not match Content-Length");
      }
      return Object.freeze({ bytes, contentType, byteLength: bytes.byteLength });
    } catch (error) {
      if (error instanceof PrototypeError) throw error;
      if (controller.signal.aborted) {
        const code = signal?.aborted ? "MP4_DOWNLOAD_ABORTED" : "MP4_DOWNLOAD_TIMEOUT";
        throw new PrototypeError(code, "MP4 download did not complete", { cause: error });
      }
      throw new PrototypeError("MP4_DOWNLOAD_NETWORK_ERROR", "MP4 download failed", { cause: error });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromParent);
    }
  }

  return Object.freeze({ download });
}
