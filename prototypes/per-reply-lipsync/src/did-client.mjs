import { PrototypeError } from "./errors.mjs";

const DID_STATUS = Object.freeze({
  created: "processing",
  started: "processing",
  processing: "processing",
  done: "ready",
  completed: "ready",
  error: "failed",
  failed: "failed",
  rejected: "failed",
});

function authorizationFor(apiKey) {
  const value = String(apiKey ?? "").trim();
  if (/^Basic\s+/i.test(value)) return value;
  return `Basic ${Buffer.from(value, "utf8").toString("base64")}`;
}

function cleanHttpsBaseUrl(value) {
  const url = new URL(String(value ?? "https://api.d-id.com").replace(/\/+$/, ""));
  if (url.protocol !== "https:") {
    throw new PrototypeError("DID_INSECURE_BASE_URL", "D-ID base URL must use HTTPS");
  }
  return url.toString().replace(/\/$/, "");
}

function externalMediaUrl(value, code, message) {
  try {
    const url = new URL(String(value ?? ""));
    if (!["https:", "s3:"].includes(url.protocol)) throw new Error("unsupported protocol");
    return url.toString();
  } catch {
    throw new PrototypeError(code, message);
  }
}

function normalizedTalk(payload, fallbackTalkId = null) {
  const talkId = String(payload?.id ?? fallbackTalkId ?? "").trim() || null;
  const resultUrl = typeof payload?.result_url === "string" && payload.result_url.trim()
    ? externalMediaUrl(payload.result_url, "DID_RESULT_URL_INVALID", "D-ID returned an invalid result URL")
    : null;
  const providerStatus = String(payload?.status ?? "").trim().toLowerCase();
  return Object.freeze({
    talkId,
    providerStatus,
    status: resultUrl ? "ready" : (DID_STATUS[providerStatus] ?? "processing"),
    videoUrl: resultUrl,
  });
}

