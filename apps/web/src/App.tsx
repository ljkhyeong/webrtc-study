import { useCallback, useEffect, useRef, useState } from 'react';
import type { RoomSessionOptions } from '@round/rtc-core';
import { ActiveRoom } from './components/ActiveRoom';
import { LandingScreen } from './components/LandingScreen';
import { PrejoinScreen } from './components/PrejoinScreen';
import {
  BatonRoomEntryBoundary,
  BatonRuntimeRoot,
  RoundRuntimeConfigurationError,
} from './components/BatonRoomEntryBoundary';
import { stopMediaStreamTracks } from './lib/prepared-media';
import {
  ParticipationGrantAccessError,
  ParticipationGrantLeaseManager,
} from './lib/participation-grant';
import { pathForRoom, roomIdFromPath, sanitizeDisplayName } from './lib/room';
import { resolveRoundAuthMode, type RoundAuthMode } from './lib/room-endpoints';

const DISPLAY_NAME_STORAGE_KEY = 'round:display-name';

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
    // 강한 개인정보 보호 설정에서 저장소를 사용할 수 없어도 방은 계속 동작한다.
  }
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

export function navigateToOwningHome(
  authMode: ImportMetaEnv['VITE_ROUND_AUTH_MODE'],
  navigate: (path: string) => void,
  navigateDocument: (path: string) => void = (path) => window.location.assign(path),
) {
  if (authMode === 'baton') {
    navigateDocument('/');
    return;
  }

  navigate('/');
}

export function App() {
  let authMode: RoundAuthMode;
  try {
    authMode = resolveRoundAuthMode(import.meta.env.VITE_ROUND_AUTH_MODE);
  } catch {
    return <RoundRuntimeConfigurationError />;
  }
  return <ConfiguredApp authMode={authMode} />;
}

function ConfiguredApp({ authMode }: { readonly authMode: RoundAuthMode }) {
  const { pathname, navigate } = usePathname();
  const roomId = roomIdFromPath(pathname);
  const [displayName, setDisplayName] = useState(() =>
    authMode === 'standalone' ? readStoredDisplayName() : '',
  );
  const [approvedRoomKey, setApprovedRoomKey] = useState<string | null>(null);
  const [activeRoomKey, setActiveRoomKey] = useState<string | null>(null);
  const [activeHostCapability, setActiveHostCapability] = useState<string | undefined>();
  const [initialInputEnabled, setInitialInputEnabled] =
    useState<RoomSessionOptions['initialInputEnabled']>();
  const [batonEntryGeneration, setBatonEntryGeneration] = useState(0);
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
    setActiveHostCapability(undefined);
    setApprovedRoomKey(null);
  }, [approvedRoomKey, displayName, roomId, stopUnclaimedPreparedMedia]);

  const goHome = () => {
    stopUnclaimedPreparedMedia();
    setActiveRoomKey(null);
    setActiveHostCapability(undefined);
    setApprovedRoomKey(null);
    navigateToOwningHome(authMode, navigate);
  };

  const retryCurrentRoom = () => {
    stopUnclaimedPreparedMedia();
    setActiveRoomKey(null);
    setActiveHostCapability(undefined);
    if (authMode === 'baton') {
      setBatonEntryGeneration((generation) => generation + 1);
    }
  };

  const enterRoom = (nextDisplayName: string, nextRoomId: string) => {
    if (authMode === 'standalone') {
      storeDisplayName(nextDisplayName);
    }
    setDisplayName(nextDisplayName);
    stopUnclaimedPreparedMedia();
    setActiveRoomKey(null);
    setApprovedRoomKey(`${nextRoomId}:${nextDisplayName}`);
    const nextPath = pathForRoom(nextRoomId);
    if (nextPath !== pathname) {
      navigate(nextPath);
    }
  };

  const renderRoomEntry = (
    participationGrantLeaseManager?: ParticipationGrantLeaseManager,
    authorizeBeforeEntryAction?: () => Promise<boolean>,
    onParticipationGrantAccessFailure?: (error: ParticipationGrantAccessError) => void,
  ) => {
    if (roomId === null) {
      return (
        <LandingScreen initialDisplayName={displayName} onEnter={enterRoom} onGoHome={goHome} />
      );
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
          showHostCapabilityInput={authMode !== 'baton'}
          authorizeBeforeEntryAction={authorizeBeforeEntryAction}
          onBack={goHome}
          onJoin={(preparedMediaStream, hostCapability, inputEnabled) => {
            stopUnclaimedPreparedMedia();
            preparedMediaStreamRef.current = preparedMediaStream;
            setActiveHostCapability(hostCapability);
            setInitialInputEnabled(inputEnabled);
            setActiveRoomKey(roomKey);
          }}
        />
      );
    }

    return (
      <ActiveRoom
        key={roomKey}
        authMode={authMode}
        displayName={displayName}
        roomId={roomId}
        hostCapability={activeHostCapability}
        initialInputEnabled={initialInputEnabled}
        participationGrantLeaseManager={participationGrantLeaseManager}
        onParticipationGrantAccessFailure={onParticipationGrantAccessFailure}
        releasePreparedMediaStream={stopUnclaimedPreparedMedia}
        takePreparedMediaStream={takePreparedMediaStream}
        onReconnect={retryCurrentRoom}
        onLeave={goHome}
      />
    );
  };

  if (authMode !== 'baton') {
    return renderRoomEntry();
  }
  if (roomId === null) {
    return <BatonRuntimeRoot />;
  }
  return (
    <BatonRoomEntryBoundary key={`${roomId}:${batonEntryGeneration}`} roomId={roomId}>
      {renderRoomEntry}
    </BatonRoomEntryBoundary>
  );
}
