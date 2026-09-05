/** 사용자가 알림음을 켠 동안만 오디오 컨텍스트를 유지한다. */
export function createTimerChime() {
  const context = new AudioContext();
  return {
    ready: context.resume(),
    play() {
      if (context.state !== 'running') return false;
      const tone = context.createOscillator();
      const gain = context.createGain();
      tone.frequency.value = 660;
      tone.connect(gain).connect(context.destination);
      const now = context.currentTime;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.1, now + 0.02);
      gain.gain.linearRampToValueAtTime(0, now + 0.7);
      tone.onended = () => {
        tone.disconnect();
        gain.disconnect();
      };
      tone.start(now);
      tone.stop(now + 0.7);
      return true;
    },
    close() {
      void context.close().catch(() => {});
    },
  };
}
