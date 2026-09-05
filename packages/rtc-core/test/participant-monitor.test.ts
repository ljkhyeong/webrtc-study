import { describe, expect, it } from 'vitest';
import { ParticipantMonitor } from '../src/participant-monitor.js';

function report(timestamp: number, received: number, lost: number, level?: number): RTCStatsReport {
  const stats = {
    id: 'audio',
    type: 'inbound-rtp',
    kind: 'audio',
    ssrc: 1,
    timestamp,
    packetsReceived: received,
    packetsLost: lost,
    jitter: 0.01,
    audioLevel: level,
  };
  return new Map([[stats.id, stats]]) as unknown as RTCStatsReport;
}

describe('참가자 통화 상태 표시', () => {
  it('연속된 손실과 복구만 품질 표시에 반영하고 수신 없는 구간은 측정 불가로 바꾼다', () => {
    const monitor = new ParticipantMonitor();
    const sample = (at: number, received: number, lost: number) =>
      monitor.sample(report(at, received, lost), at, false, false, true).receptionQuality;
    expect(sample(0, 100, 0)).toBe('unavailable');
    expect(sample(3000, 190, 10)).toBe('unavailable');
    expect(sample(6000, 280, 20)).toBe('unstable');
    expect(sample(9000, 380, 20)).toBe('unstable');
    expect(sample(12000, 480, 20)).toBe('stable');
    expect(sample(15000, 480, 20)).toBe('unavailable');
    expect(
      monitor.sample(new Map() as RTCStatsReport, 18000, false, false, true).receptionQuality,
    ).toBe('unavailable');
  });

  it('음성이 이어질 때 발언을 표시하고 음소거·미지원 통계에는 표시하지 않는다', () => {
    const monitor = new ParticipantMonitor();
    expect(monitor.sample(report(0, 1, 0, 0.1), 0, true, false, false).speaking).toBe(false);
    expect(monitor.sample(report(500, 2, 0, 0.1), 500, true, false, false).speaking).toBe(true);
    expect(monitor.sample(report(1000, 3, 0, 0), 1000, true, false, false).speaking).toBe(true);
    expect(monitor.sample(report(1500, 4, 0, 0), 1500, true, false, false).speaking).toBe(false);
    expect(monitor.sample(report(2000, 5, 0, 0.8), 2000, false, false, false).speaking).toBe(false);
    expect(monitor.sample(report(2500, 6, 0), 2500, true, false, false).speaking).toBe(false);
  });
});
