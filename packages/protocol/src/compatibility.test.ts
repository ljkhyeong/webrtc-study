import { describe, expect, it } from 'vitest';
import { supportsCurrentClient } from './compatibility.js';

describe('입장 전 서버 호환성', () => {
  it('현재 프로토콜과 필수 기능을 요구하고 추가 기능은 허용한다', () => {
    expect(
      supportsCurrentClient({
        protocolVersion: 3,
        capabilities: ['room.study', 'peer.reconnect', 'future'],
      }),
    ).toBe(true);
    for (const value of [
      null,
      '<html>',
      {},
      { protocolVersion: 2, capabilities: ['room.study', 'peer.reconnect'] },
      { protocolVersion: 3, capabilities: ['peer.reconnect'] },
      { protocolVersion: 3, capabilities: ['room.study', 'peer.reconnect', null] },
    ]) {
      expect(supportsCurrentClient(value)).toBe(false);
    }
  });
});
