import { useEffect, useState, type RefObject } from 'react';

interface ParticipantAudioControlsProps {
  name: string;
  videoRef: RefObject<HTMLVideoElement | null>;
  stream: MediaStream | undefined;
  muted: boolean;
  onToggleMuted: () => void;
}

export function ParticipantAudioControls({
  name,
  videoRef,
  stream,
  muted,
  onToggleMuted,
}: ParticipantAudioControlsProps) {
  const [volume, setVolume] = useState(100);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [panelHeight, setPanelHeight] = useState(165);

  useEffect(() => {
    const tile = videoRef.current?.closest('.video-tile');
    if (!tile || typeof ResizeObserver === 'undefined') return;
    const resize = () => setPanelHeight(Math.max(40, Math.min(165, tile.clientHeight - 70)));
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(tile);
    return () => observer.disconnect();
  }, [stream, videoRef]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !stream) {
      setSupported(null);
      return;
    }
    try {
      // 기본값 1만 읽으면 음량 변경을 무시하는 브라우저를 구분할 수 없다.
      video.volume = volume === 100 ? 0.5 : volume / 100;
      const applied = Math.abs(video.volume - (volume === 100 ? 0.5 : volume / 100)) < 0.01;
      video.volume = volume / 100;
      setSupported(applied);
    } catch {
      setSupported(false);
    }
  }, [volume, stream, videoRef]);

  return (
    <details
      className="participant-audio"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.currentTarget.open = false;
        event.currentTarget.querySelector('summary')?.focus();
      }}
    >
      <summary aria-label={`${name}의 내 쪽 소리 설정`}>
        {muted ? '음소거' : supported ? `음량 ${volume}%` : '음량'}
      </summary>
      <div className="participant-audio__panel" style={{ maxHeight: panelHeight }}>
        <label>
          내 쪽 음량 {supported ? `${volume}%` : ''}
          <input
            type="range"
            min="0"
            max="100"
            step="5"
            value={supported === false ? 100 : volume}
            disabled={!supported}
            aria-label={`${name}의 내 쪽 음량`}
            onChange={(event) => setVolume(Number(event.target.value))}
          />
        </label>
        <button
          type="button"
          className="video-tile__local-mute"
          aria-label={`${name}의 소리 내 쪽에서만 끄기`}
          aria-pressed={muted}
          onClick={onToggleMuted}
        >
          {muted ? '소리 켜기' : '소리 끄기'}
        </button>
        <small>
          {supported === false
            ? '이 브라우저는 개별 음량을 지원하지 않습니다. 기기 음량이나 소리 끄기를 사용하세요.'
            : supported === null
              ? '소리가 연결되면 음량을 조절할 수 있습니다.'
              : muted
                ? '소리 켜기를 누르면 설정한 음량으로 들립니다.'
                : '내가 듣는 소리만 바뀝니다.'}
        </small>
      </div>
    </details>
  );
}
