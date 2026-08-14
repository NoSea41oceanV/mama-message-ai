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
const neutralMedia = document.querySelector("#neutralMedia");
const mediaStage = document.querySelector("#mediaStage");
const subtitle = document.querySelector("#subtitle");
const voiceBars = document.querySelector(".voice-bars");
const playbackControls = document.querySelector("#playbackControls");
const replayButton = document.querySelector("#replayButton");
const soundButton = document.querySelector("#soundButton");
const finishButton = document.querySelector("#finishButton");
const responseConversation = document.querySelector(".response-conversation");
const talkAgainButton = document.querySelector("#talkAgainButton");
const responseTalkLead = document.querySelector("#responseTalkLead");
const responseTimer = document.querySelector("#responseTimer");
const responseDemoAudioButton = document.querySelector("#responseDemoAudioButton");
const responseTranscriptConfirm = document.querySelector("#responseTranscriptConfirm");
const responseTranscriptInput = document.querySelector("#responseTranscriptInput");
const responseRetryButton = document.querySelector("#responseRetryButton");
const responseConfirmButton = document.querySelector("#responseConfirmButton");
const responseRecordError = document.querySelector("#responseRecordError");
const adultConfirmButton = document.querySelector("#adultConfirmButton");
const adultHandoffMessage = document.querySelector("#adultHandoffMessage");
const decisionList = document.querySelector("#decisionList");
const logList = document.querySelector("#logList");
const connectionStatus = document.querySelector("#connectionStatus");
const revokeConsent = document.querySelector("#revokeConsent");
const restoreConsent = document.querySelector("#restoreConsent");
const consentAdminStatus = document.querySelector("#consentAdminStatus");
const guardianLabel = document.querySelector("#guardianLabel");
const childNameInput = document.querySelector("#childNameInput");
const speechRateSelect = document.querySelector("#speechRateSelect");
const favoriteTopicsInput = document.querySelector("#favoriteTopicsInput");
const saveFavoriteTopicsButton = document.querySelector("#saveFavoriteTopicsButton");
const favoriteTopicsStatus = document.querySelector("#favoriteTopicsStatus");
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
const videoGenerationTitle = document.querySelector("#videoGenerationTitle");
const sampleVideoPreview = document.querySelector("#sampleVideoPreview");
const videoConsentCheck = document.querySelector("#videoConsentCheck");
const videoConsentDescription = document.querySelector("#videoConsentDescription");
const generateVideoButton = document.querySelector("#generateVideoButton");
const videoGenerationStatus = document.querySelector("#videoGenerationStatus");

const guardianProfileStorageKey = "guardian-ai.profile-id.v1";
const maxVoiceSampleSeconds = 120;
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
  recordingContext: "record",
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
  liveAvatar: null,
  liveAvatarSession: null,
  liveAvatarStartPromise: null,
  liveAvatarStreamReady: false,
  liveAvatarSpeaking: false,
  liveAvatarExpiresAt: 0,
  liveAvatarKeepAliveTimer: null,
  liveAvatarPcmCache: new Map(),
  tavus: null,
  tavusCall: null,
  tavusConversationId: null,
  tavusMediaStream: null,
  tavusStreamReady: false,
  tavusStartPromise: null,
  tavusSpeaking: false,
  tavusSpeakingTimer: null,
  responseUtterance: null,
};

for (let index = 0; index < 27; index += 1) {
  const bar = document.createElement("i");
  waveform.append(bar);
}

function showScreen(name) {
  if (state.screen === "response" && name !== "response") {
    stopSpeech();
    void stopLiveAvatarSession();
    void stopTavusConversation();
  }
  state.screen = name;
  screens.forEach((screen) => screen.classList.toggle("is-active", screen.dataset.screen === name));
  backButton.disabled = ["setup", "waiting"].includes(name);
  document.querySelector(`[data-screen="${name}"] h1`)?.focus?.();
}

function setRecordState(active) {
  const inline = state.recordingContext === "response";
  recordButton.classList.toggle("is-recording", active && !inline);
  waveform.classList.toggle("is-active", active && !inline);
  talkAgainButton.classList.toggle("is-recording", active && inline);
  if (inline) {
    responseTalkLead.textContent = active ? "きいているよ" : "このまま つづけて おはなしできるよ";
    talkAgainButton.textContent = active ? "■ おわったら おしてね" : "🎙 このまま おはなし";
    talkAgainButton.setAttribute("aria-label", active ? "続けての録音を停止する" : "続けて録音を開始する");
  } else {
    recordLead.textContent = active ? "きいているよ" : "マイクをおすと、きいているよ";
    recordActionLabel.textContent = active ? "おわったら、ここをおしてね" : "おしておはなし";
    recordButton.setAttribute("aria-label", active ? "録音を停止する" : "録音を開始する");
  }
}

function setResponseTranscriptVisible(visible) {
  responseTranscriptConfirm.hidden = !visible;
  responseConversation.classList.toggle("is-confirming", visible);
}

function stopTracks() {
  state.mediaStream?.getTracks().forEach((track) => track.stop());
  state.mediaStream = null;
  clearInterval(state.recordTimer);
  clearTimeout(state.autoStopTimer);
}

