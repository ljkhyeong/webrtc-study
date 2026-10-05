import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createHarness,
  createPromiseGate,
  flushMicrotasks,
  joinSession,
  type FakePeerConnection,
  type Harness,
} from './room-session.test-support.js';

const sessions: Harness[] = [];

function audioReport(levels: { readonly inbound?: number; readonly source?: number }) {
  const entries: [string, RTCStats][] = [];
  if (levels.inbound !== undefined) {
    entries.push([
      'inbound-audio',
      {
        id: 'inbound-audio',
        type: 'inbound-rtp',
        kind: 'audio',
        timestamp: 1,
        audioLevel: levels.inbound,
      } as RTCStats,
    ]);
  }
  if (levels.source !== undefined) {
    entries.push([
      'source-audio',
      {
        id: 'source-audio',
        type: 'media-source',
        kind: 'audio',
        timestamp: 1,
        audioLevel: levels.source,
      } as RTCStats,
    ]);
  }
  return new Map(entries) as unknown as RTCStatsReport;
}

async function connectedRoom(): Promise<{ harness: Harness; peer: FakePeerConnection }> {
  const harness = createHarness({ monotonicNow: () => 0 });
  sessions.push(harness);
  await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
  const peer = harness.peerConnections[0];
  const channel = peer?.channels[0];
  if (peer === undefined || channel === undefined) {
    throw new Error('Expected a peer connection with a DataChannel');
  }
  peer.setConnectionState('connected');
  channel.open();
  channel.receive({
    type: 'participant.media',
    audioEnabled: true,
    videoEnabled: false,
    videoSource: 'camera',
  });
  await flushMicrotasks();
  return { harness, peer };
}

function activityOf(harness: Harness, peerId: string) {
  return harness.session.getSnapshot().participants.find((item) => item.peerId === peerId)
    ?.activity;
}

afterEach(async () => {
  for (const harness of sessions.splice(0)) await harness.session.leave();
  vi.restoreAllMocks();
});

describe('참가자 활동 측정', () => {
  it('두 번 연속 소리가 측정되면 상대와 나의 발화를 표시한다', async () => {
    const { harness, peer } = await connectedRoom();
    peer.statsReport = audioReport({ inbound: 0.5, source: 0.5 });

    await harness.session.sampleParticipantActivity(false);
    expect(activityOf(harness, 'peer-a')).toEqual({
      speaking: false,
      receptionQuality: 'unavailable',
    });
    expect(activityOf(harness, 'self')).toEqual({
      speaking: false,
      receptionQuality: 'unavailable',
    });

    await harness.session.sampleParticipantActivity(false);
    expect(activityOf(harness, 'peer-a')).toEqual({
      speaking: true,
      receptionQuality: 'unavailable',
    });
    expect(activityOf(harness, 'self')).toEqual({
      speaking: true,
      receptionQuality: 'unavailable',
    });
  });

  it('측정할 소리와 품질이 없거나 통계를 읽지 못하면 상대 활동을 지운다', async () => {
    const { harness, peer } = await connectedRoom();
    peer.statsReport = audioReport({ inbound: 0.5 });
    await harness.session.sampleParticipantActivity(false);
    expect(activityOf(harness, 'peer-a')).toBeDefined();

    harness.session.toggleAudio();
    peer.channels[0]?.receive({
      type: 'participant.media',
      audioEnabled: false,
      videoEnabled: false,
      videoSource: 'camera',
    });
    await harness.session.sampleParticipantActivity(false);
    expect(activityOf(harness, 'peer-a')).toBeUndefined();
    expect(activityOf(harness, 'self')).toEqual({
      speaking: false,
      receptionQuality: 'unavailable',
    });

    await harness.session.sampleParticipantActivity(true);
    expect(activityOf(harness, 'peer-a')).toEqual({
      speaking: false,
      receptionQuality: 'unavailable',
    });

    vi.spyOn(peer, 'getStats').mockRejectedValueOnce(new Error('stats unavailable'));
    await harness.session.sampleParticipantActivity(true);
    expect(activityOf(harness, 'peer-a')).toBeUndefined();
  });

  it('진행 중인 측정은 겹치지 않고 초기화 뒤 늦게 끝난 결과를 버린다', async () => {
    const { harness, peer } = await connectedRoom();
    const gate = createPromiseGate();
    const getStats = vi.spyOn(peer, 'getStats').mockImplementation(async () => {
      await gate.promise;
      return audioReport({ inbound: 0.5, source: 0.5 });
    });

    const sampling = harness.session.sampleParticipantActivity(false);
    await harness.session.sampleParticipantActivity(false);
    expect(getStats).toHaveBeenCalledTimes(1);

    harness.session.resetParticipantActivity();
    gate.resolve();
    await sampling;

    expect(activityOf(harness, 'peer-a')).toBeUndefined();
    expect(activityOf(harness, 'self')).toBeUndefined();
  });

  it('연결이 끊긴 상대의 활동을 지운다', async () => {
    const { harness, peer } = await connectedRoom();
    peer.statsReport = audioReport({ inbound: 0.5 });
    await harness.session.sampleParticipantActivity(false);
    expect(activityOf(harness, 'peer-a')).toBeDefined();

    peer.setConnectionState('disconnected');
    await flushMicrotasks();

    expect(activityOf(harness, 'peer-a')).toBeUndefined();
  });
});
