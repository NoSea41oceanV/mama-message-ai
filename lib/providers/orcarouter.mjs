import {
  GUARDIAN_RESPONSE_JSON_SCHEMA,
  createAdultHandoffFallback,
  validateGuardianResponse,
} from "../contracts.mjs";

export const DEFAULT_ORCAROUTER_BASE_URL = "https://api.orcarouter.ai/v1";
export const DEFAULT_ORCAROUTER_MODEL = "orcarouter/auto";
const DEFAULT_TIMEOUT_MS = 25_000;
const MAX_HISTORY_MESSAGES = 12;

function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((message) => message && ["user", "assistant"].includes(message.role))
    .map((message) => ({
      role: message.role,
      content: String(message.content ?? "").trim(),
    }))
    .filter((message) => message.content)
    .slice(-MAX_HISTORY_MESSAGES);
}

function collectProviderHeaders(headers) {
  const selected = {};
  if (!headers || typeof headers.entries !== "function") return selected;
  for (const [name, value] of headers.entries()) {
    const normalized = name.toLowerCase();
    if (normalized.startsWith("x-orca-") || normalized === "x-request-id" || normalized === "request-id") {
      selected[normalized] = value;
    }
  }
  return selected;
}

function parseStructuredContent(payload) {
  const message = payload?.choices?.[0]?.message;
  if (message?.parsed && typeof message.parsed === "object") return message.parsed;
  if (typeof message?.content !== "string" || !message.content.trim()) {
    throw new TypeError("structured response content is missing");
  }
  return JSON.parse(message.content);
}

function resultWithDecision(decision, values) {
  return Object.freeze({ ...decision, ...values, decision });
}

function failClosed(reasonCode, metadata = {}, cause = reasonCode) {
  const decision = createAdultHandoffFallback(reasonCode);
  return resultWithDecision(decision, {
    status: "fail_closed",
    available: true,
    ok: false,
    error: Object.freeze({
      code: reasonCode,
      message: cause instanceof Error ? cause.message : String(cause),
    }),
    metadata: Object.freeze({ provider: "orcarouter", ...metadata, fallback: true }),
  });
}

async function useLocal(
  transcript,
  history,
  localClassifier,
  localReplyBuilder,
  reasonCode = "ORCAROUTER_API_KEY_MISSING",
  reasonMessage = "OrcaRouter is unavailable; injected local fallback was used",
) {
  try {
    const local = await localClassifier(transcript, history);
    const presentation = {
      celebrate: ["bright", "smiling"],
      comfort: ["gentle", "warm"],
      calm: ["slow and calm", "reassuring"],
      encourage: ["encouraging", "supportive"],
      adult_handoff: ["calm", "concerned"],
    }[local?.supportMode] ?? ["warm", "attentive"];
    const decision = validateGuardianResponse({
      safetyLevel: local?.safetyLevel,
      supportMode: local?.supportMode,
      emotion: local?.emotion,
      reasonCodes: local?.reasonCodes,
      replyText: await localReplyBuilder(local, transcript, history),
      voiceTone: local?.voiceTone ?? presentation[0],
      expression: local?.expression ?? presentation[1],
    });
    return resultWithDecision(decision, {
      status: "unavailable",
      available: false,
      ok: true,
      error: Object.freeze({
        code: reasonCode,
        message: reasonMessage,
      }),
      metadata: Object.freeze({ provider: "local", fallback: true, historyMessages: history.length }),
    });
  } catch (error) {
    return failClosed("LOCAL_FALLBACK_INVALID", { source: "local" }, error);
  }
}

function unavailable(model, code = "ORCAROUTER_API_KEY_MISSING", message = "ORCAROUTER_API_KEY is not configured") {
  return Object.freeze({
    status: "unavailable",
    available: false,
    ok: false,
    decision: null,
    error: Object.freeze({
      code,
      message,
    }),
    metadata: Object.freeze({ provider: "orcarouter", requestedModel: model, fallback: false }),
  });
}

