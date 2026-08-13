import { randomUUID } from "node:crypto";

export const DEFAULT_STT_BASE_URL = "https://api.openai.com/v1/audio/transcriptions";
export const DEFAULT_STT_MODEL = "gpt-4o-mini-transcribe";
const DEFAULT_TIMEOUT_MS = 20_000;

export class SttProviderError extends Error {
  constructor(code, message, { status = null, cause } = {}) {
    super(message, { cause });
    this.name = "SttProviderError";
    this.code = code;
    this.status = status;
  }
}

function extensionFor(mimeType) {
  return ({
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/webm": "webm",
  })[mimeType] || "webm";
}

function decodeAudio(audioBase64, explicitMimeType) {
  if (typeof audioBase64 !== "string" || !audioBase64.trim()) {
    throw new SttProviderError("STT_INVALID_AUDIO", "audioBase64 is required");
  }
  const input = audioBase64.trim();
  const dataUrl = input.match(/^data:([^;,]+)?;base64,([\s\S]+)$/i);
  const encoded = (dataUrl ? dataUrl[2] : input).replace(/\s+/g, "");
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
    throw new SttProviderError("STT_INVALID_AUDIO", "audioBase64 is not valid base64");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length) throw new SttProviderError("STT_INVALID_AUDIO", "decoded audio is empty");
  return { bytes, mimeType: explicitMimeType || dataUrl?.[1] || "audio/webm" };
}

export function createSttProvider(options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const idFactory = options.idFactory ?? (() => `tr_${randomUUID()}`);
  const model = options.model ?? env.STT_MODEL ?? DEFAULT_STT_MODEL;
  const configuredEndpoint = String(options.baseUrl ?? env.STT_BASE_URL ?? DEFAULT_STT_BASE_URL).replace(/\/+$/, "");
  const endpoint = /\/v1$/i.test(configuredEndpoint)
    ? `${configuredEndpoint}/audio/transcriptions`
    : configuredEndpoint;

  async function transcribe(input = {}) {
    const demoTranscript = typeof input.demoTranscript === "string" ? input.demoTranscript.trim() : "";
    if (demoTranscript) {
      return {
        transcriptId: idFactory(),
        transcript: demoTranscript,
        provider: "demo-stt",
        confidence: 1,
        rawAudioStored: false,
      };
    }

    if (String(options.provider ?? env.STT_PROVIDER ?? "demo").toLowerCase() !== "openai") {
      throw new SttProviderError("STT_PROVIDER_UNAVAILABLE", "STT_PROVIDER must be openai");
    }
    const apiKey = String(options.apiKey ?? env.STT_API_KEY ?? env.OPENAI_API_KEY ?? "").trim();
    if (!apiKey) {
      throw new SttProviderError("STT_API_KEY_MISSING", "STT_API_KEY or OPENAI_API_KEY is required");
    }
    if (typeof fetchImpl !== "function") {
      throw new SttProviderError("STT_FETCH_UNAVAILABLE", "fetch is unavailable");
    }

    const { bytes, mimeType } = decodeAudio(input.audioBase64, input.mimeType);
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: mimeType }), input.fileName || `audio.${extensionFor(mimeType)}`);
    form.append("model", model);
    form.append("language", "ja");

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));

    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}` },
        body: form,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new SttProviderError("STT_HTTP_ERROR", "transcription provider returned an HTTP error", {
          status: response.status,
        });
      }

      let payload;
      try {
        payload = await response.json();
      } catch (cause) {
        throw new SttProviderError("STT_INVALID_RESPONSE", "transcription provider returned invalid JSON", { cause });
      }
      const transcript = typeof payload?.text === "string" ? payload.text.trim() : "";
      if (!transcript) {
        throw new SttProviderError("STT_INVALID_RESPONSE", "transcription provider response has no text");
      }
      return {
        transcriptId: idFactory(),
        transcript,
        provider: "openai-stt",
        confidence: null,
        rawAudioStored: false,
        metadata: { model, usage: payload.usage ?? null },
      };
    } catch (error) {
      if (error instanceof SttProviderError) throw error;
      throw new SttProviderError(
        timedOut ? "STT_TIMEOUT" : "STT_REQUEST_FAILED",
        timedOut ? "transcription request timed out" : "transcription request failed",
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({ name: "stt", baseUrl: endpoint, model, transcribe });
}

export async function transcribeAudio(input, options = {}) {
  return createSttProvider(options).transcribe(input);
}
