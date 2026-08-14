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

  function persistedRecord(store) {
    const status = store.status();
    if (!status.configured) return null;
    const resolved = store.resolve(status.consentId, status.avatarAssetId);
    return {
      consentId: status.consentId,
      avatarAssetId: status.avatarAssetId,
      photoAccessToken: decodeURIComponent(status.posterUrl.split("/").at(-1)),
      voiceAccessToken: decodeURIComponent(status.voicePreviewUrl.split("/").at(-1)),
      subjectLabel: status.subjectLabel,
      consent: { ...status.consent },
      grantedAt: status.consent.grantedAt,
      registeredAt: status.registeredAt,
      photo: { mimeType: resolved.photo.mimeType, base64: resolved.photo.bytes.toString("base64") },
      voice: {
        mimeType: resolved.voice.mimeType,
        durationSeconds: resolved.voice.durationSeconds,
        base64: resolved.voice.bytes.toString("base64"),
      },
    };
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

  function load(profileId) {
    const normalized = assertProfileId(profileId);
    if (stores.has(normalized)) return stores.get(normalized);
    const path = fileFor(normalized);
    let store;
    if (!existsSync(path)) {
      store = createGuardianSamplingStore();
    } else {
      try {
        store = hydrate(decryptRecord(readFileSync(path, "utf8"), key, normalized));
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
    const record = persistedRecord(store);
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

  function register(profileId, input) {
    const store = load(profileId);
    const status = store.register(input);
    save(profileId, store);
    return status;
  }

  function remove(profileId, method) {
    const store = load(profileId);
    const status = store[method]();
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
      const media = kind === "photo"
        ? load(profileId).readPhoto(accessToken)
        : load(profileId).readVoice(accessToken);
      if (media) return media;
    }
    return null;
  }

  return Object.freeze({
    status: (profileId) => load(profileId).status(),
    register,
    revoke: (profileId) => remove(profileId, "revoke"),
    delete: (profileId) => remove(profileId, "delete"),
    resolve: (profileId, consentId, avatarAssetId) => load(profileId).resolve(consentId, avatarAssetId),
    readPhoto: (accessToken) => readCapability("photo", accessToken),
    readVoice: (accessToken) => readCapability("voice", accessToken),
    directory,
  });
}
