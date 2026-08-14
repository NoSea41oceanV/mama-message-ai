const screens = [...document.querySelectorAll("[data-screen]")];
const backButton = document.querySelector("#backButton");
const adultButton = document.querySelector("#adultButton");
const adultDialog = document.querySelector("#adultDialog");
const closeDialog = document.querySelector("#closeDialog");
const adultGate = document.querySelector(".adult-gate");
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
const guardianPortrait = document.querySelector("#guardianPortrait");
const responsePoster = document.querySelector("#responsePoster");
const responseEyes = document.querySelector("#responseEyes");
const responseMouth = document.querySelector("#responseMouth");
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
const guardianLabel = document.querySelector("#guardianLabel");
const sampleBadge = document.querySelector("#sampleBadge");
const samplePhotoInput = document.querySelector("#samplePhotoInput");
const samplePhotoPreview = document.querySelector("#samplePhotoPreview");
const samplePhotoLabel = document.querySelector("#samplePhotoLabel");
const sampleVoiceInput = document.querySelector("#sampleVoiceInput");
const sampleVoicePreview = document.querySelector("#sampleVoicePreview");
const sampleVoiceLabel = document.querySelector("#sampleVoiceLabel");
const sampleRecordButton = document.querySelector("#sampleRecordButton");
const faceConsentCheck = document.querySelector("#faceConsentCheck");
const voiceConsentCheck = document.querySelector("#voiceConsentCheck");
const saveSampleButton = document.querySelector("#saveSampleButton");
const deleteSampleButton = document.querySelector("#deleteSampleButton");
const samplingStatus = document.querySelector("#samplingStatus");
const sampleVideoBadge = document.querySelector("#sampleVideoBadge");
const sampleVideoPreview = document.querySelector("#sampleVideoPreview");
const videoConsentCheck = document.querySelector("#videoConsentCheck");
const generateVideoButton = document.querySelector("#generateVideoButton");
const videoGenerationStatus = document.querySelector("#videoGenerationStatus");

const guardianProfileStorageKey = "guardian-ai.profile-id.v1";
let guardianProfileId;

function getGuardianProfileId() {
  if (guardianProfileId) return guardianProfileId;
  try {
    const stored = localStorage.getItem(guardianProfileStorageKey);
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(stored || "")) {
      guardianProfileId = stored;
      return guardianProfileId;
    }
    guardianProfileId = crypto.randomUUID();
    localStorage.setItem(guardianProfileStorageKey, guardianProfileId);
  } catch {
    guardianProfileId = crypto.randomUUID();
  }
  return guardianProfileId;
}

function profileFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("x-guardian-profile-id", getGuardianProfileId());
  return fetch(url, { ...options, headers });
}

const state = {
  screen: "setup",
  sessionId: crypto.randomUUID(),
  conversationId: crypto.randomUUID(),
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
  sample: null,
  samplePhoto: null,
  sampleVoiceBlob: null,
  sampleVoiceRecorder: null,
  sampleVoiceStream: null,
  sampleVoiceChunks: [],
  sampleVoiceDurationSeconds: null,
  sampleRecordStartedAt: 0,
  sampleRecordTimer: null,
  sampleAutoStopTimer: null,
  videoGeneration: null,
  videoGenerationBusy: false,
  videoGenerationPollingJobId: null,
  videoGenerationPollAbort: null,
  responseAudioContext: null,
  responseAudioSource: null,
  responseAnalyser: null,
  portraitAnimationFrame: null,
  responseUtterance: null,
};

for (let index = 0; index < 27; index += 1) {
  const bar = document.createElement("i");
  waveform.append(bar);
}

