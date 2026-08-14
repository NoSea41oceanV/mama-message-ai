const screens = [...document.querySelectorAll("[data-screen]")];
const backButton = document.querySelector("#backButton");
const adultButton = document.querySelector("#adultButton");
const adultDialog = document.querySelector("#adultDialog");
const closeDialog = document.querySelector("#closeDialog");
const consentCheck = document.querySelector("#consentCheck");
const consentDisclosure = document.querySelector("#consentDisclosure");
const startSetup = document.querySelector("#startSetup");
const demoScenario = document.querySelector("#demoScenario");
const recordButton = document.querySelector("#recordButton");
const demoAudioButton = document.querySelector("#demoAudioButton");
const recordLead = document.querySelector("#recordLead");
const recordActionLabel = document.querySelector("#recordActionLabel");
const recordError = document.querySelector("#recordError");
const waveform = document.querySelector("#waveform");
const timer = document.querySelector("#timer");
const transcriptInput = document.querySelector("#transcriptInput");
const retryButton = document.querySelector("#retryButton");
const confirmButton = document.querySelector("#confirmButton");
const cancelButton = document.querySelector("#cancelButton");
const responseTitle = document.querySelector("#responseTitle");
const responseVideo = document.querySelector("#responseVideo");
const responseAudio = document.querySelector("#responseAudio");
const responsePoster = document.querySelector("#responsePoster");
const neutralMedia = document.querySelector("#neutralMedia");
const mediaStage = document.querySelector("#mediaStage");
const subtitle = document.querySelector("#subtitle");
const voiceBars = document.querySelector(".voice-bars");
const playbackControls = document.querySelector("#playbackControls");
const replayButton = document.querySelector("#replayButton");
const soundButton = document.querySelector("#soundButton");
const finishButton = document.querySelector("#finishButton");
const talkAgainButton = document.querySelector("#talkAgainButton");
const adultConfirmButton = document.querySelector("#adultConfirmButton");
const adultHandoffMessage = document.querySelector("#adultHandoffMessage");
const decisionList = document.querySelector("#decisionList");
const logList = document.querySelector("#logList");
const connectionStatus = document.querySelector("#connectionStatus");
const revokeConsent = document.querySelector("#revokeConsent");
const restoreConsent = document.querySelector("#restoreConsent");
const consentAdminStatus = document.querySelector("#consentAdminStatus");

const state = {
  screen: "setup",
  sessionId: crypto.randomUUID(),
  consent: null,
  mediaRecorder: null,
  mediaStream: null,
  audioChunks: [],
  recordStartedAt: 0,
  recordTimer: null,
  autoStopTimer: null,
  transcriptId: null,
  requestId: null,
  response: null,
  pollAbort: null,
};

for (let index = 0; index < 27; index += 1) {
  const bar = document.createElement("i");
  waveform.append(bar);
}

function showScreen(name) {
  state.screen = name;
  screens.forEach((screen) => screen.classList.toggle("is-active", screen.dataset.screen === name));
  backButton.disabled = ["setup", "waiting"].includes(name);
  document.querySelector(`[data-screen="${name}"] h1`)?.focus?.();
}

function setRecordState(active) {
  recordButton.classList.toggle("is-recording", active);
  waveform.classList.toggle("is-active", active);
  recordLead.textContent = active ? "きいているよ" : "マイクをおすと、きいているよ";
  recordActionLabel.textContent = active ? "おわったら、ここをおしてね" : "おしておはなし";
  recordButton.setAttribute("aria-label", active ? "録音を停止する" : "録音を開始する");
}

function stopTracks() {
  state.mediaStream?.getTracks().forEach((track) => track.stop());
  state.mediaStream = null;
  clearInterval(state.recordTimer);
  clearTimeout(state.autoStopTimer);
}

