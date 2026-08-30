import { useEffect, useMemo, useRef, useState } from 'react';
import {
  RoomSession,
  type RoomConnectionDiagnostics,
  type RoomSessionOptions,
  type RoomSessionSnapshot,
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
import { RoomRefreshLifetime } from '../lib/room-refresh-lifetime';
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
import { turnCredentialRefreshDelayMs } from '../lib/turn';

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
  const ensureFreshParticipationGrantRef = useRef<() => Promise<void>>(async () => {});
  const [snapshot, setSnapshot] = useState<RoomSessionSnapshot | null>(null);
  const [startupError, setStartupError] = useState<RoomStartupErrorCode | null>(null);
  const [actionWarning, setActionWarning] = useState('');
  const [actionError, setActionError] = useState('');
  const [participationGrantRefreshWarning, setParticipationGrantRefreshWarning] = useState('');
  const [turnRefreshWarning, setTurnRefreshWarning] = useState('');
  const [deviceSettingsOpen, setDeviceSettingsOpen] = useState(false);

  useEffect(() => {
    const lifecycle = ++lifecycleRef.current;
    let isCurrentSession = true;
    let unsubscribe = () => {};
    let endpoints: RoomEndpoints | null = null;
    let participationGrantLeaseManager = preflightParticipationGrantLeaseManager ?? null;
    let ownsParticipationGrantLeaseManager = participationGrantLeaseManager === null;
    const refreshLifetime = new RoomRefreshLifetime();
    const turnRequestController = new AbortController();

    const isCurrentLifecycle = () => isCurrentSession && lifecycleRef.current === lifecycle;
    const canRefresh = () => isCurrentLifecycle() && refreshLifetime.isActive();

    const stopBackgroundRefreshes = () => {
      refreshLifetime.stop();
      if (ownsParticipationGrantLeaseManager) {
        participationGrantLeaseManager?.close();
      }
      turnRequestController.abort();
    };

    const scheduleParticipationGrantRefresh = () => {
      if (!canRefresh()) {
        return;
      }
      const delayMs = participationGrantLeaseManager?.refreshDelayMs();
      if (delayMs === undefined || delayMs === null) {
        return;
      }
      refreshLifetime.schedule(
        'participation-grant',
        () => {
          void refreshParticipationGrant();
        },
        delayMs,
      );
    };

    const scheduleParticipationGrantRefreshRetry = () => {
      if (!canRefresh()) {
        return;
      }
      refreshLifetime.schedule(
        'participation-grant',
        () => {
          void refreshParticipationGrant();
        },
        30_000,
      );
    };

    const ensureFreshParticipationGrant = async () => {
      const manager = participationGrantLeaseManager;
      if (manager === null || !canRefresh()) {
        return;
      }

      try {
        await manager.ensureFresh();
      } catch (error) {
        if (error instanceof ParticipationGrantAccessError) {
          stopBackgroundRefreshes();
          setParticipationGrantRefreshWarning('');
          onParticipationGrantAccessFailure?.(error);
          throw error;
        }
        if (canRefresh()) {
          setParticipationGrantRefreshWarning(
            '스터디 참여 권한을 갱신하지 못했습니다. 현재 통화는 유지하며 곧 다시 시도합니다.',
          );
          scheduleParticipationGrantRefreshRetry();
        }
        throw error;
      }

      if (!canRefresh()) {
        return;
      }
      setParticipationGrantRefreshWarning('');
      scheduleParticipationGrantRefresh();
    };
    ensureFreshParticipationGrantRef.current = ensureFreshParticipationGrant;

    const refreshParticipationGrant = async () => {
      try {
        await ensureFreshParticipationGrant();
      } catch {
        // 공용 도우미가 제한된 사용자 경고를 반환하고 재시도를 예약한다.
      }
    };

    const scheduleTurnRefresh = (refreshDueAtMs: number) => {
      if (!canRefresh()) {
        return;
      }
      refreshLifetime.schedule(
        'turn',
        () => {
          void refreshTurnConfiguration();
        },
        turnCredentialRefreshDelayMs(refreshDueAtMs),
      );
    };

    const scheduleTurnRefreshRetry = () => {
      if (!canRefresh()) {
        return;
      }
      refreshLifetime.schedule(
        'turn',
        () => {
          void refreshTurnConfiguration();
        },
        30_000,
      );
    };

    const refreshTurnConfiguration = async () => {
      const turnCredentialsUrl = endpoints?.turnCredentialsUrl;
      if (turnCredentialsUrl === undefined || !canRefresh()) {
        return;
      }

      try {
        await ensureFreshParticipationGrant();
      } catch {
        if (canRefresh()) {
          scheduleTurnRefreshRetry();
        }
        return;
      }

      if (!canRefresh()) {
        return;
      }

      try {
        const loaded = await loadRtcConfiguration(turnCredentialsUrl, turnRequestController.signal);
        if (!canRefresh()) {
          return;
        }

        sessionRef.current?.updateRtcConfiguration(loaded.configuration, {
          restartIce: true,
        });
        setTurnRefreshWarning('');
        if (loaded.turnRefreshDueAtMs !== null) {
          scheduleTurnRefresh(loaded.turnRefreshDueAtMs);
        }
      } catch {
        if (!canRefresh()) {
          return;
        }
        setTurnRefreshWarning(
          'TURN 연결 정보를 갱신하지 못했습니다. 현재 통화는 유지하며 곧 다시 시도합니다.',
        );
        scheduleTurnRefreshRetry();
      }
    };

    const handleSessionSnapshot = (nextSnapshot: RoomSessionSnapshot) => {
      if (nextSnapshot.status === 'error' || nextSnapshot.status === 'ended') {
        stopBackgroundRefreshes();
      }
      setSnapshot(nextSnapshot);
    };

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
            endpoints = resolvedEndpoints;

            if (resolvedEndpoints.participationGrantRefreshUrl !== null) {
              try {
                if (participationGrantLeaseManager === null) {
                  participationGrantLeaseManager = new ParticipationGrantLeaseManager({
                    endpoint: resolvedEndpoints.participationGrantRefreshUrl,
                    roomId,
                  });
                  ownsParticipationGrantLeaseManager = true;
                }
                await ensureFreshParticipationGrant();
              } catch (error) {
                throw new RoomStartupFailure('participation-grant', error);
              }
            }

            let loaded: LoadedRtcConfiguration;
            try {
              loaded = await loadRtcConfiguration(
                resolvedEndpoints.turnCredentialsUrl,
                turnRequestController.signal,
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
                    ...(participationGrantLeaseManager === null
                      ? {}
                      : {
                          beforeSignalingConnect: () => ensureFreshParticipationGrantRef.current(),
                        }),
                    mediaConstraints: DEFAULT_MEDIA_CONSTRAINTS,
                  }),
              );
              sessionRef.current = session;
            }

            setActionWarning('');
            setActionError('');
            handleSessionSnapshot(session.getSnapshot());
            unsubscribe = session.subscribe(handleSessionSnapshot);

            await session.join();
            if (loaded.turnRefreshDueAtMs !== null) {
              scheduleTurnRefresh(loaded.turnRefreshDueAtMs);
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
      unsubscribe();
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

  const participants = useMemo<ParticipantView[]>(() => {
    const session = sessionRef.current;
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
  }, [snapshot]);

  const messages = snapshot?.messages ?? [];

  const handleLeave = () => {
    const session = sessionRef.current;
    sessionRef.current = null;
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

  return (
    <>
      <RoomView
        roomId={roomId}
        status={status}
        statusLabel={roomStatusLabel(status, participants)}
        participants={participants}
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
          audioDeviceId={
            sessionRef.current?.getLocalStream()?.getAudioTracks()[0]?.getSettings().deviceId ?? ''
          }
          videoDeviceId={
            sessionRef.current?.getLocalStream()?.getVideoTracks()[0]?.getSettings().deviceId ?? ''
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