function updateTimer() {
  const seconds = Math.min(15, Math.floor((Date.now() - state.recordStartedAt) / 1000));
  const value = `00:${String(seconds).padStart(2, "0")}`;
  if (state.recordingContext === "response") responseTimer.textContent = value;
  else timer.textContent = value;
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
  if (!blob || blob.size > 10 * 1024 * 1024) throw new Error("声のサンプルは10MB以下にしてください");
  const previewUrl = URL.createObjectURL(blob);
  const durationSeconds = Number.isFinite(knownDurationSeconds)
    ? knownDurationSeconds
    : await readAudioDuration(previewUrl);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > maxVoiceSampleSeconds + 0.5) {
    URL.revokeObjectURL(previewUrl);
    throw new Error("声のサンプルは2分以内にしてください");
  }
  state.sampleVoiceBlob = blob;
  state.sampleVoiceDurationSeconds = durationSeconds;
  sampleVoicePreview.src = previewUrl;
  sampleVoicePreview.hidden = false;
  sampleVoiceLabel.textContent = `${Math.round(durationSeconds)}秒・準備できました`;
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
        const durationSeconds = Math.min(maxVoiceSampleSeconds, (Date.now() - state.sampleRecordStartedAt) / 1000);
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
      const seconds = Math.min(maxVoiceSampleSeconds, Math.floor((Date.now() - state.sampleRecordStartedAt) / 1000));
      sampleVoiceLabel.textContent = `録音中 ${seconds}秒`;
    }, 250);
    state.sampleAutoStopTimer = setTimeout(stopSampleRecording, maxVoiceSampleSeconds * 1000);
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
    ready: "準備済み",
    failed: "要再試行",
    unavailable: "利用不可",
  }[status] ?? "未作成";
}

function friendlyVideoFailureMessage(message) {
  const detail = String(message ?? "");
  if (detail.includes("TAVUS_PUBLIC_URL_REQUIRED")) {
    return "本人Faceの作成には、Tavusが写真を取得できる公開HTTPS環境が必要です。";
  }
  if (detail.includes("TAVUS") && detail.includes("HTTP 401")) return "TavusのAPIキーを確認してください。";
  if (detail.includes("TAVUS") && detail.includes("HTTP 429")) return "Tavusの利用上限に達しています。利用枠を確認してください。";
  if (detail.includes("TAVUS")) return "Tavusで本人Faceを準備できませんでした。写真、利用枠、API設定を確認してください。";
  if (detail.includes("HEYGEN") && detail.includes("HTTP 401")) {
    return "HeyGenのAPIキーを確認してください。";
  }
  if (detail.includes("HEYGEN") && detail.includes("HTTP 429")) {
    return "HeyGenが混み合っているか、利用上限に達しています。少し待ってからもう一度お試しください。";
  }
  if (detail.includes("HEYGEN")) {
    return "HeyGenで本人アバターを準備できませんでした。写真、利用枠、API設定を確認してください。";
  }
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
  const tavus = value?.tavus ?? state.sample?.tavus ?? null;
  if (tavus) {
    videoGenerationTitle.textContent = "Tavus Face";
    state.tavus = tavus;
    const generation = normalizeVideoGeneration(value);
    state.videoGeneration = generation;
    const active = Boolean(state.sample?.configured && state.sample?.active);
    const working = state.videoGenerationBusy || ["queued", "processing"].includes(generation.status);
    const customFaceReady = generation.status === "ready";
    sampleVideoPreview.hidden = true;
    sampleVideoPreview.removeAttribute("src");
    sampleVideoPreview.load();
    generateVideoButton.hidden = false;
    generateVideoButton.disabled = !active || !videoConsentCheck.checked || working || tavus.faceCreationAvailable !== true;
    generateVideoButton.textContent = customFaceReady ? "本人Faceを作り直す" : "写真から本人Faceを作る";
    videoConsentCheck.disabled = !active || tavus.streamingAvailable !== true || working;
    sampleVideoBadge.classList.toggle("is-ready", tavus.streamingAvailable === true);
    sampleVideoBadge.classList.toggle("is-progress", working);
    sampleVideoBadge.classList.toggle("is-failed", generation.status === "failed");

    if (!tavus.streamingAvailable) {
      sampleVideoBadge.textContent = "未接続";
      videoConsentDescription.textContent = "返信音声をTavusへ送信し、リアルタイム動画を生成することに同意します";
      videoGenerationStatus.textContent = "Tavusへ接続できません。API設定を確認してください。";
    } else if (customFaceReady) {
      sampleVideoBadge.textContent = "本人Face準備済み";
      videoConsentDescription.textContent = "返信音声をTavusの本人Faceへ送信し、リアルタイム動画を生成することに同意します";
      videoGenerationStatus.textContent = "本人Faceを使えます。チェックを入れると、次の返答から表情と口の動く動画になります。";
    } else if (working) {
      sampleVideoBadge.textContent = generation.status === "queued" ? "受付済み" : "本人Face生成中";
      videoConsentDescription.textContent = "登録写真と返信音声をTavusへ送信し、本人Faceとリアルタイム動画を生成することに同意します";
      videoGenerationStatus.textContent = "Tavusで本人Faceを準備しています。画面を閉じても処理は続きます。";
    } else if (generation.status === "failed") {
      sampleVideoBadge.textContent = "要再試行";
      videoConsentDescription.textContent = "登録写真と返信音声をTavusへ送信し、本人Faceとリアルタイム動画を生成することに同意します";
      videoGenerationStatus.textContent = friendlyVideoFailureMessage(generation.message);
    } else if (!tavus.faceCreationAvailable) {
      sampleVideoBadge.textContent = "テスト接続済み";
      videoConsentDescription.textContent = "返信音声をTavusの公開テストFaceへ送信し、動作確認することに同意します";
      videoGenerationStatus.textContent = "リアルタイム接続は利用できます。本人Faceの作成には、Tavusが写真を取得できる公開HTTPS環境が必要です。";
    } else {
      sampleVideoBadge.textContent = "テスト接続済み";
      videoConsentDescription.textContent = "登録写真と返信音声をTavusへ送信し、本人Faceとリアルタイム動画を生成することに同意します";
      videoGenerationStatus.textContent = active
        ? "現在は公開テストFaceです。同意を確認して「写真から本人Faceを作る」を押してください。"
        : "先に写真と声を登録してください。";
    }
    return;
  }
  const liveAvatar = value?.liveAvatar ?? state.sample?.liveAvatar ?? null;
  if (liveAvatar) {
    videoGenerationTitle.textContent = "LiveAvatar";
    state.liveAvatar = liveAvatar;
    const active = Boolean(state.sample?.configured && state.sample?.active);
    sampleVideoPreview.hidden = true;
    sampleVideoPreview.removeAttribute("src");
    sampleVideoPreview.load();
    generateVideoButton.hidden = true;
    videoConsentCheck.disabled = !active || liveAvatar.configured !== true;
    sampleVideoBadge.classList.toggle("is-ready", liveAvatar.configured === true);
    sampleVideoBadge.classList.remove("is-progress", "is-failed");

    if (!liveAvatar.configured) {
      sampleVideoBadge.textContent = "未接続";
      videoConsentDescription.textContent = "返信音声をLiveAvatarへ送信し、リアルタイム動画を生成することに同意します";
      videoGenerationStatus.textContent = "LiveAvatarへ接続できません。API設定を確認してください。";
    } else if (liveAvatar.customAvatarConfigured) {
      sampleVideoBadge.textContent = "本人設定済み";
      videoConsentDescription.textContent = "返信音声を本人のLiveAvatarへ送信し、リアルタイム動画を生成することに同意します";
      videoGenerationStatus.textContent = "本人のLiveAvatarへ接続できます。チェックを入れると、次の返答からリアルタイム動画を使います。";
    } else {
      sampleVideoBadge.textContent = "テスト接続済み";
      videoConsentDescription.textContent = "返信音声をLiveAvatarの公開テストアバターへ送信し、動作確認することに同意します";
      videoGenerationStatus.textContent = "API接続済みです。現在は公開テストアバターです。本人のLiveAvatarはまだ作成されていません。";
    }
    return;
  }
  const generation = normalizeVideoGeneration(value);
  videoGenerationTitle.textContent = "本人動画";
  state.videoGeneration = generation;
  const active = Boolean(state.sample?.configured && state.sample?.active);
  const working = state.videoGenerationBusy || ["queued", "processing"].includes(generation.status);
  sampleVideoBadge.textContent = videoStatusLabel(generation.status);
  sampleVideoBadge.classList.toggle("is-ready", generation.status === "ready");
  sampleVideoBadge.classList.toggle("is-progress", working);
  sampleVideoBadge.classList.toggle("is-failed", generation.status === "failed");
  videoConsentCheck.disabled = !active || working;
  generateVideoButton.disabled = !active || !videoConsentCheck.checked || working;
  generateVideoButton.textContent = generation.status === "ready" ? "本人アバターを作り直す" : "本人アバターを準備する";

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

  if (generation.status === "queued") videoGenerationStatus.textContent = "本人アバターの準備を受け付けました。順番を待っています。";
  else if (generation.status === "processing") videoGenerationStatus.textContent = "本人アバターを準備しています。画面を閉じても処理は続きます。";
  else if (generation.status === "ready") videoGenerationStatus.textContent = "動画素材の準備ができました。次の返答から、本人の口や表情が動く動画を作ります。";
  else if (generation.status === "failed") videoGenerationStatus.textContent = friendlyVideoFailureMessage(generation.message);
  else if (generation.status === "unavailable") videoGenerationStatus.textContent = generation.message || "動画生成サービスを利用できません。接続設定を確認してください。";
  else videoGenerationStatus.textContent = active ? "登録写真から、本人動画に使う素材を準備できます。" : "先に写真と声を登録してください。";
}

