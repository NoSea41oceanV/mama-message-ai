const DEFAULT_BASE_URL = "https://api.liveavatar.com";
export const LIVEAVATAR_SANDBOX_AVATAR_ID = "dd73ea75-1218-4ef3-92ce-606d5f7fbc0a";

export class LiveAvatarProviderError extends Error {
  constructor(code, message, { status = null, providerCode = null } = {}) {
    super(message);
    this.name = "LiveAvatarProviderError";
    this.code = code;
    this.status = status;
    this.providerCode = providerCode;
  }
}

function cleanBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
}

function enabled(value, fallback = false) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function boundedDuration(value, fallback = 60) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(30, Math.min(20 * 60, Math.round(parsed)));
}

function boundedTimeoutMs(value, fallback = 20_000) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1_000, Math.min(120_000, Math.round(parsed)));
}

function validProviderCode(value) {
  const candidate = String(value ?? "").trim();
  return /^[a-z0-9_.:-]{1,80}$/i.test(candidate) ? candidate : null;
}

export function createLiveAvatarProvider(options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const apiKey = String(options.apiKey ?? env.LIVEAVATAR_API_KEY ?? "").trim();
  const baseUrl = cleanBaseUrl(options.baseUrl ?? env.LIVEAVATAR_BASE_URL);
  const sandbox = enabled(options.sandbox ?? env.LIVEAVATAR_SANDBOX, true);
  const customAvatarId = String(options.avatarId ?? env.LIVEAVATAR_AVATAR_ID ?? "").trim();
  const avatarId = sandbox ? LIVEAVATAR_SANDBOX_AVATAR_ID : customAvatarId;
  const requestTimeoutMs = boundedTimeoutMs(
    options.timeoutMs ?? (Number(env.LIVEAVATAR_REQUEST_TIMEOUT_SECONDS || 20) * 1000),
    20_000,
  );
  const maxSessionDuration = boundedDuration(
    options.maxSessionDuration ?? env.LIVEAVATAR_MAX_SESSION_DURATION_SECONDS,
    sandbox ? 60 : 300,
  );
  let secureBaseUrl = false;
  try {
    secureBaseUrl = new URL(baseUrl).protocol === "https:";
  } catch {}
  const available = Boolean(apiKey && secureBaseUrl && avatarId);

  async function request(path, init = {}) {
    if (!available) {
      throw new LiveAvatarProviderError(
        customAvatarId || sandbox ? "LIVEAVATAR_NOT_CONFIGURED" : "LIVEAVATAR_AVATAR_REQUIRED",
        "LiveAvatar is not configured",
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    timer.unref?.();
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        ...init,
        redirect: "error",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "X-API-KEY": apiKey,
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });
      let payload = {};
      try {
        payload = await response.json();
      } catch {}
      if (!response.ok || payload?.code !== 1000) {
        throw new LiveAvatarProviderError("LIVEAVATAR_HTTP_ERROR", `LiveAvatar returned HTTP ${response.status}`, {
          status: response.status,
          providerCode: validProviderCode(payload?.code),
        });
      }
      return payload.data ?? {};
    } catch (error) {
      if (error instanceof LiveAvatarProviderError) throw error;
      if (controller.signal.aborted) {
        throw new LiveAvatarProviderError("LIVEAVATAR_TIMEOUT", "LiveAvatar request timed out");
      }
      throw new LiveAvatarProviderError("LIVEAVATAR_NETWORK_ERROR", "LiveAvatar request failed");
    } finally {
      clearTimeout(timer);
    }
  }

  async function createSessionToken() {
    const data = await request("/v1/sessions/token", {
      method: "POST",
      body: JSON.stringify({
        mode: "LITE",
        is_sandbox: sandbox,
        avatar_id: avatarId,
        video_settings: { quality: "high", encoding: "H264" },
        max_session_duration: maxSessionDuration,
      }),
    });
    const sessionToken = String(data.session_token ?? "").trim();
    const sessionId = String(data.session_id ?? "").trim();
    if (!sessionToken || !sessionId) {
      throw new LiveAvatarProviderError("LIVEAVATAR_TOKEN_MISSING", "LiveAvatar did not return a session token");
    }
    return Object.freeze({ sessionToken, sessionId, apiUrl: baseUrl, maxSessionDuration });
  }

  function status() {
    const state = !apiKey || !secureBaseUrl
      ? "unavailable"
      : customAvatarId
        ? "ready"
        : sandbox
          ? "sandbox"
          : "avatar_required";
    return Object.freeze({
      available,
      configured: available,
      mode: "LITE",
      sandbox,
      customAvatarConfigured: Boolean(customAvatarId),
      avatarKind: customAvatarId ? "custom" : sandbox ? "sandbox_public" : "none",
      status: state,
    });
  }

  return Object.freeze({
    name: "liveavatar",
    available,
    sandbox,
    customAvatarConfigured: Boolean(customAvatarId),
    maxSessionDuration,
    createSessionToken,
    status,
  });
}
