const DEFAULT_BASE_URL = "https://tavusapi.com";

export class TavusProviderError extends Error {
  constructor(code, message, { status = null, providerCode = null } = {}) {
    super(message);
    this.name = "TavusProviderError";
    this.code = code;
    this.status = status;
    this.statusCode = status === 401 ? 401 : status === 429 ? 429 : status && status < 500 ? 400 : 502;
    this.providerCode = providerCode;
  }
}

function cleanBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
}

function boundedTimeoutMs(value, fallback = 20_000) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1_000, Math.min(120_000, Math.round(parsed)));
}

function boundedSeconds(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(parsed)));
}

function validProviderCode(value) {
  const candidate = String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g, "_").slice(0, 80);
  return candidate || null;
}

function secureUrl(value) {
  try {
    const parsed = new URL(String(value ?? ""));
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function mapFaceStatus(value) {
  const status = String(value ?? "").trim().toLowerCase();
  if (["completed", "complete", "ready", "success", "succeeded"].includes(status)) return "ready";
  if (["error", "failed", "failure", "cancelled", "canceled"].includes(status)) return "failed";
  if (["started", "queued", "pending"].includes(status)) return "queued";
  return "processing";
}

export function createTavusProvider(options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const publishImage = options.publishImage ?? null;
  const deletePublishedImage = options.deletePublishedImage ?? null;
  const apiKey = String(options.apiKey ?? env.TAVUS_API_KEY ?? "").trim();
  const baseUrl = cleanBaseUrl(options.baseUrl ?? env.TAVUS_BASE_URL);
  const palId = String(options.palId ?? env.TAVUS_PAL_ID ?? "").trim();
  const fallbackFaceId = String(options.faceId ?? env.TAVUS_FACE_ID ?? "").trim();
  const voiceName = String(options.voiceName ?? env.TAVUS_TRAINING_VOICE_NAME ?? "anna").trim() || "anna";
  const requestTimeoutMs = boundedTimeoutMs(
    options.timeoutMs ?? (Number(env.TAVUS_REQUEST_TIMEOUT_SECONDS || 20) * 1000),
  );
  const maxCallDurationSeconds = boundedSeconds(
    options.maxCallDurationSeconds ?? env.TAVUS_MAX_CALL_DURATION_SECONDS,
    300,
    60,
    3600,
  );
  const secureBaseUrl = Boolean(secureUrl(baseUrl));
  const streamingAvailable = Boolean(apiKey && secureBaseUrl && palId && fallbackFaceId);
  const faceCreationAvailable = Boolean(apiKey && secureBaseUrl && publishImage);

  async function request(path, init = {}) {
    if (!apiKey || !secureBaseUrl) {
      throw new TavusProviderError("TAVUS_NOT_CONFIGURED", "Tavus is not configured");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    timer.unref?.();
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        ...init,
        redirect: "error",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-api-key": apiKey,
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });
      let payload = {};
      try {
        payload = await response.json();
      } catch {}
      if (!response.ok) {
        throw new TavusProviderError("TAVUS_HTTP_ERROR", `Tavus returned HTTP ${response.status}`, {
          status: response.status,
          providerCode: validProviderCode(payload?.error_code ?? payload?.code),
        });
      }
      return payload;
    } catch (error) {
      if (error instanceof TavusProviderError) throw error;
      if (controller.signal.aborted) throw new TavusProviderError("TAVUS_TIMEOUT", "Tavus request timed out");
      throw new TavusProviderError("TAVUS_NETWORK_ERROR", "Tavus request failed");
    } finally {
      clearTimeout(timer);
    }
  }

  async function createConversation({ faceId = fallbackFaceId, testMode = false } = {}) {
    if (!streamingAvailable || !faceId) {
      throw new TavusProviderError("TAVUS_STREAMING_NOT_CONFIGURED", "Tavus streaming is not configured");
    }
    const payload = await request("/v2/conversations", {
      method: "POST",
      body: JSON.stringify({
        face_id: faceId,
        pal_id: palId,
        conversation_name: "Mama Message",
        audio_only: false,
        require_auth: true,
        max_participants: 2,
        properties: {
          max_call_duration: maxCallDurationSeconds,
          participant_left_timeout: 5,
          participant_absent_timeout: 30,
        },
        ...(testMode ? { test_mode: true } : {}),
      }),
    });
    const conversationId = String(payload.conversation_id ?? "").trim();
    const conversationUrl = secureUrl(payload.conversation_url);
    const meetingToken = String(payload.meeting_token ?? "").trim();
    if (!conversationId || (!testMode && (!conversationUrl || !meetingToken))) {
      throw new TavusProviderError("TAVUS_CONVERSATION_INVALID", "Tavus returned an incomplete conversation");
    }
    return Object.freeze({
      conversationId,
      conversationUrl,
      meetingToken,
      status: String(payload.status ?? "active"),
    });
  }

  async function endConversation(conversationId) {
    const id = encodeURIComponent(String(conversationId ?? "").trim());
    if (!id) return false;
    await request(`/v2/conversations/${id}/end`, { method: "POST", body: "{}" });
    return true;
  }

  async function createTask({ imageBase64, mimeType, idempotencyKey } = {}) {
    if (!faceCreationAvailable) {
      throw new TavusProviderError("TAVUS_PUBLIC_URL_REQUIRED", "A public HTTPS URL is required for Tavus face training");
    }
    let published;
    try {
      published = await publishImage({ imageBase64, mimeType });
      const payload = await request("/v2/faces", {
        method: "POST",
        body: JSON.stringify({
          face_name: `Mama Message ${String(idempotencyKey ?? "face").slice(-24)}`,
          train_image_url: published.url,
          voice_name: voiceName,
          auto_fix_training_image: true,
          model_name: "phoenix-4",
        }),
      });
      const taskId = String(payload.face_id ?? "").trim();
      if (!taskId) throw new TavusProviderError("TAVUS_FACE_ID_MISSING", "Tavus did not return a face ID");
      return Object.freeze({
        taskId,
        providerAssetId: published.assetId,
        status: mapFaceStatus(payload.status),
      });
    } catch (error) {
      if (published?.assetId && deletePublishedImage) await deletePublishedImage(published.assetId).catch(() => {});
      throw error;
    }
  }

  async function getTask(taskId) {
    const id = encodeURIComponent(String(taskId ?? "").trim());
    const payload = await request(`/v2/faces/${id}`, { method: "GET" });
    const status = mapFaceStatus(payload.status);
    return Object.freeze({
      taskId: String(payload.face_id ?? taskId),
      status,
      videoUrl: null,
      prepared: status === "ready",
      cleanupProviderAsset: status === "ready",
    });
  }

  async function deleteTask(taskId) {
    const id = encodeURIComponent(String(taskId ?? "").trim());
    if (!id) return false;
    await request(`/v2/faces/${id}`, { method: "DELETE" });
    return true;
  }

  async function deleteAsset(assetId) {
    if (!assetId || !deletePublishedImage) return false;
    return deletePublishedImage(assetId);
  }

  function status() {
    return Object.freeze({
      available: streamingAvailable,
      configured: streamingAvailable,
      streamingAvailable,
      faceCreationAvailable,
      palConfigured: Boolean(palId),
      fallbackFaceConfigured: Boolean(fallbackFaceId),
      status: streamingAvailable ? "ready" : "unavailable",
    });
  }

  return Object.freeze({
    name: "tavus",
    available: faceCreationAvailable,
    streamingAvailable,
    faceCreationAvailable,
    fallbackFaceId,
    createConversation,
    endConversation,
    createTask,
    getTask,
    deleteTask,
    deleteAsset,
    status,
  });
}