function renderSampling(sample) {
  state.sample = sample;
  const configured = Boolean(sample?.configured);
  sampleBadge.textContent = configured ? (sample.active ? "登録済み" : "停止中") : "未登録";
  sampleBadge.classList.toggle("is-ready", configured && sample.active);
  guardianLabel.value = sample?.subjectLabel || guardianLabel.value || "ママ";
  favoriteTopicsInput.value = Array.isArray(sample?.favoriteTopics)
    ? sample.favoriteTopics.join("、")
    : "";
  childNameInput.value = sample?.childName || "";
  speechRateSelect.value = String(sample?.speechRate ?? 0.82);
  if (!speechRateSelect.value) speechRateSelect.value = "0.82";
  saveFavoriteTopicsButton.disabled = !configured;
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
    sampleVoiceLabel.textContent = sample.voiceCloningAvailable
      ? "音声クローン済み・再生できます"
      : "登録済み・クローン未作成";
  } else if (!state.sampleVoiceBlob) {
    sampleVoicePreview.hidden = true;
    sampleVoiceLabel.textContent = "1〜2分がおすすめ";
  }
  faceConsentCheck.checked = Boolean(sample?.faceApproved && configured);
  voiceConsentCheck.checked = Boolean(
    sample?.voiceApproved
    && sample?.voiceCloningAvailable
    && configured,
  );
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

function favoriteTopicsFromInput() {
  return favoriteTopicsInput.value
    .split(/[、,\n]/)
    .map((topic) => topic.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 5);
}

async function saveFavoriteTopics() {
  favoriteTopicsStatus.textContent = "";
  saveFavoriteTopicsButton.disabled = true;
  try {
    const response = await profileFetch("/api/sampling/preferences", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        favoriteTopics: favoriteTopicsFromInput(),
        childName: childNameInput.value.trim(),
        speechRate: Number(speechRateSelect.value),
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "好きなものを保存できませんでした");
    renderSampling(data);
    const childCall = data.childName ? `${data.childName}とよびかけます。` : "よびかたは未設定です。";
    const rateLabel = speechRateSelect.options[speechRateSelect.selectedIndex]?.textContent || "ゆっくり";
    favoriteTopicsStatus.textContent = `${childCall} はなすはやさは「${rateLabel}」です。`;
  } catch (error) {
    favoriteTopicsStatus.textContent = error.message;
  } finally {
    saveFavoriteTopicsButton.disabled = !state.sample?.configured;
  }
}

async function refreshConsent() {
  const response = await profileFetch("/api/consent");
  if (!response.ok) throw new Error("同意情報を確認できませんでした");
  applyConsent(await response.json());
}

