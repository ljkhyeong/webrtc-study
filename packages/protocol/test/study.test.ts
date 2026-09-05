import { describe, expect, it } from 'vitest';
import { parseClientMessage, parseServerMessage, PROTOCOL_VERSION } from '../src/index.js';
const base = { v: PROTOCOL_VERSION, roomId: 'abcd-efgh-jkmp' };
describe('재연결·스터디 메시지 계약', () => {
  it('재연결 대상과 서버가 정한 연결 번호를 검증한다', () => {
    expect(parseClientMessage({ ...base, type: 'peer.reconnect', to: 'peer' }).type).toBe(
      'peer.reconnect',
    );
    expect(() =>
      parseClientMessage({
        ...base,
        type: 'peer.reconnect',
        to: 'peer',
        payload: { connectionId: 'forged' },
      }),
    ).toThrow();
    expect(
      parseServerMessage({
        ...base,
        type: 'peer.reconnect',
        payload: { peerId: 'peer', connectionId: 'reset', initiator: true },
      }).type,
    ).toBe('peer.reconnect');
    expect(() =>
      parseServerMessage({
        ...base,
        type: 'peer.reconnect',
        payload: { peerId: 'peer', connectionId: '', initiator: true },
      }),
    ).toThrow();
  });
  it('지원하는 스터디 명령과 시간 범위를 검증한다', () => {
    expect(parseClientMessage({ ...base, type: 'room.study.sync' }).type).toBe('room.study.sync');
    for (const payload of [
      { action: 'start', mode: 'focus', durationSeconds: 60 },
      { action: 'pause' },
      { action: 'resume' },
      { action: 'reset' },
      { action: 'topic', topic: '' },
    ]) {
      expect(
        parseClientMessage({
          ...base,
          type: 'room.study.update',
          payload: { ...payload, expectedRevision: 0 },
        }).type,
      ).toBe('room.study.update');
    }
    for (const durationSeconds of [0, 59, 60.5, 7201])
      expect(() =>
        parseClientMessage({
          ...base,
          type: 'room.study.update',
          payload: { action: 'start', expectedRevision: 0, mode: 'focus', durationSeconds },
        }),
      ).toThrow();
    expect(() =>
      parseClientMessage({
        ...base,
        type: 'room.study.update',
        payload: { action: 'topic', expectedRevision: -1, topic: 'x'.repeat(121) },
      }),
    ).toThrow();
    expect(() =>
      parseClientMessage({
        ...base,
        type: 'room.study.update',
        payload: { action: 'pause', expectedRevision: 0, topic: 'forged' },
      }),
    ).toThrow();
  });
});
