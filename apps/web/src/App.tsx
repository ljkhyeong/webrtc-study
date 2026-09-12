import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
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
import {
  resolveNormalizedRoomEndpoints,
  resolveRoundAuthMode,
  type RoundAuthMode,
} from './lib/room-endpoints';
import { useClientRelease, checkSignalingCompatibility } from './lib/client-release';
import { ClientReleaseNotice } from './components/ClientReleaseNotice';
import { useRoomNavigation } from './lib/use-room-navigation';

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
  const { pathname, navigate, registerLeaveGuard } = useRoomNavigation();
  const roomId = roomIdFromPath(pathname);
  const [displayName, setDisplayName] = useState(() =>
    authMode === 'standalone' ? readStoredDisplayName() : '',
  );
  const [activeRoomKey, setActiveRoomKey] = useState<string | null>(null);
  const release = useClientRelease(authMode === 'standalone' || activeRoomKey !== null);
  const [activeHostCapability, setActiveHostCapability] = useState<string | undefined>();
  const [initialInputEnabled, setInitialInputEnabled] =
    useState<RoomSessionOptions['initialInputEnabled']>();
  const [batonEntryGeneration, setBatonEntryGeneration] = useState(0);
  const preparedMediaStreamRef = useRef<MediaStream | null>(null);

  const takePreparedMediaStream = useCallback(() => {
    const stream = preparedMediaStreamRef.current;
    preparedMediaStreamRef.current = null;
    return stream;
  }, []);

  const stopUnclaimedPreparedMedia = useCallback(() => {
    stopMediaStreamTracks(takePreparedMediaStream());
  }, [takePreparedMediaStream]);

  useEffect(() => {
    if (activeRoomKey === null) {
      return;
    }

    const currentRoomKey =
      roomId === null || displayName.length === 0 ? null : `${roomId}:${displayName}`;
    if (currentRoomKey === activeRoomKey) {
      return;
    }

    stopUnclaimedPreparedMedia();
    setActiveRoomKey(null);
    setActiveHostCapability(undefined);
  }, [activeRoomKey, displayName, roomId, stopUnclaimedPreparedMedia]);

  const goHome = () => {
    stopUnclaimedPreparedMedia();
    setActiveRoomKey(null);
    setActiveHostCapability(undefined);
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

    const roomKey = `${roomId}:${displayName}`;
    if (activeRoomKey !== roomKey) {
      return (
        <PrejoinScreen
          key={roomId}
          initialDisplayName={displayName}
          roomId={roomId}
          backLabel={authMode === 'baton' ? 'BATON으로 돌아가기' : '다른 방 선택'}
          showHostCapabilityInput={authMode !== 'baton'}
          authorizeBeforeEntryAction={authorizeBeforeEntryAction}
          beforeJoin={async () => {
            if ((await release.check()) !== 'current') return false;
            const endpoints = resolveNormalizedRoomEndpoints({
              roomId,
              authMode,
              location: window.location,
              signalingUrl: import.meta.env.VITE_SIGNALING_URL,
              turnCredentialsUrl: import.meta.env.VITE_TURN_CREDENTIALS_URL,
            });
            await checkSignalingCompatibility(endpoints.signalingUrl);
            return true;
          }}
          onBack={goHome}
          onJoin={(nextDisplayName, preparedMediaStream, hostCapability, inputEnabled) => {
            setDisplayName(nextDisplayName);
            if (authMode === 'standalone') storeDisplayName(nextDisplayName);
            stopUnclaimedPreparedMedia();
            preparedMediaStreamRef.current = preparedMediaStream;
            setActiveHostCapability(hostCapability);
            setInitialInputEnabled(inputEnabled);
            setActiveRoomKey(`${roomId}:${nextDisplayName}`);
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
        registerLeaveGuard={registerLeaveGuard}
      />
    );
  };

  let roomEntry: ReactNode;
  if (authMode === 'baton') {
    if (roomId === null) {
      return <BatonRuntimeRoot />;
    }
    roomEntry = (
      <BatonRoomEntryBoundary key={`${roomId}:${batonEntryGeneration}`} roomId={roomId}>
        {renderRoomEntry}
      </BatonRoomEntryBoundary>
    );
  } else {
    roomEntry = renderRoomEntry();
  }
  return (
    <>
      <ClientReleaseNotice
        status={release.status}
        inRoom={activeRoomKey !== null}
        onRetry={() => void release.check()}
      />
      {roomEntry}
    </>
  );
}
