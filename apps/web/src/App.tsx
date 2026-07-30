import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SignalingErrorCode } from '@round/protocol';
import {
  createRoomSession,
  type RoomIssue,
  type RoomSession,
  type RoomSessionSnapshot,
  type RoomSessionStatus,
} from '@round/rtc-core';
import { LandingScreen } from './components/LandingScreen';
import { PrejoinScreen } from './components/PrejoinScreen';
import { RoomView, type ChatMessageView } from './components/RoomView';
import type { ParticipantView } from './components/VideoTile';
import {
  createWithPreparedMedia,
  stopMediaStreamTracks,
  withPreparedMediaFailureCleanup,
} from './lib/prepared-media';
import { ParticipationGrantLeaseManager } from './lib/participation-grant';
import { pathForRoom, roomIdFromPath, sanitizeDisplayName } from './lib/room';
import { resolveRoomEndpoints, type RoomEndpoints } from './lib/room-endpoints';
import { loadTurnCredentials, turnCredentialRefreshDelayMs } from './lib/turn';

const DISPLAY_NAME_STORAGE_KEY = 'round:display-name';
const PEER_CONNECTION_FAILURE_MESSAGE =
  '일부 참가자와 직접 연결하지 못했습니다. 현재 연결은 유지됩니다. 모두 다시 연결하려면 방에 다시 입장해 주세요.';

const SIGNALING_ISSUE_MESSAGES = {
  INVALID_MESSAGE: {
    error: '스터디 서버와 메시지 형식이 맞지 않습니다. 페이지를 새로고침한 뒤 다시 입장해 주세요.',
    warning: '스터디 서버와 메시지 형식이 맞지 않습니다. 페이지를 새로고침해 주세요.',
  },
  ALREADY_JOINED: {
    error: '서버의 방 입장 상태가 일치하지 않습니다. 방에 다시 입장해 주세요.',
    warning: '서버의 방 입장 상태가 일치하지 않습니다. 방에 다시 입장해 주세요.',
  },
  ROOM_FULL: {
    error: '이 스터디룸은 최대 6명까지 입장할 수 있습니다.',
    warning: '이 스터디룸은 최대 6명까지 입장할 수 있습니다.',
  },
  NOT_IN_ROOM: {
    error: '서버가 이 브라우저의 방 입장 상태를 확인하지 못했습니다. 다시 연결해 주세요.',
    warning: '서버의 방 연결 상태가 어긋나 연결을 다시 설정합니다.',
  },
  ROOM_MISMATCH: {
    error: '초대받은 방과 서버의 방 정보가 일치하지 않습니다. 새 초대 링크를 받아 주세요.',
    warning: '방 연결 정보가 일치하지 않아 연결을 다시 설정합니다.',
  },
  TARGET_NOT_FOUND: {
    error: '연결하려던 참가자가 이미 퇴장했습니다. 방에 다시 입장해 주세요.',
    warning: '연결하려던 참가자가 이미 퇴장했습니다. 현재 통화는 유지됩니다.',
  },
  TARGET_SELF: {
    error: '참가자 연결 정보가 올바르지 않습니다. 방에 다시 입장해 주세요.',
    warning: '올바르지 않은 참가자 연결 요청을 감지했습니다. 방에 다시 입장해 주세요.',
  },
  INTERNAL_ERROR: {
    error: '스터디 서버가 요청을 처리하지 못했습니다. 잠시 후 다시 연결해 주세요.',
    warning: '스터디 서버가 요청 하나를 처리하지 못했습니다. 현재 통화는 유지됩니다.',
  },
} satisfies Record<SignalingErrorCode, Readonly<Record<'error' | 'warning', string>>>;

function signalingIssueMessage(code: string, severity: 'error' | 'warning'): string | undefined {
  if (!Object.hasOwn(SIGNALING_ISSUE_MESSAGES, code)) {
    return undefined;
  }
  return SIGNALING_ISSUE_MESSAGES[code as SignalingErrorCode][severity];
}

