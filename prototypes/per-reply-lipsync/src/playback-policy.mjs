export const VIDEO_OWNS_AUDIO_PLAYBACK = Object.freeze({
  mediaKind: "video/mp4",
  audioSource: "embedded-in-video",
  playSeparateTts: false,
});

export function assertNoSeparateTtsPlayback(playback) {
  return playback?.audioSource === "embedded-in-video" && playback?.playSeparateTts === false;
}
