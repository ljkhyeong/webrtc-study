import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createRoomSession,
  type RoomSession,
  type RoomSessionSnapshot,
  type RoomSessionStatus,
} from '@round/rtc-core';
import { LandingScreen } from './components/LandingScreen';
import { RoomView, type ChatMessageView } from './components/RoomView';
import type { ParticipantView } from './components/VideoTile';
import { pathForRoom, roomIdFromPath, sanitizeDisplayName } from './lib/room';

const DISPLAY_NAME_STORAGE_KEY = 'round:display-name';

const statusLabels: Record<RoomSessionStatus, string> = {
  idle: '방 준비 중',
  'preparing-media': '카메라와 마이크 확인 중',
  'connecting-signal': '서버에 연결 중',
  joining: '스터디룸 입장 중',
  active: '직접 연결됨',
  ended: '통화 종료됨',
  error: '연결 오류',
};

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

function rtcConfiguration(): RTCConfiguration {
  const stunUrls = (
    import.meta.env.VITE_STUN_URLS ?? 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302'
  )
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
  const iceServers: RTCIceServer[] = stunUrls.length > 0 ? [{ urls: stunUrls }] : [];

  const turnUrl = import.meta.env.VITE_TURN_URL?.trim();
  const turnUsername = import.meta.env.VITE_TURN_USERNAME?.trim();
  const turnCredential = import.meta.env.VITE_TURN_CREDENTIAL?.trim();
  if (turnUrl && turnUsername && turnCredential) {
    iceServers.push({
      urls: turnUrl,
      username: turnUsername,
      credential: turnCredential,
    });
  }

  return {
    iceServers,
    iceCandidatePoolSize: 4,
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
  onLeave: () => void;
}

function ActiveRoom({ displayName, roomId, onLeave }: ActiveRoomProps) {
  const sessionRef = useRef<RoomSession | null>(null);
  const [snapshot, setSnapshot] = useState<RoomSessionSnapshot | null>(null);
  const [actionError, setActionError] = useState('');

  useEffect(() => {
    let isCurrentSession = true;
    const session = createRoomSession({
      roomId,
      displayName,
      signalingUrl: signalingUrl(),
      rtcConfiguration: rtcConfiguration(),
      mediaConstraints: {
        audio: {
          autoGainControl: true,
          echoCancellation: true,
          noiseSuppression: true,
        },
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: 'user',
        },
      },
      maxChatMessages: 200,
    });

    sessionRef.current = session;
    setActionError('');
    setSnapshot(session.getSnapshot());
    const unsubscribe = session.subscribe(setSnapshot);

    void session.join().catch((error: unknown) => {
      if (isCurrentSession && sessionRef.current === session) {
        setActionError(error instanceof Error ? error.message : '스터디룸 연결에 실패했습니다.');
      }
    });

    return () => {
      isCurrentSession = false;
      unsubscribe();
      if (sessionRef.current === session) {
        sessionRef.current = null;
      }
      void session.leave();
    };
  }, [displayName, roomId]);

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

  const handleSendMessage = (text: string) => {
    try {
      sessionRef.current?.sendChat(text);
      setActionError('');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '메시지를 보내지 못했습니다.');
    }
  };

  const status = snapshot?.status ?? 'idle';
  const localMedia = snapshot?.localMedia ?? {
    audioAvailable: false,
    audioEnabled: false,
    videoAvailable: false,
    videoEnabled: false,
  };

  return (
    <RoomView
      roomId={roomId}
      status={status}
      statusLabel={statusLabels[status]}
      participants={participants}
      messages={messages}
      audioEnabled={localMedia.audioEnabled}
      videoEnabled={localMedia.videoEnabled}
      mediaWarning={snapshot?.warning?.message}
      errorMessage={(snapshot?.error?.message ?? actionError) || undefined}
      onToggleAudio={() => {
        sessionRef.current?.toggleAudio();
      }}
      onToggleVideo={() => {
        sessionRef.current?.toggleVideo();
      }}
      onSendMessage={handleSendMessage}
      onLeave={handleLeave}
    />
  );
}

export function App() {
  const { pathname, navigate } = usePathname();
  const roomId = roomIdFromPath(pathname);
  const [displayName, setDisplayName] = useState(readStoredDisplayName);
  const [approvedRoomKey, setApprovedRoomKey] = useState<string | null>(null);

  const goHome = () => {
    setApprovedRoomKey(null);
    navigate('/');
  };

  const enterRoom = (nextDisplayName: string, nextRoomId: string) => {
    storeDisplayName(nextDisplayName);
    setDisplayName(nextDisplayName);
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

  return (
    <ActiveRoom
      key={`${roomId}:${displayName}`}
      displayName={displayName}
      roomId={roomId}
      onLeave={goHome}
    />
  );
}
