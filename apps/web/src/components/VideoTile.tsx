import { useEffect, useId, useRef, useState } from 'react';
import type { ParticipantSnapshot, PeerConnectionStatus } from '@round/rtc-core';
import { enterVideoFullscreen, exitVideoFullscreen, isVideoFullscreen } from '../lib/fullscreen';
import { CameraOffIcon, FullscreenIcon, HandIcon, MicOffIcon } from './Icons';
import { ParticipantAudioControls } from './ParticipantAudioControls';
import { useScreenShareView } from './useScreenShareView';

export type ParticipantView = ParticipantSnapshot & {
  readonly stream?: MediaStream | undefined;
};

export interface AudioOutputSelection {
  readonly deviceId: string;
}

const DEFAULT_AUDIO_OUTPUT: AudioOutputSelection = { deviceId: '' };

interface VideoTileProps {
  participant: ParticipantView;
  handPosition?: number | undefined;
  qualityVisible?: boolean;
  audioOutput?: AudioOutputSelection | undefined;
  onSelectDevices?: () => void;
  pinned?: boolean;
  onTogglePin?: () => void;
  canModerateMedia?: boolean;
  onRetryPeer?: ((peerId: string) => void) | undefined;
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
  handPosition,
  qualityVisible = false,
  audioOutput = DEFAULT_AUDIO_OUTPUT,
  onSelectDevices,
  pinned = false,
  onTogglePin,
  canModerateMedia = false,
  onDisableAudio,
  onDisableVideo,
  onRetryPeer,
}: VideoTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const tileRef = useRef<HTMLElement>(null);
  const zoomHelpId = useId();
  const playbackAttemptRef = useRef(0);
  const fullscreenAttemptRef = useRef(0);
  const fullscreenShareGenerationRef = useRef(0);
  const latestFullscreenRequestGenerationRef = useRef(0);
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  const [outputError, setOutputError] = useState(false);
  const [mutedLocally, setMutedLocally] = useState(false);
  const [previewHidden, setPreviewHidden] = useState(false);
  const outputChange = useRef(Promise.resolve());
  const [fullscreenError, setFullscreenError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const update = () => setFullscreen(isVideoFullscreen(video, tileRef.current ?? undefined));
    update();
    document.addEventListener('fullscreenchange', update);
    document.addEventListener('webkitfullscreenchange', update);
    video.addEventListener('webkitbeginfullscreen', update);
    video.addEventListener('webkitendfullscreen', update);
    return () => {
      document.removeEventListener('fullscreenchange', update);
      document.removeEventListener('webkitfullscreenchange', update);
      video.removeEventListener('webkitbeginfullscreen', update);
      video.removeEventListener('webkitendfullscreen', update);
    };
  }, [participant.stream]);

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

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const attempt = ++playbackAttemptRef.current;
    video.muted = true;
    setPlaybackBlocked(false);
    setOutputError(false);
    const play = () => {
      if (playbackAttemptRef.current !== attempt) return;
      video.muted = participant.isLocal || mutedLocally;
      void playVideo(video, attempt);
    };
    if (!participant.isLocal && typeof video.setSinkId === 'function') {
      outputChange.current = outputChange.current.then(async () => {
        if (playbackAttemptRef.current !== attempt) return;
        try {
          if (video.sinkId !== audioOutput.deviceId) {
            await video.setSinkId(audioOutput.deviceId);
          }
          play();
        } catch {
          if (playbackAttemptRef.current === attempt) setOutputError(true);
        }
      });
    } else {
      play();
    }
    return () => {
      playbackAttemptRef.current += 1;
    };
  }, [participant.stream, participant.isLocal, audioOutput, mutedLocally]);

  const hasStream = Boolean(participant.stream);
  const hasVisibleVideo = participant.videoEnabled && hasStream;
  const showPreview = hasVisibleVideo && !(participant.isLocal && previewHidden);
  const isRemoteScreenShare =
    !participant.isLocal && participant.videoSource === 'screen' && hasVisibleVideo;
  const shareView = useScreenShareView(isRemoteScreenShare, participant.stream, videoRef);
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
      void exitVideoFullscreen(video, undefined, tileRef.current ?? undefined);
    }
    return undefined;
  }, [isRemoteScreenShare]);

  async function openFullscreen() {
    const video = videoRef.current;
    if (video === null) {
      return;
    }
    if (isVideoFullscreen(video, tileRef.current ?? undefined)) {
      const closeAttempt = ++fullscreenAttemptRef.current;
      setFullscreenError(null);
      const exited = await exitVideoFullscreen(video, undefined, tileRef.current ?? undefined);
      if (fullscreenAttemptRef.current !== closeAttempt) return;
      setFullscreen(isVideoFullscreen(video, tileRef.current ?? undefined));
      if (!exited)
        setFullscreenError(
          '전체 화면을 닫지 못했습니다. Esc 또는 브라우저의 뒤로가기를 사용해 주세요.',
        );
      return;
    }

    const attempt = fullscreenAttemptRef.current + 1;
    fullscreenAttemptRef.current = attempt;
    const shareGeneration = fullscreenShareGenerationRef.current;
    latestFullscreenRequestGenerationRef.current = shareGeneration;
    setFullscreenError(null);
    const container = tileRef.current ?? undefined;
    const entered = await enterVideoFullscreen(video, container);
    if (fullscreenAttemptRef.current !== attempt) {
      if (
        entered &&
        fullscreenShareGenerationRef.current !== shareGeneration &&
        latestFullscreenRequestGenerationRef.current === shareGeneration
      ) {
        await exitVideoFullscreen(video, undefined, container);
      }
      return;
    }
    if (!entered) {
      setFullscreenError(
        '화면 공유를 전체 화면으로 열지 못했습니다. 브라우저의 전체 화면 기능을 사용해 주세요.',
      );
    }
    setFullscreen(isVideoFullscreen(video, container));
  }

  return (
    <article
      ref={tileRef}
      className={`video-tile${isConnected ? ' video-tile--connected' : ''}${pinned ? ' video-tile--pinned' : ''}${participant.audioEnabled && participant.activity?.speaking ? ' video-tile--speaking' : ''}`}
      data-peer-id={participant.peerId}
      aria-label={`${participant.displayName}${participant.isLocal ? ' (나)' : ''} 참가자`}
    >
      <div
        ref={shareView.viewportRef}
        className={`video-tile__viewport${shareView.scale > 1 ? ' video-tile__viewport--zoomed' : ''}`}
        {...shareView.viewportProps}
        role={isRemoteScreenShare ? 'group' : undefined}
        aria-label={
          isRemoteScreenShare ? `${participant.displayName}의 공유 화면 확대·이동` : undefined
        }
        aria-describedby={isRemoteScreenShare ? zoomHelpId : undefined}
      >
        {hasStream ? (
          <video
            ref={videoRef}
            style={shareView.videoStyle}
            className={
              [
                showPreview ? '' : 'video-tile__media--hidden',
                participant.videoSource === 'screen' ? 'video-tile__media--screen' : '',
              ]
                .filter(Boolean)
                .join(' ') || undefined
            }
            autoPlay
            muted
            playsInline
            aria-label={`${participant.displayName}의 영상`}
            aria-hidden={!showPreview}
          />
        ) : null}
      </div>
      {!showPreview ? (
        <div
          className="video-tile__fallback"
          aria-label={
            participant.isLocal && previewHidden
              ? '내 영상 숨김'
              : participant.videoEnabled
                ? `${participant.displayName}의 영상 없음`
                : `${participant.displayName}의 카메라 꺼짐`
          }
        >
          {participant.isLocal && previewHidden ? (
            <p className="video-tile__preview-notice">
              내 영상만 숨겼습니다.
              <small>
                {participant.videoEnabled
                  ? '상대방에게 보내는 영상은 유지됩니다.'
                  : '카메라는 꺼져 있습니다.'}
              </small>
            </p>
          ) : (
            <span>{initials(participant.displayName)}</span>
          )}
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
        {participant.audioEnabled && participant.activity?.speaking ? (
          <span className="video-tile__speaking">발언 중</span>
        ) : null}
        {qualityVisible && !participant.isLocal && isConnected ? (
          <span
            className={`video-tile__quality video-tile__quality--${participant.activity?.receptionQuality ?? 'unavailable'}`}
            title="내가 받는 음성·영상의 연결 상태입니다. 자세한 수치는 연결 진단에서 확인하세요."
          >
            {participant.activity?.receptionQuality === 'unstable'
              ? '수신 불안정 · 연결 진단 확인'
              : participant.activity?.receptionQuality === 'stable'
                ? '수신 양호'
                : '수신 품질 측정값 없음'}
          </span>
        ) : null}
        {participant.handRaised ? (
          <span
            className="video-tile__hand-raised"
            aria-label={`${participant.displayName} 손들기`}
          >
            <HandIcon />
            손들기{handPosition ? ` · ${handPosition}번` : ''}
          </span>
        ) : null}
        {participant.role === 'host' ? <span>방장</span> : null}
        {participant.videoSource === 'screen' && participant.videoEnabled ? (
          <span>화면 공유 중</span>
        ) : null}
      </div>

      {isRemoteScreenShare ? (
        <div className="video-tile__view-controls">
          <div className="video-tile__zoom-controls" role="group" aria-label="공유 화면 배율">
            <button
              type="button"
              aria-label="공유 화면 축소"
              disabled={shareView.scale === 1}
              onClick={() => shareView.zoom(-0.5)}
            >
              −
            </button>
            <button
              type="button"
              aria-label="공유 화면 배율과 위치 초기화"
              onClick={shareView.reset}
            >
              {Math.round(shareView.scale * 100)}%
            </button>
            <button
              type="button"
              aria-label="공유 화면 확대"
              disabled={shareView.scale === 4}
              onClick={() => shareView.zoom(0.5)}
            >
              +
            </button>
          </div>
          {onTogglePin ? (
            <button
              type="button"
              aria-label={`${participant.displayName}의 공유 화면 ${pinned ? '고정 해제' : '고정'}`}
              aria-pressed={pinned}
              onClick={onTogglePin}
            >
              {pinned ? '고정 해제' : '화면 고정'}
            </button>
          ) : null}
          <button
            type="button"
            aria-label={`${participant.displayName}의 화면 공유 ${fullscreen ? '전체 화면 닫기' : '전체 화면으로 보기'}`}
            onClick={() => void openFullscreen()}
          >
            <FullscreenIcon />
            <span>{fullscreen ? '전체 화면 닫기' : '전체 화면'}</span>
          </button>
        </div>
      ) : null}
      {isRemoteScreenShare ? (
        <p id={zoomHelpId} className="sr-only">
          공유 화면을 끌거나 방향키로 이동할 수 있습니다. +와 -로 확대·축소하고 0으로 초기화합니다.
        </p>
      ) : null}

      {isRemoteScreenShare && fullscreenError ? (
        <p className="video-tile__fullscreen-error" role="alert">
          {fullscreenError}
        </p>
      ) : null}

      {hasStream && outputError ? (
        <div className="video-tile__playback-recovery">
          <span role="alert">선택한 스피커로 소리를 재생하지 못했습니다.</span>
          <button type="button" onClick={onSelectDevices}>
            스피커 다시 선택
          </button>
        </div>
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
          aria-label={`${participant.displayName} 마이크·영상 관리`}
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
            aria-label={`${participant.displayName} 영상 끄기`}
            onClick={() => onDisableVideo?.(participant.peerId)}
          >
            <CameraOffIcon />
          </button>
        </div>
      ) : null}

      {!participant.isLocal && participant.connectionState === 'failed' && onRetryPeer ? (
        <div className="video-tile__playback-recovery">
          <button
            type="button"
            onClick={() => onRetryPeer(participant.peerId)}
            aria-label={`${participant.displayName} 다시 연결`}
          >
            이 참가자 다시 연결
          </button>
        </div>
      ) : null}
      <div className="video-tile__shade" />
      <div className="video-tile__meta">
        <span className="video-tile__name">
          {participant.displayName}
          {participant.isLocal ? ' (나)' : ''}
        </span>
        {!participant.isLocal ? (
          <ParticipantAudioControls
            name={participant.displayName}
            videoRef={videoRef}
            stream={participant.stream}
            muted={mutedLocally}
            onToggleMuted={() => setMutedLocally((muted) => !muted)}
          />
        ) : hasStream || previewHidden ? (
          <button
            type="button"
            className="video-tile__local-mute"
            aria-pressed={previewHidden}
            onClick={() => setPreviewHidden((hidden) => !hidden)}
          >
            {previewHidden ? '내 영상 다시 보기' : '내 영상 숨기기'}
          </button>
        ) : null}
        {!participant.audioEnabled ? (
          <span className="video-tile__muted" aria-label="마이크 꺼짐">
            <MicOffIcon />
          </span>
        ) : (
          <span
            className={`video-tile__signal${participant.activity?.speaking ? ' video-tile__signal--speaking' : ''}`}
            aria-label="마이크 켜짐"
          >
            <i />
            <i />
            <i />
          </span>
        )}
      </div>
    </article>
  );
}