function updateTimer() {
  const seconds = Math.min(15, Math.floor((Date.now() - state.recordStartedAt) / 1000));
  timer.textContent = `00:${String(seconds).padStart(2, "0")}`;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function transcribe({ blob = null, useDemo = false } = {}) {
  recordError.textContent = "";
  recordButton.disabled = true;
  demoAudioButton.disabled = true;
  try {
    const payload = {
      durationMs: state.recordStartedAt ? Date.now() - state.recordStartedAt : 0,
      audioType: blob?.type ?? null,
      audioBase64: blob ? await blobToBase64(blob) : null,
      demoTranscript: useDemo ? demoScenario.value : null,
      demoFallbackTranscript: demoScenario.value,
    };
    const response = await fetch("/api/transcriptions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "音声を聞き取れませんでした");
    state.transcriptId = data.transcriptId;
    transcriptInput.value = data.transcript;
    showScreen("transcript");
  } catch (error) {
    recordError.textContent = `${error.message}。もう一度ためしてね。`;
  } finally {
    recordButton.disabled = false;
    demoAudioButton.disabled = false;
    timer.textContent = "00:00";
  }
}

async function stopRecording() {
  if (!state.mediaRecorder || state.mediaRecorder.state === "inactive") return;
  state.mediaRecorder.stop();
  setRecordState(false);
  stopTracks();
}

async function startRecording() {
  recordError.textContent = "";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.mediaStream = stream;
    state.audioChunks = [];
    state.mediaRecorder = new MediaRecorder(stream);
    state.mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data.size) state.audioChunks.push(event.data);
    });
    state.mediaRecorder.addEventListener("stop", async () => {
      const blob = new Blob(state.audioChunks, { type: state.mediaRecorder.mimeType || "audio/webm" });
      await transcribe({ blob });
    }, { once: true });
    state.mediaRecorder.start(250);
    state.recordStartedAt = Date.now();
    updateTimer();
    state.recordTimer = setInterval(updateTimer, 250);
    state.autoStopTimer = setTimeout(stopRecording, 15000);
    setRecordState(true);
  } catch {
    recordError.textContent = "マイクを使えませんでした。デモ音声ならそのまま進めます。";
  }
}

async function pollResponse(requestId) {
  state.pollAbort?.abort();
  state.pollAbort = new AbortController();
  const started = Date.now();
  while (Date.now() - started < 30000) {
    const response = await fetch(`/api/responses/${encodeURIComponent(requestId)}`, { signal: state.pollAbort.signal });
    const data = await response.json();
    if (data.status === "READY") {
      state.response = data;
      renderDecision(data);
      await prepareResponse(data);
      showScreen("response");
      await playResponse();
      return;
    }
    if (data.status === "ADULT_HANDOFF") {
      state.response = data;
      renderDecision(data);
      adultHandoffMessage.textContent = data.adultMessage;
      showScreen("safety");
      return;
    }
    if (data.status === "FAILED") throw new Error("RESPONSE_FAILED");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("RESPONSE_TIMEOUT");
}

async function createResponse() {
  const confirmedTranscript = transcriptInput.value.trim();
  if (!confirmedTranscript) {
    transcriptInput.focus();
    return;
  }
  showScreen("waiting");
  try {
    const response = await fetch("/api/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: state.sessionId,
        transcriptId: state.transcriptId,
        confirmedTranscript,
        consentId: state.consent?.consentId,
        avatarAssetId: state.consent?.avatarAssetId,
        demoFault: demoScenario.selectedOptions[0]?.dataset.demoFault ?? null,
        idempotencyKey: `${state.sessionId}:${state.transcriptId}`,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "REQUEST_FAILED");
    state.requestId = data.requestId;
    await pollResponse(data.requestId);
  } catch (error) {
    if (error.name === "AbortError") return;
    state.response = {
      status: "ADULT_HANDOFF",
      routerDecision: { safetyLevel: "uncertain", supportMode: "adult_handoff", emotion: ["unknown"] },
    };
    adultHandoffMessage.textContent = "返答を準備できませんでした。そばで話を聞き、あとでもう一度試してください。";
    renderDecision(state.response);
    showScreen("safety");
  }
}

function waitForMedia(element, timeoutMs = 5000) {
  if (element.readyState >= 2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("MEDIA_LOAD_TIMEOUT")), timeoutMs);
    const finish = (error = null) => {
      clearTimeout(timer);
      element.removeEventListener("loadeddata", onReady);
      element.removeEventListener("error", onError);
      if (error) reject(error);
      else resolve();
    };
    const onReady = () => finish();
    const onError = () => finish(new Error("MEDIA_LOAD_FAILED"));
    element.addEventListener("loadeddata", onReady, { once: true });
    element.addEventListener("error", onError, { once: true });
    element.load();
  });
}