function showScreen(name) {
  if (state.screen === "response" && name !== "response") stopSpeech();
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

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function prepareSamplePhoto(file) {
  if (!file || !["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    throw new Error("JPEG・PNG・WebPの写真を選んでください");
  }
  if (file.size > 12 * 1024 * 1024) throw new Error("写真は12MB以下を選んでください");
  const source = await fileToDataUrl(file);
  const image = new Image();
  image.src = source;
  await image.decode();
  const scale = Math.min(1, 720 / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.86));
  if (!blob || blob.size > 2 * 1024 * 1024) throw new Error("写真を小さくできませんでした");
  return { base64: await blobToBase64(blob), type: blob.type, previewUrl: URL.createObjectURL(blob) };
}

function stopSampleTracks() {
  state.sampleVoiceStream?.getTracks().forEach((track) => track.stop());
  state.sampleVoiceStream = null;
  clearInterval(state.sampleRecordTimer);
  clearTimeout(state.sampleAutoStopTimer);
}

function readAudioDuration(url) {
  return new Promise((resolve, reject) => {
    const audio = new Audio();
    const timer = setTimeout(() => reject(new Error("音声の長さを確認できませんでした")), 5000);
    audio.addEventListener("loadedmetadata", () => {
      clearTimeout(timer);
      resolve(audio.duration);
    }, { once: true });
    audio.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("音声ファイルを読み込めませんでした"));
    }, { once: true });
    audio.src = url;
  });
}

async function setSampleVoice(blob, knownDurationSeconds = null) {
  if (!blob || blob.size > 2 * 1024 * 1024) throw new Error("声のサンプルは2MB以下にしてください");
  const previewUrl = URL.createObjectURL(blob);
  const durationSeconds = Number.isFinite(knownDurationSeconds)
    ? knownDurationSeconds
    : await readAudioDuration(previewUrl);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 10.2) {
    URL.revokeObjectURL(previewUrl);
    throw new Error("声のサンプルは10秒以内にしてください");
  }
  state.sampleVoiceBlob = blob;
  state.sampleVoiceDurationSeconds = durationSeconds;
  sampleVoicePreview.src = previewUrl;
  sampleVoicePreview.hidden = false;
  sampleVoiceLabel.textContent = `${Math.max(1, Math.round(blob.size / 1024))}KB・準備できました`;
}

async function stopSampleRecording() {
  if (!state.sampleVoiceRecorder || state.sampleVoiceRecorder.state === "inactive") return;
  state.sampleVoiceRecorder.stop();
  stopSampleTracks();
  sampleRecordButton.textContent = "録音する";
}

async function startSampleRecording() {
  samplingStatus.textContent = "";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.sampleVoiceStream = stream;
    state.sampleVoiceChunks = [];
    state.sampleVoiceRecorder = new MediaRecorder(stream);
    state.sampleVoiceRecorder.addEventListener("dataavailable", (event) => {
      if (event.data.size) state.sampleVoiceChunks.push(event.data);
    });
    state.sampleVoiceRecorder.addEventListener("stop", async () => {
      try {
        const blob = new Blob(state.sampleVoiceChunks, { type: state.sampleVoiceRecorder.mimeType || "audio/webm" });
        const durationSeconds = Math.min(10, (Date.now() - state.sampleRecordStartedAt) / 1000);
        await setSampleVoice(blob, durationSeconds);
      } catch (error) {
        samplingStatus.textContent = error.message;
      }
    }, { once: true });
    state.sampleVoiceRecorder.start(250);
    state.sampleRecordStartedAt = Date.now();
    sampleRecordButton.textContent = "録音を止める";
    sampleVoiceLabel.textContent = "録音中 0秒";
    state.sampleRecordTimer = setInterval(() => {
      const seconds = Math.min(10, Math.floor((Date.now() - state.sampleRecordStartedAt) / 1000));
      sampleVoiceLabel.textContent = `録音中 ${seconds}秒`;
    }, 250);
    state.sampleAutoStopTimer = setTimeout(stopSampleRecording, 10000);
  } catch {
    samplingStatus.textContent = "マイクを使えませんでした。音声ファイルを選んでください。";
  }
}

