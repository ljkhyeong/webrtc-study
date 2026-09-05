import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@round/protocol';
import {
  createHarness,
  joinSession,
  flushMicrotasks,
  ROOM_ID,
  type Harness,
} from './room-session.test-support.js';
let harness: Harness;
afterEach(async () => {
  await harness?.session.leave();
  vi.useRealTimers();
});
const state = {
  revision: 1,
  topic: '코드 리뷰',
  mode: 'focus' as const,
  durationSeconds: 1500,
  remainingMs: 1_400_000,
  running: true,
  conflict: false,
};
function receive(payload: typeof state, requestId?: string) {
  harness.socket.serverMessage({
    v: PROTOCOL_VERSION,
    type: 'room.study.state',
    roomId: ROOM_ID,
    payload,
    ...(requestId ? { requestId } : {}),
  });
}
describe('공용 타이머 상태', () => {
  it('방장 명령에 개정 번호를 붙이고 대기 중 중복 조작과 이전 상태 덮어쓰기를 막는다', async () => {
    harness = createHarness();
    await joinSession(harness, [], 'self', { selfRole: 'host', canModerateMedia: true });
    expect(harness.session.syncStudy()).toBe(true);
    expect(harness.session.syncStudy()).toBe(false);
    receive(state);
    await flushMicrotasks();
    expect(harness.session.updateStudy({ action: 'pause' })).toBe(true);
    expect(harness.session.updateStudy({ action: 'reset' })).toBe(false);
    const command = harness.socket.messagesOfType('room.study.update')[0]!;
    expect(command.payload).toEqual({ action: 'pause', expectedRevision: 1 });
    receive(
      { ...state, revision: 2, topic: '다른 방장의 주제', conflict: true },
      command.requestId as string,
    );
    await flushMicrotasks();
    expect(harness.session.getSnapshot()).toMatchObject({
      studyPending: false,
      study: { revision: 2 },
      studyNotice: expect.stringContaining('다른 방장'),
    });
    receive(state);
    await flushMicrotasks();
    expect(harness.session.getSnapshot().study?.topic).toBe('다른 방장의 주제');
    await harness.session.leave();
    expect(harness.session.getSnapshot().study).toBeNull();
  });
  it('일반 참가자는 상태를 볼 수 있지만 변경하지 못한다', async () => {
    harness = createHarness();
    await joinSession(harness);
    receive(state);
    await flushMicrotasks();
    expect(harness.session.getSnapshot().study?.remainingMs).toBe(1_400_000);
    expect(harness.session.updateStudy({ action: 'pause' })).toBe(false);
    expect(harness.socket.messagesOfType('room.study.update')).toHaveLength(0);
  });
});
