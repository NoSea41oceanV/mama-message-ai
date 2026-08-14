import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  GUARDIAN_SAMPLING_LIMITS,
  GuardianSamplingError,
  createGuardianSamplingStore,
  normalizeChildName,
  normalizeFavoriteTopics,
} from "./lib/guardian-sampling.mjs";
import {
  GUARDIAN_PROFILE_ID_PATTERN,
  createPersistentGuardianSamplingStore,
} from "./lib/persistent-guardian-sampling.mjs";
import { createGuardianVideoService, downloadGeneratedVideo } from "./lib/guardian-video-service.mjs";
import { createDidVideoProvider } from "./lib/providers/did-video.mjs";
import { createElevenLabsProvider, ElevenLabsError } from "./lib/providers/elevenlabs.mjs";
import { createHeyGenVideoProvider } from "./lib/providers/heygen-video.mjs";
import { createKlingVideoProvider } from "./lib/providers/kling-video.mjs";
import { createLiveAvatarProvider, LiveAvatarProviderError } from "./lib/providers/liveavatar.mjs";
import { createMediaProvider, MediaProviderError } from "./lib/providers/media.mjs";
import { createOrcaRouterProvider } from "./lib/providers/orcarouter.mjs";
import { createSttProvider, SttProviderError } from "./lib/providers/stt.mjs";
import { createTavusProvider, TavusProviderError } from "./lib/providers/tavus.mjs";
import { createTavusTrainingAssetStore } from "./lib/tavus-training-assets.mjs";
import { isChildHiragana, toChildHiragana } from "./lib/japanese-text.mjs";

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
const conversations = new Map();
const technicalLogs = [];
const generatedReplyAudio = new Map();
const generatedReplyVideo = new Map();
const tavusConversations = new Map();
const configuredRetentionHours = Number(process.env.TECHNICAL_LOG_TTL_HOURS || 24);
const retentionMs = (Number.isFinite(configuredRetentionHours) ? Math.max(1, configuredRetentionHours) : 24) * 60 * 60 * 1000;
const configuredConversationTtlMinutes = Number(process.env.CONVERSATION_TTL_MINUTES || 120);
const conversationTtlMs = (Number.isFinite(configuredConversationTtlMinutes)
  ? Math.max(1, configuredConversationTtlMinutes)
  : 120) * 60 * 1000;
const MAX_CONVERSATION_TURNS = 12;
const routerMode = String(process.env.ROUTER_PROVIDER || "demo").toLowerCase();
const sttMode = String(process.env.STT_PROVIDER || "demo").toLowerCase();
const guardianSampling = createPersistentGuardianSamplingStore({
  directory: fileURLToPath(new URL("./.data/guardian-samples/", import.meta.url)),
});
const videoGenerationMode = String(process.env.VIDEO_GENERATION_PROVIDER || "disabled").trim().toLowerCase();
const videoRequestTimeoutMs = Number(
  process.env.VIDEO_REQUEST_TIMEOUT_SECONDS
    || process.env.KLING_VIDEO_REQUEST_TIMEOUT_SECONDS
    || 30,
) * 1000;
const liveAvatarProvider = createLiveAvatarProvider();
const tavusTrainingAssets = createTavusTrainingAssetStore({
  publicBaseUrl: process.env.TAVUS_PUBLIC_BASE_URL,
  ttlMs: Number(process.env.TAVUS_TRAINING_ASSET_TTL_SECONDS || 1800) * 1000,
});
const tavusProvider = createTavusProvider({
  publishImage: tavusTrainingAssets.configured ? tavusTrainingAssets.publish : null,
  deletePublishedImage: tavusTrainingAssets.deleteAsset,
});
const liveAvatarBatchPlaceholder = Object.freeze({
  name: "liveavatar",
  available: false,
  async createTask() {
    const error = new Error("LiveAvatar does not use batch avatar preparation");
    error.code = "LIVEAVATAR_REALTIME_ONLY";
    throw error;
  },
  async getTask() { return { status: "failed", videoUrl: null }; },
  async deleteTask() { return false; },
  async deleteAsset() { return false; },
});
const videoProvider = videoGenerationMode === "did"
  ? createDidVideoProvider({ timeoutMs: videoRequestTimeoutMs })
  : videoGenerationMode === "heygen"
    ? createHeyGenVideoProvider({ timeoutMs: videoRequestTimeoutMs })
    : videoGenerationMode === "liveavatar"
      ? liveAvatarBatchPlaceholder
      : videoGenerationMode === "tavus"
        ? tavusProvider
      : createKlingVideoProvider({ timeoutMs: videoRequestTimeoutMs });
const guardianVideoService = createGuardianVideoService({
  samplingStore: guardianSampling,
  provider: videoProvider,
  pollIntervalMs: Number(process.env.VIDEO_POLL_INTERVAL_SECONDS || process.env.KLING_VIDEO_POLL_INTERVAL_SECONDS || 5) * 1000,
  pollTimeoutMs: Number(process.env.VIDEO_POLL_TIMEOUT_SECONDS || process.env.KLING_VIDEO_POLL_TIMEOUT_SECONDS || 600) * 1000,
  maximumBytes: Number(process.env.VIDEO_MAX_BYTES || process.env.KLING_VIDEO_MAX_BYTES || 25 * 1024 * 1024),
  downloadTimeoutMs: Number(process.env.VIDEO_DOWNLOAD_TIMEOUT_SECONDS || process.env.KLING_VIDEO_DOWNLOAD_TIMEOUT_SECONDS || 30) * 1000,
});
const voiceCloningMode = String(process.env.VOICE_CLONING_PROVIDER || "disabled").trim().toLowerCase();
const voiceCloningProvider = createElevenLabsProvider({ provider: voiceCloningMode });
const demoConsentByProfile = new Map();

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

function sendTavusTrainingAsset(res, media) {
  res.writeHead(200, {
    "content-type": media.mimeType,
    "content-length": media.bytes.length,
    "cache-control": "no-store, max-age=0",
    "cross-origin-resource-policy": "cross-origin",
    ...securityHeaders(),
  });
  res.end(media.bytes);
}

function storeGeneratedReplyAudio(media) {
  const accessToken = randomUUID();
  generatedReplyAudio.set(accessToken, {
    bytes: media.bytes,
    mimeType: media.mimeType,
    createdAt: Date.now(),
  });
  return `/api/generated-audio/${encodeURIComponent(accessToken)}`;
}

function storeGeneratedReplyVideo(media) {
  const accessToken = randomUUID();
  generatedReplyVideo.set(accessToken, {
    bytes: media.bytes,
    mimeType: media.mimeType,
    createdAt: Date.now(),
  });
  return `/api/generated-video/${encodeURIComponent(accessToken)}`;
}

