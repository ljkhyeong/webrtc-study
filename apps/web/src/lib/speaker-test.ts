export function startSpeakerTest(deviceId: string): {
  finished: Promise<void>;
  stop: () => void;
} {
  const context = new AudioContext();
  const audio = new Audio();
  const destination = context.createMediaStreamDestination();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.frequency.value = 440;
  oscillator.connect(gain).connect(destination);
  audio.srcObject = destination.stream;
  let stopped = false;
  let finishTone: (() => void) | undefined;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    audio.pause();
    audio.srcObject = null;
    destination.stream.getTracks().forEach((track) => track.stop());
    finishTone?.();
    void context.close().catch(() => {});
  };

  const finished = (async () => {
    await Promise.all([
      context.resume(),
      deviceId && typeof audio.setSinkId === 'function'
        ? audio.setSinkId(deviceId)
        : Promise.resolve(),
    ]);
    if (stopped) return;
    await audio.play();
    if (stopped) return;
    await new Promise<void>((resolve) => {
      finishTone = resolve;
      oscillator.onended = () => resolve();
      const now = context.currentTime;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.12, now + 0.02);
      gain.gain.linearRampToValueAtTime(0, now + 0.6);
      oscillator.start(now);
      oscillator.stop(now + 0.6);
    });
  })().finally(stop);

  return { finished, stop };
}
