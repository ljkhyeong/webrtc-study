import type { SignalingErrorCode } from '@round/protocol';
import {
  ChatSendError,
  type RoomIssue,
  type RoomIssueCode,
  type RoomSessionStatus,
  type ScreenShareStartResult,
} from '@round/rtc-core';
import type { RoomSystemNoticeView } from '../components/RoomView';
import type { ParticipantView } from '../components/VideoTile';

export const PEER_CONNECTION_FAILURE_MESSAGE =
  '일부 참가자와 직접 연결하지 못했습니다. 해당 참가자의 다시 연결 버튼을 눌러 주세요. 다른 참가자와의 통화는 유지됩니다.';
type RoomIssueMessages = Readonly<Record<'error' | 'warning', string>>;

export type RoomStartupErrorCode =
  'endpoint-configuration' | 'participation-grant' | 'turn-configuration' | 'session-start';

const ROOM_STARTUP_ERROR_MESSAGES = {
  'endpoint-configuration':
    '스터디룸 연결 설정을 확인하지 못했습니다. BATON에서 다시 입장하거나 관리자에게 문의해 주세요.',
  'participation-grant':
    '스터디 참여 권한을 확인하지 못했습니다. 잠시 후 다시 시도하거나 BATON에서 다시 입장해 주세요.',
  'turn-configuration':
    '통화 연결 정보를 받지 못했습니다. 네트워크를 확인한 뒤 잠시 후 다시 시도해 주세요.',
  'session-start': '스터디룸 연결을 시작하지 못했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.',
} satisfies Record<RoomStartupErrorCode, string>;

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
    error: '이 스터디룸은 최대 인원에 도달했습니다.',
    warning: '이 스터디룸은 최대 인원에 도달했습니다.',
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
    warning: '이 작업을 수행할 방장 권한이 없습니다.',
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
    warning: '이 브라우저는 카메라·마이크를 사용할 수 없어 두 장치 없이 입장했습니다.',
  },
  'media-permission-denied': {
    error: '카메라 또는 마이크를 열지 못했습니다. 브라우저 권한을 확인한 뒤 다시 입장해 주세요.',
    warning: '장치를 켜지 못해 카메라·마이크 없이 입장했습니다. 장치를 다시 선택할 수 있습니다.',
  },
  'video-quality-update-failed': {
    error: '카메라 전송 품질을 적용하지 못했습니다.',
    warning:
      '일부 연결에 카메라 전송 품질을 적용하지 못했습니다. 통화 장치 설정에서 다시 적용하거나 카메라를 꺼 주세요.',
  },
  'rtc-configuration-update-failed': {
    error: '통화 연결 정보를 적용하지 못했습니다. 네트워크를 확인한 뒤 다시 입장해 주세요.',
    warning: '일부 참가자의 통화 연결 정보를 갱신하지 못했습니다. 현재 통화는 유지됩니다.',
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
    warning: '일부 참가자의 재연결을 기다리고 있습니다. 현재 통화는 유지됩니다.',
  },
  'ice-candidate-queue-overflow': {
    error: PEER_CONNECTION_FAILURE_MESSAGE,
    warning: '일부 참가자와 연결을 계속 시도하고 있습니다.',
  },
  'ice-candidate-rejected': {
    error: PEER_CONNECTION_FAILURE_MESSAGE,
    warning: '일부 참가자와 다른 경로로 연결을 계속 시도하고 있습니다.',
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
  'media-device-sender-recovery': {
    error: '장치 교체 후 일부 참가자와 연결하지 못했습니다. 방에 다시 입장해 주세요.',
    warning: '기존 장치로 복원하지 못한 참가자의 연결을 자동으로 복구하고 있습니다.',
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
    error: '마이크 또는 카메라 연결이 종료되었습니다. 장치를 다시 선택해 주세요.',
    warning:
      '마이크 또는 카메라 연결이 종료되었습니다. 통화를 유지한 채 장치를 다시 선택할 수 있습니다.',
  },
} satisfies Record<Exclude<RoomIssueCode, SignalingErrorCode>, RoomIssueMessages>;

const ROOM_ISSUE_MESSAGES = {
  ...SIGNALING_ISSUE_MESSAGES,
  ...INTERNAL_ROOM_ISSUE_MESSAGES,
} satisfies Record<RoomIssueCode, RoomIssueMessages>;

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
  if (error instanceof ChatSendError) {
    switch (error.code) {
      case 'peer-unavailable':
        return '연결 가능한 참가자가 없어 메시지를 보내지 못했습니다. 입력한 내용은 그대로 두었습니다.';
      case 'queue-full':
        return '전송 대기 중인 메시지가 많습니다. 잠시 후 다시 보내세요.';
      case 'room-not-active':
      case 'message-id-conflict':
        break;
    }
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

interface ActiveRoomTerminalState {
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
      terminalErrorMessage: ROOM_STARTUP_ERROR_MESSAGES[startupError],
    };
  }
  const status = snapshotStatus ?? 'idle';
  return {
    status,
    ...(status === 'error'
      ? { terminalErrorMessage: sessionError ?? ROOM_STARTUP_ERROR_MESSAGES['session-start'] }
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

export function roomStatusLabel(
  status: RoomSessionStatus,
  participants: readonly ParticipantView[],
): string {
  if (status !== 'active') {
    return statusLabels[status];
  }

  const remoteParticipants = participants.filter((participant) => !participant.isLocal);
  if (remoteParticipants.length === 0) {
    return '다른 참가자 기다리는 중';
  }
  if (remoteParticipants.some((participant) => participant.connectionState === 'failed')) {
    return '일부 참가자 연결 실패';
  }
  if (remoteParticipants.every((participant) => participant.connectionState === 'connected')) {
    return '통화 연결됨';
  }
  return '참가자 연결 중';
}