async function prepareResponse(data) {
  const bundle = data.responseBundle;
  const responseScreen = document.querySelector('[data-screen="response"]');
  responseScreen.dataset.supportMode = data.supportMode ?? data.routerDecision?.supportMode ?? "listen";
  responseScreen.classList.toggle("is-neutral-response", bundle.parentLike === false);
  subtitle.textContent = bundle.subtitle;
  responseTitle.textContent = bundle.parentLike === false ? "いっしょに確認しよう" : "おへんじがとどいたよ";
  responsePoster.src = bundle.posterUrl ?? "";
  responsePoster.hidden = Boolean(bundle.videoUrl) || !bundle.posterUrl;
  responseVideo.hidden = !bundle.videoUrl;
  neutralMedia.hidden = Boolean(bundle.videoUrl || bundle.posterUrl);
  mediaStage.classList.toggle("is-neutral", !bundle.videoUrl && !bundle.posterUrl);
  playbackControls.hidden = !bundle.videoUrl && !bundle.audioUrl && !bundle.speechSynthesis;
  voiceBars.hidden = !bundle.videoUrl && !bundle.audioUrl && !bundle.speechSynthesis;
  if (bundle.videoUrl) {
    responseVideo.src = bundle.videoUrl;
    responseVideo.poster = bundle.posterUrl ?? "";
    await waitForMedia(responseVideo);
  } else {
    responseVideo.removeAttribute("src");
    responseVideo.load();
  }
  if (bundle.audioUrl) {
    responseAudio.src = bundle.audioUrl;
    await waitForMedia(responseAudio);
  } else {
    responseAudio.removeAttribute("src");
    responseAudio.load();
  }
}

function stopSpeech() {
  speechSynthesis.cancel();
  responseVideo.pause();
  responseAudio.pause();
  mediaStage.classList.remove("is-speaking");
}

async function playResponse() {
  if (!state.response?.responseBundle) return;
  stopSpeech();
  const bundle = state.response.responseBundle;
  mediaStage.classList.add("is-speaking");
  if (bundle.videoUrl) {
    responseVideo.currentTime = 0;
    responseVideo.addEventListener("ended", () => mediaStage.classList.remove("is-speaking"), { once: true });
    try {
      await responseVideo.play();
    } catch {
      mediaStage.classList.remove("is-speaking");
    }
    return;
  }
  if (bundle.audioUrl) {
    responseAudio.currentTime = 0;
    responseAudio.addEventListener("ended", () => mediaStage.classList.remove("is-speaking"), { once: true });
    responseAudio.addEventListener("error", () => mediaStage.classList.remove("is-speaking"), { once: true });
    await responseAudio.play();
    return;
  }
  if (!bundle.speechSynthesis) {
    mediaStage.classList.remove("is-speaking");
    return;
  }
  const utterance = new SpeechSynthesisUtterance(bundle.subtitle);
  utterance.lang = "ja-JP";
  utterance.rate = 0.86;
  utterance.pitch = 1.04;
  utterance.addEventListener("end", () => mediaStage.classList.remove("is-speaking"), { once: true });
  utterance.addEventListener("error", () => mediaStage.classList.remove("is-speaking"), { once: true });
  speechSynthesis.speak(utterance);
}

function renderDecision(data) {
  const decision = data.routerDecision ?? {};
  const bundle = data.responseBundle;
  decisionList.innerHTML = `
    <dt>状態</dt><dd>${data.status ?? "-"}</dd>
    <dt>安全度</dt><dd>${decision.safetyLevel ?? "-"}</dd>
    <dt>支援方法</dt><dd>${decision.supportMode ?? "-"}</dd>
    <dt>感情</dt><dd>${decision.emotion?.join(", ") ?? "-"}</dd>
    <dt>出力</dt><dd>${bundle?.tier ?? "保護者アバターなし"}</dd>
    <dt>フォールバック</dt><dd>${bundle?.fallbackLevel ? `LEVEL ${bundle.fallbackLevel}` : "対象外"}</dd>
    <dt>同期</dt><dd>${bundle?.syncLevel ?? "対象外"}</dd>`;
}

async function loadLogs() {
  try {
    const response = await fetch("/api/logs");
    const { logs } = await response.json();
    logList.innerHTML = logs.length ? logs.map((log) => `
      <div class="log-item"><strong>${log.status}</strong> / ${log.route}<br>
      ${log.model} ・ ${log.latencyMs}ms ・ ${log.costUsd === null ? "cost 未取得" : `${log.estimatedCost ? "demo " : ""}$${Number(log.costUsd).toFixed(4)}`} ・ fallback ${log.fallbackLevel ?? "-"}</div>`).join("") : "<p>ログはまだありません。</p>";
  } catch {
    logList.innerHTML = "<p>ログを読み込めませんでした。</p>";
  }
}

