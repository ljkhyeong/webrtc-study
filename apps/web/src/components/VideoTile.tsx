import { useEffect, useRef, useState } from 'react';
import type { ParticipantSnapshot, PeerConnectionStatus } from '@round/rtc-core';
import { enterVideoFullscreen, exitVideoFullscreen } from '../lib/fullscreen';
import { CameraOffIcon, FullscreenIcon, MicOffIcon } from './Icons';

export type ParticipantView = ParticipantSnapshot & {
  readonly stream?: MediaStream | undefined;
};

interface VideoTileProps {
  participant: ParticipantView;
  canModerateMedia?: boolean;
  onDisableAudio?: ((peerId: string) => void) | undefined;
  onDisableVideo?: ((peerId: string) => void) | undefined;
}

function initials(name: string) {
  return Array.from(name.trim()).slice(0, 2).join('').toUpperCase() || '?';
}

function connectionLabel(connectionState: PeerConnectionStatus) {
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
  const playbackAttemptRef = useRef(0);
  const fullscreenAttemptRef = useRef(0);
  const fullscreenShareGenerationRef = useRef(0);
  const latestFullscreenRequestGenerationRef = useRef(0);
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  const [fullscreenError, setFullscreenError] = useState<string | null>(null);

  useEffect(() => {
    const attempt = playbackAttemptRef.current + 1;
    playbackAttemptRef.current = attempt;
    setPlaybackBlocked(false);
    const video = videoRef.current;
    if (!video) {
      return;
    }

    video.srcObject = participant.stream ?? null;
    if (participant.stream !== undefined) {
      void playVideo(video, attempt);
    }
    return () => {
      playbackAttemptRef.current += 1;
      video.srcObject = null;
    };
  }, [participant.stream]);

  const hasStream = Boolean(participant.stream);
  const hasVisibleVideo = participant.videoEnabled && hasStream;
  const isRemoteScreenShare =
    !participant.isLocal && participant.videoSource === 'screen' && hasVisibleVideo;
  const isConnected = participant.isLocal || participant.connectionState === 'connected';

  async function playVideo(video: HTMLVideoElement, attempt: number): Promise<void> {
    try {
      await video.play();
      if (playbackAttemptRef.current === attempt) {
        setPlaybackBlocked(false);
      }
    } catch {
      if (playbackAttemptRef.current === attempt) {
        setPlaybackBlocked(true);
      }
    }
  }

  function resumePlayback(): void {
    const video = videoRef.current;
    if (video === null) {
      return;
    }
    const attempt = playbackAttemptRef.current + 1;
    playbackAttemptRef.current = attempt;
    void playVideo(video, attempt);
  }

  useEffect(() => {
    const generation = fullscreenShareGenerationRef.current + 1;
    fullscreenShareGenerationRef.current = generation;
    if (isRemoteScreenShare) {
      return () => {
        fullscreenAttemptRef.current += 1;
        if (fullscreenShareGenerationRef.current === generation) {
          fullscreenShareGenerationRef.current += 1;
        }
      };
    }
    fullscreenAttemptRef.current += 1;
    setFullscreenError(null);
    const video = videoRef.current;
    if (video !== null) {
      void exitVideoFullscreen(video);
    }
    return undefined;
  }, [isRemoteScreenShare]);

  async function openFullscreen() {
    const video = videoRef.current;
    if (video === null) {
      return;
    }

    const attempt = fullscreenAttemptRef.current + 1;
    fullscreenAttemptRef.current = attempt;
    const shareGeneration = fullscreenShareGenerationRef.current;
    latestFullscreenRequestGenerationRef.current = shareGeneration;
    setFullscreenError(null);
    const entered = await enterVideoFullscreen(video);
    if (fullscreenAttemptRef.current !== attempt) {
      if (
        entered &&
        fullscreenShareGenerationRef.current !== shareGeneration &&
        latestFullscreenRequestGenerationRef.current === shareGeneration
      ) {
        await exitVideoFullscreen(video);
      }
      return;
    }
    if (!entered) {
      setFullscreenError(
        '화면 공유를 전체 화면으로 열지 못했습니다. 브라우저의 전체 화면 기능을 사용해 주세요.',
      );
    }
  }

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

      {isRemoteScreenShare ? (
        <button
          className="video-tile__fullscreen"
          type="button"
          aria-label={`${participant.displayName}의 화면 공유 전체 화면으로 보기`}
          onClick={() => void openFullscreen()}
        >
          <FullscreenIcon />
          <span>전체 화면</span>
        </button>
      ) : null}

      {isRemoteScreenShare && fullscreenError ? (
        <p className="video-tile__fullscreen-error" role="alert">
          {fullscreenError}
        </p>
      ) : null}

      {hasStream && playbackBlocked ? (
        <div className="video-tile__playback-recovery">
          <span role="status">자동 재생이 차단되었습니다.</span>
          <button
            type="button"
            aria-label={`${participant.displayName}의 소리와 영상 재생`}
            onClick={resumePlayback}
          >
            소리와 영상 재생
          </button>
        </div>
      ) : null}

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
