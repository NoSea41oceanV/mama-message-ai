const REQUIRED_CONSENTS = Object.freeze([
  "orcarouterTts",
  "guardianPhotoToDid",
  "replyAudioToDid",
  "syntheticGuardianVideo",
]);

function isApprovedSourceUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    return url.protocol === "https:" || url.protocol === "s3:";
  } catch {
    return false;
  }
}

export function evaluateGenerationGate(request = {}) {
  const reasons = [];
  const profile = request.profile ?? {};
  const consent = profile.consent ?? {};

  if (!String(request.profileId ?? "").trim()) reasons.push("profile_id_missing");
  if (!String(request.conversationId ?? "").trim()) reasons.push("conversation_id_missing");
  if (!String(request.replyText ?? "").trim()) reasons.push("reply_text_missing");
  if (request.replyFinal !== true) reasons.push("reply_not_final");
  if (request.route !== "generate_guardian_message") reasons.push("route_not_eligible");
  if (request.safetyDecision !== "ALLOW_GUARDIAN_VIDEO") reasons.push("safety_not_explicitly_allowed");
  if (profile.id !== request.profileId) reasons.push("profile_mismatch");
  if (profile.status !== "active") reasons.push("profile_inactive");
  if (profile.photoApproved !== true) reasons.push("photo_not_approved");
  if (!isApprovedSourceUrl(profile.sourceImageUrl)) reasons.push("source_url_not_approved");
  if (consent.revokedAt) reasons.push("consent_revoked");
  for (const field of REQUIRED_CONSENTS) {
    if (consent[field] !== true) reasons.push(`consent_missing:${field}`);
  }

  return Object.freeze({
    allowed: reasons.length === 0,
    reasons: Object.freeze(reasons),
    fallback: reasons.length === 0 ? null : "adult_handoff_or_non_external_reply",
  });
}