async function saveSampling() {
  samplingStatus.textContent = "";
  const canReuseRegisteredPhoto = Boolean(state.sample?.configured && state.sample?.posterUrl);
  if ((!state.samplePhoto && !canReuseRegisteredPhoto) || !state.sampleVoiceBlob) {
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
  samplingStatus.textContent = "素材を登録し、音声クローンを作成しています";
  try {
    const updatingVoiceOnly = !state.samplePhoto && canReuseRegisteredPhoto;
    const response = await profileFetch(updatingVoiceOnly ? "/api/sampling/voice" : "/api/sampling", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        subjectLabel,
        favoriteTopics: favoriteTopicsFromInput(),
        childName: childNameInput.value.trim(),
        speechRate: Number(speechRateSelect.value),
        ...(state.samplePhoto ? {
          photoBase64: state.samplePhoto.base64,
          photoType: state.samplePhoto.type,
        } : {}),
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
    samplingStatus.textContent = data.voiceCloningAvailable
      ? "登録と音声クローンが完了しました。次の返答からこの声を使います。"
      : "素材を登録しました。音声クローンはまだ利用できません。";
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
  state.videoGeneration = {
    ...state.videoGeneration,
    status: "processing",
    message: "Tavusで本人Faceを準備しています。画面を閉じても処理は続きます。",
  };
  renderVideoGeneration(state.videoGeneration);
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

async function transcribe({ blob = null, useDemo = false, stayOnResponse = false } = {}) {
  const errorTarget = stayOnResponse ? responseRecordError : recordError;
  errorTarget.textContent = "";
  if (stayOnResponse) {
    talkAgainButton.disabled = true;
    responseDemoAudioButton.disabled = true;
    responseTalkLead.textContent = "おはなしを聞き取っているよ";
  } else {
    recordButton.disabled = true;
    demoAudioButton.disabled = true;
  }
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
    if (stayOnResponse) {
      responseTranscriptInput.value = data.transcript;
      setResponseTranscriptVisible(true);
      responseTalkLead.textContent = "こう聞こえたよ。送る前に確認してね";
      responseTranscriptInput.focus();
    } else {
      transcriptInput.value = data.transcript;
      showScreen("transcript");
    }
  } catch (error) {
    errorTarget.textContent = `${error.message}。もう一度ためしてね。`;
    if (stayOnResponse) responseTalkLead.textContent = "このまま つづけて おはなしできるよ";
  } finally {
    if (stayOnResponse) {
      talkAgainButton.disabled = false;
      responseDemoAudioButton.disabled = false;
      responseTimer.textContent = "00:00";
    } else {
      recordButton.disabled = false;
      demoAudioButton.disabled = false;
      timer.textContent = "00:00";
    }
  }
}

async function stopRecording() {
  if (!state.mediaRecorder || state.mediaRecorder.state === "inactive") return;
  if (state.recordingContext === "response" && state.liveAvatarStreamReady) {
    state.liveAvatarSession?.stopListening();
  }
  state.mediaRecorder.stop();
  setRecordState(false);
  stopTracks();
}

async function startRecording(context = "record") {
  state.recordingContext = context;
  const stayOnResponse = context === "response";
  const errorTarget = stayOnResponse ? responseRecordError : recordError;
  errorTarget.textContent = "";
  if (stayOnResponse) {
    stopSpeech();
    if (state.liveAvatarStreamReady) state.liveAvatarSession?.startListening();
    setResponseTranscriptVisible(false);
    responseTranscriptInput.value = "";
  }
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
      await transcribe({ blob, stayOnResponse });
    }, { once: true });
    state.mediaRecorder.start(250);
    state.recordStartedAt = Date.now();
    updateTimer();
    state.recordTimer = setInterval(updateTimer, 250);
    state.autoStopTimer = setTimeout(stopRecording, 15000);
    setRecordState(true);
  } catch {
    errorTarget.textContent = "マイクを使えませんでした。デモ音声ならそのまま進めます。";
  }
}

function prepareInlineTurn() {
  if (state.requestId) {
    profileFetch(`/api/responses/${encodeURIComponent(state.requestId)}`, {
      method: "DELETE",
      keepalive: true,
    }).catch(() => {});
  }
  state.transcriptId = null;
  state.requestId = null;
  setResponseTranscriptVisible(false);
  responseTranscriptInput.value = "";
  responseRecordError.textContent = "";
}

function resetResponseComposer() {
  state.recordingContext = "response";
  setRecordState(false);
  setResponseTranscriptVisible(false);
  responseTranscriptInput.value = "";
  responseTimer.textContent = "00:00";
  responseTalkLead.textContent = "このまま つづけて おはなしできるよ";
  responseRecordError.textContent = "";
  talkAgainButton.disabled = false;
  responseDemoAudioButton.disabled = false;
  responseConfirmButton.disabled = false;
}

