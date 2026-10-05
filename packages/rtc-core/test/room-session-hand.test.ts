import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@round/protocol';
import {
  FakeDataChannel,
  ROOM_ID,
  createHarness,
  flushMicrotasks,
  joinSession,
  type Harness,
} from './room-session.test-support.js';

describe('손들기', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  afterEach(async () => {
    await harness.session.leave();
  });

  it('서버 대기열 순서를 모든 참가자에 적용하고 이전 개정은 무시한다', async () => {
    await joinSession(harness, [
      { peerId: 'peer-a', displayName: '가온' },
      { peerId: 'peer-b', displayName: '나래' },
    ]);
    expect(harness.socket.messagesOfType('room.hand.sync')).toHaveLength(1);
    const receive = (revision: number, peerIds: string[]) =>
      harness.socket.serverMessage({
        v: PROTOCOL_VERSION,
        type: 'room.hand.state',
        roomId: ROOM_ID,
        payload: { revision, peerIds },
      });
    const raisedIds = () =>
      harness.session
        .getSnapshot()
        .participants.filter((participant) => participant.handRaised)
        .map((participant) => participant.peerId);
    receive(3, ['peer-b', 'peer-a']);
    await flushMicrotasks();
    receive(2, ['peer-a']);
    await flushMicrotasks();
    expect(harness.session.getSnapshot().handQueue?.peerIds).toEqual(['peer-b', 'peer-a']);
    expect(raisedIds()).toEqual(['peer-a', 'peer-b']);
    harness.session.setHandRaised(true);
    expect(harness.socket.messagesOfType('room.hand.update').at(-1)?.payload).toEqual({
      raised: true,
    });
    receive(4, ['peer-a', 'self']);
    await flushMicrotasks();
    expect(raisedIds()).toEqual(['self', 'peer-a']);
    await harness.session.leave();
    expect(harness.session.getSnapshot().handQueue).toBeNull();
  });

  it('늦게 입장한 참가자도 현재 대기열로 손들기 상태를 표시한다', async () => {
    await joinSession(harness);
    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'room.hand.state',
      roomId: ROOM_ID,
      payload: { revision: 1, peerIds: ['peer-a'] },
    });
    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'peer.joined',
      roomId: ROOM_ID,
      payload: { participant: { peerId: 'peer-a', displayName: '가온' } },
    });
    await flushMicrotasks();
    expect(
      harness.session.getSnapshot().participants.find((participant) => !participant.isLocal),
    ).toMatchObject({ peerId: 'peer-a', handRaised: true });
  });

  it('미디어 없이 손을 들고 DataChannel로는 손들기 상태를 보내지 않는다', async () => {
    harness = createHarness({ preparedMediaStream: null });
    expect(harness.session.setHandRaised(true)).toBe(false);
    await joinSession(harness);
    expect(harness.session.setHandRaised(true)).toBe(true);
    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'peer.joined',
      roomId: ROOM_ID,
      payload: { participant: { peerId: 'peer-a', displayName: '가온' } },
    });
    await flushMicrotasks();
    const channel = new FakeDataChannel();
    channel.readyState = 'connecting';
    harness.peerConnections[0]!.ondatachannel!({ channel } as unknown as RTCDataChannelEvent);
    channel.open();
    expect(channel.sent.map((raw) => JSON.parse(raw).type)).not.toContain('participant.hand');
    expect(
      harness.session.getSnapshot().participants.find((participant) => participant.isLocal),
    ).toMatchObject({ handRaised: true, audioEnabled: false, videoEnabled: false });
    expect(harness.socket.messagesOfType('rtc.offer')).toHaveLength(0);
    await harness.session.leave();
    expect(harness.session.setHandRaised(false)).toBe(false);
  });
});