function isTerminalPeerWarning(issue: RoomIssue | null | undefined): boolean {
  return issue?.code === 'peer-connection-timeout' || issue?.code === 'peer-negotiation-failed';
}

const statusLabels: Record<RoomSessionStatus, string> = {
  idle: '방 준비 중',
  'preparing-media': '카메라와 마이크 확인 중',
  'connecting-signal': '서버에 연결 중',
  joining: '스터디룸 입장 중',
  active: '직접 연결됨',
  reconnecting: '연결 복구 중',
  ended: '통화 종료됨',
  error: '연결 오류',
};

export function roomErrorMessage(issue: RoomIssue | null | undefined): string | undefined {
  if (!issue) {
    return undefined;
  }

  const signalingMessage = signalingIssueMessage(issue.code, 'error');
  if (signalingMessage !== undefined) {
    return signalingMessage;
  }

  switch (issue.code) {
    case 'room-join-timeout':
      return '서버가 입장 요청에 응답하지 않았습니다. 네트워크를 확인해 주세요.';
    case 'signaling-connect-timeout':
      return '스터디 서버에 연결할 수 없습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.';
    case 'signaling-connect-failed':
    case 'signaling-closed':
    case 'reconnect-exhausted':
      return '서버와의 연결을 복구하지 못했습니다. 네트워크를 확인한 뒤 다시 연결해 주세요.';
    default:
      return issue.message;
  }
}

export function roomWarningMessage(issue: RoomIssue | null | undefined): string | undefined {
  if (!issue) {
    return undefined;
  }

  const signalingMessage = signalingIssueMessage(issue.code, 'warning');
  if (signalingMessage !== undefined) {
    return signalingMessage;
  }

  switch (issue.code) {
    case 'signaling-reconnecting':
      return '스터디 서버에 다시 연결하는 중입니다. 카메라와 마이크는 유지되지만 참가자 연결은 다시 설정됩니다.';
    case 'rtc-configuration-update-failed':
      return '일부 참가자의 TURN 연결 정보를 갱신하지 못했습니다. 현재 통화는 유지됩니다.';
    case 'data-channel-rate-limit':
      return '한 참가자의 채팅 연결에서 너무 많은 데이터가 전송되어 일부 업데이트를 잠시 무시했습니다. 통화는 유지됩니다.';
    case 'local-media-ended':
      return '마이크 또는 카메라 연결이 종료되었습니다. 현재 통화는 유지됩니다. 다시 사용하려면 방에 다시 입장해 장치를 확인해 주세요.';
    case 'peer-connection-timeout':
    case 'peer-negotiation-failed':
      return PEER_CONNECTION_FAILURE_MESSAGE;
    default:
      return issue.message;
  }
}

function chatErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message.startsWith('Chat delivery to ')) {
    return '연결 가능한 참가자가 없어 메시지를 보내지 못했습니다. 입력한 내용은 그대로 두었습니다.';
  }
  if (message.startsWith('Chat delivery queue for ')) {
    return '메시지 전송 대기열이 가득 찼습니다. 잠시 후 다시 시도해 주세요.';
  }
  return message || '메시지를 보내지 못했습니다.';
}

export function roomStatusLabel(
  status: RoomSessionStatus,
  participants: readonly ParticipantView[],
): string {
  if (status !== 'active') {
    return statusLabels[status];
  }

  const remoteParticipants = participants.filter((participant) => !participant.isLocal);
  if (remoteParticipants.length === 0) {
    return '입장 완료 · 대기 중';
  }
  if (remoteParticipants.some((participant) => participant.connectionState === 'failed')) {
    return '일부 참가자 연결 실패';
  }
  if (remoteParticipants.every((participant) => participant.connectionState === 'connected')) {
    return '통화 연결됨';
  }
  return '참가자 연결 중';
}

function readStoredDisplayName() {
  try {
    return sanitizeDisplayName(localStorage.getItem(DISPLAY_NAME_STORAGE_KEY) ?? '');
  } catch {
    return '';
  }
}

