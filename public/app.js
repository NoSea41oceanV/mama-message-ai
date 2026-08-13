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
const responsePoster = document.querySelector("#responsePoster");
const neutralMedia = document.querySelector("#neutralMedia");
const mediaStage = document.querySelector("#mediaStage");
const subtitle = document.querySelector("#subtitle");
const voiceBars = document.querySelector(".voice-bars");
const playbackControls = document.querySelector("#playbackControls");
const replayButton = document.querySelector("#replayButton");
const soundButton = document.querySelector("#soundButton");
const finishButton = document.querySelector("#finishButton");
const adultConfirmButton = document.querySelector("#adultConfirmButton");
const adultHandoffMessage = document.querySelector("#adultHandoffMessage");
const decisionList = document.querySelector("#decisionList");
const logList = document.querySelector("#logList");
const connectionStatus = document.querySelector("#connectionStatus");

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
      prepareResponse(data);
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

function prepareResponse(data) {
  const bundle = data.responseBundle;
  subtitle.textContent = bundle.subtitle;
  responseTitle.textContent = bundle.parentLike === false ? "いっしょに確認しよう" : "おへんじがとどいたよ";
  responsePoster.src = bundle.posterUrl ?? "";
  responsePoster.hidden = Boolean(bundle.videoUrl) || !bundle.posterUrl;
  responseVideo.hidden = !bundle.videoUrl;
  neutralMedia.hidden = Boolean(bundle.videoUrl || bundle.posterUrl);
  mediaStage.classList.toggle("is-neutral", !bundle.videoUrl && !bundle.posterUrl);
  playbackControls.hidden = !bundle.videoUrl && !bundle.speechSynthesis;
  voiceBars.hidden = !bundle.videoUrl && !bundle.speechSynthesis;
  if (bundle.videoUrl) responseVideo.src = bundle.videoUrl;
  else responseVideo.removeAttribute("src");
}

function stopSpeech() {
  speechSynthesis.cancel();
  responseVideo.pause();
  mediaStage.classList.remove("is-speaking");
}

async function playResponse() {
  if (!state.response?.responseBundle) return;
  stopSpeech();
  const bundle = state.response.responseBundle;
  mediaStage.classList.add("is-speaking");
  if (bundle.videoUrl) {
    responseVideo.currentTime = 0;
    await responseVideo.play();
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
      ${log.model} ・ ${log.latencyMs}ms ・ $${Number(log.costUsd).toFixed(4)} ・ fallback ${log.fallbackLevel ?? "-"}</div>`).join("") : "<p>ログはまだありません。</p>";
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
  state.requestId = null;
  state.response = null;
  transcriptInput.value = "";
  timer.textContent = "00:00";
  setRecordState(false);
  showScreen("setup");
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
adultConfirmButton.addEventListener("click", async () => { await loadLogs(); adultDialog.showModal(); });
adultButton.addEventListener("click", async () => { await loadLogs(); adultDialog.showModal(); });
closeDialog.addEventListener("click", () => adultDialog.close());
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
    state.consent = consent;
    consentDisclosure.textContent = `${consent.subjectLabel} / ${consent.disclosure}`;
    startSetup.disabled = !consentCheck.checked;
    connectionStatus.textContent = "デモ接続済み";
  })
  .catch(() => {
    consentDisclosure.textContent = "同意情報を確認できません";
    connectionStatus.textContent = "接続エラー";
  });