async function pollResponse(requestId) {
  state.pollAbort?.abort();
  state.pollAbort = new AbortController();
  const started = Date.now();
  while (Date.now() - started < 240000) {
    const response = await profileFetch(`/api/responses/${encodeURIComponent(requestId)}`, { signal: state.pollAbort.signal });
    const data = await response.json();
    if (data.status === "READY") {
      state.conversationId = data.conversationId ?? state.conversationId;
      state.response = data;
      renderDecision(data);
      await prepareResponse(data);
      showScreen("response");
      resetResponseComposer();
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

async function createResponse({ inline = false } = {}) {
  const activeTranscriptInput = inline ? responseTranscriptInput : transcriptInput;
  const confirmedTranscript = activeTranscriptInput.value.trim();
  if (!confirmedTranscript) {
    activeTranscriptInput.focus();
    return;
  }
  if (inline) {
    stopSpeech();
    responseConfirmButton.disabled = true;
    talkAgainButton.disabled = true;
    responseDemoAudioButton.disabled = true;
    responseTalkLead.textContent = "ママがおへんじを考えているよ";
    responseRecordError.textContent = "";
  } else {
    showScreen("waiting");
  }
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
    if (inline) {
      responseTalkLead.textContent = "おへんじを準備できなかったよ";
      responseRecordError.textContent = "もう一度お話してみてね。";
      talkAgainButton.disabled = false;
      responseDemoAudioButton.disabled = false;
      responseConfirmButton.disabled = false;
      return;
    }
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

function liveAvatarCanPlay(data = state.response) {
  return Boolean(
    data?.liveAvatar?.eligible
    && videoConsentCheck.checked
    && data?.responseBundle?.audioUrl
    && globalThis.LiveAvatarSDK?.LiveAvatarSession,
  );
}

function tavusCanPlay(data = state.response) {
  const Daily = globalThis.DailySDK?.default ?? globalThis.DailySDK;
  return Boolean(
    data?.tavus?.eligible
    && videoConsentCheck.checked
    && data?.responseBundle?.audioUrl
    && Daily?.createCallObject,
  );
}

async function responseAudioAsPcm24k(audioUrl) {
  if (state.liveAvatarPcmCache.has(audioUrl)) return state.liveAvatarPcmCache.get(audioUrl);
  const response = await fetch(audioUrl, { cache: "no-store" });
  if (!response.ok) throw new Error("LIVEAVATAR_AUDIO_FETCH_FAILED");
  const encoded = await response.arrayBuffer();
  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioContextClass || !globalThis.OfflineAudioContext) {
    throw new Error("LIVEAVATAR_AUDIO_CONVERSION_UNAVAILABLE");
  }
  const context = new AudioContextClass();
  let decoded;
  try {
    decoded = await context.decodeAudioData(encoded.slice(0));
  } finally {
    await context.close().catch(() => {});
  }
  const frameCount = Math.max(1, Math.ceil(decoded.duration * 24_000));
  const offline = new OfflineAudioContext(1, frameCount, 24_000);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  const samples = rendered.getChannelData(0);
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  let pcm = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    pcm += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  state.liveAvatarPcmCache.set(audioUrl, pcm);
  return pcm;
}

async function stopTavusConversation() {
  clearTimeout(state.tavusSpeakingTimer);
  state.tavusSpeakingTimer = null;
  const call = state.tavusCall;
  const conversationId = state.tavusConversationId;
  const stream = state.tavusMediaStream;
  state.tavusCall = null;
  state.tavusConversationId = null;
  state.tavusMediaStream = null;
  state.tavusStreamReady = false;
  state.tavusStartPromise = null;
  state.tavusSpeaking = false;
  stream?.getTracks().forEach((track) => track.stop());
  if (responseVideo.srcObject === stream) responseVideo.srcObject = null;
  if (call) {
    await Promise.race([
      call.leave().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    await Promise.race([
      call.destroy().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
  if (conversationId) {
    await profileFetch(`/api/tavus/conversations/${encodeURIComponent(conversationId)}/end`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      keepalive: true,
    }).catch(() => {});
  }
}

function attachTavusParticipantTracks(participant, mediaStream) {
  if (!participant || participant.local) return false;
  let attachedVideo = false;
  for (const kind of ["video", "audio"]) {
    const trackState = participant.tracks?.[kind];
    const track = trackState?.persistentTrack ?? trackState?.track ?? null;
    if (!track || track.readyState === "ended") continue;
    for (const existing of mediaStream.getTracks()) {
      if (existing.kind === kind && existing.id !== track.id) mediaStream.removeTrack(existing);
    }
    if (!mediaStream.getTracks().some((existing) => existing.id === track.id)) mediaStream.addTrack(track);
    if (kind === "video") attachedVideo = true;
  }
  return attachedVideo;
}

function safeTavusDailyError(event) {
  const raw = [
    event?.errorMsg,
    event?.error?.msg,
    event?.error?.message,
    typeof event?.error === "string" ? event.error : null,
    event?.action,
  ].find((value) => typeof value === "string" && value.trim());
  return String(raw || "unknown")
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/[A-Za-z0-9_-]{40,}/g, "[redacted]")
    .slice(0, 160);
}

async function startTavusConversation() {
  if (state.tavusCall && state.tavusStreamReady) return state.tavusCall;
  if (state.tavusStartPromise) return state.tavusStartPromise;
  const Daily = globalThis.DailySDK?.default ?? globalThis.DailySDK;
  if (!Daily?.createCallObject) throw new Error("TAVUS_DAILY_SDK_UNAVAILABLE");

  state.tavusStartPromise = (async () => {
    let response;
    try {
      response = await profileFetch("/api/tavus/conversation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          consentId: state.consent?.consentId,
          avatarAssetId: state.consent?.avatarAssetId,
          externalProcessingApproved: videoConsentCheck.checked,
        }),
      });
    } catch {
      throw new Error("TAVUS_CONVERSATION_NETWORK_FAILED");
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.conversationUrl || !payload.meetingToken || !payload.conversationId) {
      const code = /^[A-Z0-9_]{1,80}$/.test(payload.error) ? payload.error : "TAVUS_CONVERSATION_FAILED";
      throw new Error(code);
    }

    const embeddedCallMachineUrl = globalThis.MamaDailyRuntime?.createBundleUrl?.();
    const call = Daily.createCallObject({
      audioSource: false,
      videoSource: false,
      subscribeToTracksAutomatically: true,
      ...(embeddedCallMachineUrl ? { callObjectBundleUrlOverride: embeddedCallMachineUrl } : {}),
    });
    const mediaStream = new MediaStream();
    state.tavusCall = call;
    state.tavusConversationId = payload.conversationId;
    state.tavusMediaStream = mediaStream;
    responseVideo.srcObject = mediaStream;
    responseVideo.hidden = false;
    responseVideo.muted = false;
    responseVideo.autoplay = true;
    responseVideo.playsInline = true;

    let resolveVideo;
    const videoReady = new Promise((resolve) => { resolveVideo = resolve; });
    let rejectDailyError;
    const dailyError = new Promise((_, reject) => { rejectDailyError = reject; });
    const attachParticipant = (participant) => {
      if (attachTavusParticipantTracks(participant, mediaStream)) resolveVideo();
      if (mediaStream.getVideoTracks().length) responseVideo.play().catch(() => {});
    };
    call.on("track-started", (event) => attachParticipant(event?.participant));
    call.on("participant-updated", (event) => attachParticipant(event?.participant));
    call.on("app-message", (event) => {
      const eventType = String(event?.data?.event_type ?? event?.event_type ?? "");
      if (eventType.includes("started_speaking")) {
        state.tavusSpeaking = true;
        mediaStage.classList.add("is-speaking");
      } else if (eventType.includes("stopped_speaking")) {
        state.tavusSpeaking = false;
        mediaStage.classList.remove("is-speaking");
      }
    });
    call.on("error", (event) => {
      const safeDetail = safeTavusDailyError(event);
      responseRecordError.dataset.tavusDetail = safeDetail;
      console.warn("Tavus Daily error", safeDetail);
      rejectDailyError(new Error("TAVUS_DAILY_ERROR"));
    });
    call.on("left-meeting", () => {
      if (state.tavusCall !== call) return;
      const shouldResumeAudio = state.tavusSpeaking
        && state.screen === "response"
        && Boolean(state.response?.responseBundle?.audioUrl);
      state.tavusCall = null;
      state.tavusConversationId = null;
      state.tavusMediaStream = null;
      state.tavusStreamReady = false;
      state.tavusStartPromise = null;
      state.tavusSpeaking = false;
      responseVideo.srcObject = null;
      responseVideo.hidden = true;
      if (shouldResumeAudio) {
        responseRecordError.textContent = "どうががとまったので、おとのおへんじにきりかえたよ。";
        responseAudio.currentTime = 0;
        responseAudio.play().catch(() => mediaStage.classList.remove("is-speaking"));
      }
    });

    let connectionTimer;
    try {
      await Promise.race([
        call.join({
          url: payload.conversationUrl,
          token: payload.meetingToken,
          userName: "Mama Message",
          startAudioOff: true,
          startVideoOff: true,
        }),
        dailyError,
        new Promise((_, reject) => {
          connectionTimer = setTimeout(() => reject(new Error("TAVUS_JOIN_TIMEOUT")), 20_000);
        }),
      ]);
      clearTimeout(connectionTimer);
      for (const participant of Object.values(call.participants())) attachParticipant(participant);
      await Promise.race([
        videoReady,
        dailyError,
        new Promise((_, reject) => {
          connectionTimer = setTimeout(() => reject(new Error("TAVUS_STREAM_TIMEOUT")), 40_000);
        }),
      ]);
      await responseVideo.play();
    } catch (error) {
      if (["TAVUS_JOIN_TIMEOUT", "TAVUS_STREAM_TIMEOUT", "TAVUS_DAILY_ERROR"].includes(error?.message)) throw error;
      throw new Error("TAVUS_DAILY_JOIN_FAILED");
    } finally {
      clearTimeout(connectionTimer);
    }
    state.tavusStreamReady = true;
    return call;
  })();

  try {
    return await state.tavusStartPromise;
  } catch (error) {
    await stopTavusConversation();
    throw error;
  } finally {
    state.tavusStartPromise = null;
  }
}

async function playTavus(bundle) {
  if (!tavusCanPlay()) return false;
  try {
    delete responseRecordError.dataset.tavusError;
    delete responseRecordError.dataset.tavusDetail;
    responseTalkLead.textContent = "りあるたいむどうがを じゅんびしているよ";
    const [call, pcm] = await Promise.all([
      startTavusConversation(),
      responseAudioAsPcm24k(bundle.audioUrl),
    ]);
    guardianPortrait.hidden = true;
    neutralMedia.hidden = true;
    responseVideo.hidden = false;
    responseAudio.pause();
    state.tavusSpeaking = true;
    mediaStage.classList.add("is-speaking");
    await Promise.resolve(call.sendAppMessage({
      message_type: "conversation",
      event_type: "conversation.echo",
      conversation_id: state.tavusConversationId,
      properties: {
        modality: "audio",
        audio: btoa(pcm),
        sample_rate: 24000,
        inference_id: crypto.randomUUID(),
        done: "true",
      },
    }, "*"));
    clearTimeout(state.tavusSpeakingTimer);
    state.tavusSpeakingTimer = setTimeout(() => {
      state.tavusSpeaking = false;
      mediaStage.classList.remove("is-speaking");
    }, Math.ceil((pcm.length / 48_000) * 1000) + 1_500);
    responseTalkLead.textContent = "このまま つづけて おはなしできるよ";
    return true;
  } catch (error) {
    const errorCode = /^[A-Z0-9_]{1,80}$/.test(error?.message)
      ? error.message
      : "TAVUS_UNKNOWN_FAILED";
    responseRecordError.dataset.tavusError = errorCode;
    console.warn("Tavus fallback", errorCode);
    responseRecordError.textContent = "どうがにつながらなかったので、おとのおへんじにきりかえたよ。";
    responseTalkLead.textContent = "このまま つづけて おはなしできるよ";
    await stopTavusConversation();
    guardianPortrait.hidden = !bundle.posterUrl;
    responseVideo.hidden = true;
    return false;
  }
}

async function stopLiveAvatarSession() {
  clearInterval(state.liveAvatarKeepAliveTimer);
  state.liveAvatarKeepAliveTimer = null;
  const session = state.liveAvatarSession;
  state.liveAvatarSession = null;
  state.liveAvatarStartPromise = null;
  state.liveAvatarStreamReady = false;
  state.liveAvatarSpeaking = false;
  state.liveAvatarExpiresAt = 0;
  if (session) await session.stop().catch(() => {});
  responseVideo.srcObject = null;
}

async function startLiveAvatarSession() {
  const SDK = globalThis.LiveAvatarSDK;
  if (!SDK?.LiveAvatarSession) throw new Error("LIVEAVATAR_SDK_UNAVAILABLE");
  if (state.liveAvatarSession?.state === SDK.SessionState?.CONNECTED && state.liveAvatarStreamReady) {
    if (state.liveAvatarExpiresAt - Date.now() > 30_000) return state.liveAvatarSession;
    await stopLiveAvatarSession();
  }
  if (state.liveAvatarStartPromise) return state.liveAvatarStartPromise;

  state.liveAvatarStartPromise = (async () => {
    let response;
    try {
      response = await profileFetch("/api/liveavatar/session-token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          consentId: state.consent?.consentId,
          avatarAssetId: state.consent?.avatarAssetId,
          externalProcessingApproved: videoConsentCheck.checked,
        }),
      });
    } catch {
      throw new Error("LIVEAVATAR_TOKEN_NETWORK_FAILED");
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.sessionToken) {
      const code = /^[A-Z0-9_]{1,80}$/.test(payload.error) ? payload.error : "LIVEAVATAR_TOKEN_FAILED";
      throw new Error(code);
    }
    const maxSessionDuration = Math.max(30, Number(payload.maxSessionDuration) || 60);

    const session = new SDK.LiveAvatarSession(payload.sessionToken, {
      voiceChat: false,
      apiUrl: payload.apiUrl,
    });
    state.liveAvatarSession = session;
    const readyEvent = SDK.SessionEvent?.SESSION_STREAM_READY ?? "session.stream_ready";
    const disconnectedEvent = SDK.SessionEvent?.SESSION_DISCONNECTED ?? "session.disconnected";
    const streamReady = new Promise((resolve) => session.once(readyEvent, resolve));
    session.on(disconnectedEvent, () => {
      if (state.liveAvatarSession !== session) return;
      const shouldResumeAudio = state.liveAvatarSpeaking
        && state.screen === "response"
        && Boolean(state.response?.responseBundle?.audioUrl);
      clearInterval(state.liveAvatarKeepAliveTimer);
      state.liveAvatarKeepAliveTimer = null;
      state.liveAvatarSession = null;
      state.liveAvatarStartPromise = null;
      state.liveAvatarStreamReady = false;
      state.liveAvatarSpeaking = false;
      state.liveAvatarExpiresAt = 0;
      responseVideo.srcObject = null;
      responseVideo.hidden = true;
      const posterUrl = state.response?.responseBundle?.posterUrl;
      guardianPortrait.hidden = !posterUrl;
      neutralMedia.hidden = Boolean(posterUrl);
      if (shouldResumeAudio) {
        responseRecordError.textContent = "どうががとまったので、おとのおへんじにきりかえたよ。";
        responseAudio.currentTime = 0;
        responseAudio.play().catch(() => mediaStage.classList.remove("is-speaking"));
      }
    });
    session.on(SDK.AgentEventsEnum?.AVATAR_SPEAK_STARTED ?? "avatar.speak_started", () => {
      state.liveAvatarSpeaking = true;
      mediaStage.classList.add("is-speaking");
    });
    session.on(SDK.AgentEventsEnum?.AVATAR_SPEAK_ENDED ?? "avatar.speak_ended", () => {
      state.liveAvatarSpeaking = false;
      mediaStage.classList.remove("is-speaking");
    });
    let connectionTimer;
    try {
      await Promise.race([
        (async () => {
          try {
            await session.start();
          } catch {
            throw new Error("LIVEAVATAR_SESSION_START_FAILED");
          }
          await streamReady;
        })(),
        new Promise((_, reject) => {
          connectionTimer = setTimeout(() => reject(new Error("LIVEAVATAR_STREAM_TIMEOUT")), 25_000);
        }),
      ]);
    } finally {
      clearTimeout(connectionTimer);
    }
    try {
      session.attach(responseVideo);
    } catch {
      throw new Error("LIVEAVATAR_STREAM_ATTACH_FAILED");
    }
    responseVideo.hidden = false;
    responseVideo.muted = false;
    responseVideo.autoplay = true;
    responseVideo.playsInline = true;
    try {
      await responseVideo.play();
    } catch {
      throw new Error("LIVEAVATAR_VIDEO_PLAY_FAILED");
    }
    state.liveAvatarStreamReady = true;
    state.liveAvatarExpiresAt = Date.now() + (maxSessionDuration * 1000);
    state.liveAvatarKeepAliveTimer = setInterval(() => session.keepAlive().catch(() => {}), 120_000);
    return session;
  })();

  try {
    return await state.liveAvatarStartPromise;
  } catch (error) {
    await stopLiveAvatarSession();
    throw error;
  } finally {
    state.liveAvatarStartPromise = null;
  }
}

