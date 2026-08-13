import {
  DEFAULT_NEUTRAL_GUIDANCE,
  MEDIA_LEVELS,
  MEDIA_TIERS,
  normalizeMediaBundle,
  requiresAdultHandoff,
} from "../contracts.mjs";

export const DEMO_FAULT_MODES = Object.freeze({
  NONE: "none",
  GENERATED_VIDEO_FAILURE: "generated_video_failure",
  VIDEO_FAILURE: "video_failure",
  SPEECH_FAILURE: "speech_failure",
  MEDIA_UNAVAILABLE: "media-unavailable",
});

export class MediaProviderError extends Error {
  constructor(code, message, { adultHandoff = false } = {}) {
    super(message);
    this.name = "MediaProviderError";
    this.code = code;
    this.adultHandoff = adultHandoff;
    this.responseBundle = null;
  }
}

function nonEmptyString(value) {
  return typeof value === "string" && Boolean(value.trim());
}

export function isLevel1BundleReady(bundle) {
  return bundle?.fallbackLevel === 1 && bundle.parentLike === true
    && nonEmptyString(bundle.videoUrl) && bundle.audioInVideo === true
    && nonEmptyString(bundle.subtitle);
}

export function isLevel2BundleReady(bundle) {
  return bundle?.fallbackLevel === 2 && bundle.parentLike === true
    && bundle.preRecorded === true && nonEmptyString(bundle.videoUrl)
    && nonEmptyString(bundle.subtitle);
}

export function isLevel3BundleReady(bundle) {
  return bundle?.fallbackLevel === 3 && bundle.parentLike === true
    && nonEmptyString(bundle.posterUrl)
    && (nonEmptyString(bundle.audioUrl) || bundle.speechSynthesis === true)
    && nonEmptyString(bundle.subtitle);
}

export function isLevel4BundleReady(bundle) {
  return bundle?.fallbackLevel === 4 && bundle.parentLike === false
    && nonEmptyString(bundle.neutralNotice) && nonEmptyString(bundle.subtitle)
    && !bundle.videoUrl && !bundle.posterUrl && bundle.speechSynthesis === false;
}

const validators = Object.freeze({
  1: isLevel1BundleReady,
  2: isLevel2BundleReady,
  3: isLevel3BundleReady,
  4: isLevel4BundleReady,
});

export function isMediaBundleReady(bundle) {
  return bundle?.ready === true && Boolean(validators[bundle?.fallbackLevel]?.(bundle));
}

export function assertMediaBundleReady(bundle) {
  if (!isMediaBundleReady(bundle)) {
    throw new MediaProviderError("MEDIA_BUNDLE_NOT_READY", "media bundle is incomplete");
  }
  return bundle;
}

function consentIsValid(input) {
  if (typeof input.consentValid === "boolean") return input.consentValid;
  if (typeof input.consent === "boolean") return input.consent;
  if (!input.consent) return false;
  return input.consent.active === true
    && input.consent.faceApproved === true
    && input.consent.voiceApproved === true;
}

function faultModeBlocksLevel(value, level) {
  if (Number.isInteger(value) && value >= 1 && value <= 4) return level < value;
  const mode = String(value ?? "none").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!mode || mode === "none") return false;
  if (["generated_video_failure", "level2", "level_2"].includes(mode)) return level === 1;
  if (["video_failure", "level3", "level_3"].includes(mode)) return level <= 2;
  if (["speech_failure", "media_failure", "media_unavailable", "level4", "level_4"].includes(mode)) {
    return level <= 3;
  }
  return false;
}

function injectedFault(faults, level, context) {
  if (typeof faults === "function") return Boolean(faults(level, context));
  if (!faults || typeof faults !== "object") return false;
  return Boolean(faults[level] ?? faults[`level${level}`] ?? faults[`LEVEL_${level}`]);
}

function videoUrlFrom(result) {
  if (result?.ok === false || ["failed", "fallback", "unavailable"].includes(result?.status)) return "";
  if (typeof result === "string") return result.trim();
  if (nonEmptyString(result?.videoUrl)) return result.videoUrl.trim();
  if (nonEmptyString(result?.url)) return result.url.trim();
  return "";
}

