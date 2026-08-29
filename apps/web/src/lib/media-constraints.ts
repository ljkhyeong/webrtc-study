export const DEFAULT_AUDIO_CONSTRAINTS = {
  autoGainControl: true,
  echoCancellation: true,
  noiseSuppression: true,
} satisfies MediaTrackConstraints;

export const DEFAULT_VIDEO_CONSTRAINTS = {
  width: { ideal: 640 },
  height: { ideal: 360 },
  frameRate: { ideal: 15, max: 15 },
  facingMode: 'user',
} satisfies MediaTrackConstraints;

export const DEFAULT_MEDIA_CONSTRAINTS = {
  audio: DEFAULT_AUDIO_CONSTRAINTS,
  video: DEFAULT_VIDEO_CONSTRAINTS,
} satisfies MediaStreamConstraints;
