import { createHash } from "node:crypto";
import { PrototypeError } from "./errors.mjs";

function requiredString(value, field) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new PrototypeError("INVALID_REQUEST", `${field} is required`);
  }
  return normalized;
}

function digest(parts) {
  const hash = createHash("sha256");
  for (const part of parts) {
    const bytes = Buffer.from(String(part), "utf8");
    hash.update(String(bytes.length));
    hash.update(":");
    hash.update(bytes);
    hash.update(";");
  }
  return hash.digest("hex");
}

export function sha256Audio(audioBytes) {
  if (!(audioBytes instanceof Uint8Array) || audioBytes.byteLength === 0) {
    throw new PrototypeError("INVALID_AUDIO", "non-empty audio bytes are required");
  }
  return createHash("sha256").update(audioBytes).digest("hex");
}

export function createFinalJobKey({ profileId, replyText, audioBytes }) {
  const audioHash = sha256Audio(audioBytes);
  return Object.freeze({
    audioHash,
    key: digest([
      requiredString(profileId, "profileId"),
      requiredString(replyText, "replyText"),
      audioHash,
    ]),
  });
}

export function createPreflightKey({ profileId, conversationId, replyText, tts = {} }) {
  return digest([
    requiredString(profileId, "profileId"),
    requiredString(conversationId, "conversationId"),
    requiredString(replyText, "replyText"),
    tts.model ?? "",
    tts.voice ?? "",
    tts.responseFormat ?? "",
    tts.speed ?? "",
    tts.instructions ?? "",
  ]);
}
