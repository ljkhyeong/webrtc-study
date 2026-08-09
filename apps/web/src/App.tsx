import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SignalingErrorCode } from '@round/protocol';
import {
  createRoomSession,
  type RoomIssue,
  type RoomIssueCode,
  type RoomSession,
  type RoomSessionSnapshot,
  type RoomSessionStatus,
  type ScreenShareStartResult,
} from '@round/rtc-core';
import { LandingScreen } from './components/LandingScreen';
import { PrejoinScreen } from './components/PrejoinScreen';
import { RoomView, type ChatMessageView, type RoomSystemNoticeView } from './components/RoomView';
import type { ParticipantView } from './components/VideoTile';
import {
  createWithPreparedMedia,
  stopMediaStreamTracks,
  withPreparedMediaFailureCleanup,
} from './lib/prepared-media';
import { ParticipationGrantLeaseManager } from './lib/participation-grant';
import { pathForRoom, roomIdFromPath, sanitizeDisplayName } from './lib/room';
import { resolveRoomEndpoints, type RoomEndpoints } from './lib/room-endpoints';
import { RoomRefreshLifetime } from './lib/room-refresh-lifetime';
import { loadTurnCredentials, turnCredentialRefreshDelayMs } from './lib/turn';

const DISPLAY_NAME_STORAGE_KEY = 'round:display-name';
const PEER_CONNECTION_FAILURE_MESSAGE =
  '일부 참가자와 직접 연결하지 못했습니다. 현재 연결은 유지됩니다. 모두 다시 연결하려면 방에 다시 입장해 주세요.';
type RoomIssueMessages = Readonly<Record<'error' | 'warning', string>>;

export type RoomStartupErrorCode =
  'endpoint-configuration' | 'participation-grant' | 'turn-configuration' | 'session-start';

const ROOM_STARTUP_ERROR_MESSAGES = {
  'endpoint-configuration':
    '스터디룸 연결 설정을 확인하지 못했습니다. BATON에서 다시 입장하거나 관리자에게 문의해 주세요.',
  'participation-grant':
    '스터디 참여 권한을 확인하지 못했습니다. 잠시 후 다시 시도하거나 BATON에서 다시 입장해 주세요.',
  'turn-configuration':
    'TURN 서버 정보를 받지 못했습니다. 네트워크를 확인한 뒤 잠시 후 다시 시도해 주세요.',
  'session-start': '스터디룸 연결을 시작하지 못했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.',
} satisfies Record<RoomStartupErrorCode, string>;

class RoomStartupFailure extends Error {
  constructor(
    readonly code: RoomStartupErrorCode,
    cause: unknown,
  ) {
    super(code, { cause });
    this.name = 'RoomStartupFailure';
  }
}

export function roomStartupErrorMessage(code: RoomStartupErrorCode): string {
  return ROOM_STARTUP_ERROR_MESSAGES[code];
}

function startupErrorCode(error: unknown): RoomStartupErrorCode {
  return error instanceof RoomStartupFailure ? error.code : 'session-start';
}

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
  FORBIDDEN: {
    error: '방장 키가 올바르지 않거나 이 작업을 수행할 권한이 없습니다.',
    warning: '이 미디어 관리 작업을 수행할 방장 권한이 없습니다.',
  },
  INTERNAL_ERROR: {
    error: '스터디 서버가 요청을 처리하지 못했습니다. 잠시 후 다시 연결해 주세요.',
    warning: '스터디 서버가 요청 하나를 처리하지 못했습니다. 현재 통화는 유지됩니다.',
  },
} satisfies Record<SignalingErrorCode, RoomIssueMessages>;

