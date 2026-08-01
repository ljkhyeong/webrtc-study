import { useEffect, useRef } from 'react';
import { CameraOffIcon, MicOffIcon } from './Icons';

export interface ParticipantView {
  peerId: string;
  displayName: string;
  role: 'host' | 'participant';
  isLocal: boolean;
  audioEnabled: boolean;
  videoEnabled: boolean;
  videoSource: 'camera' | 'screen';
  connectionState: string;
  stream?: MediaStream | undefined;
}

interface VideoTileProps {
  participant: ParticipantView;
  canModerateMedia?: boolean;
  onDisableAudio?: ((peerId: string) => void) | undefined;
  onDisableVideo?: ((peerId: string) => void) | undefined;
}

function initials(name: string) {
  return Array.from(name.trim()).slice(0, 2).join('').toUpperCase() || '?';
}

function connectionLabel(connectionState: string) {
  switch (connectionState) {
    case 'disconnected':
      return '재연결 중';
    case 'failed':
      return '연결 실패';
    case 'closed':
      return '연결 종료';
    default:
      return '연결 중';
  }
}

export function VideoTile({
  participant,
  canModerateMedia = false,
  onDisableAudio,
  onDisableVideo,
}: VideoTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    video.srcObject = participant.stream ?? null;
    return () => {
      video.srcObject = null;
    };
  }, [participant.stream]);

  const hasStream = Boolean(participant.stream);
  const hasVisibleVideo = participant.videoEnabled && hasStream;
  const isConnected =
    participant.isLocal || ['connected', 'completed'].includes(participant.connectionState);

  return (
    <article
      className={`video-tile${isConnected ? ' video-tile--connected' : ''}`}
      data-peer-id={participant.peerId}
      aria-label={`${participant.displayName}${participant.isLocal ? ' (나)' : ''} 참가자`}
    >
      {hasStream ? (
        <video
          ref={videoRef}
          className={
            [
              hasVisibleVideo ? '' : 'video-tile__media--hidden',
              participant.videoSource === 'screen' ? 'video-tile__media--screen' : '',
            ]
              .filter(Boolean)
              .join(' ') || undefined
          }
          autoPlay
          muted={participant.isLocal}
          playsInline
          aria-label={`${participant.displayName}의 영상`}
          aria-hidden={!hasVisibleVideo}
        />
      ) : null}
      {!hasVisibleVideo ? (
        <div
          className="video-tile__fallback"
          aria-label={`${participant.displayName}의 카메라 꺼짐`}
        >
          <span>{initials(participant.displayName)}</span>
        </div>
      ) : null}
      {!isConnected ? (
        <span
          className={`video-tile__connection video-tile__connection--${participant.connectionState}`}
        >
          {connectionLabel(participant.connectionState)}
        </span>
      ) : null}

      <div className="video-tile__badges">
        {participant.role === 'host' ? <span>방장</span> : null}
        {participant.videoSource === 'screen' && participant.videoEnabled ? (
          <span>화면 공유 중</span>
        ) : null}
      </div>

      {canModerateMedia && !participant.isLocal && participant.role === 'participant' ? (
        <div
          className="video-tile__moderation"
          aria-label={`${participant.displayName} 미디어 관리`}
        >
          <button
            type="button"
            disabled={!participant.audioEnabled}
            aria-label={`${participant.displayName} 마이크 끄기`}
            onClick={() => onDisableAudio?.(participant.peerId)}
          >
            <MicOffIcon />
          </button>
          <button
            type="button"
            disabled={!participant.videoEnabled}
            aria-label={`${participant.displayName} 비디오 끄기`}
            onClick={() => onDisableVideo?.(participant.peerId)}
          >
            <CameraOffIcon />
          </button>
        </div>
      ) : null}

      <div className="video-tile__shade" />
      <div className="video-tile__meta">
        <span className="video-tile__name">
          {participant.displayName}
          {participant.isLocal ? ' (나)' : ''}
        </span>
        {!participant.audioEnabled ? (
          <span className="video-tile__muted" aria-label="마이크 꺼짐">
            <MicOffIcon />
          </span>
        ) : (
          <span className="video-tile__signal" aria-label="마이크 켜짐">
            <i />
            <i />
            <i />
          </span>
        )}
      </div>
    </article>
  );
}
