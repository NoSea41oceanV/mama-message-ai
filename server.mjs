import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  GuardianSamplingError,
  createGuardianSamplingStore,
} from "./lib/guardian-sampling.mjs";
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
const guardianSampling = createGuardianSamplingStore();
const guardianSamplingPhrase = "お話ししてくれてありがとう。いつも応援しているよ。";

const demoConsent = {
  consentId: "demo-consent-001",
  avatarAssetId: "guardian-demo-001",
  subjectLabel: "デモ保護者",
  faceApproved: true,
  voiceApproved: true,
  active: true,
  disclosure: "AI生成・本人同意済み素材（デモ）",
};

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
  ".wav": "audio/wav",
};

function sendJson(res, statusCode, value) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...securityHeaders(),
  });
  res.end(JSON.stringify(value));
}

function sendPrivateMedia(res, media) {
  res.writeHead(200, {
    "content-type": media.mimeType,
    "content-length": media.bytes.length,
    "cache-control": "private, no-store, max-age=0",
    "cross-origin-resource-policy": "same-origin",
    ...securityHeaders(),
  });
  res.end(media.bytes);
}

function securityHeaders() {
  return {
    "content-security-policy": "default-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    "permissions-policy": "camera=(), geolocation=(), payment=(), usb=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
}

async function readJson(req, maximumBytes = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximumBytes) throw new Error("PAYLOAD_TOO_LARGE");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function samplingApiView(status = guardianSampling.status()) {
  return {
    configured: status.configured === true,
    active: status.active === true,
    subjectLabel: status.subjectLabel ?? null,
    faceApproved: status.faceApproved === true,
    voiceApproved: status.voiceApproved === true,
    posterUrl: status.posterUrl ?? null,
    voicePreviewUrl: status.voicePreviewUrl ?? null,
    consentId: status.consentId ?? null,
    avatarAssetId: status.avatarAssetId ?? null,
  };
}

function customConsentView(status = guardianSampling.status()) {
  return {
    consentId: status.consentId,
    avatarAssetId: status.avatarAssetId,
    subjectLabel: status.subjectLabel,
    faceApproved: status.faceApproved,
    voiceApproved: status.voiceApproved,
    active: status.active,
    disclosure: status.disclosure,
    posterUrl: status.posterUrl,
    voicePreviewUrl: status.voicePreviewUrl,
    source: "custom-sampling",
  };
}

function samplingMutationAllowed(req) {
  if (String(req.headers["sec-fetch-site"] ?? "").toLowerCase() === "cross-site") return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return ["http:", "https:"].includes(parsed.protocol) && parsed.host === req.headers.host;
  } catch {
    return false;
  }
}

export function classifyTranscript(transcript) {
  const value = String(transcript ?? "").trim();
  if (!value) {
    return { safetyLevel: "uncertain", supportMode: "clarify", emotion: ["unknown"], reasonCodes: ["EMPTY_INPUT"] };
  }

  const urgent = /(死にたい|消えたい|息ができない|火事|血が止まらない|今すぐ助けて|毒を飲んだ|意識がない)/;
  const adultRequired = /(助けて|叩かれ|殴られ|蹴られ|触られ|痛い|けが|怖い人|帰れない|迷子|ひとりぼっち|知らない人)/;
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
  if (/(行きたくない|帰りたくない|お迎え|お別れ|ママが行っちゃった|パパが行っちゃった)/.test(value)) {
    return { safetyLevel: "normal", supportMode: "transition", emotion: ["anxiety"], reasonCodes: ["TRANSITION_SUPPORT_NEEDED"] };
  }
  if (/(おなかすいた|のどかわいた|眠い|トイレ|疲れた)/.test(value)) {
    return { safetyLevel: "normal", supportMode: "basic_need", emotion: ["discomfort"], reasonCodes: ["BASIC_NEED_SUPPORT_NEEDED"] };
  }
  return { safetyLevel: "normal", supportMode: "listen", emotion: ["neutral"], reasonCodes: ["GENERAL_LISTENING"] };
}

export function buildReply(decision) {
  const replies = {
    celebrate: "お話してくれてありがとう。できたこと、ちゃんと伝わったよ。いっしょに喜ぼうね。",
    comfort: "お話してくれてありがとう。さみしかったんだね。ゆっくり息をして、そばの大人といっしょにいようね。",
    calm: "お話してくれてありがとう。そう思ってもいいんだよ。ゆっくり息をしてみようね。",
    encourage: "お話してくれてありがとう。がんばったこと、ちゃんと伝わったよ。次の一歩をいっしょに考えようね。",
    transition: "お話してくれてありがとう。離れるのはさみしいよね。そばのおとなといっしょに、次にすることを一つだけ決めようね。",
    basic_need: "お話してくれてありがとう。からだのことは大切だよ。そばのおとなに伝えて、いっしょに確かめてもらおうね。",
    listen: "お話してくれてありがとう。あなたのお話を、ちゃんと聞いているよ。",
    clarify: "うまく聞き取れなかったよ。そばの大人と、もう一度お話してみようね。",
  };
  return replies[decision.supportMode] ?? replies.listen;
}

