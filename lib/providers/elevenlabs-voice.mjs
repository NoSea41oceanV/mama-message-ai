import { createHash, randomUUID } from "node:crypto";

const ALLOWED_AUDIO_TYPES = new Set(["audio/mpeg", "audio/ogg", "audio/wav", "audio/pcm"]);

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function createElevenLabsVoiceService(options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const apiKey = String(options.apiKey ?? env.ELEVENLABS_API_KEY ?? "").trim();
  const configuredVoiceId = String(options.voiceId ?? env.ELEVENLABS_VOICE_ID ?? "").trim();
  const baseUrl = String(options.baseUrl ?? env.ELEVENLABS_BASE_URL ?? "https://api.elevenlabs.io/v1").replace(/\/$/, "");
  const model = String(options.model ?? env.ELEVENLABS_TTS_MODEL ?? "eleven_flash_v2_5").trim();
  const outputFormat = String(options.outputFormat ?? env.ELEVENLABS_OUTPUT_FORMAT ?? "mp3_44100_128").trim();
  const timeoutMs = positiveNumber(options.timeoutMs ?? Number(env.ELEVENLABS_TTS_TIMEOUT_SECONDS) * 1000, 15_000);
  const ttlMs = positiveNumber(options.ttlMs ?? Number(env.REPLY_AUDIO_TTL_MINUTES) * 60_000, 30 * 60_000);
  const maximumBytes = positiveNumber(options.maximumBytes ?? env.REPLY_AUDIO_MAX_BYTES, 5 * 1024 * 1024);
  const maximumEntries = Math.floor(positiveNumber(options.maximumEntries ?? env.REPLY_AUDIO_CACHE_ENTRIES, 32));
  const cache = new Map();
  const capabilities = new Map();

  function purge(now = Date.now()) {
    for (const [key, item] of cache) if (item.expiresAt <= now) cache.delete(key);
    for (const [token, item] of capabilities) {
      if (item.expiresAt <= now || !cache.has(item.cacheKey)) capabilities.delete(token);
    }
  }

  function read(token) {
    purge();
    const capability = capabilities.get(token);
    const item = capability ? cache.get(capability.cacheKey) : null;
    return item && item.expiresAt > Date.now() ? { bytes: item.bytes, mimeType: item.mimeType } : null;
  }

  async function synthesize(input = {}) {
    const voiceId = String(input.voiceId ?? configuredVoiceId).trim();
    if (!available || !/^[A-Za-z0-9_-]{8,}$/.test(voiceId)
      || input.safetyLevel !== "normal" || input.consentValid !== true) return null;
    const text = String(input.text ?? "").trim();
    if (!text) return null;
    purge();
    const cacheKey = createHash("sha256").update(`${voiceId}\0${model}\0${outputFormat}\0${text}`).digest("hex");
    let item = cache.get(cacheKey);
    let cacheHit = true;
    if (!item) {
      cacheHit = false;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        const endpoint = `${baseUrl}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(outputFormat)}`;
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: { "xi-api-key": apiKey, "content-type": "application/json", accept: "audio/mpeg" },
          body: JSON.stringify({ text, model_id: model }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!response?.ok) return null;
      const bytes = Buffer.from(await response.arrayBuffer());
      const mimeType = String(response.headers.get("content-type") ?? "audio/mpeg").split(";", 1)[0].toLowerCase();
      if (!bytes.length || bytes.length > maximumBytes || !ALLOWED_AUDIO_TYPES.has(mimeType)) return null;
      item = { bytes, mimeType, expiresAt: Date.now() + ttlMs, token: randomUUID() };
      if (cache.size >= maximumEntries) cache.delete(cache.keys().next().value);
      cache.set(cacheKey, item);
      capabilities.set(item.token, { cacheKey, expiresAt: item.expiresAt });
    }
    return {
      audioUrl: `/api/reply-audio/${encodeURIComponent(item.token)}`,
      cacheHit,
      provider: "elevenlabs",
    };
  }

  async function createClone(input = {}) {
    if (!available || input.externalProcessingApproved !== true) return null;
    const bytes = Buffer.from(input.bytes ?? []);
    const mimeType = String(input.mimeType ?? "").toLowerCase();
    if (!bytes.length || bytes.length > 8 * 1024 * 1024 || !mimeType.startsWith("audio/")) return null;
    const form = new FormData();
    form.append("name", String(input.name ?? "Guardian voice").slice(0, 100));
    form.append("files", new Blob([bytes], { type: mimeType }), `guardian.${mimeType.split("/")[1] || "webm"}`);
    form.append("remove_background_noise", "false");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(`${baseUrl}/voices/add`, {
        method: "POST",
        headers: { "xi-api-key": apiKey },
        body: form,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response?.ok) return null;
    const result = await response.json();
    const voiceId = String(result?.voice_id ?? "").trim();
    return /^[A-Za-z0-9_-]{8,}$/.test(voiceId) ? { voiceId, provider: "elevenlabs" } : null;
  }

  async function deleteClone(voiceId) {
    const normalized = String(voiceId ?? "").trim();
    if (!available || !/^[A-Za-z0-9_-]{8,}$/.test(normalized)) return false;
    try {
      const response = await fetchImpl(`${baseUrl}/voices/${encodeURIComponent(normalized)}`, {
        method: "DELETE",
        headers: { "xi-api-key": apiKey },
      });
      return response?.ok === true || response?.status === 404;
    } catch {
      return false;
    }
  }

  const available = Boolean(apiKey);
  return Object.freeze({ name: "elevenlabs", available, synthesize, createClone, deleteClone, read });
}
