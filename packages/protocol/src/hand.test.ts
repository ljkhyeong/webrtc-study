import { describe, expect, it } from 'vitest';
import { parseClientMessage, parseServerMessage } from './validation.js';

const envelope = { v: 3, roomId: 'abcd-efgh-jkmp' };
describe('손들기 대기열 계약', () => {
  it('본인의 손들기 여부만 보내며 위조한 대상과 잘못된 값을 거부한다', () => {
    const message = { ...envelope, type: 'room.hand.update', payload: { raised: true } };
    expect(parseClientMessage(message)).toEqual(message);
    expect(parseClientMessage({ ...envelope, type: 'room.hand.sync' }).type).toBe('room.hand.sync');
    for (const payload of [{ raised: null }, { raised: 1 }, { raised: true, peerId: 'other' }]) {
      expect(() => parseClientMessage({ ...message, payload })).toThrow();
    }
  });
  it('중복·미지원 참가자와 잘못된 개정 번호를 대기열에 허용하지 않는다', () => {
    const message = {
      ...envelope,
      type: 'room.hand.state',
      payload: { revision: 2, peerIds: ['b', 'a'], supportedPeerIds: ['a', 'b'] },
    };
    expect(parseServerMessage(message)).toEqual(message);
    for (const changes of [
      { revision: -1 },
      { peerIds: ['a', 'a'] },
      { peerIds: ['unknown'] },
      { supportedPeerIds: ['a', 'a'] },
    ]) {
      expect(() =>
        parseServerMessage({ ...message, payload: { ...message.payload, ...changes } }),
      ).toThrow();
    }
  });
});
