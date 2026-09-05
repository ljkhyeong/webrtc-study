import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  RoomSession,
  type RoomConnectionDiagnostics,
  type RoomSessionOptions,
} from '@round/rtc-core';
import { RoomView } from './RoomView';
import { MediaDeviceDialog } from './MediaDeviceDialog';
import type { ParticipantView } from './VideoTile';
import { DEFAULT_MEDIA_CONSTRAINTS } from '../lib/media-constraints';
import { createWithPreparedMedia, withPreparedMediaFailureCleanup } from '../lib/prepared-media';
import {
  ParticipationGrantAccessError,
  ParticipationGrantLeaseManager,
} from '../lib/participation-grant';
import {
  resolveNormalizedRoomEndpoints,
  type RoomEndpoints,
  type RoundAuthMode,
} from '../lib/room-endpoints';
import { RoomRefreshCoordinator } from '../lib/room-refresh-coordinator';
import { loadRtcConfiguration, type LoadedRtcConfiguration } from '../lib/rtc-configuration';
import {
  PEER_CONNECTION_FAILURE_MESSAGE,
  buildRoomSystemNotices,
  chatErrorMessage,
  resolveActiveRoomTerminalState,
  roomErrorMessage,
  roomStatusLabel,
  roomWarningMessage,
  screenShareStartNotice,
  type RoomStartupErrorCode,
} from '../lib/room-presentation';
class RoomStartupFailure extends Error {
  constructor(
    readonly code: RoomStartupErrorCode,
    cause: unknown,
  ) {
    super(code, { cause });
    this.name = 'RoomStartupFailure';
  }
}

interface ActiveRoomProps {
  authMode: RoundAuthMode;
  displayName: string;
  roomId: string;
  hostCapability?: string | undefined;
  initialInputEnabled?: RoomSessionOptions['initialInputEnabled'];
  participationGrantLeaseManager?: ParticipationGrantLeaseManager | undefined;
  onParticipationGrantAccessFailure?: ((error: ParticipationGrantAccessError) => void) | undefined;
  releasePreparedMediaStream: () => void;
  takePreparedMediaStream: () => MediaStream | null;
  onReconnect: () => void;
  onLeave: () => void;
}