const INTERNAL_ROOM_ISSUE_MESSAGES = {
  'media-unavailable': {
    error:
      '이 브라우저에서는 카메라와 마이크를 사용할 수 없습니다. 브라우저 설정을 확인한 뒤 다시 입장해 주세요.',
    warning: '이 브라우저에서는 카메라와 마이크를 사용할 수 없어 미디어 없이 입장했습니다.',
  },
  'media-permission-denied': {
    error: '카메라 또는 마이크를 열지 못했습니다. 브라우저 권한을 확인한 뒤 다시 입장해 주세요.',
    warning:
      '카메라 또는 마이크를 열지 못해 미디어 없이 입장했습니다. 장치를 다시 선택할 수 있습니다.',
  },
  'rtc-configuration-update-failed': {
    error: 'TURN 연결 정보를 적용하지 못했습니다. 네트워크를 확인한 뒤 다시 입장해 주세요.',
    warning: '일부 참가자의 TURN 연결 정보를 갱신하지 못했습니다. 현재 통화는 유지됩니다.',
  },
  'join-failed': {
    error: '스터디룸 입장을 완료하지 못했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.',
    warning: '스터디룸 입장을 완료하지 못했습니다. 다시 연결해 주세요.',
  },
  'room-join-timeout': {
    error: '서버가 입장 요청에 응답하지 않았습니다. 네트워크를 확인해 주세요.',
    warning: '서버의 입장 응답이 늦어지고 있습니다. 다시 연결해 주세요.',
  },
  'signaling-reconnecting': {
    error: '스터디 서버와의 연결이 끊어졌습니다. 네트워크를 확인한 뒤 다시 연결해 주세요.',
    warning:
      '스터디 서버에 다시 연결하는 중입니다. 카메라와 마이크는 유지되지만 참가자 연결은 다시 설정됩니다.',
  },
  'reconnect-exhausted': {
    error: '서버와의 연결을 복구하지 못했습니다. 네트워크를 확인한 뒤 다시 연결해 주세요.',
    warning: '서버와의 연결을 복구하지 못했습니다. 방에 다시 입장해 주세요.',
  },
  'reconnect-attempt-failed': {
    error: '서버 재연결을 완료하지 못했습니다. 네트워크를 확인한 뒤 다시 연결해 주세요.',
    warning: '서버 재연결을 다시 시도하고 있습니다.',
  },
  'signaling-connect-failed': {
    error: '스터디 서버에 연결할 수 없습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.',
    warning: '스터디 서버 연결에 실패했습니다. 다시 연결하고 있습니다.',
  },
  'signaling-connect-timeout': {
    error: '스터디 서버에 연결할 수 없습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.',
    warning: '스터디 서버의 연결 응답이 늦어지고 있습니다.',
  },
  'signaling-closed': {
    error: '서버와의 연결을 복구하지 못했습니다. 네트워크를 확인한 뒤 다시 연결해 주세요.',
    warning: '스터디 서버와의 연결이 끊겨 다시 연결하고 있습니다.',
  },
  'connection-superseded': {
    error: '이 접속은 같은 계정의 새 접속으로 대체되었습니다. 계속 사용하려면 다시 입장해 주세요.',
    warning: '이 접속은 같은 계정의 새 접속으로 대체되었습니다.',
  },
  'invalid-signal-message': {
    error: '스터디 서버와 메시지 형식이 맞지 않습니다. 페이지를 새로고침한 뒤 다시 입장해 주세요.',
    warning: '서버에서 올바르지 않은 연결 메시지를 받아 무시했습니다. 현재 통화는 유지됩니다.',
  },
  'signal-handler-failed': {
    error: '참가자 연결 메시지를 처리하지 못했습니다. 방에 다시 입장해 주세요.',
    warning: '참가자 연결 메시지 하나를 처리하지 못했습니다. 현재 통화는 유지됩니다.',
  },
  'peer-restart-deferred': {
    error: PEER_CONNECTION_FAILURE_MESSAGE,
    warning: '일부 참가자의 연결 복구를 안전한 시점까지 기다리고 있습니다. 현재 통화는 유지됩니다.',
  },
  'ice-candidate-queue-overflow': {
    error: PEER_CONNECTION_FAILURE_MESSAGE,
    warning:
      '일부 참가자의 네트워크 연결 후보가 많아 오래된 정보를 정리했습니다. 현재 연결은 계속 시도합니다.',
  },
  'ice-candidate-rejected': {
    error: PEER_CONNECTION_FAILURE_MESSAGE,
    warning:
      '일부 참가자의 네트워크 연결 후보를 적용하지 못했습니다. 다른 경로로 연결을 계속 시도합니다.',
  },
  'peer-negotiation-retrying': {
    error: PEER_CONNECTION_FAILURE_MESSAGE,
    warning: '일부 참가자와의 직접 연결을 다시 시도하고 있습니다.',
  },
  'peer-connection-recovering': {
    error: PEER_CONNECTION_FAILURE_MESSAGE,
    warning: '일부 참가자와의 직접 연결을 자동으로 복구하고 있습니다. 현재 통화는 유지됩니다.',
  },
  'peer-connection-recreated': {
    error: PEER_CONNECTION_FAILURE_MESSAGE,
    warning: '일부 참가자와의 직접 연결을 새로 만들고 있습니다. 현재 통화는 유지됩니다.',
  },
  'peer-ice-restart-failed': {
    error: PEER_CONNECTION_FAILURE_MESSAGE,
    warning: '일부 참가자의 네트워크 경로 복구에 실패해 연결을 새로 만들고 있습니다.',
  },
  'screen-share-sender-recovery': {
    error: '일부 참가자에게 화면 공유를 전송하지 못했습니다. 방에 다시 입장해 주세요.',
    warning:
      '일부 참가자와 화면 공유 전환에 실패해 영상 연결을 자동으로 복구하고 있습니다. 현재 통화는 유지됩니다.',
  },
  'data-channel-closed': {
    error: '채팅 연결을 복구하지 못했습니다. 방에 다시 입장해 주세요.',
    warning: '일부 참가자와의 채팅 연결이 끊겨 자동으로 복구하고 있습니다.',
  },
  'data-channel-error': {
    error: '채팅 연결을 복구하지 못했습니다. 방에 다시 입장해 주세요.',
    warning: '일부 참가자와의 채팅 연결에서 오류가 발생해 자동으로 복구하고 있습니다.',
  },
  'data-channel-send-failed': {
    error: '채팅 메시지를 보내지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.',
    warning: '일부 참가자에게 채팅을 보내지 못해 연결을 자동으로 복구하고 있습니다.',
  },
  'data-channel-rate-limit': {
    error: '채팅 연결에서 너무 많은 데이터가 전송되었습니다. 방에 다시 입장해 주세요.',
    warning:
      '한 참가자의 채팅 연결에서 너무 많은 데이터가 전송되어 일부 업데이트를 잠시 무시했습니다. 통화는 유지됩니다.',
  },
  'peer-negotiation-failed': {
    error: PEER_CONNECTION_FAILURE_MESSAGE,
    warning: PEER_CONNECTION_FAILURE_MESSAGE,
  },
  'peer-connection-timeout': {
    error: PEER_CONNECTION_FAILURE_MESSAGE,
    warning: PEER_CONNECTION_FAILURE_MESSAGE,
  },
  'local-media-ended': {
    error:
      '마이크 또는 카메라 연결이 종료되었습니다. 장치를 다시 선택한 뒤 방에 다시 입장해 주세요.',
    warning:
      '마이크 또는 카메라 연결이 종료되었습니다. 장치를 다시 선택하면 현재 방 연결을 새로 시작합니다.',
  },
} satisfies Record<Exclude<RoomIssueCode, SignalingErrorCode>, RoomIssueMessages>;