export function replyIsAllowed(replyText) {
  const value = String(replyText ?? "").trim();
  if (!value || value.length > 180) return false;
  return !/(秘密にして|誰にも言わないで|家を出て|逃げて|薬を飲んで|ママから今届いた|パパから今届いた|本人が送った)/.test(value);
}

const routerProvider = createOrcaRouterProvider({
  localClassifier: routerMode === "demo" ? classifyTranscript : undefined,
  localReplyBuilder: routerMode === "demo" ? buildReply : undefined,
});
const sttProvider = createSttProvider();
const demoReplyAudioUrls = Object.freeze({
  celebrate: "/assets/audio/celebrate.wav",
  comfort: "/assets/audio/comfort.wav",
  calm: "/assets/audio/calm.wav",
  encourage: "/assets/audio/encourage.wav",
  transition: "/assets/audio/transition.wav",
  basic_need: "/assets/audio/basic_need.wav",
  listen: "/assets/audio/listen.wav",
  clarify: "/assets/audio/clarify.wav",
});
const demoReplyVideoUrls = Object.freeze({
  celebrate: "/assets/video/celebrate.webm",
  comfort: "/assets/video/comfort.webm",
  calm: "/assets/video/calm.webm",
  encourage: "/assets/video/encourage.webm",
  transition: "/assets/video/transition.webm",
  basic_need: "/assets/video/basic_need.webm",
  listen: "/assets/video/listen.webm",
  clarify: "/assets/video/clarify.webm",
});
const mediaProvider = createMediaProvider({
  assets: {
    preRecordedVideoUrl: process.env.PREGENERATED_VIDEO_URL || null,
    posterUrl: "/assets/guardian-demo.png",
  },
  timeoutMs: Math.min(Number(process.env.MEDIA_TIMEOUT_SECONDS || 18), 18) * 1000,
  preRecordedVideoUrlForDecision: (decision) => routerMode === "demo"
    ? demoReplyVideoUrls[decision.supportMode] ?? null
    : null,
  audioUrlForDecision: (decision) => routerMode === "demo"
    ? demoReplyAudioUrls[decision.supportMode] ?? null
    : null,
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
    providerRoute: entry.providerRoute ?? null,
    failureReason: entry.failureReason ?? null,
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
    safetyLevel: decision.safetyLevel,
    supportMode: decision.supportMode,
    emotion: decision.emotion,
    childMessage: "そばのおとなといっしょに確認しよう",
    adultMessage,
    responseBundle: null,
    bundle: null,
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

function readProviderMetrics(metadata) {
  if (routerMode === "demo") return { costUsd: 0, estimatedCost: true, providerRoute: "local-demo" };
  const headers = metadata?.headers ?? {};
  const rawCost = headers["x-orca-cost-usd"] ?? headers["x-orca-cost"] ?? null;
  const parsedCost = rawCost === null ? null : Number(rawCost);
  return {
    costUsd: Number.isFinite(parsedCost) ? parsedCost : null,
    estimatedCost: !Number.isFinite(parsedCost),
    providerRoute: headers["x-orca-route"] ?? headers["x-orca-provider"] ?? null,
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

  const registeredSample = guardianSampling.resolve(input.consentId, input.avatarAssetId);
  const demoConsentOk = input.consentId === demoConsent.consentId
    && input.avatarAssetId === demoConsent.avatarAssetId
    && demoConsent.active
    && demoConsent.faceApproved
    && demoConsent.voiceApproved;
  const consentOk = Boolean(registeredSample) || demoConsentOk;

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
      ...readProviderMetrics(routed.metadata),
      latencyMs: Date.now() - startedAt,
      status: result.status,
      ...readUsage(routed.metadata),
    });
    return;
  }

  if (!replyIsAllowed(decision.replyText)) {
    const result = createAdultHandoff(
      current,
      { ...decision, safetyLevel: "uncertain", supportMode: "adult_handoff", reasonCodes: ["REPLY_POLICY_REJECTED"] },
      "返答内容を安全に確認できませんでした。子どものそばで話を聞き、必要に応じてもう一度試してください。",
    );
    responses.set(requestId, result);
    addTechnicalLog({
      requestId,
      route: "reply_policy_handoff",
      model: routed.metadata?.resolvedModel || routed.metadata?.provider || "router",
      ...readProviderMetrics(routed.metadata),
      latencyMs: Date.now() - startedAt,
      status: result.status,
    });
    return;
  }

  let responseBundle;
  try {
    const defaultFault = registeredSample
      ? "video_failure"
      : routerMode === "demo" || process.env.PREGENERATED_VIDEO_URL
      ? "generated_video_failure"
      : "video_failure";
    responseBundle = await mediaProvider.generate({
      decision,
      replyText: registeredSample ? guardianSamplingPhrase : decision.replyText,
      consentValid: true,
      faultMode: input.demoFault || defaultFault,
      posterUrl: registeredSample?.photoUrl,
      audioUrl: registeredSample?.voicePreviewUrl,
      guardianSampling: registeredSample ? {
        configured: true,
        photoUsed: true,
        voiceSampleRegistered: true,
        voiceUsed: true,
        voiceFallback: null,
      } : null,
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
    safetyLevel: decision.safetyLevel,
    supportMode: decision.supportMode,
    emotion: decision.emotion,
    replyText: responseBundle.parentLike
      ? registeredSample ? guardianSamplingPhrase : decision.replyText
      : null,
    responseBundle,
    bundle: responseBundle,
    completedAt: new Date().toISOString(),
  };
  responses.set(requestId, result);
  addTechnicalLog({
    requestId,
    route: responseBundle.fallbackLevel === 4 ? "neutral_fallback" : "guardian_media",
    model: routed.metadata?.resolvedModel || routed.metadata?.requestedModel || routed.metadata?.provider || "local-router",
    ...readProviderMetrics(routed.metadata),
    latencyMs: Date.now() - startedAt,
    status: result.status,
    fallbackLevel: responseBundle.fallbackLevel,
    ...readUsage(routed.metadata),
  });
}

async function apiHandler(req, res, url) {
  purgeExpiredData();
  const samplingAssetMatch = url.pathname.match(/^\/api\/sampling\/assets\/(photo|voice)\/([^/]+)$/);
  if (req.method === "GET" && samplingAssetMatch) {
    let accessToken;
    try {
      accessToken = decodeURIComponent(samplingAssetMatch[2]);
    } catch {
      sendJson(res, 404, { error: "NOT_FOUND" });
      return true;
    }
    const media = samplingAssetMatch[1] === "photo"
      ? guardianSampling.readPhoto(accessToken)
      : guardianSampling.readVoice(accessToken);
    if (!media) sendJson(res, 404, { error: "NOT_FOUND" });
    else sendPrivateMedia(res, media);
    return true;
  }
  if (url.pathname === "/api/sampling") {
    if (req.method === "GET") {
      sendJson(res, 200, samplingApiView());
      return true;
    }
    if (req.method === "POST") {
      if (!samplingMutationAllowed(req)) {
        sendJson(res, 403, { error: "CROSS_SITE_REQUEST_FORBIDDEN" });
        return true;
      }
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        sendJson(res, 415, { error: "CONTENT_TYPE_UNSUPPORTED" });
        return true;
      }
      try {
        const input = await readJson(req, 10 * 1024 * 1024);
        sendJson(res, 201, samplingApiView(guardianSampling.register(input)));
      } catch (error) {
        const statusCode = error.message === "PAYLOAD_TOO_LARGE"
          ? 413
          : error instanceof GuardianSamplingError
            ? error.statusCode
            : 400;
        sendJson(res, statusCode, { error: error.code || "SAMPLING_REQUEST_INVALID" });
      }
      return true;
    }
    if (req.method === "DELETE") {
      if (!samplingMutationAllowed(req)) {
        sendJson(res, 403, { error: "CROSS_SITE_REQUEST_FORBIDDEN" });
        return true;
      }
      const result = guardianSampling.delete();
      sendJson(res, 200, { ...samplingApiView(result), deleted: result.deleted });
      return true;
    }
  }
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
    const samplingStatus = guardianSampling.status();
    sendJson(res, 200, samplingStatus.configured && samplingStatus.active
      ? customConsentView(samplingStatus)
      : demoConsent);
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/consent") {
    try {
      const input = await readJson(req);
      if (!new Set(["revoke", "restore"]).has(input.action)) {
        sendJson(res, 400, { error: "CONSENT_ACTION_INVALID" });
        return true;
      }
      if (input.action === "revoke") guardianSampling.revoke();
      demoConsent.active = input.action === "restore";
      sendJson(res, 200, demoConsent);
    } catch {
      sendJson(res, 400, { error: "CONSENT_REQUEST_INVALID" });
    }
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
      input.confirmedTranscript = String(input.confirmedTranscript ?? "").trim();
      if (!input.confirmedTranscript) {
        sendJson(res, 400, { error: "CONFIRMED_TRANSCRIPT_REQUIRED" });
        return true;
      }
      if (input.confirmedTranscript.length > 500) {
        sendJson(res, 400, { error: "CONFIRMED_TRANSCRIPT_TOO_LONG" });
        return true;
      }
      const requiredIds = ["sessionId", "transcriptId", "consentId", "avatarAssetId", "idempotencyKey"];
      if (requiredIds.some((name) => typeof input[name] !== "string" || !input[name].trim())) {
        sendJson(res, 400, { error: "RESPONSE_IDENTIFIERS_REQUIRED" });
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
  if (req.method === "DELETE" && responseMatch) {
    const requestId = responseMatch[1];
    const existed = responses.delete(requestId);
    for (const [key, storedRequestId] of idempotency) {
      if (storedRequestId === requestId) idempotency.delete(key);
    }
    sendJson(res, existed ? 200 : 404, existed ? { deleted: true } : { error: "NOT_FOUND" });
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
      ...securityHeaders(),
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
