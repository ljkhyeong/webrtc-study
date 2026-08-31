import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createHarness,
  flushMicrotasks,
  joinSession,
  type Harness,
} from './room-session.test-support.js';

const sessions: Harness[] = [];
function report(overrides: Partial<RTCInboundRtpStreamStats> = {}): RTCStatsReport {
  const stats = {
    id: 'inbound',
    type: 'inbound-rtp',
    timestamp: 1,
    ssrc: 123,
    packetsReceived: 100,
    packetsLost: 5,
    ...overrides,
  };
  return new Map([[stats.id, stats]]) as RTCStatsReport;
}

afterEach(async () => {
  for (const h of sessions.splice(0)) await h.session.leave();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('최근 연결 진단', () => {
  it.each([
    { label: '새 통계', next: { id: 'new', timestamp: 3001 }, expected: null },
    { label: 'SSRC 교체', next: { ssrc: 456, timestamp: 3001 }, expected: null },
    { label: '수신 카운터 초기화', next: { packetsReceived: 10, timestamp: 3001 }, expected: null },
    { label: '수신 없음', next: { timestamp: 3001 }, expected: null },
    { label: '같은 캐시 표본', next: {}, expected: null },
    {
      label: '손실 보정',
      next: { packetsReceived: 110, packetsLost: 3, timestamp: 3001 },
      expected: 0,
    },
  ])('$label을 누적 손실률로 잘못 표시하지 않는다', async ({ next, expected }) => {
    const h = createHarness();
    sessions.push(h);
    await joinSession(h, [{ peerId: 'peer-a', displayName: '참가자' }]);
    const peer = h.peerConnections[0]!;
    vi.spyOn(peer, 'getStats').mockResolvedValueOnce(report()).mockResolvedValueOnce(report(next));
    vi.useFakeTimers();
    const collecting = h.session.collectConnectionDiagnostics();
    await vi.advanceTimersByTimeAsync(3_000);
    const result = await collecting;
    expect(result.connections[0]!.packetLossPercent).toBe(expected);
  });

  it('연결 종료 시 측정 타이머를 취소하고 종료된 피어를 결과에 포함하지 않는다', async () => {
    const h = createHarness();
    sessions.push(h);
    await joinSession(h, [{ peerId: 'peer-a', displayName: '참가자' }]);
    const getStats = vi.spyOn(h.peerConnections[0]!, 'getStats').mockResolvedValue(report());
    vi.useFakeTimers();
    const collecting = h.session.collectConnectionDiagnostics();
    await flushMicrotasks();
    expect(vi.getTimerCount()).toBe(1);
    await h.session.leave();
    expect(await collecting).toEqual({ status: 'ended', connections: [] });
    expect(vi.getTimerCount()).toBe(0);
    expect(getStats).toHaveBeenCalledTimes(1);
  });
});