const ROOM_ISSUE_MESSAGES = {
  ...SIGNALING_ISSUE_MESSAGES,
  ...INTERNAL_ROOM_ISSUE_MESSAGES,
} satisfies Record<RoomIssueCode, RoomIssueMessages>;

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
  return ROOM_ISSUE_MESSAGES[issue.code].error;
}

export function roomWarningMessage(issue: RoomIssue | null | undefined): string | undefined {
  if (!issue) {
    return undefined;
  }
  return ROOM_ISSUE_MESSAGES[issue.code].warning;
}

export function chatErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message.startsWith('Chat delivery to ')) {
    return '연결 가능한 참가자가 없어 메시지를 보내지 못했습니다. 입력한 내용은 그대로 두었습니다.';
  }
  if (message.startsWith('Chat delivery queue for ')) {
    return '메시지 전송 대기열이 가득 찼습니다. 잠시 후 다시 시도해 주세요.';
  }
  return '메시지를 보내지 못했습니다. 잠시 후 다시 시도해 주세요.';
}

interface RoomSystemNoticeMessages {
  readonly status: RoomSessionStatus;
  readonly sessionError?: string | undefined;
  readonly actionWarning?: string | undefined;
  readonly actionError?: string | undefined;
  readonly participationGrantRefreshWarning?: string | undefined;
  readonly turnRefreshWarning?: string | undefined;
}