function normalizeVideoGeneration(value = {}) {
  const source = value?.videoGeneration ?? value?.generatedVideo ?? value ?? {};
  const videoUrl = source.videoUrl ?? source.generatedVideoUrl ?? value?.generatedVideoUrl ?? null;
  const rawStatus = String(source.status ?? source.state ?? value?.generatedVideoStatus ?? "not_started")
    .trim().toLowerCase().replace(/[\s-]+/g, "_");
  let status = rawStatus;
  if (videoUrl) status = "ready";
  else if (["pending", "submitted", "starting"].includes(status)) status = "queued";
  else if (["running", "generating", "in_progress"].includes(status)) status = "processing";
  else if (["complete", "completed", "succeeded", "success"].includes(status)) status = "ready";
  else if (["error", "cancelled", "canceled"].includes(status)) status = "failed";
  if (!["not_started", "queued", "processing", "ready", "failed", "unavailable"].includes(status)) {
    status = "not_started";
  }
  return {
    ...source,
    status,
    videoUrl,
    jobId: source.jobId ?? source.id ?? value?.jobId ?? null,
    message: source.message ?? source.error ?? value?.message ?? null,
  };
}

function videoStatusLabel(status) {
  return {
    not_started: "未作成",
    queued: "受付済み",
    processing: "生成中",
    ready: "完成",
    failed: "要再試行",
    unavailable: "利用不可",
  }[status] ?? "未作成";
}

function friendlyVideoFailureMessage(message) {
  const detail = String(message ?? "");
  if (detail.includes("insufficient_user_quota")) {
    return "OrcaRouterの通常ウォレット残高が不足しています。請求画面で1回限りのクレジットを追加してから、もう一度お試しください。";
  }
  if (detail.includes("HTTP 403")) {
    return "OrcaRouterでKling動画が拒否されました。ワークスペース残高と、プロモーションクレジットの動画利用可否を確認してください。";
  }
  if (detail.includes("HTTP 401")) return "OrcaRouterのAPIキーを確認してください。";
  if (detail.includes("HTTP 429")) return "動画生成が混み合っています。少し待ってからもう一度お試しください。";
  return detail || "動画を生成できませんでした。もう一度お試しください。";
}

function renderVideoGeneration(value = state.sample) {
  const generation = normalizeVideoGeneration(value);
  state.videoGeneration = generation;
  const active = Boolean(state.sample?.configured && state.sample?.active);
  const working = state.videoGenerationBusy || ["queued", "processing"].includes(generation.status);
  sampleVideoBadge.textContent = videoStatusLabel(generation.status);
  sampleVideoBadge.classList.toggle("is-ready", generation.status === "ready");
  sampleVideoBadge.classList.toggle("is-progress", working);
  sampleVideoBadge.classList.toggle("is-failed", generation.status === "failed");
  videoConsentCheck.disabled = !active || working;
  generateVideoButton.disabled = !active || !videoConsentCheck.checked || working;
  generateVideoButton.textContent = generation.status === "ready" ? "返信動画を作り直す" : "返信動画をつくる";

  if (generation.videoUrl) {
    if (sampleVideoPreview.src !== new URL(generation.videoUrl, location.href).href) {
      sampleVideoPreview.src = generation.videoUrl;
    }
    sampleVideoPreview.hidden = false;
  } else {
    sampleVideoPreview.hidden = true;
    sampleVideoPreview.removeAttribute("src");
    sampleVideoPreview.load();
  }

  if (generation.status === "queued") videoGenerationStatus.textContent = "動画生成を受け付けました。順番を待っています。";
  else if (generation.status === "processing") videoGenerationStatus.textContent = "保護者の返信動画を生成しています。画面を閉じても処理は続きます。";
  else if (generation.status === "ready") videoGenerationStatus.textContent = "実動画を使う準備ができました。次の返答から再生されます。";
  else if (generation.status === "failed") videoGenerationStatus.textContent = friendlyVideoFailureMessage(generation.message);
  else if (generation.status === "unavailable") videoGenerationStatus.textContent = generation.message || "動画生成サービスを利用できません。接続設定を確認してください。";
  else videoGenerationStatus.textContent = active ? "登録写真から返信動画を作成できます。" : "先に写真と声を登録してください。";
}

