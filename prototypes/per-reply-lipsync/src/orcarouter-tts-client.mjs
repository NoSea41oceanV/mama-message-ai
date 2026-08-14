import { PrototypeError } from "./errors.mjs";

const FORMAT_CONTENT_TYPES = Object.freeze({
  mp3: "audio/mpeg",
  opus: "audio/opus",
  aac: "audio/aac",
  flac: "audio/flac",
  wav: "audio/wav",
  pcm: "audio/L16",
});

function cleanHttpsBaseUrl(value) {
  const url = new URL(String(value ?? "https://api.orcarouter.ai/v1").replace(/\/+$/, ""));
  if (url.protocol !== "https:") {
    throw new PrototypeError("ORCAROUTER_INSECURE_BASE_URL", "OrcaRouter base URL must use HTTPS");
  }
  return url.toString().replace(/\/$/, "");
}

function positiveNumber(value, fallback) {
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized > 0 ? normalized : fallback;
}

export function createOrcaRouterTtsClient(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const apiKey = String(options.apiKey ?? "").trim();
  const baseUrl = cleanHttpsBaseUrl(options.baseUrl);
  const timeoutMs = positiveNumber(options.timeoutMs, 30_000);
  const maxInputChars = positiveNumber(options.maxInputChars, 4_096);
  const maxAudioBytes = positiveNumber(options.maxAudioBytes, 6 * 1024 * 1024);
  const defaultModel = String(options.model ?? "openai/gpt-4o-mini-tts");

  if (typeof fetchImpl !== "function") {
    throw new PrototypeError("ORCAROUTER_FETCH_REQUIRED", "fetch implementation is required");
  }

  async function synthesize({
    input,
    model = defaultModel,
    voice = "alloy",
    responseFormat = "mp3",
    speed,
    instructions,
  } = {}) {
    const normalizedInput = String(input ?? "").trim();
    if (!apiKey) throw new PrototypeError("ORCAROUTER_NOT_CONFIGURED", "OrcaRouter TTS is not configured");
    if (!normalizedInput || normalizedInput.length > maxInputChars) {
      throw new PrototypeError("ORCAROUTER_TTS_INPUT_INVALID", "TTS input is empty or exceeds the configured limit");
    }
    if (!FORMAT_CONTENT_TYPES[responseFormat]) {
      throw new PrototypeError("ORCAROUTER_TTS_FORMAT_INVALID", "unsupported TTS response format");
    }

    const body = {
      model: String(model),
      input: normalizedInput,
      voice: String(voice),
      response_format: responseFormat,
    };
    if (speed !== undefined) {
      const normalizedSpeed = Number(speed);
      if (!Number.isFinite(normalizedSpeed) || normalizedSpeed < 0.25 || normalizedSpeed > 4) {
        throw new PrototypeError("ORCAROUTER_TTS_SPEED_INVALID", "TTS speed must be between 0.25 and 4");
      }
      body.speed = normalizedSpeed;
    }
    if (instructions) body.instructions = String(instructions);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}/audio/speech`, {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: FORMAT_CONTENT_TYPES[responseFormat],
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new PrototypeError(
          "ORCAROUTER_TTS_HTTP_ERROR",
          `OrcaRouter TTS returned HTTP ${response.status}`,
          { status: response.status },
        );
      }
      const declaredLength = Number(response.headers?.get?.("content-length") ?? 0);
      if (declaredLength > maxAudioBytes) {
        throw new PrototypeError("ORCAROUTER_TTS_AUDIO_TOO_LARGE", "TTS audio exceeds the configured size limit");
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0 || bytes.byteLength > maxAudioBytes) {
        throw new PrototypeError("ORCAROUTER_TTS_AUDIO_INVALID", "TTS returned empty or oversized audio");
      }
      return Object.freeze({
        bytes,
        contentType: response.headers?.get?.("content-type") || FORMAT_CONTENT_TYPES[responseFormat],
        responseFormat,
      });
    } catch (error) {
      if (error instanceof PrototypeError) throw error;
      if (controller.signal.aborted) {
        throw new PrototypeError("ORCAROUTER_TTS_TIMEOUT", "OrcaRouter TTS timed out", { cause: error });
      }
      throw new PrototypeError("ORCAROUTER_TTS_NETWORK_ERROR", "OrcaRouter TTS request failed", { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({ synthesize });
}
