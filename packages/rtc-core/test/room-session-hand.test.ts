import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@round/protocol';
import {
  FakeDataChannel,
  ROOM_ID,
  answerPeer,
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

  it('미디어 없이 손을 들고 늦게 연결된 참가자에게 마지막 상태만 보낸다', async () => {
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
    harness.session.setHandRaised(false);
    harness.session.setHandRaised(true);
    harness.session.setHandRaised(true);
    expect(channel.sent).toEqual([]);
    channel.open();
    expect(
      channel.sent
        .map((raw) => JSON.parse(raw))
        .filter((message) => message.type === 'participant.hand'),
    ).toEqual([{ type: 'participant.hand', raised: true }]);
    expect(
      harness.session.getSnapshot().participants.find((participant) => participant.isLocal),
    ).toMatchObject({ handRaised: true, audioEnabled: false, videoEnabled: false });
    expect(harness.socket.messagesOfType('rtc.offer')).toHaveLength(0);
  });

  it('연결된 상대의 상태만 바꾸고 퇴장한 상대의 늦은 메시지는 무시한다', async () => {
    await joinSession(harness, [
      { peerId: 'peer-a', displayName: '가온' },
      { peerId: 'peer-b', displayName: '나래' },
    ]);
    const channel = harness.peerConnections[0]!.channels[0]!;
    channel.receive({ type: 'participant.hand', raised: true, peerId: 'peer-b' });
    expect(
      harness.session.getSnapshot().participants.every((participant) => !participant.handRaised),
    ).toBe(true);
    channel.receive({ type: 'participant.hand', raised: true });
    expect(
      harness.session
        .getSnapshot()
        .participants.filter((participant) => participant.handRaised)
        .map((participant) => participant.peerId),
    ).toEqual(['peer-a']);
    channel.receive({ type: 'participant.hand', raised: false });
    expect(
      harness.session.getSnapshot().participants.every((participant) => !participant.handRaised),
    ).toBe(true);
    channel.receive({ type: 'participant.hand', raised: true });
    const staleHandler = channel.onmessage!;
    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'peer.left',
      roomId: ROOM_ID,
      payload: { peerId: 'peer-a' },
    });
    await flushMicrotasks();
    staleHandler({
      data: JSON.stringify({ type: 'participant.hand', raised: true }),
    } as MessageEvent);
    expect(
      harness.session.getSnapshot().participants.map((participant) => participant.peerId),
    ).toEqual(['self', 'peer-b']);
    expect(
      harness.session.getSnapshot().participants.every((participant) => !participant.handRaised),
    ).toBe(true);
  });

  it('송신 버퍼가 밀리면 마지막 상태만 보내고 채널 복구 뒤에도 다시 보낸다', async () => {
    await joinSession(harness, [{ peerId: 'z-peer', displayName: '가온' }], 'a-self');
    await answerPeer(harness, 'z-peer');
    const peer = harness.peerConnections[0]!;
    peer.setConnectionState('connected');
    const channel = peer.channels[0]!;
    channel.sent.length = 0;
    channel.bufferedAmount = 256 * 1024;
    harness.session.setHandRaised(true);
    harness.session.setHandRaised(false);
    harness.session.sendChat('질문이 있습니다.');
    expect(channel.sent).toEqual([]);
    channel.drainBufferedAmount();
    expect(channel.sent.map((raw) => JSON.parse(raw))).toEqual([
      { type: 'participant.hand', raised: false },
      expect.objectContaining({ type: 'chat.message', text: '질문이 있습니다.' }),
    ]);
    harness.session.setHandRaised(true);
    channel.remoteClose();
    await flushMicrotasks();
    await answerPeer(harness, 'z-peer');
    peer.channels[1]!.open();
    expect(peer.channels[1]!.sent.map((raw) => JSON.parse(raw))).toContainEqual({
      type: 'participant.hand',
      raised: true,
    });
    await harness.session.leave();
    expect(harness.session.setHandRaised(false)).toBe(false);
    expect(harness.session.getSnapshot().participants).toEqual([]);
  });
});
