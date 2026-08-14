import { randomUUID } from "node:crypto";

const ALLOWED_VIDEO_TYPES = new Set(["video/mp4", "video/webm"]);

export class GuardianVideoError extends Error {
  constructor(code, message, statusCode = 400, options = {}) {
    super(message, options);
    this.name = "GuardianVideoError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function scheduleUnref(action, delayMs) {
  const timer = setTimeout(action, delayMs);
  timer.unref?.();
  return timer;
}

function contentTypeOf(response) {
  return String(response.headers?.get?.("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function safeFailureMessage(error) {
  const code = typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code)
    ? error.code
    : "VIDEO_GENERATION_FAILED";
  const status = Number.isInteger(error?.status) ? ` HTTP ${error.status}` : "";
  const providerCode = typeof error?.providerCode === "string" && /^[a-z0-9_.:-]{1,80}$/i.test(error.providerCode)
    ? ` / ${error.providerCode}`
    : "";
  return `Video generation failed (${code}${status}${providerCode}). You can try again.`;
}

export async function downloadGeneratedVideo(url, options = {}) {
  let parsed;
  try {
    parsed = new URL(String(url ?? ""));
  } catch {
    throw new GuardianVideoError("VIDEO_RESULT_URL_INVALID", "Generated video URL is invalid", 502);
  }
  if (parsed.protocol !== "https:") {
    throw new GuardianVideoError("VIDEO_RESULT_URL_INSECURE", "Generated video URL must use HTTPS", 502);
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const maximumBytes = positiveNumber(options.maximumBytes, 25 * 1024 * 1024);
  const timeoutMs = positiveNumber(options.timeoutMs, 30_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  timer.unref?.();
  try {
    let response;
    try {
      response = await fetchImpl(parsed, {
        method: "GET",
        redirect: "follow",
        headers: { accept: "video/mp4, video/webm" },
        signal: controller.signal,
      });
    } catch (error) {
      const code = controller.signal.aborted ? "VIDEO_DOWNLOAD_TIMEOUT" : "VIDEO_DOWNLOAD_FAILED";
      throw new GuardianVideoError(code, "Generated video could not be downloaded", 502, { cause: error });
    }

    if (!response.ok) {
      throw new GuardianVideoError("VIDEO_DOWNLOAD_HTTP_ERROR", `Generated video download returned HTTP ${response.status}`, 502);
    }
    if (response.url) {
      const finalUrl = new URL(response.url);
      if (finalUrl.protocol !== "https:") {
        throw new GuardianVideoError("VIDEO_RESULT_URL_INSECURE", "Generated video redirect must use HTTPS", 502);
      }
    }
    const mimeType = contentTypeOf(response);
    if (!ALLOWED_VIDEO_TYPES.has(mimeType)) {
      throw new GuardianVideoError("VIDEO_CONTENT_TYPE_UNSUPPORTED", "Generated video content type is unsupported", 502);
    }
    const declaredLength = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
      throw new GuardianVideoError("VIDEO_TOO_LARGE", "Generated video exceeds the size limit", 413);
    }

    const chunks = [];
    let size = 0;
    const reader = response.body?.getReader?.();
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        size += chunk.length;
        if (size > maximumBytes) {
          await reader.cancel().catch(() => {});
          for (const buffered of chunks) buffered.fill(0);
          chunk.fill(0);
          throw new GuardianVideoError("VIDEO_TOO_LARGE", "Generated video exceeds the size limit", 413);
        }
        chunks.push(chunk);
      }
    } else {
      const chunk = Buffer.from(await response.arrayBuffer());
      size = chunk.length;
      if (size > maximumBytes) {
        chunk.fill(0);
        throw new GuardianVideoError("VIDEO_TOO_LARGE", "Generated video exceeds the size limit", 413);
      }
      chunks.push(chunk);
    }
    if (!size) throw new GuardianVideoError("VIDEO_EMPTY", "Generated video is empty", 502);
    return { bytes: Buffer.concat(chunks, size), mimeType };
  } catch (error) {
    if (error instanceof GuardianVideoError) throw error;
    const code = controller.signal.aborted ? "VIDEO_DOWNLOAD_TIMEOUT" : "VIDEO_DOWNLOAD_FAILED";
    throw new GuardianVideoError(code, "Generated video could not be downloaded", 502, { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

export function createGuardianVideoService(options = {}) {
  const samplingStore = options.samplingStore;
  const provider = options.provider;
  if (!samplingStore || !provider) throw new TypeError("samplingStore and provider are required");
  const idFactory = options.idFactory ?? randomUUID;
  const now = options.now ?? (() => new Date());
  const pollIntervalMs = positiveNumber(options.pollIntervalMs, 5_000);
  const pollTimeoutMs = Math.max(pollIntervalMs, positiveNumber(options.pollTimeoutMs, 10 * 60 * 1000));
  const maximumBytes = positiveNumber(options.maximumBytes, 25 * 1024 * 1024);
  const downloadTimeoutMs = positiveNumber(options.downloadTimeoutMs, 30_000);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const schedule = options.schedule ?? scheduleUnref;
  const scheduled = new Set();
  const running = new Set();

  function publicStatus(profileId, jobId = null) {
    const status = samplingStore.status(profileId).videoGeneration;
    if (jobId && status.jobId !== jobId) return null;
    return status;
  }

  function fail(profileId, jobId, message = "Video generation failed. You can try again.") {
    return samplingStore.updateVideoJob(profileId, jobId, { status: "failed", message });
  }

  async function complete(profileId, jobId, videoUrl) {
    if (!videoUrl) return fail(profileId, jobId);
    const media = await downloadGeneratedVideo(videoUrl, {
      fetchImpl,
      maximumBytes,
      timeoutMs: downloadTimeoutMs,
    });
    try {
      return samplingStore.storeVideo(profileId, jobId, media);
    } finally {
      media.bytes.fill(0);
    }
  }

  function queueAdvance(profileId, jobId, delayMs = pollIntervalMs) {
    const key = `${profileId}:${jobId}`;
    if (scheduled.has(key)) return;
    scheduled.add(key);
    schedule(() => {
      scheduled.delete(key);
      void advance(profileId, jobId);
    }, delayMs);
  }

  async function advance(profileId, jobId) {
    const key = `${profileId}:${jobId}`;
    if (running.has(key)) return;
    running.add(key);
    try {
      let record = samplingStore.videoJob(profileId, jobId);
      if (!record || ["ready", "failed"].includes(record.status)) return;
      const elapsed = now().getTime() - Date.parse(record.createdAt);
      if (!Number.isFinite(elapsed) || elapsed > pollTimeoutMs) {
        fail(profileId, jobId, "Video generation timed out. You can try again.");
        return;
      }

      let task;
      if (!record.providerTaskId) {
        const sampleStatus = samplingStore.status(profileId);
        const sample = samplingStore.resolve(profileId, sampleStatus.consentId, sampleStatus.avatarAssetId);
        if (!sample?.photo?.bytes) {
          fail(profileId, jobId, "The registered guardian photo is no longer available.");
          return;
        }
        task = await provider.createTask({ imageBase64: sample.photo.bytes.toString("base64") });
        samplingStore.updateVideoJob(profileId, jobId, {
          providerTaskId: task.taskId,
          status: task.status === "queued" ? "queued" : "processing",
          message: task.status === "queued" ? "Video generation queued." : "Video generation is processing.",
        });
      } else {
        task = await provider.getTask(record.providerTaskId);
      }

      if (!samplingStore.videoJob(profileId, jobId)) return;
      if (task.status === "ready") {
        await complete(profileId, jobId, task.videoUrl);
        return;
      }
      if (task.status === "failed") {
        fail(profileId, jobId);
        return;
      }
      record = samplingStore.videoJob(profileId, jobId);
      if (!record) return;
      samplingStore.updateVideoJob(profileId, jobId, {
        status: task.status === "queued" ? "queued" : "processing",
        message: task.status === "queued" ? "Video generation queued." : "Video generation is processing.",
      });
      queueAdvance(profileId, jobId);
    } catch (error) {
      fail(profileId, jobId, safeFailureMessage(error));
    } finally {
      running.delete(key);
    }
  }

  function start(profileId) {
    const status = samplingStore.createVideoJob(profileId, {
      jobId: `video_${idFactory()}`,
      createdAt: now().toISOString(),
      message: "Video generation queued.",
    });
    queueAdvance(profileId, status.jobId, 0);
    return status;
  }

  function status(profileId, jobId) {
    const result = publicStatus(profileId, jobId);
    if (result && ["queued", "processing"].includes(result.status)) {
      queueAdvance(profileId, jobId, 0);
    }
    return result;
  }

  function profileStatus(profileId) {
    return publicStatus(profileId);
  }

  return Object.freeze({ start, status, profileStatus, advance, readVideo: samplingStore.readVideo });
}