export function buildRoomSystemNotices({
  status,
  sessionError,
  actionWarning,
  actionError,
  participationGrantRefreshWarning,
  turnRefreshWarning,
}: RoomSystemNoticeMessages): RoomSystemNoticeView[] {
  if (status !== 'active') {
    return [];
  }
  return [
    ...(sessionError
      ? [{ id: 'session-error', tone: 'error', message: sessionError } as const]
      : []),
    ...(actionWarning
      ? [{ id: 'action-warning', tone: 'warning', message: actionWarning } as const]
      : []),
    ...(actionError ? [{ id: 'action-error', tone: 'error', message: actionError } as const] : []),
    ...(participationGrantRefreshWarning
      ? [
          {
            id: 'participation-grant-refresh',
            tone: 'warning',
            message: participationGrantRefreshWarning,
          } as const,
        ]
      : []),
    ...(turnRefreshWarning
      ? [{ id: 'turn-refresh', tone: 'warning', message: turnRefreshWarning } as const]
      : []),
  ];
}

interface ActiveRoomTerminalStateInput {
  readonly snapshotStatus?: RoomSessionStatus | undefined;
  readonly sessionError?: string | undefined;
  readonly startupError: RoomStartupErrorCode | null;
}

export interface ActiveRoomTerminalState {
  readonly status: RoomSessionStatus;
  readonly terminalErrorMessage?: string | undefined;
}

export function resolveActiveRoomTerminalState({
  snapshotStatus,
  sessionError,
  startupError,
}: ActiveRoomTerminalStateInput): ActiveRoomTerminalState {
  if (startupError !== null) {
    return {
      status: 'error',
      terminalErrorMessage: roomStartupErrorMessage(startupError),
    };
  }
  const status = snapshotStatus ?? 'idle';
  return {
    status,
    ...(status === 'error'
      ? { terminalErrorMessage: sessionError ?? roomStartupErrorMessage('session-start') }
      : {}),
  };
}

export function screenShareStartNotice(
  result: ScreenShareStartResult,
): Pick<RoomSystemNoticeView, 'tone' | 'message'> | undefined {
  if (result === 'cancelled') {
    return {
      tone: 'warning',
      message: '화면 공유가 시작되지 않았습니다. 다시 시도하려면 화면 공유 버튼을 눌러 주세요.',
    };
  }
  if (result === 'failed') {
    return {
      tone: 'error',
      message:
        '화면 공유를 시작하지 못했습니다. 공유할 화면을 선택하고 브라우저 권한을 확인해 주세요.',
    };
  }
  return undefined;
}

