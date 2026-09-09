/** Browser-safe localization vocabulary. Keep this module free of Node-only imports. */
export const LOCALIZED_AUDIO_MODES = [
  "authorized-tts",
  "local-voice",
  "uploaded",
  "lip-sync",
  "regenerated-avatar",
  "subtitles-only",
] as const;

export type LocalizedAudioMode = (typeof LOCALIZED_AUDIO_MODES)[number];