function storeDisplayName(displayName: string) {
  try {
    localStorage.setItem(DISPLAY_NAME_STORAGE_KEY, displayName);
  } catch {
    // Storage can be unavailable in strict privacy modes; the room still works.
  }
}

interface LoadedRtcConfiguration {
  readonly configuration: RTCConfiguration;
  readonly turnExpiresAt: number | null;
}

async function loadRtcConfiguration(turnCredentialsUrl: string): Promise<LoadedRtcConfiguration> {
  const stunUrls = (
    import.meta.env.VITE_STUN_URLS ?? 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302'
  )
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
  const iceServers: RTCIceServer[] = stunUrls.length > 0 ? [{ urls: stunUrls }] : [];

  let credentials;
  try {
    credentials = await loadTurnCredentials({ endpoint: turnCredentialsUrl });
  } catch (error) {
    throw new Error('TURN 서버 정보를 받지 못했습니다. 잠시 후 다시 시도해 주세요.', {
      cause: error,
    });
  }
  if (credentials !== null) {
    iceServers.push(credentials.iceServer);
  }

  const configuredPolicy = import.meta.env.VITE_ICE_TRANSPORT_POLICY?.trim() || 'all';
  if (configuredPolicy !== 'all' && configuredPolicy !== 'relay') {
    throw new Error('ICE 전송 정책 설정이 올바르지 않습니다.');
  }

  const localDevelopment = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
  if (credentials === null && (!localDevelopment || configuredPolicy === 'relay')) {
    throw new Error('TURN 서버 정보를 받지 못했습니다. 잠시 후 다시 시도해 주세요.');
  }

  return {
    configuration: {
      iceServers,
      iceCandidatePoolSize: 1,
      iceTransportPolicy: configuredPolicy,
    },
    turnExpiresAt: credentials?.expiresAt ?? null,
  };
}