async function playLiveAvatar(bundle) {
  if (!liveAvatarCanPlay()) return false;
  try {
    delete responseRecordError.dataset.liveAvatarError;
    responseTalkLead.textContent = "りあるたいむどうがを じゅんびしているよ";
    const [session, pcm] = await Promise.all([
      startLiveAvatarSession(),
      responseAudioAsPcm24k(bundle.audioUrl),
    ]);
    guardianPortrait.hidden = true;
    neutralMedia.hidden = true;
    responseVideo.hidden = false;
    responseAudio.pause();
    session.interrupt();
    session.repeatAudio(pcm);
    responseTalkLead.textContent = "このまま つづけて おはなしできるよ";
    return true;
  } catch (error) {
    const errorCode = /^[A-Z0-9_]{1,80}$/.test(error?.message)
      ? error.message
      : "LIVEAVATAR_UNKNOWN_FAILED";
    responseRecordError.dataset.liveAvatarError = errorCode;
    console.warn("LiveAvatar fallback", errorCode);
    responseRecordError.textContent = "どうがにつながらなかったので、おとのおへんじにきりかえたよ。";
    responseTalkLead.textContent = "このまま つづけて おはなしできるよ";
    await stopLiveAvatarSession();
    guardianPortrait.hidden = !bundle.posterUrl;
    responseVideo.hidden = true;
    return false;
  }
}