function renderSampling(sample) {
  state.sample = sample;
  const configured = Boolean(sample?.configured);
  sampleBadge.textContent = configured ? (sample.active ? "登録済み" : "停止中") : "未登録";
  sampleBadge.classList.toggle("is-ready", configured && sample.active);
  guardianLabel.value = sample?.subjectLabel || guardianLabel.value || "ママ";
  deleteSampleButton.disabled = !configured;
  if (sample?.posterUrl && !state.samplePhoto) {
    samplePhotoPreview.src = sample.posterUrl;
    samplePhotoPreview.hidden = false;
    samplePhotoLabel.textContent = "登録済み";
  } else if (!state.samplePhoto) {
    samplePhotoPreview.hidden = true;
    samplePhotoLabel.textContent = "写真を選ぶ";
  }
  if (sample?.voicePreviewUrl && !state.sampleVoiceBlob) {
    sampleVoicePreview.src = sample.voicePreviewUrl;
    sampleVoicePreview.hidden = false;
    sampleVoiceLabel.textContent = "登録済み・再生できます";
  } else if (!state.sampleVoiceBlob) {
    sampleVoicePreview.hidden = true;
    sampleVoiceLabel.textContent = "10秒まで録音";
  }
  faceConsentCheck.checked = Boolean(sample?.faceApproved && configured);
  voiceConsentCheck.checked = Boolean(sample?.voiceApproved && configured);
  renderVideoGeneration(sample);
}

async function loadSampling() {
  const response = await profileFetch("/api/sampling");
  if (!response.ok) throw new Error("登録状態を確認できませんでした");
  const sample = await response.json();
  renderSampling(sample);
  const generation = normalizeVideoGeneration(sample);
  if (["queued", "processing"].includes(generation.status) && generation.jobId) {
    resumeSamplingVideoPolling(generation.jobId);
  }
  return sample;
}

async function refreshConsent() {
  const response = await profileFetch("/api/consent");
  if (!response.ok) throw new Error("同意情報を確認できませんでした");
  applyConsent(await response.json());
}

async function saveSampling() {
  samplingStatus.textContent = "";
  if (!state.samplePhoto || !state.sampleVoiceBlob) {
    samplingStatus.textContent = "顔写真と声のサンプルを両方用意してください。";
    return;
  }
  if (!faceConsentCheck.checked || !voiceConsentCheck.checked) {
    samplingStatus.textContent = "顔写真と声、それぞれの利用同意を確認してください。";
    return;
  }
  const subjectLabel = guardianLabel.value.trim();
  if (!subjectLabel) {
    guardianLabel.focus();
    return;
  }
  saveSampleButton.disabled = true;
  samplingStatus.textContent = "素材を登録しています";
  try {
    const response = await profileFetch("/api/sampling", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        subjectLabel,
        photoBase64: state.samplePhoto.base64,
        photoType: state.samplePhoto.type,
        voiceBase64: await blobToBase64(state.sampleVoiceBlob),
        voiceType: state.sampleVoiceBlob.type,
        voiceDurationSeconds: state.sampleVoiceDurationSeconds,
        faceApproved: true,
        voiceApproved: true,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "素材を登録できませんでした");
    state.samplePhoto = null;
    state.sampleVoiceBlob = null;
    state.sampleVoiceDurationSeconds = null;
    videoConsentCheck.checked = false;
    renderSampling(data);
    await refreshConsent();
    samplingStatus.textContent = "登録しました。続けて返信動画を作成してください。";
  } catch (error) {
    samplingStatus.textContent = error.message;
  } finally {
    saveSampleButton.disabled = false;
  }
}

