const DEFAULT_BASE_URL = "https://api.heygen.com";
const DEFAULT_ENGINE = "avatar_iv";
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png"]);
const ALLOWED_AUDIO_TYPES = new Set(["audio/mpeg", "audio/wav"]);

const AVATAR_STATUS_MAP = Object.freeze({
  completed: "ready",
  ready: "ready",
  failed: "failed",
  error: "failed",
  pending: "queued",
  queued: "queued",
  processing: "processing",
  training: "processing",
});

const VIDEO_STATUS_MAP = Object.freeze({
  completed: "ready",
  ready: "ready",
  failed: "failed",
  error: "failed",
  pending: "queued",
  queued: "queued",
  processing: "processing",
});

const MOTION_BY_SUPPORT_MODE = Object.freeze({
  celebrate: Object.freeze({ prompt: "Smile brightly and clap once.", expressiveness: "high" }),
  comfort: Object.freeze({ prompt: "Look warm and empathetic, with one hand over the heart.", expressiveness: "medium" }),
  calm: Object.freeze({ prompt: "Keep a calm reassuring expression and nod slowly.", expressiveness: "low" }),
  encourage: Object.freeze({ prompt: "Smile warmly and give a gentle thumbs up.", expressiveness: "medium" }),
  transition: Object.freeze({ prompt: "Look reassuring and make one small open-palm gesture.", expressiveness: "medium" }),
  basic_need: Object.freeze({ prompt: "Look attentive and nod gently.", expressiveness: "low" }),
  listen: Object.freeze({ prompt: "Look warm and attentive, with a small gentle nod.", expressiveness: "low" }),
  clarify: Object.freeze({ prompt: "Look curious and attentive, with a small gentle nod.", expressiveness: "low" }),
});

export class HeyGenVideoProviderError extends Error {
  constructor(code, message, { status = null, providerCode = null } = {}) {
    super(message);
    this.name = "HeyGenVideoProviderError";
    this.code = code;
    this.status = status;
    this.providerCode = providerCode;
  }
}

function cleanBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
}

