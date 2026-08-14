const DEFAULT_BASE_URL = "https://api.elevenlabs.io/v1";
const DEFAULT_MODEL = "eleven_multilingual_v2";
const DEFAULT_OUTPUT_FORMAT = "mp3_44100_128";
const MAX_TTS_BYTES = 10 * 1024 * 1024;
const MIN_SPEECH_RATE = 0.7;
const MAX_SPEECH_RATE = 1.2;
const DEFAULT_SPEECH_RATE = 0.82;
const DEFAULT_STABILITY = 0.45;
const DEFAULT_SIMILARITY_BOOST = 0.85;
const DEFAULT_STYLE = 0.2;

const extensionsByMimeType = Object.freeze({
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/webm": "webm",
});

export class ElevenLabsError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "ElevenLabsError";
    this.code = code;
    this.status = options.status ?? null;
  }
}

function normalizedBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
}

function normalizedMimeType(value) {
  return String(value ?? "").split(";", 1)[0].trim().toLowerCase();
}

function normalizedSpeechRate(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_SPEECH_RATE;
  return Math.round(Math.min(MAX_SPEECH_RATE, Math.max(MIN_SPEECH_RATE, numeric)) * 100) / 100;
}

function normalizedUnitSetting(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.round(Math.min(1, Math.max(0, numeric)) * 100) / 100;
}

async function errorDetail(response) {
  try {
    const body = await response.json();
    const detail = body?.detail;
    if (typeof detail === "string") return detail;
    if (typeof detail?.message === "string") return detail.message;
    if (typeof body?.message === "string") return body.message;
  } catch {
    // Keep provider error details out of child-facing responses.
  }
  return `HTTP ${response.status}`;
}

function withTimeout(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

function assertAvailable(providerName, apiKey) {
  if (providerName !== "elevenlabs" || !apiKey) {
    throw new ElevenLabsError("ELEVENLABS_NOT_CONFIGURED", "ElevenLabs voice cloning is not configured");
  }
}

export function createElevenLabsProvider(options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const providerName = String(options.provider ?? env.VOICE_CLONING_PROVIDER ?? "disabled").trim().toLowerCase();
  const apiKey = String(options.apiKey ?? env.ELEVENLABS_API_KEY ?? "").trim();
  const baseUrl = normalizedBaseUrl(options.baseUrl ?? env.ELEVENLABS_BASE_URL);
  const modelId = String(options.modelId ?? env.ELEVENLABS_MODEL ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const outputFormat = String(options.outputFormat ?? env.ELEVENLABS_OUTPUT_FORMAT ?? DEFAULT_OUTPUT_FORMAT).trim() || DEFAULT_OUTPUT_FORMAT;
  const stability = normalizedUnitSetting(options.stability ?? env.ELEVENLABS_STABILITY, DEFAULT_STABILITY);
  const similarityBoost = normalizedUnitSetting(
    options.similarityBoost ?? env.ELEVENLABS_SIMILARITY_BOOST,
    DEFAULT_SIMILARITY_BOOST,
  );
  const style = normalizedUnitSetting(options.style ?? env.ELEVENLABS_STYLE, DEFAULT_STYLE);
  const useSpeakerBoost = String(options.useSpeakerBoost ?? env.ELEVENLABS_SPEAKER_BOOST ?? "true").toLowerCase() !== "false";
  const timeoutMs = Math.max(1, Number(options.timeoutMs ?? env.ELEVENLABS_TIMEOUT_SECONDS ?? 45) * 1000);
  const available = providerName === "elevenlabs" && Boolean(apiKey);

  async function request(path, init) {
    assertAvailable(providerName, apiKey);
    const timeout = withTimeout(timeoutMs);
    try {
      return await fetchImpl(`${baseUrl}${path}`, {
        ...init,
        headers: {
          "xi-api-key": apiKey,
          ...(init?.headers ?? {}),
        },
        signal: timeout.signal,
      });
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new ElevenLabsError("ELEVENLABS_TIMEOUT", "ElevenLabs request timed out");
      }
      throw new ElevenLabsError("ELEVENLABS_UNAVAILABLE", "ElevenLabs could not be reached");
    } finally {
      timeout.clear();
    }
  }

  async function cloneVoice(input = {}) {
    const bytes = Buffer.isBuffer(input.bytes) ? input.bytes : Buffer.from(input.bytes ?? []);
    const mimeType = normalizedMimeType(input.mimeType);
    const extension = extensionsByMimeType[mimeType];
    if (!bytes.length || !extension) {
      throw new ElevenLabsError("ELEVENLABS_SAMPLE_INVALID", "A supported voice sample is required");
    }
    const form = new FormData();
    form.append("name", String(input.name || "Mama Message guardian voice").slice(0, 100));
    form.append("description", "本人同意済みのMama Message AI保護者音声");
    form.append("files", new Blob([bytes], { type: mimeType }), `guardian-voice.${extension}`);
    const response = await request("/voices/add", { method: "POST", body: form });
    if (!response.ok) {
      const detail = await errorDetail(response);
      throw new ElevenLabsError("ELEVENLABS_CLONE_FAILED", detail, { status: response.status });
    }
    const result = await response.json();
    const voiceId = String(result?.voice_id ?? "").trim();
    if (!voiceId) throw new ElevenLabsError("ELEVENLABS_CLONE_RESPONSE_INVALID", "ElevenLabs did not return a voice ID");
    return Object.freeze({ provider: "elevenlabs", voiceId });
  }

  async function synthesize(input = {}) {
    const voiceId = String(input.voiceId ?? "").trim();
    const text = String(input.text ?? "").trim();
    if (!voiceId || !text) throw new ElevenLabsError("ELEVENLABS_TTS_INPUT_INVALID", "A voice ID and text are required");
    const response = await request(`/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(outputFormat)}`, {
      method: "POST",
      headers: {
        accept: "audio/mpeg",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        language_code: "ja",
        voice_settings: {
          stability,
          similarity_boost: similarityBoost,
          style,
          use_speaker_boost: useSpeakerBoost,
          speed: normalizedSpeechRate(input.speed),
        },
      }),
    });
    if (!response.ok) {
      const detail = await errorDetail(response);
      throw new ElevenLabsError("ELEVENLABS_TTS_FAILED", detail, { status: response.status });
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_TTS_BYTES) {
      bytes.fill(0);
      throw new ElevenLabsError("ELEVENLABS_TTS_RESPONSE_INVALID", "ElevenLabs returned invalid audio");
    }
    return Object.freeze({ bytes, mimeType: normalizedMimeType(response.headers.get("content-type")) || "audio/mpeg" });
  }

  async function deleteVoice(voiceId) {
    const normalizedVoiceId = String(voiceId ?? "").trim();
    if (!normalizedVoiceId || !available) return false;
    const response = await request(`/voices/${encodeURIComponent(normalizedVoiceId)}`, { method: "DELETE" });
    if (response.status === 404) return false;
    if (!response.ok) {
      const detail = await errorDetail(response);
      throw new ElevenLabsError("ELEVENLABS_DELETE_FAILED", detail, { status: response.status });
    }
    return true;
  }

  async function verify() {
    const response = await request("/voices?page_size=1", { method: "GET" });
    if (!response.ok) {
      const detail = await errorDetail(response);
      throw new ElevenLabsError("ELEVENLABS_AUTH_FAILED", detail, { status: response.status });
    }
    return true;
  }

  return Object.freeze({
    name: providerName,
    available,
    modelId,
    cloneVoice,
    synthesize,
    deleteVoice,
    verify,
  });
}