async function prepareResponse(data) {
  const bundle = data.responseBundle;
  const keepLiveStream = (liveAvatarCanPlay(data) && state.liveAvatarStreamReady)
    || (tavusCanPlay(data) && state.tavusStreamReady);
  const responseScreen = document.querySelector('[data-screen="response"]');
  responseScreen.dataset.supportMode = data.supportMode ?? data.routerDecision?.supportMode ?? "listen";
  responseScreen.classList.toggle("is-neutral-response", bundle.parentLike === false);
  subtitle.textContent = bundle.subtitle;
  responseTitle.textContent = bundle.parentLike === false ? "いっしょに確認しよう" : "おへんじがとどいたよ";
  responsePoster.src = bundle.posterUrl ?? "";
  guardianPortrait.hidden = keepLiveStream || Boolean(bundle.videoUrl) || !bundle.posterUrl;
  responseVideo.hidden = !keepLiveStream && !bundle.videoUrl;
  neutralMedia.hidden = keepLiveStream || Boolean(bundle.videoUrl || bundle.posterUrl);
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
    if (!keepLiveStream) {
      responseVideo.removeAttribute("src");
      responseVideo.load();
    }
  }
  if (bundle.audioUrl) {
    responseAudio.src = bundle.audioUrl;
    await waitForMedia(responseAudio);
  } else {
    responseAudio.removeAttribute("src");
    responseAudio.load();
  }
}

