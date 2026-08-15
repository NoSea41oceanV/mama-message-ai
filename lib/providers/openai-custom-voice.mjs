import { createHash, randomUUID } from "node:crypto";

const ALLOWED_AUDIO_TYPES = new Set([
  "audio/mpeg",
  "audio/ogg",
  "audio/aac",
  "audio/flac",
  "audio/wav",
  "audio/pcm",
]);

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function createOpenAICustomVoiceService(options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const apiKey = String(options.apiKey ?? env.OPENAI_API_KEY ?? "").trim();
  const voiceId = String(options.voiceId ?? env.OPENAI_CUSTOM_VOICE_ID ?? "").trim();
  const baseUrl = String(options.baseUrl ?? env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const model = String(options.model ?? env.OPENAI_TTS_MODEL ?? "gpt-4o-mini-tts-2025-12-15").trim();
  const format = String(options.format ?? env.OPENAI_TTS_FORMAT ?? "mp3").trim().toLowerCase();
  const timeoutMs = positiveNumber(options.timeoutMs ?? Number(env.OPENAI_TTS_TIMEOUT_SECONDS) * 1000, 15_000);
  const ttlMs = positiveNumber(options.ttlMs ?? Number(env.REPLY_AUDIO_TTL_MINUTES) * 60_000, 30 * 60_000);
  const maximumBytes = positiveNumber(options.maximumBytes ?? env.REPLY_AUDIO_MAX_BYTES, 5 * 1024 * 1024);
  const maximumEntries = Math.floor(positiveNumber(options.maximumEntries ?? env.REPLY_AUDIO_CACHE_ENTRIES, 32));
  const cache = new Map();
  const capabilities = new Map();

  function purge(now = Date.now()) {
    for (const [key, item] of cache) {
      if (item.expiresAt <= now) cache.delete(key);
    }
    for (const [token, item] of capabilities) {
      if (item.expiresAt <= now || !cache.has(item.cacheKey)) capabilities.delete(token);
    }
  }

  function capabilityFor(cacheKey, item) {
    if (item.token && capabilities.has(item.token)) return item.token;
    const token = randomUUID();
    item.token = token;
    capabilities.set(token, { cacheKey, expiresAt: item.expiresAt });
    return token;
  }

  function read(accessToken) {
    purge();
    const capability = capabilities.get(accessToken);
    const item = capability ? cache.get(capability.cacheKey) : null;
    if (!item || item.expiresAt <= Date.now()) return null;
    return { bytes: item.bytes, mimeType: item.mimeType };
  }

  async function synthesize(input = {}) {
    if (!available) return null;
    if (input.safetyLevel !== "normal" || input.consentValid !== true) return null;
    const text = String(input.text ?? "").trim();
    if (!text) return null;
    purge();
    const cacheKey = createHash("sha256").update(`${voiceId}\0${model}\0${format}\0${text}`).digest("hex");
    let item = cache.get(cacheKey);
    let cacheHit = true;
    if (!item) {
      cacheHit = false;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetchImpl(`${baseUrl}/audio/speech`, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ model, voice: { id: voiceId }, input: text, response_format: format }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!response?.ok) return null;
      const bytes = Buffer.from(await response.arrayBuffer());
      const mimeType = String(response.headers.get("content-type") ?? "").split(";", 1)[0].toLowerCase();
      if (!bytes.length || bytes.length > maximumBytes || !ALLOWED_AUDIO_TYPES.has(mimeType)) return null;
      item = { bytes, mimeType, expiresAt: Date.now() + ttlMs, token: null };
      if (cache.size >= maximumEntries) cache.delete(cache.keys().next().value);
      cache.set(cacheKey, item);
    }
    const token = capabilityFor(cacheKey, item);
    return { audioUrl: `/api/reply-audio/${encodeURIComponent(token)}`, cacheHit, provider: "openai-custom-voice" };
  }

  const available = Boolean(apiKey && /^voice_[A-Za-z0-9_-]+$/.test(voiceId));
  return Object.freeze({ name: "openai-custom-voice", available, synthesize, read });
}
