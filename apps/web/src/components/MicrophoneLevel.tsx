import { useEffect, useRef, useState } from 'react';

interface MicrophoneLevelProps {
  track: MediaStreamTrack | null;
  enabled: boolean;
}

export function MicrophoneLevel({ track, enabled }: MicrophoneLevelProps) {
  const meterRef = useRef<HTMLMeterElement>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const [state, setState] = useState<'idle' | 'running' | 'suspended' | 'unavailable'>('idle');

  useEffect(() => {
    if (meterRef.current !== null) meterRef.current.value = 0;
    if (track === null || !enabled) {
      setState('idle');
      return;
    }

    let context: AudioContext;
    try {
      context = new AudioContext();
    } catch {
      setState('unavailable');
      return;
    }
    contextRef.current = context;
    let frame = 0;
    let disposed = false;
    let source: MediaStreamAudioSourceNode | undefined;
    let analyser: AnalyserNode | undefined;
    const updateState = () => {
      if (!disposed) setState(context.state === 'running' ? 'running' : 'suspended');
    };
    context.addEventListener('statechange', updateState);
    try {
      source = context.createMediaStreamSource(new MediaStream([track]));
      analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      const input = analyser;
      let lastSampleAt = -Infinity;
      const sample = (now: number) => {
        if (now - lastSampleAt >= 100) {
          input.getFloatTimeDomainData(samples);
          let peak = 0;
          for (const value of samples) peak = Math.max(peak, Math.abs(value));
          if (meterRef.current !== null) meterRef.current.value = peak;
          lastSampleAt = now;
        }
        frame = requestAnimationFrame(sample);
      };
      frame = requestAnimationFrame(sample);
      updateState();
      void context.resume().catch(() => {
        if (!disposed) setState('suspended');
      });
    } catch {
      setState('unavailable');
    }

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      source?.disconnect();
      analyser?.disconnect();
      context.removeEventListener('statechange', updateState);
      contextRef.current = null;
      void context.close().catch(() => {});
    };
  }, [track, enabled]);

  return (
    <div className="microphone-level">
      <span>마이크 입력 크기</span>
      <meter ref={meterRef} min={0} max={1} defaultValue={0} aria-label="마이크 입력 크기" />
      <small>
        {track === null
          ? '마이크를 연결하면 입력 크기를 확인할 수 있습니다.'
          : !enabled
            ? '마이크가 꺼져 있습니다.'
            : state === 'unavailable'
              ? '이 브라우저에서는 입력 크기를 표시할 수 없습니다.'
              : state === 'suspended'
                ? '입력 표시를 시작해 주세요.'
                : '말하면서 막대가 움직이는지 확인하세요. 입력 크기는 이 화면에서만 계산하며 저장하지 않습니다.'}
      </small>
      {state === 'suspended' && enabled ? (
        <button
          className="prejoin-text-action"
          type="button"
          onClick={() => {
            void contextRef.current?.resume().catch(() => setState('unavailable'));
          }}
        >
          입력 표시 시작
        </button>
      ) : null}
    </div>
  );
}