function delayWithSignal(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

async function pollSamplingVideo(jobId) {
  state.videoGenerationPollAbort?.abort();
  state.videoGenerationPollAbort = new AbortController();
  const signal = state.videoGenerationPollAbort.signal;
  const startedAt = Date.now();
  while (Date.now() - startedAt < 180000) {
    const response = await profileFetch(`/api/sampling/video/${encodeURIComponent(jobId)}`, { signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "動画の生成状況を確認できませんでした");
    const generation = normalizeVideoGeneration(data);
    renderVideoGeneration(generation);
    if (generation.status === "ready") {
      await loadSampling();
      return;
    }
    if (["failed", "unavailable"].includes(generation.status)) {
      throw new Error(generation.message || "動画を生成できませんでした");
    }
    await delayWithSignal(2500, signal);
  }
  throw new Error("動画生成が続いています。大人向け画面を開くと進捗を再確認できます。");
}

function resumeSamplingVideoPolling(jobId) {
  if (!jobId || state.videoGenerationPollingJobId === jobId) return;
  state.videoGenerationPollingJobId = jobId;
  state.videoGenerationBusy = true;
  renderVideoGeneration(state.videoGeneration);
  void pollSamplingVideo(jobId)
    .catch((error) => {
      if (error.name !== "AbortError") {
        state.videoGeneration = { ...state.videoGeneration, status: "failed", message: error.message };
      }
    })
    .finally(() => {
      if (state.videoGenerationPollingJobId === jobId) state.videoGenerationPollingJobId = null;
      state.videoGenerationBusy = false;
      renderVideoGeneration(state.videoGeneration);
    });
}

async function generateSamplingVideo() {
  if (!state.sample?.configured || !state.sample?.active) {
    videoGenerationStatus.textContent = "先に写真と声を登録してください。";
    return;
  }
  if (!videoConsentCheck.checked) {
    videoGenerationStatus.textContent = "外部の動画生成サービスへ写真を送信する同意を確認してください。";
    return;
  }
  state.videoGenerationBusy = true;
  renderVideoGeneration(state.videoGeneration);
  videoGenerationStatus.textContent = "動画生成を申し込んでいます。";
  try {
    const response = await profileFetch("/api/sampling/video", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ externalProcessingApproved: true }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "動画生成を開始できませんでした");
    const generation = normalizeVideoGeneration(data);
    renderVideoGeneration(generation);
    if (generation.status === "ready") {
      await loadSampling();
      return;
    }
    if (!generation.jobId) throw new Error("動画生成ジョブを確認できませんでした");
    state.videoGenerationPollingJobId = generation.jobId;
    await pollSamplingVideo(generation.jobId);
  } catch (error) {
    if (error.name === "AbortError") return;
    state.videoGeneration = { ...state.videoGeneration, status: "failed", message: error.message };
  } finally {
    state.videoGenerationPollingJobId = null;
    state.videoGenerationBusy = false;
    renderVideoGeneration(state.videoGeneration);
  }
}

async function deleteSampling() {
  if (!window.confirm("登録した顔写真と声を削除します。よろしいですか？")) return;
  deleteSampleButton.disabled = true;
  samplingStatus.textContent = "登録素材を削除しています";
  try {
    const response = await profileFetch("/api/sampling", { method: "DELETE" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "登録素材を削除できませんでした");
    state.samplePhoto = null;
    state.sampleVoiceBlob = null;
    state.sampleVoiceDurationSeconds = null;
    state.videoGenerationPollAbort?.abort();
    videoConsentCheck.checked = false;
    samplePhotoInput.value = "";
    sampleVoiceInput.value = "";
    renderSampling(data);
    await refreshConsent();
    samplingStatus.textContent = "登録素材を削除しました。デモ素材に戻りました。";
  } catch (error) {
    samplingStatus.textContent = error.message;
    deleteSampleButton.disabled = !state.sample?.configured;
  }
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
    const response = await profileFetch(`/api/responses/${encodeURIComponent(requestId)}`, { signal: state.pollAbort.signal });
    const data = await response.json();
    if (data.status === "READY") {
      state.conversationId = data.conversationId ?? state.conversationId;
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
    const response = await profileFetch("/api/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: state.sessionId,
        conversationId: state.conversationId,
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
    state.conversationId = data.conversationId ?? state.conversationId;
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
  stopPortraitAnimation();
  const bundle = data.responseBundle;
  const responseScreen = document.querySelector('[data-screen="response"]');
  responseScreen.dataset.supportMode = data.supportMode ?? data.routerDecision?.supportMode ?? "listen";
  responseScreen.classList.toggle("is-neutral-response", bundle.parentLike === false);
  subtitle.textContent = bundle.subtitle;
  responseTitle.textContent = bundle.parentLike === false ? "いっしょに確認しよう" : "おへんじがとどいたよ";
  responsePoster.src = bundle.posterUrl ?? "";
  responseEyes.src = bundle.posterUrl ?? "";
  responseMouth.src = bundle.posterUrl ?? "";
  guardianPortrait.hidden = Boolean(bundle.videoUrl) || !bundle.posterUrl;
  responseVideo.hidden = !bundle.videoUrl;
  neutralMedia.hidden = Boolean(bundle.videoUrl || bundle.posterUrl);
  mediaStage.classList.toggle("is-neutral", !bundle.videoUrl && !bundle.posterUrl);
  playbackControls.hidden = !bundle.videoUrl && !bundle.audioUrl && !bundle.speechSynthesis;
  voiceBars.hidden = !bundle.videoUrl && !bundle.audioUrl && !bundle.speechSynthesis;
  if (bundle.videoUrl) {
    responseVideo.src = bundle.videoUrl;
    responseVideo.poster = bundle.posterUrl ?? "";
    responseVideo.loop = bundle.audioInVideo !== true;
    responseVideo.muted = bundle.audioInVideo !== true;
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

function isAnimatedGuardianPortrait(bundle = state.response?.responseBundle) {
  return Boolean(bundle?.posterUrl && !bundle.videoUrl);
}

function stopPortraitAnimation() {
  if (state.portraitAnimationFrame) cancelAnimationFrame(state.portraitAnimationFrame);
  state.portraitAnimationFrame = null;
  mediaStage.classList.remove("is-portrait-animated", "is-audio-fallback");
  mediaStage.style.removeProperty("--mouth-shift");
  mediaStage.style.removeProperty("--mouth-scale");
  mediaStage.style.removeProperty("--portrait-tilt");
}

async function startPortraitAnimation({ syntheticSpeech = false } = {}) {
  stopPortraitAnimation();
  const eligible = isAnimatedGuardianPortrait();
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!eligible || reducedMotion) return;

  mediaStage.classList.add("is-portrait-animated", "is-audio-fallback");
  if (syntheticSpeech) return;
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    state.responseAudioContext ||= new AudioContextClass();
    state.responseAnalyser ||= state.responseAudioContext.createAnalyser();
    state.responseAnalyser.fftSize = 256;
    state.responseAnalyser.smoothingTimeConstant = 0.72;
    if (!state.responseAudioSource) {
      state.responseAudioSource = state.responseAudioContext.createMediaElementSource(responseAudio);
      state.responseAudioSource.connect(state.responseAnalyser);
      state.responseAnalyser.connect(state.responseAudioContext.destination);
    }
    await state.responseAudioContext.resume();
    const samples = new Uint8Array(state.responseAnalyser.frequencyBinCount);
    mediaStage.classList.remove("is-audio-fallback");
    const updateMouth = () => {
      if (responseAudio.paused || responseAudio.ended || !isAnimatedGuardianPortrait()) {
        stopPortraitAnimation();
        return;
      }
      state.responseAnalyser.getByteFrequencyData(samples);
      const speechBins = samples.subarray(1, Math.min(42, samples.length));
      const average = speechBins.reduce((sum, value) => sum + value, 0) / speechBins.length;
      const energy = Math.max(0, Math.min(1, (average - 14) / 92));
      mediaStage.style.setProperty("--mouth-shift", `${(energy * 8).toFixed(2)}px`);
      mediaStage.style.setProperty("--mouth-scale", (1 + energy * .3).toFixed(3));
      mediaStage.style.setProperty("--portrait-tilt", `${((energy - .5) * 1.2).toFixed(2)}deg`);
      state.portraitAnimationFrame = requestAnimationFrame(updateMouth);
    };
    updateMouth();
  } catch {
    // The deterministic CSS animation remains active when Web Audio is unavailable.
  }
}

function stopSpeech() {
  speechSynthesis.cancel();
  state.responseUtterance = null;
  responseVideo.pause();
  responseAudio.pause();
  stopPortraitAnimation();
  mediaStage.classList.remove("is-speaking");
}

async function playResponse() {
  if (!state.response?.responseBundle) return;
  stopSpeech();
  const bundle = state.response.responseBundle;
  const hasVideo = Boolean(bundle.videoUrl);
  mediaStage.classList.add("is-speaking");
  if (isAnimatedGuardianPortrait(bundle)) {
    startPortraitAnimation({ syntheticSpeech: true });
  }
  if (hasVideo) {
    responseVideo.currentTime = 0;
    responseVideo.loop = bundle.audioInVideo !== true;
    responseVideo.muted = bundle.audioInVideo !== true;
    try {
      await responseVideo.play();
    } catch {
      if (!bundle.audioUrl && !bundle.speechSynthesis) mediaStage.classList.remove("is-speaking");
    }
    if (bundle.audioInVideo === true) {
      responseVideo.addEventListener("ended", () => mediaStage.classList.remove("is-speaking"), { once: true });
      return;
    }
  }
  if (bundle.audioUrl) {
    responseAudio.currentTime = 0;
    try {
      await responseAudio.play();
      await startPortraitAnimation();
    } catch {
      stopPortraitAnimation();
      mediaStage.classList.remove("is-speaking");
    }
    return;
  }
  if (!bundle.speechSynthesis) {
    if (hasVideo) {
      responseVideo.loop = false;
      responseVideo.addEventListener("ended", () => mediaStage.classList.remove("is-speaking"), { once: true });
      return;
    }
    mediaStage.classList.remove("is-speaking");
    return;
  }
  const utterance = new SpeechSynthesisUtterance(bundle.subtitle);
  state.responseUtterance = utterance;
  utterance.lang = "ja-JP";
  utterance.rate = 0.86;
  utterance.pitch = 1.04;
  utterance.addEventListener("start", () => {
    if (!hasVideo) startPortraitAnimation({ syntheticSpeech: true });
  }, { once: true });
  utterance.addEventListener("end", () => {
    state.responseUtterance = null;
    if (hasVideo) responseVideo.pause();
    stopPortraitAnimation();
    mediaStage.classList.remove("is-speaking");
  }, { once: true });
  utterance.addEventListener("error", () => {
    state.responseUtterance = null;
    if (hasVideo) responseVideo.pause();
    stopPortraitAnimation();
    mediaStage.classList.remove("is-speaking");
  }, { once: true });
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
  state.conversationId = crypto.randomUUID();
  state.transcriptId = null;
  if (state.requestId) profileFetch(`/api/responses/${encodeURIComponent(state.requestId)}`, { method: "DELETE", keepalive: true }).catch(() => {});
  state.requestId = null;
  state.response = null;
  transcriptInput.value = "";
  subtitle.textContent = "";
  responsePoster.removeAttribute("src");
  responseEyes.removeAttribute("src");
  responseMouth.removeAttribute("src");
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
  if (state.requestId) profileFetch(`/api/responses/${encodeURIComponent(state.requestId)}`, { method: "DELETE", keepalive: true }).catch(() => {});
  state.transcriptId = null;
  state.requestId = null;
  state.response = null;
  transcriptInput.value = "";
  subtitle.textContent = "";
  responsePoster.removeAttribute("src");
  responseEyes.removeAttribute("src");
  responseMouth.removeAttribute("src");
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
  adultGate.hidden = Boolean(consent.active);
  consentDisclosure.textContent = consent.active
    ? `${consent.subjectLabel} / ${consent.disclosure || "本人同意済み素材"}`
    : "素材利用は停止されています。大人向け画面で確認してください。";
  consentAdminStatus.textContent = consent.active ? "素材利用: 有効" : "素材利用: 停止中";
  consentCheck.checked = Boolean(consent.active);
  consentCheck.disabled = !consent.active;
  startSetup.disabled = !consent.active;
  revokeConsent.disabled = !consent.active;
  restoreConsent.disabled = consent.active;
}

async function updateConsent(action) {
  const response = await profileFetch("/api/consent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action }),
  });
  if (!response.ok) throw new Error("同意状態を更新できませんでした");
  applyConsent(await response.json());
  await loadSampling();
  samplingStatus.textContent = action === "revoke"
    ? "素材利用を停止し、登録した写真と声を破棄しました。"
    : "デモ素材の利用を再開しました。";
}

consentCheck.addEventListener("change", () => { startSetup.disabled = !consentCheck.checked || !state.consent; });
videoConsentCheck.addEventListener("change", () => renderVideoGeneration(state.videoGeneration));
samplePhotoInput.addEventListener("change", async () => {
  samplingStatus.textContent = "";
  try {
    state.samplePhoto = await prepareSamplePhoto(samplePhotoInput.files?.[0]);
    samplePhotoPreview.src = state.samplePhoto.previewUrl;
    samplePhotoPreview.hidden = false;
    samplePhotoLabel.textContent = "準備できました";
  } catch (error) {
    state.samplePhoto = null;
    samplePhotoInput.value = "";
    samplingStatus.textContent = error.message;
  }
});
sampleVoiceInput.addEventListener("change", async () => {
  samplingStatus.textContent = "";
  try {
    const file = sampleVoiceInput.files?.[0];
    if (!file || !file.type.startsWith("audio/")) throw new Error("音声ファイルを選んでください");
    await setSampleVoice(file);
  } catch (error) {
    state.sampleVoiceBlob = null;
    sampleVoiceInput.value = "";
    samplingStatus.textContent = error.message;
  }
});
sampleRecordButton.addEventListener("click", () => {
  if (state.sampleVoiceRecorder?.state === "recording") stopSampleRecording();
  else startSampleRecording();
});
saveSampleButton.addEventListener("click", saveSampling);
deleteSampleButton.addEventListener("click", deleteSampling);
generateVideoButton.addEventListener("click", generateSamplingVideo);
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
adultConfirmButton.addEventListener("click", async () => { await Promise.allSettled([loadLogs(), loadSampling()]); adultDialog.showModal(); });
adultButton.addEventListener("click", async () => { await Promise.allSettled([loadLogs(), loadSampling()]); adultDialog.showModal(); });
closeDialog.addEventListener("click", () => { stopSampleRecording(); adultDialog.close(); });
revokeConsent.addEventListener("click", () => updateConsent("revoke").catch((error) => { consentAdminStatus.textContent = error.message; }));
restoreConsent.addEventListener("click", () => updateConsent("restore").catch((error) => { consentAdminStatus.textContent = error.message; }));
backButton.addEventListener("click", () => {
  stopSpeech();
  if (state.screen === "record") showScreen("setup");
  else if (state.screen === "transcript") showScreen("record");
  else resetFlow();
});
window.addEventListener("pagehide", () => {
  state.videoGenerationPollAbort?.abort();
  stopTracks();
  stopSampleTracks();
  stopSpeech();
});
responseAudio.addEventListener("pause", () => {
  if (!state.response?.responseBundle?.audioUrl) return;
  if (state.response.responseBundle.videoUrl) responseVideo.pause();
  stopPortraitAnimation();
});
responseAudio.addEventListener("ended", () => {
  if (!state.response?.responseBundle?.audioUrl) return;
  if (state.response.responseBundle.videoUrl) responseVideo.pause();
  stopPortraitAnimation();
  mediaStage.classList.remove("is-speaking");
});
responseAudio.addEventListener("error", () => {
  if (!state.response?.responseBundle?.audioUrl) return;
  if (state.response.responseBundle.videoUrl) responseVideo.pause();
  stopPortraitAnimation();
  mediaStage.classList.remove("is-speaking");
});

Promise.all([profileFetch("/api/consent").then((response) => response.json()), loadSampling()])
  .then(([consent]) => {
    applyConsent(consent);
    connectionStatus.textContent = "じゅんびできたよ";
  })
  .catch(() => {
    adultGate.hidden = false;
    consentDisclosure.textContent = "同意情報を確認できません";
    connectionStatus.textContent = "おとなと確認してね";
  });
