import { isValidRoomId } from './room';

export interface RoomEndpointLocation {
  readonly protocol: string;
  readonly host: string;
}

export interface ResolveRoomEndpointsOptions {
  readonly roomId: string;
  readonly authMode?: string | undefined;
  readonly location: RoomEndpointLocation;
  readonly signalingUrl?: string | undefined;
  readonly turnCredentialsUrl?: string | undefined;
}

export interface RoomEndpoints {
  readonly signalingUrl: string;
  readonly turnCredentialsUrl: string;
}

type RoundAuthMode = 'standalone' | 'baton';

const DEFAULT_SIGNALING_PATH = '/signal';
const DEFAULT_TURN_CREDENTIALS_PATH = '/api/turn-credentials';

export function resolveRoomEndpoints(options: ResolveRoomEndpointsOptions): RoomEndpoints {
  if (!isValidRoomId(options.roomId)) {
    throw new Error('방 식별자가 올바르지 않습니다.');
  }

  const authMode = resolveAuthMode(options.authMode);
  const signalingOverride = nonBlank(options.signalingUrl);
  const turnCredentialsOverride = nonBlank(options.turnCredentialsUrl);

  if (authMode === 'baton') {
    if (signalingOverride !== undefined || turnCredentialsOverride !== undefined) {
      throw new Error(
        'BATON 모드에서는 방 단위 동일 출처 signaling과 TURN 경로만 사용할 수 있습니다.',
      );
    }

    const roomPath = `/round/rooms/${encodeURIComponent(options.roomId)}`;
    return {
      signalingUrl: `${webSocketOrigin(options.location)}${roomPath}/signal`,
      turnCredentialsUrl: `${roomPath}/turn-credentials`,
    };
  }

  return {
    signalingUrl:
      signalingOverride === undefined
        ? `${webSocketOrigin(options.location)}${DEFAULT_SIGNALING_PATH}`
        : normalizeSignalingOverride(signalingOverride),
    turnCredentialsUrl: turnCredentialsOverride ?? DEFAULT_TURN_CREDENTIALS_PATH,
  };
}

function resolveAuthMode(value: string | undefined): RoundAuthMode {
  const normalized = value?.trim() ?? '';
  if (normalized === '' || normalized === 'standalone') {
    return 'standalone';
  }
  if (normalized === 'baton') {
    return 'baton';
  }
  throw new Error('ROUND 브라우저 인증 모드 설정이 올바르지 않습니다.');
}

function nonBlank(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeSignalingOverride(value: string): string {
  if (value.startsWith('https://')) {
    return value.replace(/^https:/, 'wss:');
  }
  if (value.startsWith('http://')) {
    return value.replace(/^http:/, 'ws:');
  }
  return value;
}

function webSocketOrigin(location: RoomEndpointLocation): string {
  if (!location.host.trim()) {
    throw new Error('ROUND 브라우저 origin 설정이 올바르지 않습니다.');
  }
  if (location.protocol === 'https:') {
    return `wss://${location.host}`;
  }
  if (location.protocol === 'http:') {
    return `ws://${location.host}`;
  }
  throw new Error('ROUND는 HTTP 또는 HTTPS origin에서 실행해야 합니다.');
}
