import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { createGuardianSamplingStore } from "./guardian-sampling.mjs";

export const GUARDIAN_PROFILE_ID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

function encryptionKeyFrom(value) {
  if (Buffer.isBuffer(value) && value.length === 32) return Buffer.from(value);
  const text = String(value ?? "").trim();
  if (/^[0-9a-f]{64}$/i.test(text)) return Buffer.from(text, "hex");
  if (text) {
    const decoded = Buffer.from(text, "base64");
    if (decoded.length === 32 && decoded.toString("base64").replace(/=+$/, "") === text.replace(/=+$/, "")) {
      return decoded;
    }
    return createHash("sha256").update(text).digest();
  }
  return null;
}

function loadOrCreateKey(keyPath, configuredKey) {
  const provided = encryptionKeyFrom(configuredKey);
  if (provided) return provided;
  mkdirSync(dirname(keyPath), { recursive: true });
  if (existsSync(keyPath)) return Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64");
  const generated = randomBytes(32);
  try {
    writeFileSync(keyPath, `${generated.toString("base64")}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try { chmodSync(keyPath, 0o600); } catch {}
    return generated;
  } catch (error) {
    generated.fill(0);
    if (error.code === "EEXIST") return Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64");
    throw error;
  }
}

function encryptRecord(record, key, profileId) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(profileId, "utf8"));
  const plaintext = Buffer.from(JSON.stringify(record), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  plaintext.fill(0);
  return JSON.stringify({
    version: 1,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  });
}

function decryptRecord(source, key, profileId) {
  const envelope = JSON.parse(source);
  if (envelope.version !== 1 || envelope.algorithm !== "aes-256-gcm") throw new Error("SAMPLING_FORMAT_UNSUPPORTED");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAAD(Buffer.from(profileId, "utf8"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]);
  try {
    return JSON.parse(plaintext.toString("utf8"));
  } finally {
    plaintext.fill(0);
  }
}

function profileIdFromFile(name) {
  const match = String(name).match(/^([0-9a-f-]+)\.sample$/i);
  return match && GUARDIAN_PROFILE_ID_PATTERN.test(match[1]) ? match[1] : null;
}

export function createPersistentGuardianSamplingStore(options = {}) {
  const directory = options.directory ?? join(process.cwd(), ".data", "guardian-samples");
  const keyPath = options.keyPath ?? join(dirname(directory), "sampling.key");
  const key = loadOrCreateKey(keyPath, options.encryptionKey ?? process.env.SAMPLING_ENCRYPTION_KEY);
  const stores = new Map();
  const videos = new Map();
  const voiceClones = new Map();
  mkdirSync(directory, { recursive: true });

  const fileFor = (profileId) => join(directory, `${profileId}.sample`);

  function assertProfileId(profileId) {
    if (!GUARDIAN_PROFILE_ID_PATTERN.test(String(profileId ?? ""))) {
      const error = new Error("GUARDIAN_PROFILE_ID_INVALID");
      error.code = "GUARDIAN_PROFILE_ID_INVALID";
      error.statusCode = 400;
      throw error;
    }
    return String(profileId).toLowerCase();
  }

  function persistedRecord(store, videoGeneration = null) {
    const status = store.status();
    if (!status.configured) return null;
    const resolved = store.resolve(status.consentId, status.avatarAssetId);
    const record = {
      consentId: status.consentId,
      avatarAssetId: status.avatarAssetId,
      photoAccessToken: decodeURIComponent(status.posterUrl.split("/").at(-1)),
      voiceAccessToken: decodeURIComponent(status.voicePreviewUrl.split("/").at(-1)),
      subjectLabel: status.subjectLabel,
      selfReference: resolved.speakingStyle?.selfReference ?? status.subjectLabel,
      favoriteEndings: [...(resolved.speakingStyle?.favoriteEndings ?? [])],
      favoritePhrases: [...(resolved.speakingStyle?.favoritePhrases ?? [])],
      replyExamples: (resolved.speakingStyle?.replyExamples ?? []).map((item) => ({ ...item })),
      favoriteTopics: [...(status.favoriteTopics ?? [])],
      childName: status.childName ?? "",
      speechRate: status.speechRate,
      consent: { ...status.consent },
      grantedAt: status.consent.grantedAt,
      registeredAt: status.registeredAt,
      photo: { mimeType: resolved.photo.mimeType, base64: resolved.photo.bytes.toString("base64") },
      voice: {
        mimeType: resolved.voice.mimeType,
        durationSeconds: resolved.voice.durationSeconds,
        base64: resolved.voice.bytes.toString("base64"),
      },
      voiceClone: resolved.voiceClone ? { ...resolved.voiceClone } : null,
    };
    if (videoGeneration) {
      record.videoGeneration = {
        status: videoGeneration.status,
        jobId: videoGeneration.jobId,
        provider: videoGeneration.provider ?? null,
        providerTaskId: videoGeneration.providerTaskId ?? null,
        providerAssetId: videoGeneration.providerAssetId ?? null,
        message: videoGeneration.message ?? null,
        createdAt: videoGeneration.createdAt,
        updatedAt: videoGeneration.updatedAt,
        videoAccessToken: videoGeneration.videoAccessToken ?? null,
        video: videoGeneration.video ? {
          mimeType: videoGeneration.video.mimeType,
          base64: videoGeneration.video.bytes.toString("base64"),
        } : null,
      };
    }
    return record;
  }

  function hydrate(record) {
    return createGuardianSamplingStore({
      initialRecord: {
        ...record,
        photo: { mimeType: record.photo.mimeType, bytes: Buffer.from(record.photo.base64, "base64") },
        voice: {
          mimeType: record.voice.mimeType,
          durationSeconds: record.voice.durationSeconds,
          bytes: Buffer.from(record.voice.base64, "base64"),
        },
      },
    });
  }

  function hydrateVideo(record) {
    if (!record || typeof record !== "object" || typeof record.jobId !== "string") return null;
    return {
      status: record.status,
      jobId: record.jobId,
      provider: record.provider ?? null,
      providerTaskId: record.providerTaskId ?? null,
      providerAssetId: record.providerAssetId ?? null,
      message: record.message ?? null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      videoAccessToken: record.videoAccessToken ?? null,
      video: record.video?.base64 ? {
        mimeType: record.video.mimeType,
        bytes: Buffer.from(record.video.base64, "base64"),
      } : null,
    };
  }

  function eraseVideo(profileId) {
    const normalized = assertProfileId(profileId);
    videos.get(normalized)?.video?.bytes?.fill(0);
    videos.delete(normalized);
  }

  function publicVideoStatus(record) {
    if (!record) return Object.freeze({ status: "not_started" });
    const status = ["queued", "processing", "ready", "failed"].includes(record.status)
      ? record.status
      : "failed";
    return Object.freeze({
      status,
      jobId: record.jobId,
      ...(status === "ready" && record.videoAccessToken
        ? { videoUrl: `/api/sampling/assets/video/${encodeURIComponent(record.videoAccessToken)}` }
        : {}),
      ...(record.message ? { message: record.message } : {}),
    });
  }

  function load(profileId) {
    const normalized = assertProfileId(profileId);
    if (stores.has(normalized)) return stores.get(normalized);
    const path = fileFor(normalized);
    let store;
    if (!existsSync(path)) {
      store = createGuardianSamplingStore();
    } else {
      try {
        const record = decryptRecord(readFileSync(path, "utf8"), key, normalized);
        store = hydrate(record);
        const video = hydrateVideo(record.videoGeneration);
        if (video) videos.set(normalized, video);
        if (record.voiceClone?.provider === "elevenlabs" && typeof record.voiceClone.voiceId === "string") {
          voiceClones.set(normalized, { provider: "elevenlabs", voiceId: record.voiceClone.voiceId });
        }
      } catch {
        const corruptPath = `${path}.corrupt-${Date.now()}`;
        try { renameSync(path, corruptPath); } catch {}
        store = createGuardianSamplingStore();
      }
    }
    stores.set(normalized, store);
    return store;
  }

  function save(profileId, store) {
    const normalized = assertProfileId(profileId);
    const record = persistedRecord(store, videos.get(normalized));
    if (record && voiceClones.has(normalized)) record.voiceClone = voiceClones.get(normalized);
    const target = fileFor(normalized);
    if (!record) {
      if (existsSync(target)) unlinkSync(target);
      return;
    }
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    const encrypted = encryptRecord(record, key, normalized);
    writeFileSync(temporary, encrypted, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try { chmodSync(temporary, 0o600); } catch {}
    try {
      renameSync(temporary, target);
    } catch (error) {
      try { unlinkSync(temporary); } catch {}
      throw error;
    }
  }

  function register(profileId, input, internal = {}) {
    const store = load(profileId);
    const status = store.register(input, internal);
    eraseVideo(profileId);
    voiceClones.delete(assertProfileId(profileId));
    save(profileId, store);
    return status;
  }

  function replaceVoice(profileId, input, internal = {}) {
    const store = load(profileId);
    const status = store.replaceVoice(input, internal);
    save(profileId, store);
    return status;
  }

  function updatePreferences(profileId, input = {}) {
    const store = load(profileId);
    const status = store.updatePreferences(input);
    save(profileId, store);
    return status;
  }

  function remove(profileId, method) {
    const store = load(profileId);
    const status = store[method]();
    eraseVideo(profileId);
    voiceClones.delete(assertProfileId(profileId));
    save(profileId, store);
    return status;
  }

  function profileIds() {
    const ids = new Set(stores.keys());
    for (const name of readdirSync(directory)) {
      const profileId = profileIdFromFile(name);
      if (profileId) ids.add(profileId);
    }
    return ids;
  }

  function readCapability(kind, accessToken) {
    for (const profileId of profileIds()) {
      load(profileId);
      const media = kind === "photo"
        ? stores.get(profileId).readPhoto(accessToken)
        : kind === "voice"
          ? stores.get(profileId).readVoice(accessToken)
          : videos.get(profileId)?.videoAccessToken === accessToken
            ? videos.get(profileId)?.video
            : null;
      if (media) return media;
    }
    return null;
  }

  function createVideoJob(profileId, input = {}) {
    const normalized = assertProfileId(profileId);
    const store = load(normalized);
    if (!store.status().configured || !store.status().active) {
      const error = new Error("SAMPLING_NOT_REGISTERED");
      error.code = "SAMPLING_NOT_REGISTERED";
      error.statusCode = 409;
      throw error;
    }
    eraseVideo(normalized);
    const timestamp = String(input.createdAt ?? new Date().toISOString());
    videos.set(normalized, {
      status: "queued",
      jobId: String(input.jobId || `video_${randomUUID()}`),
      provider: input.provider ? String(input.provider) : null,
      providerTaskId: null,
      providerAssetId: null,
      message: input.message ?? "Video generation queued.",
      createdAt: timestamp,
      updatedAt: timestamp,
      videoAccessToken: null,
      video: null,
    });
    save(normalized, store);
    return publicVideoStatus(videos.get(normalized));
  }

  function videoJob(profileId, jobId) {
    const normalized = assertProfileId(profileId);
    load(normalized);
    const record = videos.get(normalized);
    if (!record || record.jobId !== jobId) return null;
    const { video: _video, ...metadata } = record;
    return { ...metadata };
  }

  function updateVideoJob(profileId, jobId, patch = {}) {
    const normalized = assertProfileId(profileId);
    const store = load(normalized);
    const current = videos.get(normalized);
    if (!current || current.jobId !== jobId || current.status === "failed") return null;
    const next = {
      ...current,
      ...(patch.status ? { status: patch.status } : {}),
      ...(Object.hasOwn(patch, "provider") ? { provider: patch.provider } : {}),
      ...(Object.hasOwn(patch, "providerTaskId") ? { providerTaskId: patch.providerTaskId } : {}),
      ...(Object.hasOwn(patch, "providerAssetId") ? { providerAssetId: patch.providerAssetId } : {}),
      ...(Object.hasOwn(patch, "message") ? { message: patch.message } : {}),
      updatedAt: String(patch.updatedAt ?? new Date().toISOString()),
    };
    videos.set(normalized, next);
    save(normalized, store);
    return publicVideoStatus(next);
  }

  function resumeTimedOutVideoJob(profileId, jobId) {
    const normalized = assertProfileId(profileId);
    const store = load(normalized);
    const current = videos.get(normalized);
    if (
      !current
      || current.jobId !== jobId
      || current.status !== "failed"
      || !current.providerTaskId
      || current.message !== "Video generation timed out. You can try again."
    ) return null;
    const next = {
      ...current,
      status: "processing",
      message: "Video generation is processing.",
      updatedAt: new Date().toISOString(),
    };
    videos.set(normalized, next);
    save(normalized, store);
    return publicVideoStatus(next);
  }

  function storeVideo(profileId, jobId, media) {
    const normalized = assertProfileId(profileId);
    const store = load(normalized);
    const current = videos.get(normalized);
    if (!current || current.jobId !== jobId || current.status === "failed") return null;
    current.video?.bytes?.fill(0);
    const bytes = Buffer.from(media.bytes);
    const next = {
      ...current,
      status: "ready",
      message: null,
      updatedAt: new Date().toISOString(),
      videoAccessToken: randomUUID(),
      video: { bytes, mimeType: media.mimeType },
    };
    videos.set(normalized, next);
    save(normalized, store);
    return publicVideoStatus(next);
  }

  function markVideoReady(profileId, jobId) {
    const normalized = assertProfileId(profileId);
    const store = load(normalized);
    const current = videos.get(normalized);
    if (!current || current.jobId !== jobId || current.status === "failed") return null;
    const next = {
      ...current,
      status: "ready",
      message: null,
      updatedAt: new Date().toISOString(),
    };
    videos.set(normalized, next);
    save(normalized, store);
    return publicVideoStatus(next);
  }

  return Object.freeze({
    status: (profileId) => {
      const normalized = assertProfileId(profileId);
      return {
        ...load(normalized).status(),
        videoGeneration: publicVideoStatus(videos.get(normalized)),
      };
    },
    register,
    replaceVoice,
    updatePreferences,
    revoke: (profileId) => remove(profileId, "revoke"),
    delete: (profileId) => remove(profileId, "delete"),
    resolve: (profileId, consentId, avatarAssetId) => load(profileId).resolve(consentId, avatarAssetId),
    readPhoto: (accessToken) => readCapability("photo", accessToken),
    readVoice: (accessToken) => readCapability("voice", accessToken),
    readVideo: (accessToken) => readCapability("video", accessToken),
    createVideoJob,
    videoJob,
    updateVideoJob,
    resumeTimedOutVideoJob,
    storeVideo,
    markVideoReady,
    directory,
  });
}
