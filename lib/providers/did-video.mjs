const DID_STATUS_MAP = Object.freeze({
  created: "queued",
  started: "processing",
  done: "ready",
  error: "failed",
});

export class DidVideoProviderError extends Error {
  constructor(code, message, { status = null, providerCode = null } = {}) {
    super(message);
    this.name = "DidVideoProviderError";
    this.code = code;
    this.status = status;
    this.providerCode = providerCode;
  }
}

function cleanBaseUrl(value) {
  return String(value || "https://api.d-id.com").replace(/\/+$/, "");
}

function authorizationFor(apiKey) {
  const value = String(apiKey || "").trim();
  if (/^Basic\s+/i.test(value)) return value;
  return `Basic ${Buffer.from(value, "utf8").toString("base64")}`;
}

function imageFromBase64(value) {
  const raw = String(value ?? "").trim();
  if (!raw || raw.startsWith("data:") || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    throw new DidVideoProviderError(
      "DID_VIDEO_IMAGE_INVALID",
      "D-ID video generation requires raw base64 JPEG or PNG image data",
    );
  }
  const bytes = Buffer.from(raw, "base64");
  const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng = bytes.length >= 8
    && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (!isJpeg && !isPng) {
    throw new DidVideoProviderError(
      "DID_VIDEO_IMAGE_INVALID",
      "D-ID video generation requires raw base64 JPEG or PNG image data",
    );
  }
  return {
    bytes,
    mimeType: isPng ? "image/png" : "image/jpeg",
    filename: isPng ? "guardian.png" : "guardian.jpg",
  };
}

function normalizedTask(payload, fallbackTaskId = null) {
  const taskId = String(payload?.id ?? payload?.task_id ?? fallbackTaskId ?? "").trim() || null;
  const providerStatus = String(payload?.status ?? "").trim().toLowerCase();
  const candidateUrl = typeof payload?.result_url === "string" ? payload.result_url.trim() : "";
  return Object.freeze({
    taskId,
    status: candidateUrl ? "ready" : (DID_STATUS_MAP[providerStatus] ?? "processing"),
    videoUrl: candidateUrl || null,
  });
}

function uploadedImageUrl(payload) {
  const candidates = [payload?.url, payload?.image_url, payload?.source_url];
  const value = candidates.find((candidate) => typeof candidate === "string" && candidate.trim());
  if (!value) return null;
  try {
    const parsed = new URL(value.trim());
    return ["https:", "s3:"].includes(parsed.protocol) ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export function createDidVideoProvider(options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const apiKey = String(options.apiKey ?? env.DID_API_KEY ?? "").trim();
  const baseUrl = cleanBaseUrl(options.baseUrl ?? env.DID_BASE_URL);
  const providerMode = String(
    options.providerMode ?? env.VIDEO_GENERATION_PROVIDER ?? "disabled",
  ).trim().toLowerCase();
  const timeoutSeconds = env.VIDEO_REQUEST_TIMEOUT_SECONDS
    ?? env.KLING_VIDEO_REQUEST_TIMEOUT_SECONDS
    ?? 30;
  const configuredTimeoutMs = Number(options.timeoutMs ?? (Number(timeoutSeconds) * 1000));
  const timeoutMs = Number.isFinite(configuredTimeoutMs) ? Math.max(1, configuredTimeoutMs) : 30_000;
  let baseUrlIsHttps = false;
  try {
    baseUrlIsHttps = new URL(baseUrl).protocol === "https:";
  } catch {}
  const available = providerMode === "did" && Boolean(apiKey) && baseUrlIsHttps;

  async function request(path, init = {}) {
    if (providerMode === "did" && apiKey && !baseUrlIsHttps) {
      throw new DidVideoProviderError(
        "DID_VIDEO_BASE_URL_INSECURE",
        "D-ID video provider base URL must use HTTPS",
      );
    }
    if (!available) {
      throw new DidVideoProviderError(
        "DID_VIDEO_NOT_CONFIGURED",
        "D-ID video generation is not configured",
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
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
      if (!response.ok) {
        let providerCode = null;
        try {
          const payload = await response.json();
          const candidate = String(
            payload?.error?.code ?? payload?.error?.kind ?? payload?.kind ?? payload?.code ?? "",
          ).trim();
          if (/^[a-z0-9_.:-]{1,80}$/i.test(candidate)) providerCode = candidate;
        } catch {}
        throw new DidVideoProviderError(
          "DID_VIDEO_HTTP_ERROR",
          `D-ID video provider returned HTTP ${response.status}`,
          { status: response.status, providerCode },
        );
      }
      try {
        return await response.json();
      } catch {
        throw new DidVideoProviderError(
          "DID_VIDEO_INVALID_RESPONSE",
          "D-ID video provider returned invalid JSON",
        );
      }
    } catch (error) {
      if (error instanceof DidVideoProviderError) throw error;
      if (controller.signal.aborted) {
        throw new DidVideoProviderError("DID_VIDEO_TIMEOUT", "D-ID video provider timed out");
      }
      throw new DidVideoProviderError("DID_VIDEO_NETWORK_ERROR", "D-ID video provider request failed");
    } finally {
      clearTimeout(timer);
    }
  }

  async function createTask({ imageBase64 } = {}) {
    const image = imageFromBase64(imageBase64);
    const form = new FormData();
    form.append("image", new Blob([image.bytes], { type: image.mimeType }), image.filename);
    const uploaded = await request("/images", { method: "POST", body: form });
    const sourceUrl = uploadedImageUrl(uploaded);
    if (!sourceUrl) {
      throw new DidVideoProviderError(
        "DID_VIDEO_IMAGE_URL_MISSING",
        "D-ID image upload response did not include a supported image URL",
      );
    }
    const payload = await request("/talks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source_url: sourceUrl,
        driver_url: "bank://lively/driver-06",
        script: {
          type: "text",
          ssml: true,
          input: '<break time="5000ms"/>',
          provider: {
            type: "microsoft",
            voice_id: "ja-JP-NanamiNeural",
          },
        },
        config: { fluent: true },
      }),
    });
    const task = normalizedTask(payload);
    if (!task.taskId) {
      throw new DidVideoProviderError(
        "DID_VIDEO_INVALID_RESPONSE",
        "D-ID video response did not include a task ID",
      );
    }
    return task;
  }

  async function getTask(taskId) {
    const normalizedTaskId = String(taskId ?? "").trim();
    if (!normalizedTaskId) {
      throw new DidVideoProviderError("DID_VIDEO_TASK_ID_REQUIRED", "D-ID video task ID is required");
    }
    const payload = await request(`/talks/${encodeURIComponent(normalizedTaskId)}`, { method: "GET" });
    return normalizedTask(payload, normalizedTaskId);
  }

  return Object.freeze({
    available,
    name: "d-id",
    createTask,
    getTask,
  });
}
