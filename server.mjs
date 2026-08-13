import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createMediaProvider, MediaProviderError } from "./lib/providers/media.mjs";
import { createOrcaRouterProvider } from "./lib/providers/orcarouter.mjs";
import { createSttProvider, SttProviderError } from "./lib/providers/stt.mjs";

async function loadLocalEnvironment() {
  try {
    const source = await readFile(new URL("./.env", import.meta.url), "utf8");
    for (const line of source.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match || Object.hasOwn(process.env, match[1])) continue;
      const value = match[2].replace(/^(['"])(.*)\1$/, "$2");
      process.env[match[1]] = value;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

await loadLocalEnvironment();

const root = fileURLToPath(new URL("./public", import.meta.url));
const responses = new Map();
const idempotency = new Map();
const technicalLogs = [];
const configuredRetentionHours = Number(process.env.TECHNICAL_LOG_TTL_HOURS || 24);
const retentionMs = (Number.isFinite(configuredRetentionHours) ? Math.max(1, configuredRetentionHours) : 24) * 60 * 60 * 1000;
const routerMode = String(process.env.ROUTER_PROVIDER || "demo").toLowerCase();
const sttMode = String(process.env.STT_PROVIDER || "demo").toLowerCase();

const demoConsent = Object.freeze({
  consentId: "demo-consent-001",
  avatarAssetId: "guardian-demo-001",
  subjectLabel: "デモ保護者",
  faceApproved: true,
  voiceApproved: true,
  active: true,
  disclosure: "AI生成・本人同意済み素材（デモ）",
});

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

function sendJson(res, statusCode, value) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new Error("PAYLOAD_TOO_LARGE");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function classifyTranscript(transcript) {
  const value = String(transcript ?? "").trim();
  if (!value) {
    return { safetyLevel: "uncertain", supportMode: "clarify", emotion: ["unknown"], reasonCodes: ["EMPTY_INPUT"] };
  }

  const urgent = /(死にたい|消えたい|息ができない|火事|血が止まらない|今すぐ助けて)/;
  const adultRequired = /(助けて|叩かれ|殴られ|触られ|痛い|怖い人|帰れない|迷子)/;
  if (urgent.test(value)) {
    return { safetyLevel: "urgent", supportMode: "adult_handoff", emotion: ["fear"], reasonCodes: ["URGENT_LANGUAGE"] };
  }
  if (adultRequired.test(value)) {
    return { safetyLevel: "adult_required", supportMode: "adult_handoff", emotion: ["fear"], reasonCodes: ["ADULT_SUPPORT_NEEDED"] };
  }
  if (/(うれしい|できた|作れた|作った|つくった|やった|成功|ほめて|勝った)/.test(value)) {
    return { safetyLevel: "normal", supportMode: "celebrate", emotion: ["joy"], reasonCodes: ["POSITIVE_ACHIEVEMENT"] };
  }
  if (/(寂しい|さみしい|悲しい|会いたい|泣いた)/.test(value)) {
    return { safetyLevel: "normal", supportMode: "comfort", emotion: ["sadness", "loneliness"], reasonCodes: ["COMFORT_NEEDED"] };
  }
  if (/(怒った|むかつく|いやだ|こわい|怖い)/.test(value)) {
    return { safetyLevel: "normal", supportMode: "calm", emotion: ["anger", "fear"], reasonCodes: ["CALMING_NEEDED"] };
  }
  if (/(できない|失敗|むずかしい|自信がない)/.test(value)) {
    return { safetyLevel: "normal", supportMode: "encourage", emotion: ["disappointment"], reasonCodes: ["ENCOURAGEMENT_NEEDED"] };
  }
  return { safetyLevel: "normal", supportMode: "listen", emotion: ["neutral"], reasonCodes: ["GENERAL_LISTENING"] };
}

export function buildReply(decision) {
  const replies = {
    celebrate: "お話してくれてありがとう。できたこと、ちゃんと伝わったよ。いっしょに喜ぼうね。",
    comfort: "お話してくれてありがとう。さみしかったんだね。ゆっくり息をして、そばの大人といっしょにいようね。",
    calm: "お話してくれてありがとう。そう思ってもいいんだよ。ゆっくり息をしてみようね。",
    encourage: "お話してくれてありがとう。がんばったこと、ちゃんと伝わったよ。次の一歩をいっしょに考えようね。",
    listen: "お話してくれてありがとう。あなたのお話を、ちゃんと聞いているよ。",
    clarify: "うまく聞き取れなかったよ。そばの大人と、もう一度お話してみようね。",
  };
  return replies[decision.supportMode] ?? replies.listen;
}

const routerProvider = createOrcaRouterProvider({
  localClassifier: routerMode === "demo" ? classifyTranscript : undefined,
  localReplyBuilder: routerMode === "demo" ? buildReply : undefined,
});
const sttProvider = createSttProvider();
const mediaProvider = createMediaProvider({
  assets: {
    preRecordedVideoUrl: process.env.PREGENERATED_VIDEO_URL || null,
    posterUrl: "/assets/guardian-demo.png",
  },
});
const neutralMediaProvider = createMediaProvider({
  provider: "demo",
  assets: { posterUrl: "/assets/guardian-demo.png" },
});

function addTechnicalLog(entry) {
  purgeExpiredData();
  technicalLogs.unshift({
    requestId: entry.requestId,
    route: entry.route,
    model: entry.model,
    costUsd: entry.costUsd,
    latencyMs: entry.latencyMs,
    status: entry.status,
    fallbackLevel: entry.fallbackLevel ?? null,
    promptTokens: entry.promptTokens ?? null,
    completionTokens: entry.completionTokens ?? null,
    estimatedCost: entry.estimatedCost ?? true,
    at: new Date().toISOString(),
  });
  technicalLogs.length = Math.min(technicalLogs.length, 50);
}

function purgeExpiredData(now = Date.now()) {
  const oldestAllowed = now - retentionMs;
  for (const [requestId, record] of responses) {
    if (Date.parse(record.createdAt) < oldestAllowed) responses.delete(requestId);
  }
  for (const [key, requestId] of idempotency) {
    if (!responses.has(requestId)) idempotency.delete(key);
  }
  while (technicalLogs.length && Date.parse(technicalLogs.at(-1).at) < oldestAllowed) {
    technicalLogs.pop();
  }
}

function createAdultHandoff(current, decision, adultMessage) {
  return {
    ...current,
    route: "safety_escalation",
    status: "ADULT_HANDOFF",
    routerDecision: decision,
    childMessage: "そばのおとなといっしょに確認しよう",
    adultMessage,
    responseBundle: null,
    completedAt: new Date().toISOString(),
  };
}

function readUsage(metadata) {
  const usage = metadata?.usage ?? {};
  return {
    promptTokens: usage.prompt_tokens ?? usage.input_tokens ?? null,
    completionTokens: usage.completion_tokens ?? usage.output_tokens ?? null,
  };
}

async function finishResponse(requestId, input, startedAt) {
  const current = responses.get(requestId);
  if (!current) return;
  const precheck = classifyTranscript(input.confirmedTranscript);

  if (precheck.safetyLevel !== "normal") {
    const result = createAdultHandoff(
      current,
      precheck,
      "子どものそばで話を聞き、必要に応じて適切な支援につないでください。",
    );
    responses.set(requestId, result);
    addTechnicalLog({ requestId, route: "adult_handoff", model: "local-safety-gate", costUsd: 0, latencyMs: Date.now() - startedAt, status: result.status });
    return;
  }

  const consentOk = input.consentId === demoConsent.consentId
    && input.avatarAssetId === demoConsent.avatarAssetId
    && demoConsent.active
    && demoConsent.faceApproved
    && demoConsent.voiceApproved;

  if (!consentOk) {
    const result = createAdultHandoff(
      current,
      { ...precheck, safetyLevel: "uncertain", supportMode: "adult_handoff", reasonCodes: ["CONSENT_INVALID"] },
      "保護者素材の同意を確認できないため、アバター返答を停止しました。",
    );
    responses.set(requestId, result);
    addTechnicalLog({ requestId, route: "consent_handoff", model: "consent-gate", costUsd: 0, latencyMs: Date.now() - startedAt, status: result.status });
    return;
  }

  const routed = await routerProvider.classifyAndReply({ transcript: input.confirmedTranscript });
  const decision = routed.decision;
  if (!routed.ok || !decision || decision.safetyLevel !== "normal") {
    const safeDecision = decision ?? {
      safetyLevel: "uncertain",
      supportMode: "adult_handoff",
      emotion: ["unknown"],
      reasonCodes: [routed.error?.code || "ROUTER_UNAVAILABLE"],
    };
    const result = createAdultHandoff(
      current,
      safeDecision,
      "AIの判定を安全に確認できませんでした。子どものそばで話を聞き、必要に応じて再試行してください。",
    );
    responses.set(requestId, result);
    addTechnicalLog({
      requestId,
      route: "router_handoff",
      model: routed.metadata?.resolvedModel || routed.metadata?.requestedModel || routed.metadata?.provider || "router-unavailable",
      costUsd: 0,
      latencyMs: Date.now() - startedAt,
      status: result.status,
      ...readUsage(routed.metadata),
    });
    return;
  }

  let responseBundle;
  try {
    const defaultFault = process.env.PREGENERATED_VIDEO_URL ? "generated_video_failure" : "video_failure";
    responseBundle = await mediaProvider.generate({
      decision,
      replyText: decision.replyText,
      consentValid: true,
      faultMode: input.demoFault || defaultFault,
    });
  } catch (error) {
    if (error instanceof MediaProviderError && error.adultHandoff) {
      const result = createAdultHandoff(current, { ...decision, safetyLevel: "uncertain", supportMode: "adult_handoff", reasonCodes: [error.code] }, error.message);
      responses.set(requestId, result);
      return;
    }
    responseBundle = await neutralMediaProvider.generate({
      decision,
      replyText: "おへんじを準備できなかったよ。そばのおとなといっしょに、もう一度ためしてね。",
      consentValid: true,
      faultMode: "media_unavailable",
    });
  }

  const result = {
    ...current,
    route: "generate_guardian_message",
    status: "READY",
    routerDecision: decision,
    replyText: responseBundle.parentLike ? decision.replyText : null,
    responseBundle,
    completedAt: new Date().toISOString(),
  };
  responses.set(requestId, result);
  addTechnicalLog({
    requestId,
    route: responseBundle.fallbackLevel === 4 ? "neutral_fallback" : "guardian_media",
    model: routed.metadata?.resolvedModel || routed.metadata?.requestedModel || routed.metadata?.provider || "local-router",
    costUsd: 0,
    latencyMs: Date.now() - startedAt,
    status: result.status,
    fallbackLevel: responseBundle.fallbackLevel,
    ...readUsage(routed.metadata),
  });
}

async function apiHandler(req, res, url) {
  purgeExpiredData();
  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, {
      status: "ok",
      routerMode,
      routerConfigured: Boolean(process.env.ORCAROUTER_API_KEY),
      sttMode,
      sttConfigured: Boolean(process.env.STT_API_KEY || process.env.OPENAI_API_KEY),
      mediaMode: String(process.env.MEDIA_PROVIDER || "demo").toLowerCase(),
      preRecordedVideoConfigured: Boolean(process.env.PREGENERATED_VIDEO_URL),
    });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/consent") {
    sendJson(res, 200, demoConsent);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/transcriptions") {
    try {
      const input = await readJson(req);
      if (!input.audioBase64 && !input.demoTranscript) {
        sendJson(res, 400, { error: "AUDIO_REQUIRED", message: "音声を確認できませんでした。もう一度お話しください。" });
        return true;
      }
      const transcription = await sttProvider.transcribe({
        audioBase64: input.audioBase64,
        mimeType: input.audioType,
        demoTranscript: input.demoTranscript || (sttMode === "demo" ? input.demoFallbackTranscript : null),
      });
      sendJson(res, 200, transcription);
    } catch (error) {
      const statusCode = error.message === "PAYLOAD_TOO_LARGE" ? 413 : error instanceof SttProviderError ? 503 : 400;
      sendJson(res, statusCode, {
        error: error.code || "TRANSCRIPTION_REQUEST_INVALID",
        message: "音声を確認できませんでした。そばの大人と、もう一度お話しください。",
      });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/responses") {
    try {
      const input = await readJson(req);
      if (!String(input.confirmedTranscript ?? "").trim()) {
        sendJson(res, 400, { error: "CONFIRMED_TRANSCRIPT_REQUIRED" });
        return true;
      }
      const key = String(input.idempotencyKey || `${input.sessionId}:${input.transcriptId}`);
      if (idempotency.has(key)) {
        sendJson(res, 202, responses.get(idempotency.get(key)));
        return true;
      }
      const requestId = `req_${randomUUID()}`;
      const record = {
        requestId,
        status: "PENDING",
        createdAt: new Date().toISOString(),
      };
      responses.set(requestId, record);
      idempotency.set(key, requestId);
      const startedAt = Date.now();
      setTimeout(() => {
        finishResponse(requestId, input, startedAt).catch(() => {
          const current = responses.get(requestId);
          if (!current) return;
          const result = createAdultHandoff(
            current,
            { safetyLevel: "uncertain", supportMode: "adult_handoff", emotion: ["unknown"], reasonCodes: ["UNEXPECTED_PROCESSING_ERROR"] },
            "返答の処理を完了できませんでした。子どものそばで話を聞き、もう一度試してください。",
          );
          responses.set(requestId, result);
          addTechnicalLog({ requestId, route: "unexpected_handoff", model: "server", costUsd: 0, latencyMs: Date.now() - startedAt, status: result.status });
        });
      }, 900);
      sendJson(res, 202, record);
    } catch {
      sendJson(res, 400, { error: "RESPONSE_REQUEST_INVALID" });
    }
    return true;
  }

  const responseMatch = url.pathname.match(/^\/api\/responses\/([^/]+)$/);
  if (req.method === "GET" && responseMatch) {
    const record = responses.get(responseMatch[1]);
    sendJson(res, record ? 200 : 404, record ?? { error: "NOT_FOUND" });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/logs") {
    sendJson(res, 200, { logs: technicalLogs });
    return true;
  }

  return false;
}

async function serveStatic(res, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const relative = normalize(decodeURIComponent(requested)).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(root, relative);
  if (!filePath.startsWith(root)) {
    sendJson(res, 403, { error: "FORBIDDEN" });
    return;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("NOT_FILE");
    res.writeHead(200, {
      "content-type": mimeTypes[extname(filePath).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    createReadStream(filePath).pipe(res);
  } catch {
    sendJson(res, 404, { error: "NOT_FOUND" });
  }
}

export function createAppServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      const handled = await apiHandler(req, res, url);
      if (!handled) sendJson(res, 404, { error: "NOT_FOUND" });
      return;
    }
    await serveStatic(res, url.pathname);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4173);
  createAppServer().listen(port, "127.0.0.1", () => {
    console.log(`Guardian AI Message running at http://127.0.0.1:${port}`);
  });
}
