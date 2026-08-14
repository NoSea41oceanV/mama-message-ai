import { randomUUID } from "node:crypto";

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const MAX_VOICE_BYTES = 10 * 1024 * 1024;
const MAX_VOICE_SECONDS = 30;
const MAX_FAVORITE_TOPICS = 5;
const MAX_FAVORITE_TOPIC_LENGTH = 30;
const MAX_CHILD_NAME_LENGTH = 20;
const MIN_SPEECH_RATE = 0.7;
const MAX_SPEECH_RATE = 1.2;
const DEFAULT_SPEECH_RATE = 0.82;
const DISCLOSURE_VERSION = "guardian-sampling-v1";

const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const VOICE_TYPES = new Set([
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
]);

export class GuardianSamplingError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "GuardianSamplingError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function normalizedMimeType(value) {
  return String(value ?? "").split(";", 1)[0].trim().toLowerCase();
}

function parseDataUrl(value) {
  const match = String(value ?? "").match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/i);
  return match ? { mimeType: normalizedMimeType(match[1]), base64: match[2] } : null;
}

function decodeBase64(value, code) {
  const compact = String(value ?? "").replace(/\s/g, "");
  if (!compact || compact.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new GuardianSamplingError(code, "media must be valid base64");
  }
  const bytes = Buffer.from(compact, "base64");
  if (!bytes.length) throw new GuardianSamplingError(code, "media must not be empty");
  const supplied = compact.replace(/=+$/, "");
  const canonical = bytes.toString("base64").replace(/=+$/, "");
  if (supplied !== canonical) throw new GuardianSamplingError(code, "media must be valid base64");
  return bytes;
}

function photoSignatureMatches(bytes, mimeType) {
  if (mimeType === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === "image/webp") {
    return bytes.subarray(0, 4).toString("ascii") === "RIFF"
      && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  }
  return false;
}

function voiceSignatureMatches(bytes, mimeType) {
  if (mimeType === "audio/wav") {
    return bytes.subarray(0, 4).toString("ascii") === "RIFF"
      && bytes.subarray(8, 12).toString("ascii") === "WAVE";
  }
  if (mimeType === "audio/webm") return bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (mimeType === "audio/ogg") return bytes.subarray(0, 4).toString("ascii") === "OggS";
  if (mimeType === "audio/mp4") return bytes.subarray(4, 8).toString("ascii") === "ftyp";
  if (mimeType === "audio/mpeg") {
    return bytes.subarray(0, 3).toString("ascii") === "ID3"
      || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
  }
  return false;
}

function readMedia(input, kind) {
  const nested = input?.[kind] && typeof input[kind] === "object" ? input[kind] : {};
  const raw = nested.base64 ?? nested.dataBase64 ?? input?.[`${kind}Base64`];
  const dataUrl = parseDataUrl(raw);
  const mimeType = normalizedMimeType(
    nested.mimeType ?? nested.type ?? input?.[`${kind}Type`] ?? dataUrl?.mimeType,
  );
  const base64 = dataUrl?.base64 ?? raw;
  const allowed = kind === "photo" ? PHOTO_TYPES : VOICE_TYPES;
  if (!allowed.has(mimeType)) {
    throw new GuardianSamplingError(`${kind.toUpperCase()}_TYPE_UNSUPPORTED`, `${kind} type is unsupported`, 415);
  }
  if (dataUrl && dataUrl.mimeType !== mimeType) {
    throw new GuardianSamplingError(`${kind.toUpperCase()}_TYPE_MISMATCH`, `${kind} type does not match data URL`);
  }
  const bytes = decodeBase64(base64, `${kind.toUpperCase()}_BASE64_INVALID`);
  const maximum = kind === "photo" ? MAX_PHOTO_BYTES : MAX_VOICE_BYTES;
  if (bytes.length > maximum) {
    bytes.fill(0);
    throw new GuardianSamplingError(`${kind.toUpperCase()}_TOO_LARGE`, `${kind} exceeds the size limit`, 413);
  }
  const signatureMatches = kind === "photo"
    ? photoSignatureMatches(bytes, mimeType)
    : voiceSignatureMatches(bytes, mimeType);
  if (!signatureMatches) {
    bytes.fill(0);
    throw new GuardianSamplingError(`${kind.toUpperCase()}_CONTENT_INVALID`, `${kind} content does not match its type`);
  }
  return { bytes, mimeType };
}

function readConsent(input) {
  const consent = input?.consent && typeof input.consent === "object" ? input.consent : {};
  const faceApproved = consent.faceApproved ?? input?.faceApproved;
  const voiceApproved = consent.voiceApproved ?? input?.voiceApproved;
  const explicit = consent.explicit
    ?? consent.accepted
    ?? consent.guardianConfirmed
    ?? input?.explicitConsent
    ?? (faceApproved === true && voiceApproved === true);
  if (faceApproved !== true || voiceApproved !== true || explicit !== true) {
    throw new GuardianSamplingError(
      "EXPLICIT_CONSENT_REQUIRED",
      "explicit face and voice consent is required",
      422,
    );
  }
  return { faceApproved: true, voiceApproved: true, explicit: true };
}

