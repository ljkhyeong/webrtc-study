import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { pathForRoom, roomIdFromPath, sanitizeDisplayName } from './lib/room';
import { loadTurnCredentials, turnCredentialRefreshDelayMs } from './lib/turn';

const DISPLAY_NAME_STORAGE_KEY = 'round:display-name';
const PEER_CONNECTION_FAILURE_MESSAGE =
  '일부 참가자와 직접 연결하지 못했습니다. 현재 연결은 유지됩니다. 모두 다시 연결하려면 방에 다시 입장해 주세요.';

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

function roomErrorMessage(issue: RoomIssue | null | undefined): string | undefined {
  if (!issue) {
    return undefined;
  }

  switch (issue.code) {
    case 'ROOM_FULL':
      return '이 스터디룸은 최대 6명까지 입장할 수 있습니다.';
    case 'INVALID_MESSAGE':
      return '초대 정보가 올바르지 않습니다. 새 초대 링크를 받아 주세요.';
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
  switch (issue.code) {
    case 'signaling-reconnecting':
      return '스터디 서버에 다시 연결하는 중입니다. 카메라와 마이크는 유지되지만 참가자 연결은 다시 설정됩니다.';
    case 'rtc-configuration-update-failed':
      return '일부 참가자의 TURN 연결 정보를 갱신하지 못했습니다. 현재 통화는 유지됩니다.';
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

function signalingUrl() {
  const configuredUrl = import.meta.env.VITE_SIGNALING_URL?.trim();
  if (configuredUrl) {
    if (configuredUrl.startsWith('https://')) {
      return configuredUrl.replace(/^https:/, 'wss:');
    }
    if (configuredUrl.startsWith('http://')) {
      return configuredUrl.replace(/^http:/, 'ws:');
    }
    return configuredUrl;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/signal`;
}

interface LoadedRtcConfiguration {
  readonly configuration: RTCConfiguration;
  readonly turnExpiresAt: number | null;
}

async function loadRtcConfiguration(): Promise<LoadedRtcConfiguration> {
  const stunUrls = (
    import.meta.env.VITE_STUN_URLS ?? 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302'
  )
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
  const iceServers: RTCIceServer[] = stunUrls.length > 0 ? [{ urls: stunUrls }] : [];

  const credentialsEndpoint = import.meta.env.VITE_TURN_CREDENTIALS_URL?.trim();
  let credentials;
  try {
    credentials = await loadTurnCredentials(
      credentialsEndpoint ? { endpoint: credentialsEndpoint } : {},
    );
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
  takePreparedMediaStream: () => MediaStream | null;
  onReconnect: () => void;
  onLeave: () => void;
}

function ActiveRoom({
  displayName,
  roomId,
  takePreparedMediaStream,
  onReconnect,
  onLeave,
}: ActiveRoomProps) {
  const sessionRef = useRef<RoomSession | null>(null);
  const lifecycleRef = useRef(0);
  const [snapshot, setSnapshot] = useState<RoomSessionSnapshot | null>(null);
  const [actionError, setActionError] = useState('');
  const [turnRefreshWarning, setTurnRefreshWarning] = useState('');

  useEffect(() => {
    const lifecycle = ++lifecycleRef.current;
    let isCurrentSession = true;
    let unsubscribe = () => {};
    let turnRefreshTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

    const scheduleTurnRefresh = (expiresAt: number) => {
      if (!isCurrentSession || lifecycleRef.current !== lifecycle) {
        return;
      }
      if (turnRefreshTimer !== null) {
        globalThis.clearTimeout(turnRefreshTimer);
      }
      turnRefreshTimer = globalThis.setTimeout(() => {
        void refreshTurnConfiguration();
      }, turnCredentialRefreshDelayMs(expiresAt));
    };

    const scheduleTurnRefreshRetry = () => {
      if (!isCurrentSession || lifecycleRef.current !== lifecycle) {
        return;
      }
      if (turnRefreshTimer !== null) {
        globalThis.clearTimeout(turnRefreshTimer);
      }
      turnRefreshTimer = globalThis.setTimeout(() => {
        void refreshTurnConfiguration();
      }, 30_000);
    };

    const refreshTurnConfiguration = async () => {
      try {
        const loaded = await loadRtcConfiguration();
        if (!isCurrentSession || lifecycleRef.current !== lifecycle) {
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
        if (!isCurrentSession || lifecycleRef.current !== lifecycle) {
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
        const loaded = await loadRtcConfiguration();
        if (!isCurrentSession || lifecycleRef.current !== lifecycle) {
          return;
        }

        let session = sessionRef.current;
        if (session === null) {
          session = createRoomSession({
            roomId,
            displayName,
            signalingUrl: signalingUrl(),
            rtcConfiguration: loaded.configuration,
            preparedMediaStream: takePreparedMediaStream(),
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
          });
          sessionRef.current = session;
        }

        setActionError('');
        setSnapshot(session.getSnapshot());
        unsubscribe = session.subscribe(setSnapshot);

        await session.join();
        if (loaded.turnExpiresAt !== null) {
          scheduleTurnRefresh(loaded.turnExpiresAt);
        }
      } catch (error) {
        if (isCurrentSession) {
          setActionError(error instanceof Error ? error.message : '스터디룸 연결에 실패했습니다.');
        }
      }
    };

    setActionError('');
    void startSession();

    return () => {
      isCurrentSession = false;
      unsubscribe();
      if (turnRefreshTimer !== null) {
        globalThis.clearTimeout(turnRefreshTimer);
      }
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
  }, [displayName, roomId, takePreparedMediaStream]);

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
      audioEnabled={localMedia.audioEnabled}
      videoEnabled={localMedia.videoEnabled}
      peerRecoveryMessage={hasFailedRemotePeer ? PEER_CONNECTION_FAILURE_MESSAGE : undefined}
      mediaWarning={
        isTerminalPeerWarning(snapshot?.warning) ? undefined : roomWarningMessage(snapshot?.warning)
      }
      errorMessage={
        roomErrorMessage(snapshot?.error) || actionError || turnRefreshWarning || undefined
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
    for (const track of preparedMediaStreamRef.current?.getTracks() ?? []) {
      track.stop();
    }
    preparedMediaStreamRef.current = null;
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
      takePreparedMediaStream={takePreparedMediaStream}
      onReconnect={retryCurrentRoom}
      onLeave={goHome}
    />
  );
}