function securityHeaders() {
  return {
    "content-security-policy": "default-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self' https://api.liveavatar.com wss://api.liveavatar.com wss://webrtc-signaling.heygen.io wss://*.livekit.cloud https://*.livekit.cloud https://*.daily.co wss://*.daily.co; frame-src https://*.daily.co; worker-src 'self' blob:; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
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

function samplingApiView(status, videoGeneration = status.videoGeneration) {
  return {
    configured: status.configured === true,
    active: status.active === true,
    subjectLabel: status.subjectLabel ?? null,
    favoriteTopics: [...(status.favoriteTopics ?? [])],
    childName: status.childName ?? "",
    speechRate: status.speechRate ?? GUARDIAN_SAMPLING_LIMITS.defaultSpeechRate,
    faceApproved: status.faceApproved === true,
    voiceApproved: status.voiceApproved === true,
    posterUrl: status.posterUrl ?? null,
    voicePreviewUrl: status.voicePreviewUrl ?? null,
    consentId: status.consentId ?? null,
    avatarAssetId: status.avatarAssetId ?? null,
    voiceSamplePurpose: status.voicePreviewUrl ? "sampling-confirmation" : null,
    voiceCloningAvailable: status.voiceCloningAvailable === true,
    videoGeneration: videoGeneration ?? { status: "not_started" },
    liveAvatar: videoGenerationMode === "liveavatar" ? liveAvatarProvider.status() : null,
    tavus: videoGenerationMode === "tavus" ? tavusProvider.status() : null,
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
    voiceSamplePurpose: status.voicePreviewUrl ? "sampling-confirmation" : null,
    voiceCloningAvailable: status.voiceCloningAvailable === true,
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

function readGuardianProfileId(req) {
  const raw = String(req.headers["x-guardian-profile-id"] ?? "").trim();
  if (!raw) return null;
  return GUARDIAN_PROFILE_ID_PATTERN.test(raw) ? raw.toLowerCase() : false;
}

function profileDemoConsent(profileId) {
  return {
    ...demoConsent,
    active: profileId
      ? demoConsentByProfile.get(profileId) ?? true
      : demoConsent.active,
  };
}

export function classifyTranscript(transcript) {
  const value = String(transcript ?? "").trim();
  if (!value) {
    return { safetyLevel: "uncertain", supportMode: "clarify", emotion: ["unknown"], reasonCodes: ["EMPTY_INPUT"] };
  }

  const urgent = /(死にたい|消えたい|息ができない|火事|血が止まらない|今すぐ助けて|毒を飲んだ|意識がない)/;
  const adultRequired = /(叩かれ|殴られ|蹴られ|無理やり触られ|体を触られ|けがをした|血が出て|怖い人|帰れない|迷子|知らない人(?:が|に).*(?:ついて|追いかけ|連れて)|(?:怖い|危ない|閉じ込め|追いかけ).{0,16}助けて|助けて.{0,16}(?:怖い|危ない|閉じ込め|追いかけ))/;
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

function shortConversationTopic(value, maximumLength = 28) {
  const normalized = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[「」]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";
  return normalized.length <= maximumLength
    ? normalized
    : `${normalized.slice(0, maximumLength)}…`;
}

function presentCaregiverLabel(value) {
  if (/(パパ|お父さん|父さん)/.test(value)) return "パパ";
  if (/(先生|保育園|幼稚園|こども園|延長保育)/.test(value)) return "先生";
  if (/(ベビーシッター|シッター)/.test(value)) return "シッターさん";
  return "いま一緒にいる人";
}

function childNamePrefix(childName) {
  const normalized = normalizeChildName(childName);
  return normalized ? `${normalized}、` : "";
}

export function buildSeparationReply(transcript = "", favoriteTopics = [], childName = "") {
  const value = shortConversationTopic(transcript, 80);
  if (!value) return null;
  const caregiver = presentCaregiverLabel(value);
  const favorite = normalizeFavoriteTopics(favoriteTopics)[0] ?? null;
  const childCall = childNamePrefix(childName);
  if (/(?:お迎え|ママ|お母さん).*(?:まだ|いつ|来る)|(?:まだ|いつ).*(?:お迎え|ママ|お母さん)/.test(value)) {
    return favorite
      ? `${childCall}お迎えを待つの、長く感じるよね。${caregiver}に時間を聞いて、${favorite}のお話をしながら待とうね。`
      : `${childCall}お迎えを待つの、長く感じるよね。${caregiver}に時間を聞いて、待つあいだ何をするか一緒に決めようね。`;
  }
  if (/(?:ママ|お母さん).*(?:どこ|何してる)/.test(value)) {
    return `${childCall}ママのことが気になったんだね。${caregiver}に、お迎えのことを聞いてみようね。`;
  }
  const separationDistress = /(?:ママ|お母さん).*(?:会いたい|いな(?:い|く)|来て|さみしい|寂しい)|(?:会いたい|さみしい|寂しい).*(?:ママ|お母さん)/;
  if (separationDistress.test(value) && /(泣|涙)/.test(value)) {
    return favorite
      ? `${childCall}泣いても大丈夫だよ。ママに会いたくなったんだね。${caregiver}のそばで、${favorite}のお話をしながら待とうね。`
      : `${childCall}泣いても大丈夫だよ。ママに会いたくなったんだね。${caregiver}のそばで、ゆっくり三つ数えてみようね。`;
  }
  if (separationDistress.test(value)) {
    return favorite
      ? `${childCall}ママに会いたくなったんだね。寂しいよね。${caregiver}のそばで、${favorite}のお話をしながら待とうね。`
      : `${childCall}ママに会いたくなったんだね。寂しいよね。${caregiver}のそばで、いっしょに待とうね。`;
  }
  return null;
}

export function buildReply(decision, transcript = "", history = [], favoriteTopics = [], childName = "") {
  const currentTopic = shortConversationTopic(transcript);
  const separationReply = buildSeparationReply(transcript, favoriteTopics, childName);
  if (separationReply) return separationReply;
  if (/(元気|げんき)[？?。！!]*$/.test(currentTopic)) {
    return "うん、元気だよ！今日は何してたの？";
  }
  if (/(今日|きょう).*(暇|ひま)|(?:暇|ひま).*(今日|きょう)/.test(currentTopic)) {
    return "少しならお話できるよ。どうしたの？";
  }
  if (/(宿題|しゅくだい).*(助けて|手伝って|わからない)/.test(currentTopic)) {
    return "もちろん。一緒に見てみよう。どの問題で困ってる？";
  }
  const priorMessage = Array.isArray(history)
    ? [...history].reverse().find((message) => message?.role === "user" && String(message.content ?? "").trim())
    : null;
  const priorTopic = shortConversationTopic(priorMessage?.content);
  const continuity = priorTopic && priorTopic !== currentTopic
    ? `さっきの「${priorTopic}」のお話の続きだね。`
    : "";
  const acknowledgment = currentTopic ? `「${currentTopic}」って教えてくれたんだね。` : "お話してくれてありがとう。";
  const replies = {
    celebrate: `${continuity}${acknowledgment}できたこと、ちゃんと伝わったよ。いっしょに喜ぼうね。`,
    comfort: `${continuity}${acknowledgment}さみしかったね。ゆっくり息をして、そばの大人といっしょにいようね。`,
    calm: `${continuity}${acknowledgment}そう思ってもいいんだよ。いっしょにゆっくり息をしてみようね。`,
    encourage: `${continuity}${acknowledgment}がんばったこと、ちゃんと伝わったよ。次の一歩をいっしょに考えようね。`,
    transition: `${continuity}${acknowledgment}離れるのはさみしいよね。そばの大人と、次にすることを一つ決めようね。`,
    basic_need: `${continuity}${acknowledgment}からだのことは大切だよ。そばの大人に伝えて、いっしょに確かめてもらおうね。`,
    listen: `${continuity}${acknowledgment}そのお話、もう少し聞かせてくれる？`,
    clarify: "うまく聞き取れなかったよ。そばの大人と、もう一度お話してみようね。",
  };
  return replies[decision.supportMode] ?? replies.listen;
}

export function refineGuardianReply(decision, transcript = "", history = [], favoriteTopics = [], childName = "") {
  if (!decision || decision.safetyLevel !== "normal") return decision;
  const currentTopic = shortConversationTopic(transcript);
  const fixedDailyReply = buildSeparationReply(transcript, favoriteTopics, childName) ?? ((
    /(元気|げんき)[？?。！!]*$/.test(currentTopic)
    || /(今日|きょう).*(暇|ひま)|(?:暇|ひま).*(今日|きょう)/.test(currentTopic)
    || /(宿題|しゅくだい).*(助けて|手伝って|わからない)/.test(currentTopic)
  ) ? buildReply(decision, transcript, history, favoriteTopics, childName) : null);
  const soundsLikeCounselingBot = /(きみはどう|今日はどんな(?:気持ち|気分)|今どんな(?:気持ち|気分)|お話ししてくれてありがとう)/.test(
    String(decision.replyText ?? ""),
  );
  if (!fixedDailyReply && !soundsLikeCounselingBot) return decision;
  return Object.freeze({
    ...decision,
    replyText: fixedDailyReply ?? buildReply(decision, transcript, history, favoriteTopics, childName),
  });
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
const storedGeneratedVideoProvider = Object.freeze({
  name: "guardian-reply-video",
  generate: async (context) => context.generatedReplyVideoUrl
    ? {
        videoUrl: context.generatedReplyVideoUrl,
        audioInVideo: true,
        audioUrl: null,
        speechSynthesis: false,
      }
    : context.generatedVideoUrl
      ? {
          videoUrl: context.generatedVideoUrl,
          audioInVideo: false,
          audioUrl: context.audioUrl || null,
          speechSynthesis: !context.audioUrl,
        }
      : null,
});
const mediaProvider = createMediaProvider({
  generatedVideoProvider: storedGeneratedVideoProvider,
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

function safeExternalFailureReason(error, fallback) {
  const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,80}$/.test(error.code)
    ? error.code
    : fallback;
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? `:HTTP_${error.status}`
    : "";
  const providerCode = typeof error?.providerCode === "string" && /^[a-z0-9_.:-]{1,80}$/i.test(error.providerCode)
    ? `:${error.providerCode}`
    : "";
  const providerDetail = typeof error?.providerDetail === "string" && error.providerDetail.length <= 240
    ? `:${error.providerDetail}`
    : "";
  const providerParam = typeof error?.providerParam === "string" && /^[a-z0-9_.:[\]-]{1,120}$/i.test(error.providerParam)
    ? `:PARAM_${error.providerParam}`
    : "";
  return `${code}${status}${providerCode}${providerDetail}${providerParam}`;
}

function conversationStorageKey(guardianProfileId, conversationId) {
  return `${guardianProfileId || "legacy"}:${conversationId}`;
}

function readConversationHistory(guardianProfileId, conversationId, now = Date.now()) {
  const key = conversationStorageKey(guardianProfileId, conversationId);
  const conversation = conversations.get(key);
  if (!conversation || now - conversation.updatedAt > conversationTtlMs) {
    conversations.delete(key);
    return [];
  }
  return conversation.turns.flatMap((turn) => [
    { role: "user", content: turn.childMessage },
    { role: "assistant", content: turn.guardianReply },
  ]);
}

function rememberConversationTurn(guardianProfileId, conversationId, childMessage, guardianReply, now = Date.now()) {
  const key = conversationStorageKey(guardianProfileId, conversationId);
  const previous = conversations.get(key);
  const turns = previous && now - previous.updatedAt <= conversationTtlMs
    ? [...previous.turns]
    : [];
  turns.push({ childMessage, guardianReply });
  conversations.set(key, {
    updatedAt: now,
    turns: turns.slice(-MAX_CONVERSATION_TURNS),
  });
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
  for (const [key, conversation] of conversations) {
    if (now - conversation.updatedAt > conversationTtlMs) conversations.delete(key);
  }
  for (const [accessToken, audio] of generatedReplyAudio) {
    if (now - audio.createdAt > retentionMs) {
      audio.bytes.fill(0);
      generatedReplyAudio.delete(accessToken);
    }
  }
  for (const [accessToken, video] of generatedReplyVideo) {
    if (now - video.createdAt > retentionMs) {
      video.bytes.fill(0);
      generatedReplyVideo.delete(accessToken);
    }
  }
  tavusTrainingAssets.purge();
  for (const [conversationId, conversation] of tavusConversations) {
    if (now - conversation.createdAt > conversationTtlMs) tavusConversations.delete(conversationId);
  }
}

async function endTavusConversationsForProfile(profileId, provider = tavusProvider) {
  for (const [conversationId, conversation] of tavusConversations) {
    if (conversation.profileId !== profileId) continue;
    await provider.endConversation(conversationId);
    tavusConversations.delete(conversationId);
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

async function finishResponse(requestId, input, startedAt, runtime = {}) {
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

  const registeredSample = input.guardianProfileId
    ? guardianSampling.resolve(input.guardianProfileId, input.consentId, input.avatarAssetId)
    : null;
  const effectiveDemoConsent = profileDemoConsent(input.guardianProfileId);
  const demoConsentOk = input.consentId === demoConsent.consentId
    && input.avatarAssetId === demoConsent.avatarAssetId
    && effectiveDemoConsent.active
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

  const conversationHistory = readConversationHistory(input.guardianProfileId, input.conversationId);
  const routed = await routerProvider.classifyAndReply({
    transcript: input.confirmedTranscript,
    history: conversationHistory,
    favoriteTopics: registeredSample?.favoriteTopics ?? [],
    childName: registeredSample?.childName ?? "",
  });
  const routedDecision = routed.decision;
  if (!routed.ok || !routedDecision || routedDecision.safetyLevel !== "normal") {
    const safeDecision = routedDecision ?? {
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

  const refinedDecision = refineGuardianReply(
    routedDecision,
    input.confirmedTranscript,
    conversationHistory,
    registeredSample?.favoriteTopics ?? [],
    registeredSample?.childName ?? "",
  );

  const convertedReply = await toChildHiragana(refinedDecision.replyText);
  const fallbackReply = isChildHiragana(convertedReply)
    ? convertedReply
    : await toChildHiragana(buildReply(precheck, input.confirmedTranscript, conversationHistory));
  const decision = Object.freeze({
    ...refinedDecision,
    replyText: isChildHiragana(fallbackReply)
      ? fallbackReply
      : "だいじょうぶだよ。いまいっしょにいるおとなと、いっしょにまとうね。",
  });

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

  const activeVoiceProvider = runtime.voiceCloningProvider ?? voiceCloningProvider;
  const activeVideoService = runtime.videoService ?? guardianVideoService;
  const activeLiveAvatarProvider = runtime.liveAvatarProvider ?? liveAvatarProvider;
  const activeTavusProvider = runtime.tavusProvider ?? tavusProvider;
  const activeReplyVideoProvider = runtime.replyVideoProvider
    ?? (videoProvider.name === "heygen" ? videoProvider : null);
  let clonedReplyAudio = null;
  let clonedReplyAudioUrl = null;
  let voiceFailureReason = null;
  if (registeredSample?.voiceClone?.provider === "elevenlabs" && registeredSample.voiceClone.voiceId) {
    try {
      clonedReplyAudio = await activeVoiceProvider.synthesize({
        voiceId: registeredSample.voiceClone.voiceId,
        text: decision.replyText,
        speed: registeredSample.speechRate ?? GUARDIAN_SAMPLING_LIMITS.defaultSpeechRate,
      });
      clonedReplyAudioUrl = storeGeneratedReplyAudio(clonedReplyAudio);
    } catch (error) {
      voiceFailureReason = error instanceof ElevenLabsError ? error.code : "VOICE_CLONE_TTS_FAILED";
    }
  }

  let responseBundle;
  let videoFailureReason = null;
  try {
    const generatedVideo = registeredSample && !["liveavatar", "tavus"].includes(videoGenerationMode)
      ? activeVideoService.profileStatus?.(input.guardianProfileId)
        ?? guardianSampling.status(input.guardianProfileId).videoGeneration
      : null;
    const generatedVideoUrl = generatedVideo?.status === "ready" ? generatedVideo.videoUrl : null;
    let generatedReplyVideoUrl = null;
    const providerAvatarId = registeredSample
      ? activeVideoService.profileProviderTaskId?.(input.guardianProfileId)
      : null;
    const providerImageAssetId = registeredSample
      ? activeVideoService.profileProviderAssetId?.(input.guardianProfileId)
      : null;
    if (
      providerAvatarId
      && clonedReplyAudio?.bytes
      && activeReplyVideoProvider?.available !== false
      && typeof activeReplyVideoProvider?.renderReply === "function"
    ) {
      let replyTask = null;
      try {
        replyTask = await activeReplyVideoProvider.renderReply({
          avatarId: providerAvatarId,
          imageAssetId: providerImageAssetId,
          audioBytes: clonedReplyAudio.bytes,
          audioMimeType: clonedReplyAudio.mimeType,
          decision,
          idempotencyKey: requestId,
        });
        const replyVideo = await (runtime.videoDownloader ?? downloadGeneratedVideo)(replyTask.videoUrl, {
          maximumBytes: Number(process.env.VIDEO_MAX_BYTES || 25 * 1024 * 1024),
          timeoutMs: Number(process.env.VIDEO_DOWNLOAD_TIMEOUT_SECONDS || 30) * 1000,
        });
        generatedReplyVideoUrl = storeGeneratedReplyVideo(replyVideo);
      } catch (error) {
        videoFailureReason = safeExternalFailureReason(error, "HEYGEN_REPLY_VIDEO_FAILED");
      } finally {
        if (replyTask?.taskId && typeof activeReplyVideoProvider.deleteReplyTask === "function") {
          await activeReplyVideoProvider.deleteReplyTask(replyTask.taskId).catch(() => {});
        }
      }
    }
    const defaultFault = registeredSample
      ? generatedReplyVideoUrl || generatedVideoUrl ? "none" : "video_failure"
      : routerMode === "demo" || process.env.PREGENERATED_VIDEO_URL
      ? "generated_video_failure"
      : "video_failure";
    responseBundle = await mediaProvider.generate({
      decision,
      replyText: decision.replyText,
      consentValid: true,
      faultMode: input.demoFault || defaultFault,
      generatedReplyVideoUrl,
      generatedVideoUrl,
      posterUrl: registeredSample?.photoUrl,
      audioUrl: clonedReplyAudioUrl,
      recordedAudioText: clonedReplyAudioUrl ? decision.replyText : null,
      guardianSampling: registeredSample ? {
        configured: true,
        photoUsed: true,
        voiceSampleRegistered: true,
        voiceSampleMatchesReply: false,
        voiceSamplePurpose: registeredSample.voiceClone?.voiceId
          ? "voice-cloning-source"
          : "sampling-confirmation",
        voiceUsed: Boolean(clonedReplyAudioUrl),
        voiceCloningUsed: Boolean(clonedReplyAudioUrl),
        voiceFallback: clonedReplyAudioUrl
          ? null
          : registeredSample.voiceClone?.voiceId
            ? voiceFailureReason || "browser-speech"
            : "dynamic-tts",
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
      replyText: "おへんじをじゅんびできなかったよ。そばのおとなといっしょに、もういちどためしてね。",
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
      ? decision.replyText
      : null,
    conversationTurn: Math.floor(conversationHistory.length / 2) + 1,
    speechRate: registeredSample?.speechRate ?? GUARDIAN_SAMPLING_LIMITS.defaultSpeechRate,
    liveAvatar: Object.freeze({
      ...activeLiveAvatarProvider.status(),
      eligible: Boolean(
        videoGenerationMode === "liveavatar"
        && registeredSample
        && clonedReplyAudioUrl
        && activeLiveAvatarProvider.available
      ),
    }),
    tavus: Object.freeze({
      ...activeTavusProvider.status(),
      eligible: Boolean(
        videoGenerationMode === "tavus"
        && registeredSample
        && clonedReplyAudioUrl
        && activeTavusProvider.streamingAvailable
      ),
      customFaceReady: Boolean(
        videoGenerationMode === "tavus"
        && activeVideoService.profileProviderTaskId?.(input.guardianProfileId)
      ),
    }),
    responseBundle,
    bundle: responseBundle,
    completedAt: new Date().toISOString(),
  };
  responses.set(requestId, result);
  if (responseBundle.parentLike) {
    rememberConversationTurn(
      input.guardianProfileId,
      input.conversationId,
      input.confirmedTranscript,
      decision.replyText,
    );
  }
  addTechnicalLog({
    requestId,
    route: responseBundle.fallbackLevel === 4 ? "neutral_fallback" : "guardian_media",
    model: routed.metadata?.resolvedModel || routed.metadata?.requestedModel || routed.metadata?.provider || "local-router",
    ...readProviderMetrics(routed.metadata),
    latencyMs: Date.now() - startedAt,
    status: result.status,
    fallbackLevel: responseBundle.fallbackLevel,
    failureReason: voiceFailureReason || videoFailureReason,
    ...readUsage(routed.metadata),
  });
}

async function apiHandler(req, res, url, runtime = {}) {
  purgeExpiredData();
  const videoService = runtime.videoService ?? guardianVideoService;
  const activeVoiceProvider = runtime.voiceCloningProvider ?? voiceCloningProvider;
  const activeLiveAvatarProvider = runtime.liveAvatarProvider ?? liveAvatarProvider;
  const activeTavusProvider = runtime.tavusProvider ?? tavusProvider;
  const tavusTrainingAssetMatch = url.pathname.match(/^\/api\/tavus\/training-assets\/([^/]+)$/);
  if (req.method === "GET" && tavusTrainingAssetMatch) {
    let assetId;
    try {
      assetId = decodeURIComponent(tavusTrainingAssetMatch[1]);
    } catch {
      assetId = "";
    }
    const media = assetId ? tavusTrainingAssets.read(assetId) : null;
    if (!media) sendJson(res, 404, { error: "NOT_FOUND" });
    else sendTavusTrainingAsset(res, media);
    return true;
  }
  const generatedAudioMatch = url.pathname.match(/^\/api\/generated-audio\/([^/]+)$/);
  if (req.method === "GET" && generatedAudioMatch) {
    let accessToken;
    try {
      accessToken = decodeURIComponent(generatedAudioMatch[1]);
    } catch {
      sendJson(res, 404, { error: "NOT_FOUND" });
      return true;
    }
    const media = generatedReplyAudio.get(accessToken);
    if (!media) sendJson(res, 404, { error: "NOT_FOUND" });
    else sendPrivateMedia(res, media);
    return true;
  }
  const generatedVideoMatch = url.pathname.match(/^\/api\/generated-video\/([^/]+)$/);
  if (req.method === "GET" && generatedVideoMatch) {
    let accessToken;
    try {
      accessToken = decodeURIComponent(generatedVideoMatch[1]);
    } catch {
      sendJson(res, 404, { error: "NOT_FOUND" });
      return true;
    }
    const media = generatedReplyVideo.get(accessToken);
    if (!media) sendJson(res, 404, { error: "NOT_FOUND" });
    else sendPrivateMedia(res, media);
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/liveavatar/session-token") {
    const profileId = readGuardianProfileId(req);
    if (profileId === false) {
      sendJson(res, 400, { error: "GUARDIAN_PROFILE_ID_INVALID" });
      return true;
    }
    if (!profileId) {
      sendJson(res, 400, { error: "GUARDIAN_PROFILE_ID_REQUIRED" });
      return true;
    }
    if (!samplingMutationAllowed(req)) {
      sendJson(res, 403, { error: "CROSS_SITE_REQUEST_FORBIDDEN" });
      return true;
    }
    if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      sendJson(res, 415, { error: "CONTENT_TYPE_UNSUPPORTED" });
      return true;
    }
    try {
      const input = await readJson(req, 4 * 1024);
      if (input.externalProcessingApproved !== true) {
        sendJson(res, 422, { error: "EXTERNAL_PROCESSING_CONSENT_REQUIRED" });
        return true;
      }
      const sample = guardianSampling.resolve(profileId, input.consentId, input.avatarAssetId);
      if (!sample) {
        sendJson(res, 409, { error: "SAMPLING_NOT_REGISTERED" });
        return true;
      }
      const session = await activeLiveAvatarProvider.createSessionToken();
      sendJson(res, 201, {
        sessionToken: session.sessionToken,
        apiUrl: session.apiUrl,
        maxSessionDuration: session.maxSessionDuration,
        liveAvatar: activeLiveAvatarProvider.status(),
      });
    } catch (error) {
      const statusCode = error instanceof LiveAvatarProviderError && error.status === 401 ? 401 : 503;
      sendJson(res, statusCode, { error: error.code || "LIVEAVATAR_SESSION_FAILED" });
    }
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/tavus/conversation") {
    const profileId = readGuardianProfileId(req);
    if (profileId === false) {
      sendJson(res, 400, { error: "GUARDIAN_PROFILE_ID_INVALID" });
      return true;
    }
    if (!profileId) {
      sendJson(res, 400, { error: "GUARDIAN_PROFILE_ID_REQUIRED" });
      return true;
    }
    if (!samplingMutationAllowed(req)) {
      sendJson(res, 403, { error: "CROSS_SITE_REQUEST_FORBIDDEN" });
      return true;
    }
    if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      sendJson(res, 415, { error: "CONTENT_TYPE_UNSUPPORTED" });
      return true;
    }
    try {
      const input = await readJson(req, 4 * 1024);
      if (input.externalProcessingApproved !== true) {
        sendJson(res, 422, { error: "EXTERNAL_PROCESSING_CONSENT_REQUIRED" });
        return true;
      }
      const sample = guardianSampling.resolve(profileId, input.consentId, input.avatarAssetId);
      if (!sample) {
        sendJson(res, 409, { error: "SAMPLING_NOT_REGISTERED" });
        return true;
      }
      const customFaceId = videoService.profileProviderTaskId?.(profileId);
      const conversation = await activeTavusProvider.createConversation({
        faceId: customFaceId || activeTavusProvider.fallbackFaceId,
      });
      tavusConversations.set(conversation.conversationId, { profileId, createdAt: Date.now() });
      sendJson(res, 201, {
        conversationId: conversation.conversationId,
        conversationUrl: conversation.conversationUrl,
        meetingToken: conversation.meetingToken,
        customFace: Boolean(customFaceId),
        tavus: activeTavusProvider.status(),
      });
    } catch (error) {
      const statusCode = error instanceof TavusProviderError
        ? error.status === 401 ? 401 : error.status === 429 ? 429 : 503
        : 503;
      sendJson(res, statusCode, { error: error.code || "TAVUS_CONVERSATION_FAILED" });
    }
    return true;
  }
  const tavusEndMatch = url.pathname.match(/^\/api\/tavus\/conversations\/([^/]+)\/end$/);
  if (req.method === "POST" && tavusEndMatch) {
    const profileId = readGuardianProfileId(req);
    if (profileId === false) {
      sendJson(res, 400, { error: "GUARDIAN_PROFILE_ID_INVALID" });
      return true;
    }
    if (!profileId) {
      sendJson(res, 400, { error: "GUARDIAN_PROFILE_ID_REQUIRED" });
      return true;
    }
    if (!samplingMutationAllowed(req)) {
      sendJson(res, 403, { error: "CROSS_SITE_REQUEST_FORBIDDEN" });
      return true;
    }
    let conversationId;
    try {
      conversationId = decodeURIComponent(tavusEndMatch[1]).trim();
    } catch {
      conversationId = "";
    }
    const owned = tavusConversations.get(conversationId);
    if (!owned || owned.profileId !== profileId) {
      sendJson(res, 404, { error: "NOT_FOUND" });
      return true;
    }
    try {
      await activeTavusProvider.endConversation(conversationId);
      tavusConversations.delete(conversationId);
      sendJson(res, 200, { ended: true });
    } catch (error) {
      sendJson(res, 503, { error: error.code || "TAVUS_END_FAILED" });
    }
    return true;
  }
  const samplingAssetMatch = url.pathname.match(/^\/api\/sampling\/assets\/(photo|voice|video)\/([^/]+)$/);
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
      : samplingAssetMatch[1] === "voice"
        ? guardianSampling.readVoice(accessToken)
        : videoService.readVideo(accessToken);
    if (!media) sendJson(res, 404, { error: "NOT_FOUND" });
    else sendPrivateMedia(res, media);
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/sampling/video") {
    const profileId = readGuardianProfileId(req);
    if (profileId === false) {
      sendJson(res, 400, { error: "GUARDIAN_PROFILE_ID_INVALID" });
      return true;
    }
    if (!profileId) {
      sendJson(res, 400, { error: "GUARDIAN_PROFILE_ID_REQUIRED" });
      return true;
    }
    if (!samplingMutationAllowed(req)) {
      sendJson(res, 403, { error: "CROSS_SITE_REQUEST_FORBIDDEN" });
      return true;
    }
    if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      sendJson(res, 415, { error: "CONTENT_TYPE_UNSUPPORTED" });
      return true;
    }
    try {
      const input = await readJson(req, 4 * 1024);
      if (input.externalProcessingApproved !== true) {
        sendJson(res, 422, { error: "EXTERNAL_PROCESSING_CONSENT_REQUIRED" });
        return true;
      }
      await videoService.deleteRemote?.(profileId).catch(() => {});
      sendJson(res, 202, videoService.start(profileId));
    } catch (error) {
      sendJson(res, error.message === "PAYLOAD_TOO_LARGE" ? 413 : error.statusCode || 400, {
        error: error.code || "VIDEO_GENERATION_REQUEST_INVALID",
      });
    }
    return true;
  }
  const samplingVideoMatch = url.pathname.match(/^\/api\/sampling\/video\/([^/]+)$/);
  if (req.method === "GET" && samplingVideoMatch) {
    const profileId = readGuardianProfileId(req);
    if (profileId === false) {
      sendJson(res, 400, { error: "GUARDIAN_PROFILE_ID_INVALID" });
      return true;
    }
    if (!profileId) {
      sendJson(res, 400, { error: "GUARDIAN_PROFILE_ID_REQUIRED" });
      return true;
    }
    let jobId;
    try {
      jobId = decodeURIComponent(samplingVideoMatch[1]);
    } catch {
      sendJson(res, 404, { error: "NOT_FOUND" });
      return true;
    }
    const status = videoService.status(profileId, jobId);
    sendJson(res, status ? 200 : 404, status ?? { error: "NOT_FOUND" });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/sampling/voice") {
    const profileId = readGuardianProfileId(req);
    if (profileId === false) {
      sendJson(res, 400, { error: "GUARDIAN_PROFILE_ID_INVALID" });
      return true;
    }
    if (!profileId) {
      sendJson(res, 400, { error: "GUARDIAN_PROFILE_ID_REQUIRED" });
      return true;
    }
    if (!samplingMutationAllowed(req)) {
      sendJson(res, 403, { error: "CROSS_SITE_REQUEST_FORBIDDEN" });
      return true;
    }
    if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      sendJson(res, 415, { error: "CONTENT_TYPE_UNSUPPORTED" });
      return true;
    }
    try {
      const currentStatus = guardianSampling.status(profileId);
      const currentSample = currentStatus.configured
        ? guardianSampling.resolve(profileId, currentStatus.consentId, currentStatus.avatarAssetId)
        : null;
      if (!currentSample) {
        sendJson(res, 409, { error: "SAMPLING_NOT_REGISTERED" });
        return true;
      }
      const input = await readJson(req, 15 * 1024 * 1024);
      const validationInput = {
        ...input,
        photoBase64: currentSample.photo.bytes.toString("base64"),
        photoType: currentSample.photo.mimeType,
        faceApproved: true,
      };
      const validationStore = createGuardianSamplingStore();
      let clonedVoice = null;
      try {
        const validationStatus = validationStore.register(validationInput);
        const validated = validationStore.resolve(validationStatus.consentId, validationStatus.avatarAssetId);
        if (activeVoiceProvider.name === "elevenlabs") {
          if (!activeVoiceProvider.available) {
            throw new ElevenLabsError("ELEVENLABS_NOT_CONFIGURED", "ElevenLabs is not configured");
          }
          clonedVoice = await activeVoiceProvider.cloneVoice({
            bytes: validated.voice.bytes,
            mimeType: validated.voice.mimeType,
            name: `Mama Message ${profileId.slice(0, 8)}`,
          });
        }
      } finally {
        validationStore.delete();
      }
      let updated;
      try {
        updated = guardianSampling.replaceVoice(profileId, input, { voiceClone: clonedVoice });
      } catch (error) {
        if (clonedVoice?.voiceId) await activeVoiceProvider.deleteVoice(clonedVoice.voiceId).catch(() => {});
        throw error;
      }
      if (currentSample.voiceClone?.voiceId && currentSample.voiceClone.voiceId !== clonedVoice?.voiceId) {
        await activeVoiceProvider.deleteVoice(currentSample.voiceClone.voiceId).catch(() => {});
      }
      sendJson(res, 200, samplingApiView(updated, videoService.profileStatus?.(profileId)));
    } catch (error) {
      const statusCode = error.message === "PAYLOAD_TOO_LARGE"
        ? 413
        : error instanceof ElevenLabsError
          ? error.status === 401 ? 401 : error.status === 429 ? 429 : 502
          : error instanceof GuardianSamplingError
            ? error.statusCode
            : 400;
      sendJson(res, statusCode, {
        error: error.code || "VOICE_SAMPLING_REQUEST_INVALID",
        message: error instanceof ElevenLabsError
          ? "ElevenLabsで声を作れませんでした。APIキー、利用枠、録音内容を確認してください。"
          : undefined,
      });
    }
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/sampling/preferences") {
    const profileId = readGuardianProfileId(req);
    if (!profileId) {
      sendJson(res, 400, { error: "GUARDIAN_PROFILE_ID_REQUIRED" });
      return true;
    }
    if (!samplingMutationAllowed(req)) {
      sendJson(res, 403, { error: "CROSS_SITE_REQUEST_FORBIDDEN" });
      return true;
    }
    try {
      const input = await readJson(req, 16 * 1024);
      guardianSampling.updatePreferences(profileId, input);
      sendJson(res, 200, samplingApiView(
        guardianSampling.status(profileId),
        videoService.profileStatus?.(profileId),
      ));
    } catch (error) {
      sendJson(res, error instanceof GuardianSamplingError ? error.statusCode : 400, {
        error: error.code || "PREFERENCES_REQUEST_INVALID",
        message: error instanceof GuardianSamplingError
          ? "先に保護者の写真と声を登録してください。"
          : "好きなものを保存できませんでした。",
      });
    }
    return true;
  }
  if (url.pathname === "/api/sampling") {
    const profileId = readGuardianProfileId(req);
    if (!profileId) {
      sendJson(res, 400, { error: "GUARDIAN_PROFILE_ID_REQUIRED" });
      return true;
    }
    if (req.method === "GET") {
      sendJson(res, 200, samplingApiView(
        guardianSampling.status(profileId),
        videoService.profileStatus?.(profileId),
      ));
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
        const input = await readJson(req, 20 * 1024 * 1024);
        const validationStore = createGuardianSamplingStore();
        let clonedVoice = null;
        let validatedSample;
        try {
          const validationStatus = validationStore.register(input);
          validatedSample = validationStore.resolve(validationStatus.consentId, validationStatus.avatarAssetId);
          if (activeVoiceProvider.name === "elevenlabs") {
            if (!activeVoiceProvider.available) {
              throw new ElevenLabsError("ELEVENLABS_NOT_CONFIGURED", "ElevenLabs is not configured");
            }
            clonedVoice = await activeVoiceProvider.cloneVoice({
              bytes: validatedSample.voice.bytes,
              mimeType: validatedSample.voice.mimeType,
              name: `Mama Message ${profileId.slice(0, 8)}`,
            });
          }
        } finally {
          validationStore.delete();
        }

        const previousStatus = guardianSampling.status(profileId);
        const previousSample = previousStatus.configured
          ? guardianSampling.resolve(profileId, previousStatus.consentId, previousStatus.avatarAssetId)
          : null;
        let created;
        try {
          if (previousStatus.configured) {
            await endTavusConversationsForProfile(profileId, activeTavusProvider);
            await videoService.deleteRemote?.(profileId);
          }
          created = guardianSampling.register(profileId, input, { voiceClone: clonedVoice });
        } catch (error) {
          if (clonedVoice?.voiceId) await activeVoiceProvider.deleteVoice(clonedVoice.voiceId).catch(() => {});
          throw error;
        }
        if (previousSample?.voiceClone?.voiceId && previousSample.voiceClone.voiceId !== clonedVoice?.voiceId) {
          await activeVoiceProvider.deleteVoice(previousSample.voiceClone.voiceId).catch(() => {});
        }
        sendJson(res, 201, samplingApiView(created, videoService.profileStatus?.(profileId)));
      } catch (error) {
        const statusCode = error.message === "PAYLOAD_TOO_LARGE"
          ? 413
          : error instanceof ElevenLabsError
            ? error.status === 401 ? 401 : error.status === 429 ? 429 : 502
          : error instanceof GuardianSamplingError
            ? error.statusCode
            : 400;
        sendJson(res, statusCode, {
          error: error.code || "SAMPLING_REQUEST_INVALID",
          message: error instanceof ElevenLabsError
            ? "ElevenLabsで声を作れませんでした。APIキー、利用枠、録音内容を確認してください。"
            : undefined,
        });
      }
      return true;
    }
    if (req.method === "DELETE") {
      if (!samplingMutationAllowed(req)) {
        sendJson(res, 403, { error: "CROSS_SITE_REQUEST_FORBIDDEN" });
        return true;
      }
      const previousStatus = guardianSampling.status(profileId);
      const previousSample = previousStatus.configured
        ? guardianSampling.resolve(profileId, previousStatus.consentId, previousStatus.avatarAssetId)
        : null;
      if (previousSample?.voiceClone?.voiceId && activeVoiceProvider.available) {
        try {
          await activeVoiceProvider.deleteVoice(previousSample.voiceClone.voiceId);
        } catch {
          sendJson(res, 502, {
            error: "ELEVENLABS_DELETE_FAILED",
            message: "ElevenLabs上の音声を削除できませんでした。接続を確認してもう一度お試しください。",
          });
          return true;
        }
      }
      try {
        await endTavusConversationsForProfile(profileId, activeTavusProvider);
        await videoService.deleteRemote?.(profileId);
      } catch {
        sendJson(res, 502, {
          error: "REMOTE_AVATAR_DELETE_FAILED",
          message: "外部サービス上の本人アバターを削除できませんでした。接続を確認してもう一度お試しください。",
        });
        return true;
      }
      const result = guardianSampling.delete(profileId);
      sendJson(res, 200, { ...samplingApiView(result), deleted: result.deleted });
      return true;
    }
  }
  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, {
      status: "ok",
      routerMode,
      routerConfigured: routerProvider.available,
      routerModel: process.env.ORCAROUTER_MODEL || "orcarouter/auto",
      sttMode,
      sttConfigured: Boolean(process.env.STT_API_KEY || process.env.OPENAI_API_KEY),
      mediaMode: String(process.env.MEDIA_PROVIDER || "demo").toLowerCase(),
      preRecordedVideoConfigured: Boolean(process.env.PREGENERATED_VIDEO_URL),
      videoGenerationMode,
      videoGenerationProvider: videoProvider.name,
      videoGenerationConfigured: videoGenerationMode === "tavus"
        ? tavusProvider.streamingAvailable
        : videoProvider.available,
      replyMotionConfigured: videoProvider.name === "heygen" && videoProvider.available,
      liveAvatarConfigured: liveAvatarProvider.available,
      liveAvatarMode: liveAvatarProvider.status().mode,
      liveAvatarSandbox: liveAvatarProvider.sandbox,
      liveAvatarCustomAvatarConfigured: liveAvatarProvider.customAvatarConfigured,
      tavusConfigured: tavusProvider.streamingAvailable,
      tavusFaceCreationConfigured: tavusProvider.faceCreationAvailable,
      voiceCloningMode,
      voiceCloningProvider: activeVoiceProvider.name,
      voiceCloningConfigured: activeVoiceProvider.available,
    });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/consent") {
    const profileId = readGuardianProfileId(req);
    if (profileId === false) {
      sendJson(res, 400, { error: "GUARDIAN_PROFILE_ID_INVALID" });
      return true;
    }
    const samplingStatus = profileId ? guardianSampling.status(profileId) : null;
    sendJson(res, 200, samplingStatus?.configured && samplingStatus.active
      ? customConsentView(samplingStatus)
      : profileDemoConsent(profileId));
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/consent") {
    try {
      const profileId = readGuardianProfileId(req);
      if (profileId === false) {
        sendJson(res, 400, { error: "GUARDIAN_PROFILE_ID_INVALID" });
        return true;
      }
      const input = await readJson(req);
      if (!new Set(["revoke", "restore"]).has(input.action)) {
        sendJson(res, 400, { error: "CONSENT_ACTION_INVALID" });
        return true;
      }
      if (profileId) {
        if (input.action === "revoke") {
          const previousStatus = guardianSampling.status(profileId);
          const previousSample = previousStatus.configured
            ? guardianSampling.resolve(profileId, previousStatus.consentId, previousStatus.avatarAssetId)
            : null;
          if (previousSample?.voiceClone?.voiceId && activeVoiceProvider.available) {
            await activeVoiceProvider.deleteVoice(previousSample.voiceClone.voiceId).catch(() => {});
          }
          await endTavusConversationsForProfile(profileId, activeTavusProvider).catch(() => {});
          await videoService.deleteRemote?.(profileId).catch(() => {});
          guardianSampling.revoke(profileId);
        }
        demoConsentByProfile.set(profileId, input.action === "restore");
        sendJson(res, 200, profileDemoConsent(profileId));
      } else {
        demoConsent.active = input.action === "restore";
        sendJson(res, 200, demoConsent);
      }
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
      const guardianProfileId = readGuardianProfileId(req);
      if (guardianProfileId === false) {
        sendJson(res, 400, { error: "GUARDIAN_PROFILE_ID_INVALID" });
        return true;
      }
      const input = await readJson(req);
      input.guardianProfileId = guardianProfileId;
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
      if (input.conversationId != null && (
        typeof input.conversationId !== "string"
        || !input.conversationId.trim()
        || input.conversationId.trim().length > 128
      )) {
        sendJson(res, 400, { error: "CONVERSATION_ID_INVALID" });
        return true;
      }
      input.conversationId = input.conversationId?.trim() || input.sessionId.trim();
      const key = `${guardianProfileId || "legacy"}:${String(input.idempotencyKey || `${input.sessionId}:${input.transcriptId}`)}`;
      if (idempotency.has(key)) {
        sendJson(res, 202, responses.get(idempotency.get(key)));
        return true;
      }
      const requestId = `req_${randomUUID()}`;
      const record = {
        requestId,
        status: "PENDING",
        guardianProfileId,
        conversationId: input.conversationId,
        createdAt: new Date().toISOString(),
      };
      responses.set(requestId, record);
      idempotency.set(key, requestId);
      const startedAt = Date.now();
      setTimeout(() => {
        finishResponse(requestId, input, startedAt, runtime).catch(() => {
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
    const guardianProfileId = readGuardianProfileId(req);
    if (guardianProfileId === false) {
      sendJson(res, 400, { error: "GUARDIAN_PROFILE_ID_INVALID" });
      return true;
    }
    const record = responses.get(responseMatch[1]);
    const allowed = record && (!record.guardianProfileId || record.guardianProfileId === guardianProfileId);
    sendJson(res, allowed ? 200 : 404, allowed ? record : { error: "NOT_FOUND" });
    return true;
  }
  if (req.method === "DELETE" && responseMatch) {
    const guardianProfileId = readGuardianProfileId(req);
    if (guardianProfileId === false) {
      sendJson(res, 400, { error: "GUARDIAN_PROFILE_ID_INVALID" });
      return true;
    }
    const requestId = responseMatch[1];
    const record = responses.get(requestId);
    const allowed = record && (!record.guardianProfileId || record.guardianProfileId === guardianProfileId);
    const existed = allowed ? responses.delete(requestId) : false;
    for (const [key, storedRequestId] of idempotency) {
      if (storedRequestId === requestId) idempotency.delete(key);
    }
    sendJson(res, existed ? 200 : 404, existed ? { deleted: true } : { error: "NOT_FOUND" });
    return true;
  }

  const conversationMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)$/);
  if (req.method === "DELETE" && conversationMatch) {
    const guardianProfileId = readGuardianProfileId(req);
    if (guardianProfileId === false) {
      sendJson(res, 400, { error: "GUARDIAN_PROFILE_ID_INVALID" });
      return true;
    }
    let conversationId;
    try {
      conversationId = decodeURIComponent(conversationMatch[1]).trim();
    } catch {
      conversationId = "";
    }
    if (!conversationId || conversationId.length > 128) {
      sendJson(res, 400, { error: "CONVERSATION_ID_INVALID" });
      return true;
    }
    const deleted = conversations.delete(conversationStorageKey(guardianProfileId, conversationId));
    sendJson(res, 200, { deleted });
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

export function createAppServer(options = {}) {
  const runtime = {
    videoService: options.videoService ?? guardianVideoService,
    replyVideoProvider: options.replyVideoProvider
      ?? (videoProvider.name === "heygen" ? videoProvider : null),
    videoDownloader: options.videoDownloader ?? downloadGeneratedVideo,
    voiceCloningProvider: options.voiceCloningProvider ?? voiceCloningProvider,
    liveAvatarProvider: options.liveAvatarProvider ?? liveAvatarProvider,
    tavusProvider: options.tavusProvider ?? tavusProvider,
  };
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      const handled = await apiHandler(req, res, url, runtime);
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