export function normalizeFavoriteTopics(value) {
  const source = Array.isArray(value)
    ? value
    : String(value ?? "").split(/[、,\n]/);
  const topics = [];
  for (const item of source) {
    const topic = String(item ?? "").replace(/\s+/g, " ").trim();
    if (!topic || topic.length > MAX_FAVORITE_TOPIC_LENGTH || topics.includes(topic)) continue;
    topics.push(topic);
    if (topics.length >= MAX_FAVORITE_TOPICS) break;
  }
  return topics;
}

export function normalizeChildName(value) {
  return String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CHILD_NAME_LENGTH);
}

export function normalizeSpeechRate(value, fallback = DEFAULT_SPEECH_RATE) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.round(Math.min(MAX_SPEECH_RATE, Math.max(MIN_SPEECH_RATE, numeric)) * 100) / 100;
}

function publicStatus(record, state = record ? "READY" : "NOT_REGISTERED") {
  if (!record) {
    return Object.freeze({
      status: state,
      registered: false,
      configured: false,
      ready: false,
      active: false,
      consentId: null,
      avatarAssetId: null,
      subjectLabel: null,
      favoriteTopics: [],
      childName: "",
      speechRate: DEFAULT_SPEECH_RATE,
      faceApproved: false,
      voiceApproved: false,
      voiceCloningAvailable: false,
      posterUrl: null,
      voicePreviewUrl: null,
      photo: { registered: false },
      voice: { registered: false },
      storage: "memory-only",
      fallbackAvailable: true,
    });
  }
  return Object.freeze({
    status: "READY",
    registered: true,
    configured: true,
    ready: true,
    active: true,
    consentId: record.consentId,
    avatarAssetId: record.avatarAssetId,
    subjectLabel: record.subjectLabel,
    favoriteTopics: Object.freeze([...(record.favoriteTopics ?? [])]),
    childName: normalizeChildName(record.childName),
    speechRate: normalizeSpeechRate(record.speechRate),
    faceApproved: true,
    voiceApproved: true,
    voiceCloningAvailable: Boolean(record.voiceClone?.voiceId),
    disclosure: "AI生成への写真・音声利用に保護者が明示同意済み",
    posterUrl: `/api/sampling/assets/photo/${encodeURIComponent(record.photoAccessToken)}`,
    voicePreviewUrl: `/api/sampling/assets/voice/${encodeURIComponent(record.voiceAccessToken)}`,
    consent: Object.freeze({
      explicit: true,
      faceApproved: true,
      voiceApproved: true,
      grantedAt: record.grantedAt,
      disclosureVersion: DISCLOSURE_VERSION,
    }),
    photo: Object.freeze({ registered: true, mimeType: record.photo.mimeType }),
    voice: Object.freeze({
      registered: true,
      mimeType: record.voice.mimeType,
      durationSeconds: record.voice.durationSeconds,
    }),
    registeredAt: record.registeredAt,
    storage: "memory-only",
    fallbackAvailable: true,
  });
}

function erase(record) {
  record?.photo?.bytes?.fill(0);
  record?.voice?.bytes?.fill(0);
}

function trustedVoiceClone(internal = {}) {
  return internal.voiceClone?.provider === "elevenlabs" && internal.voiceClone?.voiceId
    ? {
        provider: "elevenlabs",
        voiceId: String(internal.voiceClone.voiceId),
      }
    : null;
}

function readVoiceDuration(input) {
  const durationValue = input.voice?.durationSeconds ?? input.voiceDurationSeconds;
  const durationSeconds = Number(durationValue);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > MAX_VOICE_SECONDS) {
    throw new GuardianSamplingError("VOICE_DURATION_INVALID", `voice duration must be at most ${MAX_VOICE_SECONDS} seconds`, 422);
  }
  return durationSeconds;
}