export function ActiveRoom({
  authMode,
  displayName,
  roomId,
  hostCapability,
  initialInputEnabled,
  participationGrantLeaseManager: preflightParticipationGrantLeaseManager,
  onParticipationGrantAccessFailure,
  releasePreparedMediaStream,
  takePreparedMediaStream,
  onReconnect,
  onLeave,
}: ActiveRoomProps) {
  const sessionRef = useRef<RoomSession | null>(null);
  const lifecycleRef = useRef(0);
  const refreshCoordinatorRef = useRef<RoomRefreshCoordinator | null>(null);
  const ensureFreshParticipationGrantRef = useRef<() => Promise<void>>(async () => {});
  const [subscribedSession, setSubscribedSession] = useState<RoomSession | null>(null);
  const [startupError, setStartupError] = useState<RoomStartupErrorCode | null>(null);
  const [actionWarning, setActionWarning] = useState('');
  const [actionError, setActionError] = useState('');
  const [participationGrantRefreshWarning, setParticipationGrantRefreshWarning] = useState('');
  const [turnRefreshWarning, setTurnRefreshWarning] = useState('');
  const [qualityVisible, setQualityVisible] = useState(false);
  const [deviceSettingsOpen, setDeviceSettingsOpen] = useState(false);
  const [audioOutput, setAudioOutput] = useState({ deviceId: '' });
  const outputDeviceId = audioOutput.deviceId;
  const [outputWarning, setOutputWarning] = useState('');
  const subscribeToSession = useCallback(
    (onStoreChange: () => void) => subscribedSession?.subscribe(onStoreChange) ?? (() => {}),
    [subscribedSession],
  );
  const readSessionSnapshot = useCallback(
    () => subscribedSession?.getSnapshot() ?? null,
    [subscribedSession],
  );
  const snapshot = useSyncExternalStore(subscribeToSession, readSessionSnapshot, () => null);

  useEffect(() => {
    setOutputWarning('');
    if (!outputDeviceId) return;
    let disposed = false;
    let request = 0;
    const mediaDevices = navigator.mediaDevices;
    const checkOutput = async () => {
      const current = ++request;
      try {
        const devices = await mediaDevices.enumerateDevices();
        if (!disposed && current === request) {
          setOutputWarning(
            devices.some(
              (device) => device.kind === 'audiooutput' && device.deviceId === outputDeviceId,
            )
              ? ''
              : '선택한 스피커가 연결되어 있지 않습니다. 통화 장치 설정에서 스피커를 다시 선택해 주세요.',
          );
        }
      } catch {
        // 목록 조회 실패만으로 사용 중인 출력 장치를 바꾸지 않는다.
      }
    };
    mediaDevices.addEventListener('devicechange', checkOutput);
    return () => {
      disposed = true;
      mediaDevices.removeEventListener('devicechange', checkOutput);
    };
  }, [outputDeviceId]);

  useEffect(() => {
    const lifecycle = ++lifecycleRef.current;
    let isCurrentSession = true;
    const isCurrentLifecycle = () => isCurrentSession && lifecycleRef.current === lifecycle;
    const refreshCoordinator = new RoomRefreshCoordinator({
      ...(preflightParticipationGrantLeaseManager === undefined
        ? {}
        : { participationGrantLeaseManager: preflightParticipationGrantLeaseManager }),
      isCurrent: isCurrentLifecycle,
      updateRtcConfiguration: (configuration) => {
        sessionRef.current?.updateRtcConfiguration(configuration, { restartIce: true });
      },
      onParticipationGrantWarning: setParticipationGrantRefreshWarning,
      onTurnWarning: setTurnRefreshWarning,
      ...(onParticipationGrantAccessFailure === undefined
        ? {}
        : { onParticipationGrantAccessFailure }),
    });
    refreshCoordinatorRef.current = refreshCoordinator;
    const ensureFreshParticipationGrant = () => refreshCoordinator.ensureFreshParticipationGrant();
    ensureFreshParticipationGrantRef.current = ensureFreshParticipationGrant;
    const stopBackgroundRefreshes = () => refreshCoordinator.stop();

    const startSession = async () => {
      try {
        await withPreparedMediaFailureCleanup(
          async () => {
            let resolvedEndpoints: RoomEndpoints;
            try {
              resolvedEndpoints = resolveNormalizedRoomEndpoints({
                roomId,
                authMode,
                location: window.location,
                signalingUrl: import.meta.env.VITE_SIGNALING_URL,
                turnCredentialsUrl: import.meta.env.VITE_TURN_CREDENTIALS_URL,
              });
            } catch (error) {
              throw new RoomStartupFailure('endpoint-configuration', error);
            }
            refreshCoordinator.setTurnCredentialsUrl(resolvedEndpoints.turnCredentialsUrl);

            if (resolvedEndpoints.participationGrantRefreshUrl !== null) {
              try {
                refreshCoordinator.configureParticipationGrant(
                  resolvedEndpoints.participationGrantRefreshUrl,
                  roomId,
                );
                await ensureFreshParticipationGrant();
              } catch (error) {
                throw new RoomStartupFailure('participation-grant', error);
              }
            }

            let loaded: LoadedRtcConfiguration;
            try {
              loaded = await loadRtcConfiguration(
                resolvedEndpoints.turnCredentialsUrl,
                refreshCoordinator.turnRequestSignal,
              );
            } catch (error) {
              throw new RoomStartupFailure('turn-configuration', error);
            }
            if (!isCurrentLifecycle()) {
              return;
            }

            let session = sessionRef.current;
            if (session === null) {
              session = createWithPreparedMedia(
                takePreparedMediaStream,
                (preparedMediaStream) =>
                  new RoomSession({
                    roomId,
                    displayName,
                    signalingUrl: resolvedEndpoints.signalingUrl,
                    rtcConfiguration: loaded.configuration,
                    preparedMediaStream,
                    ...(initialInputEnabled === undefined ? {} : { initialInputEnabled }),
                    ...(hostCapability === undefined ? {} : { hostCapability }),
                    ...(!refreshCoordinator.hasParticipationGrantManager()
                      ? {}
                      : {
                          beforeSignalingConnect: () => ensureFreshParticipationGrantRef.current(),
                        }),
                    mediaConstraints: DEFAULT_MEDIA_CONSTRAINTS,
                  }),
              );
              sessionRef.current = session;
            }
            setSubscribedSession(session);

            setActionWarning('');
            setActionError('');

            await session.join();
            if (loaded.turnRefreshDueAtMs !== null) {
              refreshCoordinator.scheduleTurnRefresh(loaded.turnRefreshDueAtMs);
            }
          },
          {
            hasSession: () => sessionRef.current !== null,
            isCurrent: () => isCurrentSession && lifecycleRef.current === lifecycle,
            release: releasePreparedMediaStream,
          },
        );
      } catch (error) {
        stopBackgroundRefreshes();
        if (isCurrentLifecycle()) {
          const sessionStatus = sessionRef.current?.getSnapshot().status;
          if (sessionStatus !== 'error') {
            setStartupError(error instanceof RoomStartupFailure ? error.code : 'session-start');
          }
        }
      }
    };

    setStartupError(null);
    setActionWarning('');
    setActionError('');
    setParticipationGrantRefreshWarning('');
    setTurnRefreshWarning('');
    void startSession();

    return () => {
      isCurrentSession = false;
      // React StrictMode는 개발 환경에서 effect를 즉시 다시 실행한다. 정리를 미루면
      // 두 번째 설정이 일회용 세션과 전달받은 입장 전 track을 재사용할 수 있다.
      queueMicrotask(() => {
        const session = sessionRef.current;
        if (lifecycleRef.current !== lifecycle) {
          if (session === null) {
            stopBackgroundRefreshes();
          } else {
            void session
              .join()
              .catch(() => {})
              .finally(stopBackgroundRefreshes);
          }
          return;
        }
        stopBackgroundRefreshes();
        if (refreshCoordinatorRef.current === refreshCoordinator) {
          refreshCoordinatorRef.current = null;
        }
        if (ensureFreshParticipationGrantRef.current === ensureFreshParticipationGrant) {
          ensureFreshParticipationGrantRef.current = async () => {};
        }
        if (session === null) {
          return;
        }
        sessionRef.current = null;
        void session.leave();
      });
    };
  }, [
    authMode,
    displayName,
    hostCapability,
    initialInputEnabled,
    onParticipationGrantAccessFailure,
    preflightParticipationGrantLeaseManager,
    releasePreparedMediaStream,
    roomId,
    takePreparedMediaStream,
  ]);

  useEffect(() => {
    if (snapshot?.status === 'error' || snapshot?.status === 'ended') {
      refreshCoordinatorRef.current?.stop();
    }
  }, [snapshot?.status, subscribedSession]);

  const participants = useMemo<ParticipantView[]>(() => {
    const session = subscribedSession;
    if (!snapshot || !session) {
      return [];
    }

    return snapshot.participants.map((participant) => {
      const stream = participant.isLocal
        ? session.getLocalStream()
        : session.getRemoteStream(participant.peerId);

      return {
        ...participant,
        stream: stream ?? undefined,
      };
    });
  }, [snapshot, subscribedSession]);

  useEffect(() => {
    const session = subscribedSession;
    if (!session || snapshot?.status !== 'active') return;
    let disposed = false;
    let sampleGeneration = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sample = async () => {
      const generation = sampleGeneration;
      if (disposed || document.hidden) return;
      await session.sampleParticipantActivity(qualityVisible);
      if (!disposed && generation === sampleGeneration && !document.hidden)
        timer = setTimeout(() => void sample(), 500);
    };
    const visibility = () => {
      sampleGeneration += 1;
      clearTimeout(timer);
      session.resetParticipantActivity();
      if (!document.hidden) void sample();
    };
    document.addEventListener('visibilitychange', visibility);
    void sample();
    return () => {
      disposed = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibility);
      session.resetParticipantActivity();
    };
  }, [subscribedSession, snapshot?.status, qualityVisible]);

  useEffect(() => {
    if (!subscribedSession || snapshot?.status !== 'active') return;
    const sync = () => {
      if (!document.hidden) subscribedSession.syncStudy();
    };
    sync();
    const timer = setInterval(sync, 15_000);
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('online', sync);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('online', sync);
    };
  }, [subscribedSession, snapshot?.status]);

  const messages = snapshot?.messages ?? [];

  const handleLeave = () => {
    const session = sessionRef.current;
    sessionRef.current = null;
    setSubscribedSession(null);
    if (session) {
      void session.leave();
    }
    onLeave();
  };

  const handleSendMessage = (text: string): boolean => {
    try {
      const session = sessionRef.current;
      if (session === null) {
        throw new Error('Room session is unavailable');
      }
      session.sendChat(text);
      setActionWarning('');
      setActionError('');
      return true;
    } catch (error) {
      setActionWarning('');
      setActionError(chatErrorMessage(error));
      return false;
    }
  };

  const sessionError = roomErrorMessage(snapshot?.error);
  const { status, terminalErrorMessage } = resolveActiveRoomTerminalState({
    snapshotStatus: snapshot?.status,
    sessionError,
    startupError,
  });
  const localMedia = snapshot?.localMedia ?? {
    audioAvailable: false,
    audioEnabled: false,
    videoAvailable: false,
    videoEnabled: false,
    videoSource: 'camera' as const,
  };
  const localAudioTrack = subscribedSession?.getLocalStream()?.getAudioTracks()[0] ?? null;
  const hasFailedRemotePeer = participants.some(
    (participant) => !participant.isLocal && participant.connectionState === 'failed',
  );
  const systemNotices = buildRoomSystemNotices({
    status,
    sessionError,
    actionWarning: actionWarning || undefined,
    actionError: actionError || undefined,
    participationGrantRefreshWarning: participationGrantRefreshWarning || undefined,
    turnRefreshWarning: turnRefreshWarning || undefined,
  });
  if (outputWarning) {
    systemNotices.push({ id: 'audio-output', tone: 'warning', message: outputWarning });
  }

  return (
    <>
      <RoomView
        study={snapshot?.study}
        studyPending={snapshot?.studyPending}
        studyNotice={snapshot?.studyNotice}
        onStudyCommand={(command) => sessionRef.current?.updateStudy(command) ?? false}
        onSyncStudy={() => {
          sessionRef.current?.syncStudy();
        }}
        qualityVisible={qualityVisible}
        onSetQualityVisible={setQualityVisible}
        roomId={roomId}
        status={status}
        statusLabel={roomStatusLabel(status, participants)}
        participants={participants}
        audioOutput={audioOutput}
        messages={messages}
        audioAvailable={localMedia.audioAvailable}
        audioEnabled={localMedia.audioEnabled}
        videoAvailable={localMedia.videoAvailable}
        videoEnabled={localMedia.videoEnabled}
        screenShareAvailable={snapshot?.screenShareAvailable ?? false}
        screenSharing={snapshot?.screenSharing ?? false}
        canModerateMedia={snapshot?.canModerateMedia ?? false}
        moderationNotice={
          snapshot?.lastModerationNotice?.kind === 'audio'
            ? '방장이 마이크를 껐습니다. 필요하면 직접 다시 켤 수 있습니다.'
            : snapshot?.lastModerationNotice?.kind === 'video'
              ? '방장이 비디오를 껐습니다. 필요하면 직접 다시 켤 수 있습니다.'
              : undefined
        }
        peerRecoveryMessage={hasFailedRemotePeer ? PEER_CONNECTION_FAILURE_MESSAGE : undefined}
        mediaWarning={
          snapshot?.warning?.code === 'peer-connection-timeout' ||
          snapshot?.warning?.code === 'peer-negotiation-failed'
            ? undefined
            : roomWarningMessage(snapshot?.warning)
        }
        mediaRecoveryAvailable={snapshot?.warning?.code === 'local-media-ended'}
        errorMessage={terminalErrorMessage}
        systemNotices={systemNotices}
        onToggleAudio={() => {
          sessionRef.current?.toggleAudio();
        }}
        onToggleVideo={() => {
          sessionRef.current?.toggleVideo();
        }}
        onRetryMessage={(messageId, peerId) => {
          if (!sessionRef.current?.retryChat(messageId, peerId))
            setActionError('재전송할 수 없습니다. 상대 연결과 재전송 가능 시간을 확인해 주세요.');
        }}
        onRetryPeer={(peerId) => {
          sessionRef.current?.retryPeer(peerId);
        }}
        onSetHandRaised={(raised) => {
          sessionRef.current?.setHandRaised(raised);
        }}
        onToggleScreenShare={() => {
          const session = sessionRef.current;
          if (session === null) {
            return;
          }
          setActionWarning('');
          setActionError('');
          const wasSharing = snapshot?.screenSharing === true;
          if (wasSharing) {
            void session.stopScreenShare().catch(() => {
              if (sessionRef.current === session) {
                setActionWarning('');
                setActionError('화면 공유를 중지하지 못했습니다. 잠시 후 다시 시도해 주세요.');
              }
            });
            return;
          }
          void session
            .startScreenShare()
            .then((result) => {
              if (sessionRef.current !== session) {
                return;
              }
              const notice = screenShareStartNotice(result);
              if (notice?.tone === 'warning') {
                setActionError('');
                setActionWarning(notice.message);
              } else if (notice?.tone === 'error') {
                setActionWarning('');
                setActionError(notice.message);
              }
            })
            .catch(() => {
              if (sessionRef.current === session) {
                setActionWarning('');
                setActionError('화면 공유를 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.');
              }
            });
        }}
        onDisableParticipantAudio={(peerId) => {
          if (!sessionRef.current?.disableParticipantMedia(peerId, 'audio')) {
            setActionWarning('');
            setActionError('이 참가자의 마이크를 끌 수 없습니다.');
          }
        }}
        onDisableParticipantVideo={(peerId) => {
          if (!sessionRef.current?.disableParticipantMedia(peerId, 'video')) {
            setActionWarning('');
            setActionError('이 참가자의 비디오를 끌 수 없습니다.');
          }
        }}
        onSendMessage={handleSendMessage}
        onCollectConnectionDiagnostics={async (): Promise<RoomConnectionDiagnostics> => {
          const session = sessionRef.current;
          if (session === null) {
            throw new Error('Room session is unavailable');
          }
          return session.collectConnectionDiagnostics();
        }}
        onSelectDevices={() => setDeviceSettingsOpen(true)}
        onReconnect={onReconnect}
        onLeave={handleLeave}
      />
      {deviceSettingsOpen ? (
        <MediaDeviceDialog
          screenShareQuality={snapshot?.screenShareQuality}
          onSelectScreenShareQuality={(mode) =>
            sessionRef.current?.setScreenShareQuality(mode) ?? false
          }
          videoQualityMode={snapshot?.videoQualityMode ?? 'standard'}
          onSelectVideoQuality={async (mode) =>
            sessionRef.current?.setVideoQualityMode(mode) ?? false
          }
          outputDeviceId={outputDeviceId}
          onSelectOutput={(deviceId) => {
            setAudioOutput({ deviceId });
            setOutputWarning('');
          }}
          audioDeviceId={localAudioTrack?.getSettings().deviceId ?? ''}
          audioTrack={localAudioTrack}
          audioEnabled={localMedia.audioEnabled}
          videoDeviceId={
            subscribedSession?.getLocalStream()?.getVideoTracks()[0]?.getSettings().deviceId ?? ''
          }
          screenSharing={snapshot?.screenSharing ?? false}
          active={status === 'active'}
          onSelect={async (kind, deviceId) => {
            const session = sessionRef.current;
            const lifecycle = lifecycleRef.current;
            if (session === null) return false;
            await ensureFreshParticipationGrantRef.current();
            if (sessionRef.current !== session || lifecycleRef.current !== lifecycle) return false;
            return session.selectInputDevice(kind, deviceId);
          }}
          onClose={() => setDeviceSettingsOpen(false)}
        />
      ) : null}
    </>
  );
}
