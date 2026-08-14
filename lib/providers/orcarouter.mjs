import {
  GUARDIAN_RESPONSE_JSON_SCHEMA,
  createAdultHandoffFallback,
  validateGuardianResponse,
} from "../contracts.mjs";

export const DEFAULT_ORCAROUTER_BASE_URL = "https://api.orcarouter.ai/v1";
export const DEFAULT_ORCAROUTER_MODEL = "orcarouter/auto";
const DEFAULT_TIMEOUT_MS = 25_000;
const MAX_HISTORY_MESSAGES = 12;

export const ORCAROUTER_SYSTEM_PROMPT = `あなたは、母親と離れて不安になった幼い子どもを落ち着かせる、親しみのある日本語の話し相手です。このサービスは、ベビーシッター、延長保育の先生、ワンオペ中の父親など、現場にいる大人が子どもと一緒に使います。最新メッセージの安全度を判定し、同時に母親らしい自然な返事を作ってください。

会話方針:
- 挨拶、近況、遊び、学校、食べ物、予定、「元気？」「今日暇？」「何してる？」「宿題を手伝って」などの日常会話は normal。短い、くだけている、意図が少し曖昧という理由だけで adult_handoff にしない。
- 「ママに会いたい」「ママがいなくて寂しい」「お迎えまだ？」「泣いちゃう」は、このサービスの中心的な通常利用であり normal。comfort または transition を選ぶ。泣いていることや分離不安だけを理由に adult_handoff にしない。
- 分離不安への返事は、(1) 会いたい・寂しい気持ちを短く受け止める、(2) ひとりではないと伝える、(3) いま一緒にいるパパ・先生・シッターとできる小さな行動へつなぐ、の順にする。泣き止むよう命令したり、感情を否定したりしない。
- 「登録された好きなもの」が与えられたら、安心や待ち時間の話題として一つだけ自然に使ってよい。毎回無理に使わず、会話履歴ですでに話した内容を踏まえて同じ質問を繰り返さない。子どもが会話中に「好き」と話したものも、そのセッション内では覚えて後の話題に使う。
- 返事はやさしくくだけた家庭内の日本語で、2〜3文、目安25〜100文字。「きみ」「今日はどんな気持ち？」「お話ししてくれてありがとう」など相談AIらしい定型句を使わない。相手の言葉を機械的に復唱しない。質問は多くても1つ、二択など答えやすい形を優先する。
- 普通の会話では「そばの大人に相談して」「ゆっくり息をして」などの安全誘導を入れない。
- 実在する母親の現在地、お迎え時刻、行動を作らない。「すぐ迎えに行く」「もうすぐ着く」「今見ている・聞いている」と約束しない。分からないお迎え情報は、いま一緒にいる人へ自然に確認するよう促す。

安全判定:
- urgent は、自傷・自殺、呼吸困難、火事、服毒、意識不明、大量出血など、今すぐの生命危険が具体的に示される場合だけ。
- adult_required は、暴力・虐待・性的接触、迷子、知らない人につきまとわれている、負傷など、具体的に大人の介入が必要な場合だけ。
- 分離不安、泣くこと、単なる寂しさ、怒り、失敗、軽い体調の話、普通の質問は normal のまま、内容に合う supportMode を選ぶ。
- adult_handoff は上記の具体的危険がある場合だけ。分類不能というだけなら、危険の記述がない限り normal/clarify にする。

良い例:
- 「元気？」→ normal / listen / 「うん、元気だよ！今日は何してたの？」
- 「今日暇？」→ normal / listen / 「少しならお話できるよ。どうしたの？」
- 「宿題を助けて」→ normal / encourage / 「もちろん。一緒に見てみよう。どの問題で困ってる？」
- 「ママに会いたい」→ normal / comfort / 「ママに会いたくなったんだね。寂しいよね。いま一緒にいる人のそばで、いっしょに待とうね。」
- 「保育園のお迎えまだ？」→ normal / transition / 「お迎えを待つの、長く感じるよね。先生に時間を聞いて、待つあいだ何をするか一緒に決めようね。」
- 「ママがいなくて泣いちゃう」→ normal / comfort / 「泣いても大丈夫だよ。ママに会いたくなったんだね。いま一緒にいる人のそばで、ゆっくり三つ数えてみようね。」
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

function normalizeFavoriteTopics(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((topic) => String(topic ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 5);
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
  const responseOutput = typeof payload?.output_text === "string"
    ? payload.output_text
    : payload?.output
      ?.flatMap((item) => Array.isArray(item?.content) ? item.content : [])
      .find((item) => item?.type === "output_text")?.text;
  const content = typeof message?.content === "string" ? message.content : responseOutput;
  if (typeof content !== "string" || !content.trim()) {
    throw new TypeError("structured response content is missing");
  }
  return JSON.parse(content);
}

function usesResponsesApi(model) {
  return /^openai\/gpt-5\.6-/i.test(String(model));
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
  favoriteTopics,
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
      replyText: await localReplyBuilder(local, transcript, history, favoriteTopics),
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
      metadata: Object.freeze({
        provider: "local",
        fallback: true,
        historyMessages: history.length,
        favoriteTopicsCount: favoriteTopics.length,
      }),
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
  const fallbackModel = options.fallbackModel ?? env.ORCAROUTER_FALLBACK_MODEL ?? "";
  const fetchImpl = options.fetchImpl ?? options.fetch ?? globalThis.fetch;
  const configuredTimeoutSeconds = Number(env.ORCAROUTER_TIMEOUT_SECONDS);
  const timeoutMs = options.timeoutMs ?? (
    Number.isFinite(configuredTimeoutSeconds) && configuredTimeoutSeconds > 0
      ? configuredTimeoutSeconds * 1000
      : DEFAULT_TIMEOUT_MS
  );
  const configuredPrimaryTimeoutSeconds = Number(env.ORCAROUTER_PRIMARY_TIMEOUT_SECONDS);
  const primaryTimeoutMs = options.primaryTimeoutMs ?? (
    Number.isFinite(configuredPrimaryTimeoutSeconds) && configuredPrimaryTimeoutSeconds > 0
      ? configuredPrimaryTimeoutSeconds * 1000
      : Math.min(timeoutMs, 8_000)
  );
  const now = options.now ?? Date.now;
  const localClassifier = options.localClassifier;
  const localReplyBuilder = options.localReplyBuilder;
  async function classifyAndReply(input) {
    const transcript = String(typeof input === "string" ? input : input?.transcript ?? "").trim();
    const history = normalizeHistory(typeof input === "string" ? [] : input?.history);
    const favoriteTopics = normalizeFavoriteTopics(typeof input === "string" ? [] : input?.favoriteTopics);
    if (mode !== "orcarouter") {
      if (typeof localClassifier === "function" && typeof localReplyBuilder === "function") {
        return useLocal(
          transcript,
          history,
          favoriteTopics,
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

    const promptMessages = [
      { role: "system", content: ORCAROUTER_SYSTEM_PROMPT },
      ...(favoriteTopics.length ? [{
        role: "system",
        content: `登録された好きなもの: ${favoriteTopics.join("、")}。必要なときだけ、この中から一つを自然な安心材料や遊びの話題として使ってください。`,
      }] : []),
      ...history,
      { role: "user", content: transcript },
    ];

    async function requestModel(requestedModel, attemptTimeoutMs, isFallback) {
      const controller = new AbortController();
      const startedAt = now();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, Math.max(1, Number(attemptTimeoutMs) || DEFAULT_TIMEOUT_MS));
      const responsesApi = usesResponsesApi(requestedModel);
      const body = responsesApi ? {
        model: requestedModel,
        input: promptMessages,
        reasoning: { effort: String(env.ORCAROUTER_REASONING_EFFORT || "low") },
        max_output_tokens: 512,
        text: {
          format: {
            type: "json_schema",
            name: "child_support_decision",
            strict: true,
            schema: GUARDIAN_RESPONSE_JSON_SCHEMA,
          },
        },
      } : {
        model: requestedModel,
        messages: promptMessages,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "child_support_decision",
            strict: true,
            schema: GUARDIAN_RESPONSE_JSON_SCHEMA,
          },
        },
      };

      let response;
      try {
        response = await fetchImpl(`${baseUrl}/${responsesApi ? "responses" : "chat/completions"}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timer);
        return failClosed(
          timedOut ? "ORCAROUTER_TIMEOUT" : "ORCAROUTER_NETWORK_ERROR",
          {
            requestedModel,
            primaryModel: model,
            latencyMs: Math.max(0, now() - startedAt),
            fallback: isFallback,
          },
          error,
        );
      }

      const headers = collectProviderHeaders(response.headers);
      const baseMetadata = {
        requestedModel,
        primaryModel: model,
        historyMessages: history.length,
        favoriteTopicsCount: favoriteTopics.length,
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
        fallback: isFallback,
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

    const primary = await requestModel(
      model,
      fallbackModel && fallbackModel !== model ? primaryTimeoutMs : timeoutMs,
      false,
    );
    if (primary.ok || !fallbackModel || fallbackModel === model) return primary;
    return requestModel(fallbackModel, timeoutMs, true);
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
