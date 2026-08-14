const DEFAULT_PROMPT = [
  "A warm, caring adult looks into the camera and speaks a short, reassuring message naturally.",
  "Preserve the person's identity and facial features from the reference photo.",
  "Use only subtle, natural facial expression, lip, and small head movements.",
  "Keep the camera completely stationary and the original composition stable.",
  "Show exactly one person, with no added people, captions, text, logos, or watermarks.",
].join(" ");

const QUEUED_STATUSES = new Set(["queued", "pending", "submitted", "created", "waiting"]);
const PROCESSING_STATUSES = new Set(["processing", "running", "in_progress", "generating"]);
const READY_STATUSES = new Set(["ready", "succeeded", "success", "completed", "complete"]);
const FAILED_STATUSES = new Set(["failed", "failure", "error", "cancelled", "canceled"]);

export class KlingVideoProviderError extends Error {
  constructor(code, message, { status = null, providerCode = null, cause } = {}) {
    super(message, { cause });
    this.name = "KlingVideoProviderError";
    this.code = code;
    this.status = status;
    this.providerCode = providerCode;
  }
}

function cleanBaseUrl(value) {
  return String(value || "https://api.orcarouter.ai/v1").replace(/\/+$/, "");
}

function normalizedStatus(value) {
  const status = String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (QUEUED_STATUSES.has(status)) return "queued";
  if (PROCESSING_STATUSES.has(status)) return "processing";
  if (READY_STATUSES.has(status)) return "ready";
  if (FAILED_STATUSES.has(status)) return "failed";
  return "processing";
}

function taskIdFrom(payload) {
  return payload?.task_id ?? payload?.id ?? payload?.data?.task_id ?? payload?.data?.id ?? null;
}

function videoUrlFrom(payload) {
  const candidates = [
    payload?.video_url,
    payload?.url,
    payload?.output?.video_url,
    payload?.output?.url,
    payload?.result?.video_url,
    payload?.result?.url,
    payload?.result_url,
    payload?.data?.video_url,
    payload?.data?.url,
    payload?.data?.result_url,
    payload?.data?.output?.video_url,
    payload?.data?.output?.url,
    payload?.data?.task_result?.videos?.[0]?.url,
    payload?.task_result?.videos?.[0]?.url,
    payload?.videos?.[0]?.url,
  ];
  const value = candidates.find((candidate) => typeof candidate === "string" && candidate.trim());
  return value?.trim() ?? null;
}

function statusFrom(payload) {
  return normalizedStatus(
    payload?.status
      ?? payload?.task_status
      ?? payload?.data?.status
      ?? payload?.data?.task_status,
  );
}

function normalizedTask(payload, fallbackTaskId = null) {
  const videoUrl = videoUrlFrom(payload);
  const status = videoUrl ? "ready" : statusFrom(payload);
  return Object.freeze({
    taskId: String(taskIdFrom(payload) ?? fallbackTaskId ?? "").trim() || null,
    status,
    videoUrl,
  });
}