export function createOrcaRouterProvider(options = {}) {
  const env = options.env ?? process.env;
  const mode = String(options.mode ?? env.ROUTER_PROVIDER ?? "demo").trim().toLowerCase();
  const apiKey = String(options.apiKey ?? env.ORCAROUTER_API_KEY ?? "").trim();
  const baseUrl = String(options.baseUrl ?? env.ORCAROUTER_BASE_URL ?? DEFAULT_ORCAROUTER_BASE_URL)
    .replace(/\/+$/, "");
  const model = options.model ?? env.ORCAROUTER_MODEL ?? DEFAULT_ORCAROUTER_MODEL;
  const fetchImpl = options.fetchImpl ?? options.fetch ?? globalThis.fetch;
  const configuredTimeoutSeconds = Number(env.ORCAROUTER_TIMEOUT_SECONDS);
  const timeoutMs = options.timeoutMs ?? (
    Number.isFinite(configuredTimeoutSeconds) && configuredTimeoutSeconds > 0
      ? configuredTimeoutSeconds * 1000
      : DEFAULT_TIMEOUT_MS
  );
  const now = options.now ?? Date.now;
  const localClassifier = options.localClassifier;
  const localReplyBuilder = options.localReplyBuilder;
  async function classifyAndReply(input) {
    const transcript = String(typeof input === "string" ? input : input?.transcript ?? "").trim();
    const history = normalizeHistory(typeof input === "string" ? [] : input?.history);
    if (mode !== "orcarouter") {
      if (typeof localClassifier === "function" && typeof localReplyBuilder === "function") {
        return useLocal(
          transcript,
          history,
          localClassifier,
          localReplyBuilder,
          "ORCAROUTER_DISABLED",
          "ROUTER_PROVIDER is not set to orcarouter; injected local fallback was used",
        );
      }
      return unavailable(model, "ORCAROUTER_DISABLED", "ROUTER_PROVIDER is not set to orcarouter");
    }
    if (!apiKey) return unavailable(model);
    if (typeof fetchImpl !== "function") {
      return failClosed("ORCAROUTER_FETCH_UNAVAILABLE", { requestedModel: model }, "fetch is unavailable");
    }

    const controller = new AbortController();
    const startedAt = now();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));

    let response;
    try {
      response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "system",
              content: "Classify the latest Japanese message from a young child and draft a brief, natural, guardian-like supportive reply. Use the supplied conversation history to continue the same exchange without repeating a stock phrase. Do not claim the reply is literally from the guardian. Any ambiguity or safety concern must use adult_handoff. Return only the required structured fields.",
            },
            ...history,
            { role: "user", content: transcript },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "child_support_decision",
              strict: true,
              schema: GUARDIAN_RESPONSE_JSON_SCHEMA,
            },
          },
        }),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      return failClosed(
        timedOut ? "ORCAROUTER_TIMEOUT" : "ORCAROUTER_NETWORK_ERROR",
        { requestedModel: model, latencyMs: Math.max(0, now() - startedAt) },
        error,
      );
    }

    const headers = collectProviderHeaders(response.headers);
    const baseMetadata = {
      requestedModel: model,
      historyMessages: history.length,
      httpStatus: response.status,
      latencyMs: Math.max(0, now() - startedAt),
      headers,
      orcaHeaders: Object.fromEntries(
        Object.entries(headers).filter(([name]) => name.startsWith("x-orca-")),
      ),
    };
    if (!response.ok) {
      clearTimeout(timer);
      return failClosed("ORCAROUTER_HTTP_ERROR", baseMetadata, `OrcaRouter returned HTTP ${response.status}`);
    }

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      clearTimeout(timer);
      return failClosed(timedOut ? "ORCAROUTER_TIMEOUT" : "ORCAROUTER_INVALID_JSON", baseMetadata, error);
    }

    const metadata = Object.freeze({
      provider: "orcarouter",
      fallback: false,
      ...baseMetadata,
      resolvedModel: response.headers?.get?.("X-Orca-Resolved-Model") || payload.model || null,
      requestId: response.headers?.get?.("X-Orca-Request-Id")
        || response.headers?.get?.("X-Request-Id")
        || payload.id
        || null,
      usage: payload?.usage && typeof payload.usage === "object" ? payload.usage : null,
    });

    try {
      const decision = validateGuardianResponse(parseStructuredContent(payload));
      return resultWithDecision(decision, {
        status: "available",
        available: true,
        ok: true,
        error: null,
        metadata,
      });
    } catch (error) {
      return failClosed("ORCAROUTER_INVALID_RESPONSE", {
        ...metadata,
        usage: payload?.usage ?? null,
      }, error);
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({
    name: "orcarouter",
    mode,
    available: mode === "orcarouter" && Boolean(apiKey),
    baseUrl,
    model,
    classifyAndReply,
    route: classifyAndReply,
    analyze: classifyAndReply,
  });
}

export async function classifyAndReply(input, options = {}) {
  return createOrcaRouterProvider(options).classifyAndReply(input);
}

export const routeWithOrcaRouter = classifyAndReply;