function normalizedMimeType(value) {
  return String(value ?? "").split(";", 1)[0].trim().toLowerCase();
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function unwrapData(payload) {
  return payload?.data && typeof payload.data === "object" ? payload.data : payload;
}

function avatarItem(payload) {
  const data = unwrapData(payload) ?? {};
  return data.avatar_item ?? data.avatar_look ?? data.look ?? data;
}

function normalizedAvatarTask(payload, fallbackTaskId = null, providerAssetId = null) {
  const item = avatarItem(payload);
  const taskId = String(item?.id ?? item?.avatar_id ?? fallbackTaskId ?? "").trim() || null;
  const rawStatus = String(item?.status ?? unwrapData(payload)?.status ?? "processing").trim().toLowerCase();
  return Object.freeze({
    taskId,
    providerAssetId,
    status: AVATAR_STATUS_MAP[rawStatus] ?? "processing",
    prepared: (AVATAR_STATUS_MAP[rawStatus] ?? "processing") === "ready",
    videoUrl: null,
  });
}

function normalizedVideoTask(payload, fallbackTaskId = null) {
  const data = unwrapData(payload) ?? {};
  const taskId = String(data.video_id ?? data.id ?? fallbackTaskId ?? "").trim() || null;
  const rawStatus = String(data.status ?? "processing").trim().toLowerCase();
  const videoUrl = typeof data.video_url === "string" ? data.video_url.trim() : "";
  const status = videoUrl ? "ready" : (VIDEO_STATUS_MAP[rawStatus] ?? "processing");
  return Object.freeze({ taskId, status, videoUrl: videoUrl || null });
}

function fileDetails(kind, mimeType) {
  const normalized = normalizedMimeType(mimeType);
  const allowed = kind === "image" ? ALLOWED_IMAGE_TYPES : ALLOWED_AUDIO_TYPES;
  if (!allowed.has(normalized)) {
    throw new HeyGenVideoProviderError(
      `HEYGEN_${kind.toUpperCase()}_TYPE_UNSUPPORTED`,
      `HeyGen requires a supported ${kind} file`,
    );
  }
  const extension = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
  }[normalized];
  return { mimeType: normalized, filename: `guardian-${kind}.${extension}` };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function heyGenMotionForDecision(decision = {}) {
  return MOTION_BY_SUPPORT_MODE[decision.supportMode] ?? MOTION_BY_SUPPORT_MODE.listen;
}

export function createHeyGenVideoProvider(options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const apiKey = String(options.apiKey ?? env.HEYGEN_API_KEY ?? "").trim();
  const baseUrl = cleanBaseUrl(options.baseUrl ?? env.HEYGEN_BASE_URL);
  const providerMode = String(options.providerMode ?? env.VIDEO_GENERATION_PROVIDER ?? "disabled").trim().toLowerCase();
  const engine = String(options.engine ?? env.HEYGEN_AVATAR_ENGINE ?? DEFAULT_ENGINE).trim().toLowerCase() || DEFAULT_ENGINE;
  const requestTimeoutMs = positiveNumber(
    options.timeoutMs ?? (Number(env.VIDEO_REQUEST_TIMEOUT_SECONDS || 30) * 1000),
    30_000,
  );
  const replyTimeoutMs = positiveNumber(
    options.replyTimeoutMs ?? (Number(env.HEYGEN_RESPONSE_TIMEOUT_SECONDS || 180) * 1000),
    180_000,
  );
  const pollIntervalMs = positiveNumber(
    options.pollIntervalMs ?? (Number(env.HEYGEN_POLL_INTERVAL_SECONDS || 5) * 1000),
    5_000,
  );
  let baseUrlIsHttps = false;
  try {
    baseUrlIsHttps = new URL(baseUrl).protocol === "https:";
  } catch {}
  const available = providerMode === "heygen" && Boolean(apiKey) && baseUrlIsHttps;

  async function request(path, init = {}) {
    if (providerMode === "heygen" && apiKey && !baseUrlIsHttps) {
      throw new HeyGenVideoProviderError("HEYGEN_BASE_URL_INSECURE", "HeyGen base URL must use HTTPS");
    }
    if (!available) {
      throw new HeyGenVideoProviderError("HEYGEN_NOT_CONFIGURED", "HeyGen video generation is not configured");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    timer.unref?.();
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        ...init,
        redirect: "error",
        headers: {
          "x-api-key": apiKey,
          accept: "application/json",
          ...(init.headers ?? {}),
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
        throw new HeyGenVideoProviderError(
          "HEYGEN_HTTP_ERROR",
          `HeyGen returned HTTP ${response.status}`,
          { status: response.status, providerCode },
        );
      }
      try {
        return await response.json();
      } catch {
        throw new HeyGenVideoProviderError("HEYGEN_INVALID_RESPONSE", "HeyGen returned invalid JSON");
      }
    } catch (error) {
      if (error instanceof HeyGenVideoProviderError) throw error;
      if (controller.signal.aborted) {
        throw new HeyGenVideoProviderError("HEYGEN_TIMEOUT", "HeyGen request timed out");
      }
      throw new HeyGenVideoProviderError("HEYGEN_NETWORK_ERROR", "HeyGen request failed");
    } finally {
      clearTimeout(timer);
    }
  }

  async function uploadAsset({ bytes, mimeType, kind, idempotencyKey }) {
    const media = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
    if (!media.length || media.length > 32 * 1024 * 1024) {
      throw new HeyGenVideoProviderError("HEYGEN_ASSET_INVALID", "HeyGen asset is empty or too large");
    }
    const details = fileDetails(kind, mimeType);
    const form = new FormData();
    form.append("file", new Blob([media], { type: details.mimeType }), details.filename);
    const payload = await request("/v3/assets", {
      method: "POST",
      headers: idempotencyKey ? { "Idempotency-Key": String(idempotencyKey).slice(0, 255) } : {},
      body: form,
    });
    const data = unwrapData(payload) ?? {};
    const assetId = String(data.asset_id ?? data.id ?? "").trim();
    if (!assetId) throw new HeyGenVideoProviderError("HEYGEN_ASSET_ID_MISSING", "HeyGen did not return an asset ID");
    return Object.freeze({ assetId });
  }

  async function createTask({ imageBase64, mimeType = null, idempotencyKey = null } = {}) {
    const raw = String(imageBase64 ?? "").trim();
    if (!raw || raw.startsWith("data:") || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
      throw new HeyGenVideoProviderError("HEYGEN_IMAGE_INVALID", "HeyGen requires raw base64 image data");
    }
    const bytes = Buffer.from(raw, "base64");
    const isPng = bytes.length >= 8
      && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const detectedType = isPng ? "image/png" : isJpeg ? "image/jpeg" : normalizedMimeType(mimeType);
    if (!ALLOWED_IMAGE_TYPES.has(detectedType)) {
      throw new HeyGenVideoProviderError("HEYGEN_IMAGE_INVALID", "HeyGen requires a JPEG or PNG image");
    }
    const uploaded = await uploadAsset({
      bytes,
      mimeType: detectedType,
      kind: "image",
      idempotencyKey: idempotencyKey ? `${idempotencyKey}:image` : null,
    });
    try {
      const payload = await request("/v3/avatars", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(idempotencyKey ? { "Idempotency-Key": String(`${idempotencyKey}:avatar`).slice(0, 255) } : {}),
        },
        body: JSON.stringify({
          type: "photo",
          name: `Mama Message ${String(idempotencyKey ?? "guardian").slice(-24)}`,
          file: { type: "asset_id", asset_id: uploaded.assetId },
        }),
      });
      const task = normalizedAvatarTask(payload, null, uploaded.assetId);
      if (!task.taskId) throw new HeyGenVideoProviderError("HEYGEN_AVATAR_ID_MISSING", "HeyGen did not return an avatar ID");
      return task;
    } catch (error) {
      await deleteAsset(uploaded.assetId).catch(() => {});
      throw error;
    } finally {
      bytes.fill(0);
    }
  }

  async function getTask(taskId) {
    const normalizedTaskId = String(taskId ?? "").trim();
    if (!normalizedTaskId) throw new HeyGenVideoProviderError("HEYGEN_AVATAR_ID_REQUIRED", "HeyGen avatar ID is required");
    const payload = await request(`/v3/avatars/looks/${encodeURIComponent(normalizedTaskId)}`, { method: "GET" });
    return normalizedAvatarTask(payload, normalizedTaskId);
  }

  async function createReplyTask({ avatarId, audioAssetId, motionPrompt, expressiveness, idempotencyKey }) {
    const payload = await request("/v3/videos", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(idempotencyKey ? { "Idempotency-Key": String(idempotencyKey).slice(0, 255) } : {}),
      },
      body: JSON.stringify({
        type: "avatar",
        avatar_id: String(avatarId),
        audio_asset_id: String(audioAssetId),
        title: "Mama Message reply",
        resolution: "720p",
        aspect_ratio: "auto",
        output_format: "mp4",
        motion_prompt: String(motionPrompt),
        expressiveness: String(expressiveness),
        engine: { type: engine },
      }),
    });
    const task = normalizedVideoTask(payload);
    if (!task.taskId) throw new HeyGenVideoProviderError("HEYGEN_VIDEO_ID_MISSING", "HeyGen did not return a video ID");
    return task;
  }

  async function getReplyTask(taskId) {
    const normalizedTaskId = String(taskId ?? "").trim();
    if (!normalizedTaskId) throw new HeyGenVideoProviderError("HEYGEN_VIDEO_ID_REQUIRED", "HeyGen video ID is required");
    const payload = await request(`/v3/videos/${encodeURIComponent(normalizedTaskId)}`, { method: "GET" });
    return normalizedVideoTask(payload, normalizedTaskId);
  }

  async function renderReply(input = {}) {
    const avatarId = String(input.avatarId ?? "").trim();
    const audioBytes = Buffer.isBuffer(input.audioBytes) ? input.audioBytes : Buffer.from(input.audioBytes ?? []);
    if (!avatarId || !audioBytes.length) {
      throw new HeyGenVideoProviderError("HEYGEN_REPLY_INPUT_INVALID", "HeyGen reply requires an avatar and audio");
    }
    const motion = input.motionPrompt && input.expressiveness
      ? { prompt: input.motionPrompt, expressiveness: input.expressiveness }
      : heyGenMotionForDecision(input.decision);
    const uploaded = await uploadAsset({
      bytes: audioBytes,
      mimeType: input.audioMimeType,
      kind: "audio",
      idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:audio` : null,
    });
    try {
      let task = await createReplyTask({
        avatarId,
        audioAssetId: uploaded.assetId,
        motionPrompt: motion.prompt,
        expressiveness: motion.expressiveness,
        idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:video` : null,
      });
      const deadline = Date.now() + replyTimeoutMs;
      while (!["ready", "failed"].includes(task.status) && Date.now() < deadline) {
        await sleep(pollIntervalMs);
        task = await getReplyTask(task.taskId);
      }
      if (task.status !== "ready" || !task.videoUrl) {
        throw new HeyGenVideoProviderError(
          task.status === "failed" ? "HEYGEN_VIDEO_FAILED" : "HEYGEN_VIDEO_TIMEOUT",
          task.status === "failed" ? "HeyGen video generation failed" : "HeyGen video generation timed out",
        );
      }
      return task;
    } finally {
      await deleteAsset(uploaded.assetId).catch(() => {});
    }
  }

  async function deleteAsset(assetId) {
    const normalized = String(assetId ?? "").trim();
    if (!normalized || !available) return false;
    try {
      await request(`/v3/assets/${encodeURIComponent(normalized)}`, { method: "DELETE" });
      return true;
    } catch (error) {
      if (error instanceof HeyGenVideoProviderError && error.status === 404) return false;
      throw error;
    }
  }

  async function deleteTask(taskId) {
    const normalized = String(taskId ?? "").trim();
    if (!normalized || !available) return false;
    try {
      await request(`/v3/avatars/looks/${encodeURIComponent(normalized)}`, { method: "DELETE" });
      return true;
    } catch (error) {
      if (error instanceof HeyGenVideoProviderError && error.status === 404) return false;
      throw error;
    }
  }

  async function deleteReplyTask(taskId) {
    const normalized = String(taskId ?? "").trim();
    if (!normalized || !available) return false;
    try {
      await request(`/v3/videos/${encodeURIComponent(normalized)}`, { method: "DELETE" });
      return true;
    } catch (error) {
      if (error instanceof HeyGenVideoProviderError && error.status === 404) return false;
      throw error;
    }
  }

  async function verify() {
    await request("/v3/users/me", { method: "GET" });
    return true;
  }

  return Object.freeze({
    available,
    name: "heygen",
    engine,
    createTask,
    getTask,
    renderReply,
    deleteAsset,
    deleteTask,
    deleteReplyTask,
    verify,
  });
}