function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const abort = () => {
      clearTimeout(timer);
      reject(new PrototypeError("DID_POLL_ABORTED", "D-ID polling was aborted"));
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function positiveNumber(value, fallback, { allowZero = false } = {}) {
  const normalized = Number(value);
  const valid = Number.isFinite(normalized) && (allowZero ? normalized >= 0 : normalized > 0);
  return valid ? normalized : fallback;
}

export function createDidClient(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const apiKey = String(options.apiKey ?? "").trim();
  const baseUrl = cleanHttpsBaseUrl(options.baseUrl);
  const requestTimeoutMs = positiveNumber(options.requestTimeoutMs, 30_000);
  const defaultPollTimeoutMs = positiveNumber(options.pollTimeoutMs, 90_000);
  const defaultPollIntervalMs = positiveNumber(
    options.pollIntervalMs,
    1_500,
    { allowZero: true },
  );
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;

  if (typeof fetchImpl !== "function") {
    throw new PrototypeError("DID_FETCH_REQUIRED", "fetch implementation is required");
  }

  async function request(path, init = {}, { allowStatuses = [] } = {}) {
    if (!apiKey) throw new PrototypeError("DID_NOT_CONFIGURED", "D-ID is not configured");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    const parentSignal = init.signal;
    const abortFromParent = () => controller.abort();
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        ...init,
        redirect: "error",
        headers: {
          authorization: authorizationFor(apiKey),
          accept: "application/json",
          ...init.headers,
        },
        signal: controller.signal,
      });
      if (!response.ok && !allowStatuses.includes(response.status)) {
        throw new PrototypeError(
          "DID_HTTP_ERROR",
          `D-ID returned HTTP ${response.status}`,
          { status: response.status },
        );
      }
      return response;
    } catch (error) {
      if (error instanceof PrototypeError) throw error;
      if (controller.signal.aborted) {
        const code = parentSignal?.aborted ? "DID_REQUEST_ABORTED" : "DID_REQUEST_TIMEOUT";
        throw new PrototypeError(code, "D-ID request did not complete", { cause: error });
      }
      throw new PrototypeError("DID_NETWORK_ERROR", "D-ID request failed", { cause: error });
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abortFromParent);
    }
  }

  async function requestJson(path, init) {
    const response = await request(path, init);
    try {
      return await response.json();
    } catch (error) {
      throw new PrototypeError("DID_INVALID_RESPONSE", "D-ID returned invalid JSON", { cause: error });
    }
  }

  async function uploadAudio({
    bytes,
    contentType = "audio/mpeg",
    filename = "reply.mp3",
    signal,
  } = {}) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > 6 * 1024 * 1024) {
      throw new PrototypeError("DID_AUDIO_INVALID", "D-ID audio must be non-empty and no larger than 6 MB");
    }
    if (!/^audio\//i.test(contentType) || !/^[A-Za-z0-9._-]{1,50}$/.test(filename)) {
      throw new PrototypeError("DID_AUDIO_METADATA_INVALID", "D-ID audio metadata is invalid");
    }
    const form = new FormData();
    form.append("audio", new Blob([bytes], { type: contentType }), filename);
    const payload = await requestJson("/audios", { method: "POST", body: form, signal });
    const id = String(payload?.id ?? payload?.audio_id ?? "").trim();
    const urlCandidate = payload?.url ?? payload?.audio_url ?? payload?.source_url;
    const audioUrl = externalMediaUrl(
      urlCandidate,
      "DID_AUDIO_URL_MISSING",
      "D-ID audio upload did not return a supported URL",
    );
    if (!id) throw new PrototypeError("DID_AUDIO_ID_MISSING", "D-ID audio upload did not return an ID");
    return Object.freeze({ id, audioUrl });
  }

  async function createTalk({ sourceImageUrl, audioUrl, name, config, signal } = {}) {
    const sourceUrl = externalMediaUrl(
      sourceImageUrl,
      "DID_SOURCE_URL_INVALID",
      "D-ID source image URL must use HTTPS or S3",
    );
    const normalizedAudioUrl = externalMediaUrl(
      audioUrl,
      "DID_AUDIO_URL_INVALID",
      "D-ID audio URL must use HTTPS or S3",
    );
    const body = {
      source_url: sourceUrl,
      script: {
        type: "audio",
        audio_url: normalizedAudioUrl,
      },
    };
    if (name) body.name = String(name).slice(0, 100);
    if (config) body.config = config;
    const payload = await requestJson("/talks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    const talk = normalizedTalk(payload);
    if (!talk.talkId) throw new PrototypeError("DID_TALK_ID_MISSING", "D-ID did not return a talk ID");
    return talk;
  }

  async function getTalk(talkId, { signal } = {}) {
    const normalizedId = String(talkId ?? "").trim();
    if (!normalizedId) throw new PrototypeError("DID_TALK_ID_REQUIRED", "D-ID talk ID is required");
    const payload = await requestJson(`/talks/${encodeURIComponent(normalizedId)}`, {
      method: "GET",
      signal,
    });
    return normalizedTalk(payload, normalizedId);
  }

  async function pollTalk(talkId, {
    timeoutMs = defaultPollTimeoutMs,
    intervalMs = defaultPollIntervalMs,
    signal,
  } = {}) {
    const normalizedTimeoutMs = positiveNumber(timeoutMs, defaultPollTimeoutMs);
    const normalizedIntervalMs = positiveNumber(
      intervalMs,
      defaultPollIntervalMs,
      { allowZero: true },
    );
    const startedAt = now();
    while (true) {
      if (signal?.aborted) throw new PrototypeError("DID_POLL_ABORTED", "D-ID polling was aborted");
      if (now() - startedAt >= normalizedTimeoutMs) {
        throw new PrototypeError("DID_POLL_TIMEOUT", "D-ID talk generation timed out");
      }
      const talk = await getTalk(talkId, { signal });
      if (talk.status === "ready") return talk;
      if (talk.status === "failed") {
        throw new PrototypeError("DID_TALK_FAILED", "D-ID talk generation failed");
      }
      await sleep(normalizedIntervalMs, signal);
    }
  }

  async function deleteAudio(audioId, { signal } = {}) {
    const normalizedId = String(audioId ?? "").trim();
    if (!normalizedId) throw new PrototypeError("DID_AUDIO_ID_REQUIRED", "D-ID audio ID is required");
    await request(`/audios/${encodeURIComponent(normalizedId)}`, {
      method: "DELETE",
      signal,
    }, { allowStatuses: [404] });
    return true;
  }

  async function deleteTalk(talkId, { signal } = {}) {
    const normalizedId = String(talkId ?? "").trim();
    if (!normalizedId) throw new PrototypeError("DID_TALK_ID_REQUIRED", "D-ID talk ID is required");
    await request(`/talks/${encodeURIComponent(normalizedId)}`, {
      method: "DELETE",
      signal,
    }, { allowStatuses: [404] });
    return true;
  }

  return Object.freeze({
    uploadAudio,
    createTalk,
    getTalk,
    pollTalk,
    deleteAudio,
    deleteTalk,
  });
}