function resetFlow() {
  stopSpeech();
  stopTracks();
  state.pollAbort?.abort();
  state.sessionId = crypto.randomUUID();
  state.transcriptId = null;
  if (state.requestId) fetch(`/api/responses/${encodeURIComponent(state.requestId)}`, { method: "DELETE", keepalive: true }).catch(() => {});
  state.requestId = null;
  state.response = null;
  transcriptInput.value = "";
  subtitle.textContent = "";
  responsePoster.removeAttribute("src");
  responseVideo.removeAttribute("src");
  responseVideo.load();
  responseAudio.removeAttribute("src");
  responseAudio.load();
  timer.textContent = "00:00";
  setRecordState(false);
  showScreen("setup");
}

function continueTalking() {
  stopSpeech();
  if (state.requestId) fetch(`/api/responses/${encodeURIComponent(state.requestId)}`, { method: "DELETE", keepalive: true }).catch(() => {});
  state.sessionId = crypto.randomUUID();
  state.transcriptId = null;
  state.requestId = null;
  state.response = null;
  transcriptInput.value = "";
  subtitle.textContent = "";
  responsePoster.removeAttribute("src");
  responseVideo.removeAttribute("src");
  responseVideo.load();
  responseAudio.removeAttribute("src");
  responseAudio.load();
  timer.textContent = "00:00";
  setRecordState(false);
  showScreen("record");
}

function applyConsent(consent) {
  state.consent = consent.active ? consent : null;
  consentDisclosure.textContent = consent.active
    ? `${consent.subjectLabel} / 本人同意済み素材（デモ）`
    : "素材利用は停止されています。大人向け画面で確認してください。";
  consentAdminStatus.textContent = consent.active ? "素材利用: 有効" : "素材利用: 停止中";
  consentCheck.checked = consent.active ? consentCheck.checked : false;
  consentCheck.disabled = !consent.active;
  startSetup.disabled = !consent.active || !consentCheck.checked;
  revokeConsent.disabled = !consent.active;
  restoreConsent.disabled = consent.active;
}

async function updateConsent(action) {
  const response = await fetch("/api/consent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action }),
  });
  if (!response.ok) throw new Error("同意状態を更新できませんでした");
  applyConsent(await response.json());
}

consentCheck.addEventListener("change", () => { startSetup.disabled = !consentCheck.checked || !state.consent; });
startSetup.addEventListener("click", () => showScreen("record"));
recordButton.addEventListener("click", () => state.mediaRecorder?.state === "recording" ? stopRecording() : startRecording());
demoAudioButton.addEventListener("click", () => transcribe({ useDemo: true }));
retryButton.addEventListener("click", () => showScreen("record"));
confirmButton.addEventListener("click", createResponse);
cancelButton.addEventListener("click", resetFlow);
replayButton.addEventListener("click", playResponse);
soundButton.addEventListener("click", stopSpeech);
finishButton.addEventListener("click", resetFlow);
talkAgainButton.addEventListener("click", continueTalking);
adultConfirmButton.addEventListener("click", async () => { await loadLogs(); adultDialog.showModal(); });
adultButton.addEventListener("click", async () => { await loadLogs(); adultDialog.showModal(); });
closeDialog.addEventListener("click", () => adultDialog.close());
revokeConsent.addEventListener("click", () => updateConsent("revoke").catch((error) => { consentAdminStatus.textContent = error.message; }));
restoreConsent.addEventListener("click", () => updateConsent("restore").catch((error) => { consentAdminStatus.textContent = error.message; }));
backButton.addEventListener("click", () => {
  stopSpeech();
  if (state.screen === "record") showScreen("setup");
  else if (state.screen === "transcript") showScreen("record");
  else resetFlow();
});
window.addEventListener("pagehide", () => { stopTracks(); stopSpeech(); });

fetch("/api/consent")
  .then((response) => response.json())
  .then((consent) => {
    applyConsent(consent);
    connectionStatus.textContent = "じゅんびできたよ";
  })
  .catch(() => {
    consentDisclosure.textContent = "同意情報を確認できません";
    connectionStatus.textContent = "おとなと確認してね";
  });