async function runWithTimeout(action, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new MediaProviderError("MEDIA_TIMEOUT", "media generation timed out")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function readyBundle(level, values) {
  const candidate = normalizeMediaBundle({
    fallbackLevel: level,
    level: `LEVEL_${level}`,
    tier: MEDIA_TIERS[level],
    ready: true,
    videoUrl: null,
    posterUrl: null,
    audioInVideo: false,
    speechSynthesis: false,
    browserSpeech: false,
    preRecorded: false,
    parentLike: level < MEDIA_LEVELS.NEUTRAL_GUIDANCE,
    ...values,
  });
  return assertMediaBundleReady(candidate);
}

function level4(reason) {
  return readyBundle(MEDIA_LEVELS.NEUTRAL_GUIDANCE, {
    provider: "neutral-guidance",
    parentLike: false,
    neutralNotice: DEFAULT_NEUTRAL_GUIDANCE,
    subtitle: DEFAULT_NEUTRAL_GUIDANCE,
    reason,
    syncLevel: "subtitle-only",
  });
}

export function createMediaProvider(options = {}) {
  const env = options.env ?? process.env;
  const providerName = String(options.provider ?? env.MEDIA_PROVIDER ?? "demo").toLowerCase();
  const generatedVideoProvider = options.generatedVideoProvider
    ?? options.videoProvider
    ?? null;
  const preRecordedVideoUrl = options.preRecordedVideoUrl
    ?? options.assets?.preRecordedVideoUrl
    ?? env.PREGENERATED_VIDEO_URL
    ?? null;
  const posterUrl = options.posterUrl ?? options.assets?.posterUrl ?? "/assets/guardian-demo.png";
  const audioUrlForDecision = options.audioUrlForDecision ?? null;
  const configuredFaults = options.faults ?? options.faultInjection ?? null;
  const configuredTimeoutMs = Number(options.timeoutMs ?? (Number(env.MEDIA_TIMEOUT_SECONDS || 30) * 1000));
  const timeoutMs = Number.isFinite(configuredTimeoutMs) ? Math.max(1, configuredTimeoutMs) : 30_000;

  async function generate(input = {}) {
    const decision = input.decision ?? input.routerDecision ?? input.safetyDecision
      ?? (input.safetyLevel ? input : null);
    if (requiresAdultHandoff(decision) || !consentIsValid(input)) {
      throw new MediaProviderError(
        "ADULT_HANDOFF_REQUIRED",
        "media generation is forbidden for a non-normal decision or invalid consent",
        { adultHandoff: true },
      );
    }
    if (providerName !== "demo") {
      throw new MediaProviderError("MEDIA_PROVIDER_UNSUPPORTED", `unsupported media provider: ${providerName}`);
    }

    const subtitle = String(input.replyText ?? input.subtitle ?? decision.replyText ?? "").trim();
    if (!subtitle) return level4("MEDIA_SUBTITLE_REQUIRED");
    const context = { ...input, decision, replyText: subtitle };
    const faultMode = input.faultMode ?? options.faultMode ?? DEMO_FAULT_MODES.NONE;
    const blocked = (level) => faultModeBlocksLevel(faultMode, level)
      || injectedFault(configuredFaults, level, context);

    if (generatedVideoProvider && !blocked(1)) {
      try {
        const generator = typeof generatedVideoProvider === "function"
          ? generatedVideoProvider
          : generatedVideoProvider.generate?.bind(generatedVideoProvider)
            ?? generatedVideoProvider.create?.bind(generatedVideoProvider);
        if (typeof generator === "function") {
          const generated = await runWithTimeout(() => generator(context), timeoutMs);
          const videoUrl = videoUrlFrom(generated);
          if (videoUrl && generated?.audioInVideo === true) {
            return readyBundle(MEDIA_LEVELS.GENERATED_VIDEO, {
              provider: generatedVideoProvider.name || providerName || "generated-video",
              videoUrl,
              posterUrl: generated?.posterUrl ?? posterUrl,
              audioInVideo: true,
              subtitle,
              syncLevel: "video-audio-subtitle",
            });
          }
        }
      } catch {
        // Continue through the explicit fallback ladder.
      }
    }

    if (nonEmptyString(preRecordedVideoUrl) && !blocked(2)) {
      return readyBundle(MEDIA_LEVELS.PRE_RECORDED_VIDEO, {
        provider: "pre-recorded-video",
        videoUrl: preRecordedVideoUrl.trim(),
        posterUrl,
        audioInVideo: true,
        preRecorded: true,
        subtitle,
        syncLevel: "prerecorded-video-subtitle",
      });
    }

    if (nonEmptyString(posterUrl) && !blocked(3)) {
      const audioUrl = typeof audioUrlForDecision === "function"
        ? String(await audioUrlForDecision(decision, context) ?? "").trim()
        : "";
      return readyBundle(MEDIA_LEVELS.STILL_SPEECH_SUBTITLE, {
        provider: audioUrl ? "demo-generated-audio" : "browser-speech",
        posterUrl: posterUrl.trim(),
        audioUrl: audioUrl || null,
        speechSynthesis: !audioUrl,
        browserSpeech: !audioUrl,
        subtitle,
        syncLevel: audioUrl ? "still-audio-subtitle" : "still-speech-subtitle",
      });
    }

    return level4(blocked(3) ? "MEDIA_FAULT_INJECTED" : "LEVEL_3_UNAVAILABLE");
  }

  return Object.freeze({ name: providerName, generate, create: generate, resolve: generate });
}

export async function generateMediaBundle(input, options = {}) {
  return createMediaProvider(options).generate(input);
}

export const resolveMedia = generateMediaBundle;
