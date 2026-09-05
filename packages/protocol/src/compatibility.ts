import { PROTOCOL_VERSION } from './types.js';

export const REQUIRED_SIGNALING_CAPABILITIES = ['peer.reconnect', 'room.study'] as const;

/** HTTP 호환성 응답에서 현재 웹이 사용하는 서버 기능을 확인한다. 추가 기능은 허용한다. */
export function supportsCurrentClient(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const { protocolVersion, capabilities } = value as Record<string, unknown>;
  return (
    protocolVersion === PROTOCOL_VERSION &&
    Array.isArray(capabilities) &&
    capabilities.every((item) => typeof item === 'string') &&
    REQUIRED_SIGNALING_CAPABILITIES.every((item) => capabilities.includes(item))
  );
}
