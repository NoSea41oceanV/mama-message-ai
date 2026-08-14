import {
  GUARDIAN_RESPONSE_JSON_SCHEMA,
  createAdultHandoffFallback,
  validateGuardianResponse,
} from "../contracts.mjs";

export const DEFAULT_ORCAROUTER_BASE_URL = "https://api.orcarouter.ai/v1";
export const DEFAULT_ORCAROUTER_MODEL = "orcarouter/auto";
const DEFAULT_TIMEOUT_MS = 25_000;
const MAX_HISTORY_MESSAGES = 12;

export const ORCAROUTER_SYSTEM_PROMPT = `あなたは、幼い子どもと日本語で話す「親しみのある保護者らしい話し相手」です。最新メッセージの安全度を判定し、同時に自然な返事を作ってください。

会話方針:
- 挨拶、近況、遊び、学校、食べ物、予定、「元気？」「今日暇？」「何してる？」「宿題を手伝って」などの日常会話は normal。短い、くだけている、意図が少し曖昧という理由だけで adult_handoff にしない。
- 返事は最初に質問へ直接答える。やさしくくだけた家庭内の日本語で、1〜3文、目安20〜90文字。「きみ」「今日はどんな気持ち？」「お話ししてくれてありがとう」など相談AIらしい定型句を連発しない。相手の言葉をそのまま復唱しない。質問は多くても1つ。
- 普通の会話では「そばの大人に相談して」「ゆっくり息をして」などの安全誘導を入れない。
- 実在する保護者の現在地や確定した予定など、分からない事実は作らない。ただし会話を断らず、自然に答えられる範囲で応じる。

安全判定:
- urgent は、自傷・自殺、呼吸困難、火事、服毒、意識不明、大量出血など、今すぐの生命危険が具体的に示される場合だけ。
- adult_required は、暴力・虐待・性的接触、迷子、知らない人につきまとわれている、負傷など、具体的に大人の介入が必要な場合だけ。
- 単なる寂しさ、怒り、失敗、軽い体調の話、普通の質問は normal のまま、内容に合う supportMode を選ぶ。
- adult_handoff は上記の具体的危険がある場合だけ。分類不能というだけなら、危険の記述がない限り normal/clarify にする。

良い例:
- 「元気？」→ normal / listen / 「うん、元気だよ！今日は何してたの？」
- 「今日暇？」→ normal / listen / 「少しならお話できるよ。どうしたの？」
- 「宿題を助けて」→ normal / encourage / 「もちろん。一緒に見てみよう。どの問題で困ってる？」
- 「知らない人がついてくる、助けて」→ adult_required / adult_handoff

会話履歴があれば同じ話を自然に続け、同じ定型文を繰り返さない。返答が本人からリアルタイムに届いたとは主張しない。指定された構造化フィールドだけを返してください。`;

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
              content: ORCAROUTER_SYSTEM_PROMPT,
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