function usePathname() {
  const [pathname, setPathname] = useState(window.location.pathname);

  useEffect(() => {
    const handlePopState = () => setPathname(window.location.pathname);
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const navigate = (path: string, replace = false) => {
    if (replace) {
      window.history.replaceState(null, '', path);
    } else {
      window.history.pushState(null, '', path);
    }
    setPathname(path);
  };

  return { pathname, navigate };
}

interface ActiveRoomProps {
  displayName: string;
  roomId: string;
  releasePreparedMediaStream: () => void;
  takePreparedMediaStream: () => MediaStream | null;
  onReconnect: () => void;
  onLeave: () => void;
}

function ActiveRoom({
  displayName,
  roomId,
  releasePreparedMediaStream,
  takePreparedMediaStream,
  onReconnect,
  onLeave,
}: ActiveRoomProps) {
  const sessionRef = useRef<RoomSession | null>(null);
  const lifecycleRef = useRef(0);
  const [snapshot, setSnapshot] = useState<RoomSessionSnapshot | null>(null);
  const [actionError, setActionError] = useState('');
  const [participationGrantRefreshWarning, setParticipationGrantRefreshWarning] = useState('');
  const [turnRefreshWarning, setTurnRefreshWarning] = useState('');

  useEffect(() => {
    const lifecycle = ++lifecycleRef.current;
    let isCurrentSession = true;
    let unsubscribe = () => {};
    let participationGrantRefreshTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
    let turnRefreshTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
    let endpoints: RoomEndpoints | null = null;
    let participationGrantLeaseManager: ParticipationGrantLeaseManager | null = null;

    const isCurrentLifecycle = () => isCurrentSession && lifecycleRef.current === lifecycle;

    const clearParticipationGrantRefreshTimer = () => {
      if (participationGrantRefreshTimer !== null) {
        globalThis.clearTimeout(participationGrantRefreshTimer);
        participationGrantRefreshTimer = null;
      }
    };

    const clearTurnRefreshTimer = () => {
      if (turnRefreshTimer !== null) {
        globalThis.clearTimeout(turnRefreshTimer);
        turnRefreshTimer = null;
      }
    };

    const scheduleParticipationGrantRefresh = () => {
      if (!isCurrentLifecycle()) {
        return;
      }
      const delayMs = participationGrantLeaseManager?.refreshDelayMs();
      if (delayMs === undefined || delayMs === null) {
        return;
      }
      clearParticipationGrantRefreshTimer();
      participationGrantRefreshTimer = globalThis.setTimeout(() => {
        void refreshParticipationGrant();
      }, delayMs);
    };

    const scheduleParticipationGrantRefreshRetry = () => {
      if (!isCurrentLifecycle()) {
        return;
      }
      clearParticipationGrantRefreshTimer();
      participationGrantRefreshTimer = globalThis.setTimeout(() => {
        void refreshParticipationGrant();
      }, 30_000);
    };

    const ensureFreshParticipationGrant = async () => {
      const manager = participationGrantLeaseManager;
      if (manager === null) {
        return;
      }

      try {
        await manager.ensureFresh();
      } catch (error) {
        if (isCurrentLifecycle()) {
          setParticipationGrantRefreshWarning(
            '스터디 참여 권한을 갱신하지 못했습니다. 현재 통화는 유지하며 곧 다시 시도합니다.',
          );
          scheduleParticipationGrantRefreshRetry();
        }
        throw error;
      }

      if (!isCurrentLifecycle()) {
        return;
      }
      setParticipationGrantRefreshWarning('');
      scheduleParticipationGrantRefresh();
    };

    const refreshParticipationGrant = async () => {
      try {
        await ensureFreshParticipationGrant();
      } catch {
        // The shared helper exposes a bounded user warning and schedules a retry.
      }
    };

    const scheduleTurnRefresh = (expiresAt: number) => {
      if (!isCurrentLifecycle()) {
        return;
      }
      clearTurnRefreshTimer();
      turnRefreshTimer = globalThis.setTimeout(() => {
        void refreshTurnConfiguration();
      }, turnCredentialRefreshDelayMs(expiresAt));
    };

    const scheduleTurnRefreshRetry = () => {
      if (!isCurrentLifecycle()) {
        return;
      }
      clearTurnRefreshTimer();
      turnRefreshTimer = globalThis.setTimeout(() => {
        void refreshTurnConfiguration();
      }, 30_000);
    };

    const refreshTurnConfiguration = async () => {
      const turnCredentialsUrl = endpoints?.turnCredentialsUrl;
      if (turnCredentialsUrl === undefined) {
        return;
      }

      try {
        await ensureFreshParticipationGrant();
      } catch {
        scheduleTurnRefreshRetry();
        return;
      }

      try {
        const loaded = await loadRtcConfiguration(turnCredentialsUrl);
        if (!isCurrentLifecycle()) {
          return;
        }

        sessionRef.current?.updateRtcConfiguration(loaded.configuration, {
          restartIce: true,
        });
        setTurnRefreshWarning('');
        if (loaded.turnExpiresAt !== null) {
          scheduleTurnRefresh(loaded.turnExpiresAt);
        }
      } catch {
        if (!isCurrentLifecycle()) {
          return;
        }
        setTurnRefreshWarning(
          'TURN 연결 정보를 갱신하지 못했습니다. 현재 통화는 유지하며 곧 다시 시도합니다.',
        );
        scheduleTurnRefreshRetry();
      }
    };

    const startSession = async () => {
      try {
        await withPreparedMediaFailureCleanup(
          async () => {
            const resolvedEndpoints = resolveRoomEndpoints({
              roomId,
              authMode: import.meta.env.VITE_ROUND_AUTH_MODE,
              location: window.location,
              signalingUrl: import.meta.env.VITE_SIGNALING_URL,
              turnCredentialsUrl: import.meta.env.VITE_TURN_CREDENTIALS_URL,
            });
            endpoints = resolvedEndpoints;

            if (resolvedEndpoints.participationGrantRefreshUrl !== null) {
              try {
                participationGrantLeaseManager = new ParticipationGrantLeaseManager({
                  endpoint: resolvedEndpoints.participationGrantRefreshUrl,
                });
                await ensureFreshParticipationGrant();
              } catch (error) {
                throw new Error(
                  '스터디 참여 권한을 확인하지 못했습니다. 잠시 후 다시 시도하거나 BATON에서 다시 입장해 주세요.',
                  { cause: error },
                );
              }
            }

            const loaded = await loadRtcConfiguration(resolvedEndpoints.turnCredentialsUrl);
            if (!isCurrentLifecycle()) {
              return;
            }

            let session = sessionRef.current;
            if (session === null) {
              session = createWithPreparedMedia(takePreparedMediaStream, (preparedMediaStream) =>
                createRoomSession({
                  roomId,
                  displayName,
                  signalingUrl: resolvedEndpoints.signalingUrl,
                  rtcConfiguration: loaded.configuration,
                  preparedMediaStream,
                  ...(participationGrantLeaseManager === null
                    ? {}
                    : { beforeSignalingConnect: ensureFreshParticipationGrant }),
                  mediaConstraints: {
                    audio: {
                      autoGainControl: true,
                      echoCancellation: true,
                      noiseSuppression: true,
                    },
                    video: {
                      width: { ideal: 640 },
                      height: { ideal: 360 },
                      frameRate: { ideal: 15, max: 15 },
                      facingMode: 'user',
                    },
                  },
                  maxChatMessages: 200,
                }),
              );
              sessionRef.current = session;
            }

            setActionError('');
            setSnapshot(session.getSnapshot());
            unsubscribe = session.subscribe(setSnapshot);

            await session.join();
            if (loaded.turnExpiresAt !== null) {
              scheduleTurnRefresh(loaded.turnExpiresAt);
            }
          },
          {
            hasSession: () => sessionRef.current !== null,
            isCurrent: () => isCurrentSession && lifecycleRef.current === lifecycle,
            release: releasePreparedMediaStream,
          },
        );
      } catch (error) {
        clearParticipationGrantRefreshTimer();
        clearTurnRefreshTimer();
        if (isCurrentSession) {
          setActionError(error instanceof Error ? error.message : '스터디룸 연결에 실패했습니다.');
        }
      }
    };

    setActionError('');
    setParticipationGrantRefreshWarning('');
    setTurnRefreshWarning('');
    void startSession();

    return () => {
      isCurrentSession = false;
      unsubscribe();
      clearParticipationGrantRefreshTimer();
      clearTurnRefreshTimer();
      // React StrictMode immediately re-runs effects in development. Deferring
      // disposal lets the second setup reuse the single-use session and the
      // transferred pre-join tracks instead of stopping them between setups.
      queueMicrotask(() => {
        const session = sessionRef.current;
        if (lifecycleRef.current !== lifecycle || session === null) {
          return;
        }
        sessionRef.current = null;
        void session.leave();
      });
    };
  }, [displayName, releasePreparedMediaStream, roomId, takePreparedMediaStream]);

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

  const messages = useMemo<ChatMessageView[]>(
    () =>
      snapshot?.messages.map((message) => ({
        id: message.id,
        senderId: message.senderId,
        senderName: message.senderName,
        text: message.text,
        sentAt: message.sentAt,
        isLocal: message.isLocal,
        deliveryState: message.deliveryState,
      })) ?? [],
    [snapshot?.messages],
  );

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
      setActionError('');
      return true;
    } catch (error) {
      setActionError(chatErrorMessage(error));
      return false;
    }
  };

  const status = snapshot?.status ?? 'idle';
  const localMedia = snapshot?.localMedia ?? {
    audioAvailable: false,
    audioEnabled: false,
    videoAvailable: false,
    videoEnabled: false,
  };
  const hasFailedRemotePeer = participants.some(
    (participant) => !participant.isLocal && participant.connectionState === 'failed',
  );

  return (
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
      peerRecoveryMessage={hasFailedRemotePeer ? PEER_CONNECTION_FAILURE_MESSAGE : undefined}
      mediaWarning={
        isTerminalPeerWarning(snapshot?.warning) ? undefined : roomWarningMessage(snapshot?.warning)
      }
      errorMessage={
        roomErrorMessage(snapshot?.error) ||
        actionError ||
        participationGrantRefreshWarning ||
        turnRefreshWarning ||
        undefined
      }
      onToggleAudio={() => {
        sessionRef.current?.toggleAudio();
      }}
      onToggleVideo={() => {
        sessionRef.current?.toggleVideo();
      }}
      onSendMessage={handleSendMessage}
      onReconnect={onReconnect}
      onLeave={handleLeave}
    />
  );
}

