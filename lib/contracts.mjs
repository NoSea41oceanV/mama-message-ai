export const SAFETY_LEVELS = Object.freeze(["normal", "adult_required", "urgent", "uncertain"]);

export const SUPPORT_MODES = Object.freeze([
  "celebrate",
  "comfort",
  "calm",
  "encourage",
  "listen",
  "transition",
  "basic_need",
  "clarify",
  "adult_handoff",
]);

export const GUARDIAN_RESPONSE_FIELDS = Object.freeze([
  "safetyLevel",
  "supportMode",
  "emotion",
  "reasonCodes",
  "replyText",
  "voiceTone",
  "expression",
]);

export const ROUTER_DECISION_FIELDS = Object.freeze([
  "safetyLevel",
  "supportMode",
  "emotion",
  "reasonCodes",
  "replyText",
]);

export const ROUTER_DECISION_JSON_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ROUTER_DECISION_FIELDS,
  properties: {
    safetyLevel: { type: "string", enum: SAFETY_LEVELS },
    supportMode: { type: "string", enum: SUPPORT_MODES },
    emotion: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
    reasonCodes: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1 } },
    replyText: { type: "string", minLength: 1 },
  },
});

export const GUARDIAN_RESPONSE_JSON_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: GUARDIAN_RESPONSE_FIELDS,
  properties: {
    safetyLevel: { type: "string", enum: SAFETY_LEVELS },
    supportMode: { type: "string", enum: SUPPORT_MODES },
    emotion: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
    reasonCodes: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
    replyText: { type: "string", minLength: 1 },
    voiceTone: { type: "string", minLength: 1 },
    expression: { type: "string", minLength: 1 },
  },
});

export const MEDIA_LEVELS = Object.freeze({
  GENERATED_VIDEO: 1,
  PRE_RECORDED_VIDEO: 2,
  STILL_SPEECH_SUBTITLE: 3,
  NEUTRAL_GUIDANCE: 4,
});

export const MEDIA_TIERS = Object.freeze({
  1: "GENERATED_VIDEO",
  2: "PRE_RECORDED_VIDEO",
  3: "STILL_AUDIO",
  4: "NEUTRAL_GUIDANCE",
});

export const DEFAULT_HANDOFF_REPLY =
  "うまく判断できなかったよ。そばにいる大人といっしょに確認しようね。";
export const DEFAULT_NEUTRAL_GUIDANCE =
  "いまは映像を用意できません。そばにいる大人といっしょに確認しようね。";

export class ContractValidationError extends TypeError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "ContractValidationError";
    this.code = "INVALID_PROVIDER_RESPONSE";
  }
}

export function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ContractValidationError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function requireStringArray(value, field) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ContractValidationError(`${field} must be a non-empty array`);
  }
  const normalized = value.map((item, index) => requireString(item, `${field}[${index}]`));
  if (new Set(normalized).size !== normalized.length) {
    throw new ContractValidationError(`${field} must not contain duplicates`);
  }
  return normalized;
}

function validateRoutingFields(value, allowedFields, label) {
  if (!isPlainObject(value)) {
    throw new ContractValidationError(`${label} must be an object`);
  }
  const missing = allowedFields.filter((field) => !Object.hasOwn(value, field));
  const unexpected = Object.keys(value).filter((field) => !allowedFields.includes(field));
  if (missing.length || unexpected.length) {
    throw new ContractValidationError(`${label} has missing or unexpected fields`);
  }
  if (!SAFETY_LEVELS.includes(value.safetyLevel)) {
    throw new ContractValidationError("safetyLevel is invalid");
  }
  if (!SUPPORT_MODES.includes(value.supportMode)) {
    throw new ContractValidationError("supportMode is invalid");
  }
  if (value.safetyLevel !== "normal" && value.supportMode !== "adult_handoff") {
    throw new ContractValidationError("non-normal safety decisions must use adult_handoff");
  }
}

export function validateGuardianResponse(value) {
  validateRoutingFields(value, GUARDIAN_RESPONSE_FIELDS, "guardian response");

  return Object.freeze({
    safetyLevel: value.safetyLevel,
    supportMode: value.supportMode,
    emotion: Object.freeze(requireStringArray(value.emotion, "emotion")),
    reasonCodes: Object.freeze(requireStringArray(value.reasonCodes, "reasonCodes")),
    replyText: requireString(value.replyText, "replyText"),
    voiceTone: requireString(value.voiceTone, "voiceTone"),
    expression: requireString(value.expression, "expression"),
  });
}

export function normalizeRouterDecision(value) {
  validateRoutingFields(value, ROUTER_DECISION_FIELDS, "router decision");
  return Object.freeze({
    safetyLevel: value.safetyLevel,
    supportMode: value.supportMode,
    emotion: Object.freeze(requireStringArray(value.emotion, "emotion")),
    reasonCodes: Object.freeze(requireStringArray(value.reasonCodes, "reasonCodes")),
    replyText: requireString(value.replyText, "replyText"),
  });
}

export const validateRouterDecision = normalizeRouterDecision;

export function isValidRouterDecision(value) {
  try {
    normalizeRouterDecision(value);
    return true;
  } catch {
    return false;
  }
}

export function createAdultHandoffFallback(reasonCode = "PROVIDER_UNCERTAIN") {
  return validateGuardianResponse({
    safetyLevel: "uncertain",
    supportMode: "adult_handoff",
    emotion: ["unknown"],
    reasonCodes: [String(reasonCode || "PROVIDER_UNCERTAIN")],
    replyText: DEFAULT_HANDOFF_REPLY,
    voiceTone: "calm",
    expression: "concerned",
  });
}

export function createFailClosedDecision(reasonCode = "PROVIDER_UNCERTAIN") {
  return normalizeRouterDecision({
    safetyLevel: "uncertain",
    supportMode: "adult_handoff",
    emotion: ["unknown"],
    reasonCodes: [String(reasonCode || "PROVIDER_UNCERTAIN")],
    replyText: DEFAULT_HANDOFF_REPLY,
  });
}

export function requiresAdultHandoff(decision) {
  return !decision || decision.safetyLevel !== "normal" || decision.supportMode === "adult_handoff";
}

export function normalizeMediaBundle(value) {
  if (!isPlainObject(value)) throw new ContractValidationError("media bundle must be an object");
  if (![1, 2, 3, 4].includes(value.fallbackLevel)) {
    throw new ContractValidationError("media bundle has an invalid fallbackLevel");
  }
  if (value.tier !== MEDIA_TIERS[value.fallbackLevel]) {
    throw new ContractValidationError("media tier does not match fallbackLevel");
  }
  requireString(value.subtitle, "subtitle");
  if (typeof value.parentLike !== "boolean") {
    throw new ContractValidationError("media parentLike must be boolean");
  }
  if (value.fallbackLevel === MEDIA_LEVELS.NEUTRAL_GUIDANCE && value.parentLike) {
    throw new ContractValidationError("LEVEL 4 media cannot be parent-like");
  }
  if ([MEDIA_LEVELS.GENERATED_VIDEO, MEDIA_LEVELS.PRE_RECORDED_VIDEO].includes(value.fallbackLevel)) {
    requireString(value.videoUrl, "videoUrl");
  }
  if (value.fallbackLevel === MEDIA_LEVELS.STILL_SPEECH_SUBTITLE) {
    requireString(value.posterUrl, "posterUrl");
  }
  return Object.freeze({ ...value, subtitle: value.subtitle.trim() });
}

export const validateMediaBundle = normalizeMediaBundle;