export function createGuardianSamplingStore(options = {}) {
  const idFactory = options.idFactory ?? randomUUID;
  const now = options.now ?? (() => new Date());
  let current = options.initialRecord ? {
    ...options.initialRecord,
    favoriteTopics: normalizeFavoriteTopics(options.initialRecord.favoriteTopics),
    childName: normalizeChildName(options.initialRecord.childName),
    speechRate: normalizeSpeechRate(options.initialRecord.speechRate),
    consent: { ...options.initialRecord.consent },
    photo: {
      ...options.initialRecord.photo,
      bytes: Buffer.from(options.initialRecord.photo.bytes),
    },
    voice: {
      ...options.initialRecord.voice,
      bytes: Buffer.from(options.initialRecord.voice.bytes),
    },
  } : null;
  let emptyState = "NOT_REGISTERED";

  function register(input = {}, internal = {}) {
    const consent = readConsent(input);
    let photo;
    let voice;
    try {
      photo = readMedia(input, "photo");
      voice = readMedia(input, "voice");
      const durationSeconds = readVoiceDuration(input);
      const timestamp = now().toISOString();
      const next = {
        consentId: `consent_${idFactory()}`,
        avatarAssetId: `guardian_${idFactory()}`,
        photoAccessToken: idFactory(),
        voiceAccessToken: idFactory(),
        subjectLabel: String(input.subjectLabel ?? "登録保護者").trim().slice(0, 60) || "登録保護者",
        favoriteTopics: normalizeFavoriteTopics(input.favoriteTopics),
        childName: normalizeChildName(input.childName),
        speechRate: normalizeSpeechRate(input.speechRate),
        consent,
        grantedAt: timestamp,
        registeredAt: timestamp,
        photo,
        voice: { ...voice, durationSeconds },
        voiceClone: trustedVoiceClone(internal),
      };
      erase(current);
      current = next;
      emptyState = "NOT_REGISTERED";
      return publicStatus(current);
    } catch (error) {
      if (photo && photo !== current?.photo) photo.bytes.fill(0);
      if (voice && voice !== current?.voice) voice.bytes.fill(0);
      throw error;
    }
  }

  function replaceVoice(input = {}, internal = {}) {
    if (!current) throw new GuardianSamplingError("SAMPLING_NOT_REGISTERED", "a guardian sample is required", 409);
    const consent = readConsent({ ...input, faceApproved: true });
    let voice;
    try {
      voice = readMedia(input, "voice");
      const durationSeconds = readVoiceDuration(input);
      const timestamp = now().toISOString();
      const previousVoice = current.voice;
      current = {
        ...current,
        consent,
        grantedAt: timestamp,
        registeredAt: timestamp,
        voiceAccessToken: idFactory(),
        voice: { ...voice, durationSeconds },
        voiceClone: trustedVoiceClone(internal),
      };
      previousVoice.bytes.fill(0);
      return publicStatus(current);
    } catch (error) {
      if (voice && voice !== current?.voice) voice.bytes.fill(0);
      throw error;
    }
  }

  function updatePreferences(input = {}) {
    if (!current) throw new GuardianSamplingError("SAMPLING_NOT_REGISTERED", "a guardian sample is required", 409);
    current = {
      ...current,
      ...(Object.hasOwn(input, "favoriteTopics")
        ? { favoriteTopics: normalizeFavoriteTopics(input.favoriteTopics) }
        : {}),
      ...(Object.hasOwn(input, "childName")
        ? { childName: normalizeChildName(input.childName) }
        : {}),
      ...(Object.hasOwn(input, "speechRate")
        ? { speechRate: normalizeSpeechRate(input.speechRate) }
        : {}),
    };
    return publicStatus(current);
  }

  function revoke() {
    const existed = Boolean(current);
    erase(current);
    current = null;
    emptyState = "REVOKED";
    return { ...publicStatus(null, emptyState), revoked: existed };
  }

  function remove() {
    const existed = Boolean(current);
    erase(current);
    current = null;
    emptyState = "NOT_REGISTERED";
    return { ...publicStatus(), deleted: existed };
  }

  function resolve(consentId, avatarAssetId) {
    if (!current || current.consentId !== consentId || current.avatarAssetId !== avatarAssetId) return null;
    return {
      consentId: current.consentId,
      avatarAssetId: current.avatarAssetId,
      photoUrl: `/api/sampling/assets/photo/${encodeURIComponent(current.photoAccessToken)}`,
      voicePreviewUrl: `/api/sampling/assets/voice/${encodeURIComponent(current.voiceAccessToken)}`,
      photo: current.photo,
      voice: current.voice,
      voiceClone: current.voiceClone ? { ...current.voiceClone } : null,
      favoriteTopics: [...(current.favoriteTopics ?? [])],
      childName: normalizeChildName(current.childName),
      speechRate: normalizeSpeechRate(current.speechRate),
    };
  }

  function readPhoto(accessToken) {
    if (!current || current.photoAccessToken !== accessToken) return null;
    return { bytes: current.photo.bytes, mimeType: current.photo.mimeType };
  }

  function readVoice(accessToken) {
    if (!current || current.voiceAccessToken !== accessToken) return null;
    return { bytes: current.voice.bytes, mimeType: current.voice.mimeType };
  }

  return Object.freeze({
    register,
    replaceVoice,
    updatePreferences,
    status: () => publicStatus(current, emptyState),
    revoke,
    delete: remove,
    resolve,
    readPhoto,
    readVoice,
  });
}

export const GUARDIAN_SAMPLING_LIMITS = Object.freeze({
  maxPhotoBytes: MAX_PHOTO_BYTES,
  maxVoiceBytes: MAX_VOICE_BYTES,
  maxVoiceSeconds: MAX_VOICE_SECONDS,
  maxChildNameLength: MAX_CHILD_NAME_LENGTH,
  minSpeechRate: MIN_SPEECH_RATE,
  maxSpeechRate: MAX_SPEECH_RATE,
  defaultSpeechRate: DEFAULT_SPEECH_RATE,
  disclosureVersion: DISCLOSURE_VERSION,
});