export function App() {
  const { pathname, navigate } = usePathname();
  const roomId = roomIdFromPath(pathname);
  const [displayName, setDisplayName] = useState(readStoredDisplayName);
  const [approvedRoomKey, setApprovedRoomKey] = useState<string | null>(null);
  const [activeRoomKey, setActiveRoomKey] = useState<string | null>(null);
  const preparedMediaStreamRef = useRef<MediaStream | null>(null);

  const stopUnclaimedPreparedMedia = useCallback(() => {
    const stream = preparedMediaStreamRef.current;
    preparedMediaStreamRef.current = null;
    stopMediaStreamTracks(stream);
  }, []);

  const takePreparedMediaStream = useCallback(() => {
    const stream = preparedMediaStreamRef.current;
    preparedMediaStreamRef.current = null;
    return stream;
  }, []);

  useEffect(() => {
    if (approvedRoomKey === null) {
      return;
    }

    const currentRoomKey =
      roomId === null || displayName.length === 0 ? null : `${roomId}:${displayName}`;
    if (currentRoomKey === approvedRoomKey) {
      return;
    }

    stopUnclaimedPreparedMedia();
    setActiveRoomKey(null);
    setApprovedRoomKey(null);
  }, [approvedRoomKey, displayName, roomId, stopUnclaimedPreparedMedia]);

  const goHome = () => {
    stopUnclaimedPreparedMedia();
    setActiveRoomKey(null);
    setApprovedRoomKey(null);
    navigate('/');
  };

  const retryCurrentRoom = () => {
    stopUnclaimedPreparedMedia();
    setActiveRoomKey(null);
  };

  const enterRoom = (nextDisplayName: string, nextRoomId: string) => {
    storeDisplayName(nextDisplayName);
    setDisplayName(nextDisplayName);
    stopUnclaimedPreparedMedia();
    setActiveRoomKey(null);
    setApprovedRoomKey(`${nextRoomId}:${nextDisplayName}`);
    const nextPath = pathForRoom(nextRoomId);
    if (nextPath !== pathname) {
      navigate(nextPath);
    }
  };

  if (!roomId) {
    return <LandingScreen initialDisplayName={displayName} onEnter={enterRoom} onGoHome={goHome} />;
  }

  if (!displayName || approvedRoomKey !== `${roomId}:${displayName}`) {
    return (
      <LandingScreen
        initialDisplayName={displayName}
        invitedRoomId={roomId}
        onEnter={enterRoom}
        onGoHome={goHome}
      />
    );
  }

  const roomKey = `${roomId}:${displayName}`;
  if (activeRoomKey !== roomKey) {
    return (
      <PrejoinScreen
        key={roomKey}
        displayName={displayName}
        roomId={roomId}
        onBack={goHome}
        onJoin={(preparedMediaStream) => {
          stopUnclaimedPreparedMedia();
          preparedMediaStreamRef.current = preparedMediaStream;
          setActiveRoomKey(roomKey);
        }}
      />
    );
  }

  return (
    <ActiveRoom
      key={roomKey}
      displayName={displayName}
      roomId={roomId}
      releasePreparedMediaStream={stopUnclaimedPreparedMedia}
      takePreparedMediaStream={takePreparedMediaStream}
      onReconnect={retryCurrentRoom}
      onLeave={goHome}
    />
  );
}