export function shouldStopRoomRefreshes(status: RoomSessionStatus): boolean {
  return status === 'error' || status === 'ended';
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

async function loadRtcConfiguration(
  turnCredentialsUrl: string,
  signal?: AbortSignal,
): Promise<LoadedRtcConfiguration> {
  const stunUrls = (
    import.meta.env.VITE_STUN_URLS ?? 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302'
  )
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
  const iceServers: RTCIceServer[] = stunUrls.length > 0 ? [{ urls: stunUrls }] : [];

  let credentials;
  try {
    credentials = await loadTurnCredentials({
      endpoint: turnCredentialsUrl,
      ...(signal === undefined ? {} : { signal }),
    });
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

interface ActiveRoomProps {
  displayName: string;
  roomId: string;
  hostCapability?: string | undefined;
  releasePreparedMediaStream: () => void;
  takePreparedMediaStream: () => MediaStream | null;
  onReconnect: () => void;
  onLeave: () => void;
}

export function ActiveRoom({
  displayName,
  roomId,
  hostCapability,
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

  useEffect(() => {
    const lifecycle = ++lifecycleRef.current;
    let isCurrentSession = true;
    let unsubscribe = () => {};
    let endpoints: RoomEndpoints | null = null;
    let participationGrantLeaseManager: ParticipationGrantLeaseManager | null = null;
    const refreshLifetime = new RoomRefreshLifetime();
    const turnRequestController = new AbortController();

    const isCurrentLifecycle = () => isCurrentSession && lifecycleRef.current === lifecycle;
    const canRefresh = () => isCurrentLifecycle() && refreshLifetime.isActive();

    const stopBackgroundRefreshes = () => {
      refreshLifetime.stop();
      participationGrantLeaseManager?.close();
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
        // The shared helper exposes a bounded user warning and schedules a retry.
      }
    };

    const scheduleTurnRefresh = (expiresAt: number) => {
      if (!canRefresh()) {
        return;
      }
      refreshLifetime.schedule(
        'turn',
        () => {
          void refreshTurnConfiguration();
        },
        turnCredentialRefreshDelayMs(expiresAt),
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
        if (loaded.turnExpiresAt !== null) {
          scheduleTurnRefresh(loaded.turnExpiresAt);
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
      if (shouldStopRoomRefreshes(nextSnapshot.status)) {
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
              resolvedEndpoints = resolveRoomEndpoints({
                roomId,
                authMode: import.meta.env.VITE_ROUND_AUTH_MODE,
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
                participationGrantLeaseManager = new ParticipationGrantLeaseManager({
                  endpoint: resolvedEndpoints.participationGrantRefreshUrl,
                  roomId,
                });
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
              session = createWithPreparedMedia(takePreparedMediaStream, (preparedMediaStream) =>
                createRoomSession({
                  roomId,
                  displayName,
                  signalingUrl: resolvedEndpoints.signalingUrl,
                  rtcConfiguration: loaded.configuration,
                  preparedMediaStream,
                  ...(hostCapability === undefined ? {} : { hostCapability }),
                  ...(participationGrantLeaseManager === null
                    ? {}
                    : {
                        beforeSignalingConnect: () => ensureFreshParticipationGrantRef.current(),
                      }),
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

            setActionWarning('');
            setActionError('');
            handleSessionSnapshot(session.getSnapshot());
            unsubscribe = session.subscribe(handleSessionSnapshot);

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
        stopBackgroundRefreshes();
        if (isCurrentLifecycle()) {
          const sessionStatus = sessionRef.current?.getSnapshot().status;
          if (sessionStatus !== 'error') {
            setStartupError(startupErrorCode(error));
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
      // React StrictMode immediately re-runs effects in development. Deferring
      // disposal lets the second setup reuse the single-use session and the
      // transferred pre-join tracks instead of stopping them between setups.
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
  }, [displayName, hostCapability, releasePreparedMediaStream, roomId, takePreparedMediaStream]);

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
        isTerminalPeerWarning(snapshot?.warning) ? undefined : roomWarningMessage(snapshot?.warning)
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
      onSelectDevices={onReconnect}
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
  const [activeHostCapability, setActiveHostCapability] = useState<string | undefined>();
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
    navigateToOwningHome(import.meta.env.VITE_ROUND_AUTH_MODE, navigate);
  };

  const retryCurrentRoom = () => {
    stopUnclaimedPreparedMedia();
    setActiveRoomKey(null);
    setActiveHostCapability(undefined);
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
        showHostCapabilityInput={import.meta.env.VITE_ROUND_AUTH_MODE !== 'baton'}
        onBack={goHome}
        onJoin={(preparedMediaStream, hostCapability) => {
          stopUnclaimedPreparedMedia();
          preparedMediaStreamRef.current = preparedMediaStream;
          setActiveHostCapability(hostCapability);
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
      hostCapability={activeHostCapability}
      releasePreparedMediaStream={stopUnclaimedPreparedMedia}
      takePreparedMediaStream={takePreparedMediaStream}
      onReconnect={retryCurrentRoom}
      onLeave={goHome}
    />
  );
}