export function createKlingVideoProvider(options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const apiKey = String(options.apiKey ?? env.ORCAROUTER_API_KEY ?? "").trim();
  const baseUrl = cleanBaseUrl(options.baseUrl ?? env.ORCAROUTER_BASE_URL);
  const model = String(options.model ?? env.KLING_VIDEO_MODEL ?? "kling/kling-v3").trim();
  const mode = String(options.mode ?? env.KLING_VIDEO_MODE ?? "std").trim().toLowerCase();
  const duration = Number(options.duration ?? env.KLING_VIDEO_DURATION_SECONDS ?? 5);
  const providerMode = String(
    options.providerMode ?? env.VIDEO_GENERATION_PROVIDER ?? "disabled",
  ).trim().toLowerCase();
  const configuredTimeoutMs = Number(options.timeoutMs ?? (Number(env.KLING_VIDEO_REQUEST_TIMEOUT_SECONDS || 30) * 1000));
  const timeoutMs = Number.isFinite(configuredTimeoutMs) ? Math.max(1, configuredTimeoutMs) : 30_000;
  const prompt = String(options.prompt ?? DEFAULT_PROMPT).trim();
  let baseUrlIsHttps = false;
  try {
    baseUrlIsHttps = new URL(baseUrl).protocol === "https:";
  } catch {}
  const available = providerMode === "kling" && Boolean(apiKey) && baseUrlIsHttps;

  async function request(path, init = {}) {
    if (providerMode === "kling" && apiKey && !baseUrlIsHttps) {
      throw new KlingVideoProviderError(
        "KLING_VIDEO_BASE_URL_INSECURE",
        "Kling video provider base URL must use HTTPS",
      );
    }
    if (!available) {
      throw new KlingVideoProviderError(
        "KLING_VIDEO_NOT_CONFIGURED",
        "Kling video generation is not configured",
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        ...init,
        redirect: "error",
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: "application/json",
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        let providerCode = null;
        try {
          const payload = await response.json();
          const candidate = String(payload?.error?.code ?? payload?.code ?? "").trim();
          if (/^[a-z0-9_.:-]{1,80}$/i.test(candidate)) providerCode = candidate;
        } catch {}
        throw new KlingVideoProviderError(
          "KLING_VIDEO_HTTP_ERROR",
          `Kling video provider returned HTTP ${response.status}`,
          { status: response.status, providerCode },
        );
      }
      try {
        return await response.json();
      } catch (error) {
        throw new KlingVideoProviderError(
          "KLING_VIDEO_INVALID_RESPONSE",
          "Kling video provider returned invalid JSON",
          { cause: error },
        );
      }
    } catch (error) {
      if (error instanceof KlingVideoProviderError) throw error;
      if (controller.signal.aborted) {
        throw new KlingVideoProviderError("KLING_VIDEO_TIMEOUT", "Kling video provider timed out", { cause: error });
      }
      throw new KlingVideoProviderError("KLING_VIDEO_NETWORK_ERROR", "Kling video provider request failed", { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }

  async function createTask({ imageBase64 } = {}) {
    const rawImage = String(imageBase64 ?? "").trim();
    if (!rawImage || rawImage.startsWith("data:")) {
      throw new KlingVideoProviderError(
        "KLING_VIDEO_IMAGE_INVALID",
        "Kling video generation requires raw base64 image data",
      );
    }
    const normalizedDuration = Number.isFinite(duration) ? Math.max(3, Math.min(15, Math.round(duration))) : 5;
    const payload = await request("/video/generations", {
      method: "POST",
      body: JSON.stringify({
        model,
        prompt,
        image: rawImage,
        metadata: {
          mode: mode === "pro" ? "pro" : "std",
          duration: String(normalizedDuration),
          sound: "off",
        },
      }),
    });
    const task = normalizedTask(payload);
    if (!task.taskId) {
      throw new KlingVideoProviderError("KLING_VIDEO_INVALID_RESPONSE", "Kling video response did not include a task ID");
    }
    return task;
  }

  async function getTask(taskId) {
    const normalizedTaskId = String(taskId ?? "").trim();
    if (!normalizedTaskId) {
      throw new KlingVideoProviderError("KLING_VIDEO_TASK_ID_REQUIRED", "Kling video task ID is required");
    }
    const payload = await request(`/video/generations/${encodeURIComponent(normalizedTaskId)}`, {
      method: "GET",
    });
    return normalizedTask(payload, normalizedTaskId);
  }

  return Object.freeze({
    name: "orcarouter-kling",
    available,
    model,
    mode: mode === "pro" ? "pro" : "std",
    duration: Number.isFinite(duration) ? Math.max(3, Math.min(15, Math.round(duration))) : 5,
    sound: "off",
    createTask,
    getTask,
  });
}

export const KLING_GUARDIAN_VIDEO_PROMPT = DEFAULT_PROMPT;