function stopSpeech(endTavus = false) {
  speechSynthesis.cancel();
  state.responseUtterance = null;
  if (state.liveAvatarStreamReady) state.liveAvatarSession?.interrupt();
  else if (!state.tavusStreamReady) responseVideo.pause();
  if (endTavus) void stopTavusConversation();
  responseAudio.pause();
  mediaStage.classList.remove("is-speaking");
}

async function playResponse() {
  if (!state.response?.responseBundle) return;
  stopSpeech();
  const bundle = state.response.responseBundle;
  if (await playTavus(bundle)) return;
  if (await playLiveAvatar(bundle)) return;
  const hasVideo = Boolean(bundle.videoUrl);
  mediaStage.classList.add("is-speaking");
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
    } catch {
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
  utterance.rate = Number(state.response.speechRate ?? 0.82);
  utterance.pitch = 1.04;
  utterance.addEventListener("end", () => {
    state.responseUtterance = null;
    if (hasVideo) responseVideo.pause();
    mediaStage.classList.remove("is-speaking");
  }, { once: true });
  utterance.addEventListener("error", () => {
    state.responseUtterance = null;
    if (hasVideo) responseVideo.pause();
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
  void stopTavusConversation();
  void stopLiveAvatarSession();
  state.liveAvatarPcmCache.clear();
  stopTracks();
  state.pollAbort?.abort();
  const endedConversationId = state.conversationId;
  if (endedConversationId) {
    profileFetch(`/api/conversations/${encodeURIComponent(endedConversationId)}`, {
      method: "DELETE",
      keepalive: true,
    }).catch(() => {});
  }
  state.sessionId = crypto.randomUUID();
  state.conversationId = crypto.randomUUID();
  state.transcriptId = null;
  if (state.requestId) profileFetch(`/api/responses/${encodeURIComponent(state.requestId)}`, { method: "DELETE", keepalive: true }).catch(() => {});
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
  state.recordingContext = "record";
  setRecordState(false);
  setResponseTranscriptVisible(false);
  responseTranscriptInput.value = "";
  responseTimer.textContent = "00:00";
  responseTalkLead.textContent = "このまま つづけて おはなしできるよ";
  responseRecordError.textContent = "";
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
saveFavoriteTopicsButton.addEventListener("click", saveFavoriteTopics);
deleteSampleButton.addEventListener("click", deleteSampling);
generateVideoButton.addEventListener("click", generateSamplingVideo);
startSetup.addEventListener("click", () => showScreen("record"));
recordButton.addEventListener("click", () => state.mediaRecorder?.state === "recording" ? stopRecording() : startRecording("record"));
demoAudioButton.addEventListener("click", () => transcribe({ useDemo: true }));
retryButton.addEventListener("click", () => showScreen("record"));
confirmButton.addEventListener("click", createResponse);
cancelButton.addEventListener("click", resetFlow);
replayButton.addEventListener("click", playResponse);
soundButton.addEventListener("click", () => stopSpeech(true));
finishButton.addEventListener("click", resetFlow);
talkAgainButton.addEventListener("click", () => {
  if (state.mediaRecorder?.state === "recording" && state.recordingContext === "response") {
    stopRecording();
    return;
  }
  prepareInlineTurn();
  startRecording("response");
});
responseDemoAudioButton.addEventListener("click", () => {
  prepareInlineTurn();
  state.recordingContext = "response";
  transcribe({ useDemo: true, stayOnResponse: true });
});
responseRetryButton.addEventListener("click", () => {
  setResponseTranscriptVisible(false);
  responseTranscriptInput.value = "";
  responseTalkLead.textContent = "このまま つづけて おはなしできるよ";
  talkAgainButton.focus();
});
responseConfirmButton.addEventListener("click", () => createResponse({ inline: true }));
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
  void stopTavusConversation();
  void stopLiveAvatarSession();
});
responseAudio.addEventListener("pause", () => {
  if (!state.response?.responseBundle?.audioUrl) return;
  if (state.response.responseBundle.videoUrl) responseVideo.pause();
});
responseAudio.addEventListener("ended", () => {
  if (!state.response?.responseBundle?.audioUrl) return;
  if (state.response.responseBundle.videoUrl) responseVideo.pause();
  mediaStage.classList.remove("is-speaking");
});
responseAudio.addEventListener("error", () => {
  if (!state.response?.responseBundle?.audioUrl) return;
  if (state.response.responseBundle.videoUrl) responseVideo.pause();
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
