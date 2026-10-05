import { describe, expect, it, vi } from 'vitest';

import { PROTOCOL_VERSION } from '@round/protocol';

import {
  FakeDataChannel,
  ROOM_ID,
  acknowledgeChat,
  answerPeer,
  createHarness,
  flushMicrotasks,
  joinSession,
} from './room-session.test-support.js';

describe('RoomSession', () => {
  it('fans chat out and scopes duplicate message ids to each peer', async () => {
    const harness = createHarness({
      createId: () => 'message-local',
      wallClockNow: () => 1_234,
    });
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
    const channel = harness.peerConnections[0]?.channels[0];
    expect(channel).toBeDefined();

    const local = harness.session.sendChat('  hello  ');
    expect(local).toEqual({
      id: 'message-local',
      senderId: 'self',
      senderName: 'Jin',
      text: 'hello',
      sentAt: 1_234,
      isLocal: true,
      deliveryState: 'pending',
      recipients: [{ peerId: 'peer-a', displayName: 'Ara', state: 'pending' }],
    });
    expect(JSON.parse(channel?.sent.at(-1) ?? '')).toEqual({
      type: 'chat.message',
      id: 'message-local',
      senderId: 'self',
      text: 'hello',
      sentAt: 1_234,
    });
    acknowledgeChat(channel as FakeDataChannel, local.id);
    expect(harness.session.getSnapshot().messages).toContainEqual({
      ...local,
      deliveryState: 'sent',
      recipients: [
        { peerId: 'peer-a', displayName: 'Ara', state: 'acknowledged', canRetry: false },
      ],
    });

    channel?.receive({
      type: 'chat.message',
      id: 'message-local',
      senderId: 'self',
      text: 'hello',
      sentAt: 1_234,
    });
    channel?.receive({
      type: 'chat.message',
      id: 'message-remote',
      senderId: 'spoofed-peer',
      text: 'hi back',
      sentAt: 1_235,
    });
    channel?.receive({
      type: 'chat.message',
      id: 'message-remote',
      senderId: 'spoofed-peer',
      text: 'duplicate',
      sentAt: 1_236,
    });

    expect(harness.session.getSnapshot().messages).toEqual([
      {
        ...local,
        deliveryState: 'sent',
        recipients: [
          { peerId: 'peer-a', displayName: 'Ara', state: 'acknowledged', canRetry: false },
        ],
      },
      {
        id: 'message-local',
        senderId: 'peer-a',
        senderName: 'Ara',
        text: 'hello',
        sentAt: 1_234,
        isLocal: false,
        deliveryState: 'received',
      },
      {
        id: 'message-remote',
        senderId: 'peer-a',
        senderName: 'Ara',
        text: 'hi back',
        sentAt: 1_235,
        isLocal: false,
        deliveryState: 'received',
      },
    ]);
    expect(
      channel?.sent
        .map((raw) => JSON.parse(raw) as { type: string; messageId?: string })
        .filter((message) => message.type === 'chat.ack' && message.messageId === 'message-remote'),
    ).toHaveLength(2);
  });

  it('reports partial delivery without resending to a peer that already received the message', async () => {
    const harness = createHarness({
      createId: () => 'message-partial',
      wallClockNow: () => 1_300,
    });
    await joinSession(harness, [
      { peerId: 'peer-a', displayName: 'Ara' },
      { peerId: 'peer-b', displayName: 'Bora' },
    ]);
    const deliveredChannel = harness.peerConnections[0]?.channels[0];
    const pendingChannel = harness.peerConnections[1]?.channels[0];
    if (deliveredChannel === undefined || pendingChannel === undefined) {
      throw new Error('Expected both participant DataChannels');
    }
    pendingChannel.readyState = 'connecting';

    const local = harness.session.sendChat('한 명에게만 먼저 도착');

    expect(local.deliveryState).toBe('pending');
    acknowledgeChat(deliveredChannel, local.id);
    expect(
      deliveredChannel.sent
        .map((raw) => JSON.parse(raw) as { type: string; id?: string })
        .filter((message) => message.type === 'chat.message' && message.id === local.id),
    ).toHaveLength(1);
    expect(
      pendingChannel.sent
        .map((raw) => JSON.parse(raw) as { type: string; id?: string })
        .filter((message) => message.type === 'chat.message' && message.id === local.id),
    ).toEqual([]);

    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'peer.left',
      roomId: ROOM_ID,
      payload: { peerId: 'peer-b' },
    });
    await flushMicrotasks();

    expect(harness.session.getSnapshot().messages).toContainEqual(
      expect.objectContaining({
        id: local.id,
        deliveryState: 'partial',
      }),
    );
    expect(
      deliveredChannel.sent
        .map((raw) => JSON.parse(raw) as { type: string; id?: string })
        .filter((message) => message.type === 'chat.message' && message.id === local.id),
    ).toHaveLength(1);

    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'peer.joined',
      roomId: ROOM_ID,
      payload: {
        participant: { peerId: 'peer-b', displayName: 'Bora' },
      },
    });
    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'rtc.offer',
      roomId: ROOM_ID,
      from: 'peer-b',
      payload: {
        negotiationId: 'rejoin.1',
        description: { type: 'offer', sdp: 'rejoin-offer' },
      },
    });
    await flushMicrotasks();
    const rejoinedPeer = harness.peerConnections[2];
    const rejoinedChannel = new FakeDataChannel();
    rejoinedPeer?.ondatachannel?.({
      channel: rejoinedChannel,
    } as unknown as RTCDataChannelEvent);
    rejoinedChannel.open();

    expect(
      rejoinedChannel.sent
        .map((raw) => JSON.parse(raw) as { type: string; id?: string })
        .filter((message) => message.type === 'chat.message' && message.id === local.id),
    ).toEqual([]);
  });

  it('waits for every recipient acknowledgement and ignores early or unknown acknowledgements', async () => {
    const harness = createHarness({
      createId: () => 'message-acknowledged',
      wallClockNow: () => 1_400,
    });
    await joinSession(harness, [
      { peerId: 'peer-a', displayName: 'Ara' },
      { peerId: 'peer-b', displayName: 'Bora' },
    ]);
    const firstChannel = harness.peerConnections[0]?.channels[0];
    const secondChannel = harness.peerConnections[1]?.channels[0];
    if (firstChannel === undefined || secondChannel === undefined) {
      throw new Error('Expected both participant DataChannels');
    }
    firstChannel.readyState = 'connecting';

    const local = harness.session.sendChat('모두 확인해야 완료');
    acknowledgeChat(firstChannel, local.id);
    acknowledgeChat(secondChannel, 'unknown-message');
    acknowledgeChat(secondChannel, local.id);

    expect(harness.session.getSnapshot().messages).toContainEqual(
      expect.objectContaining({ id: local.id, deliveryState: 'pending' }),
    );

    firstChannel.open();
    acknowledgeChat(firstChannel, local.id);
    acknowledgeChat(firstChannel, local.id);

    expect(harness.session.getSnapshot().messages).toContainEqual(
      expect.objectContaining({ id: local.id, deliveryState: 'sent' }),
    );
    await harness.session.leave();
  });

  it('keeps received chat tombstones across visible history eviction and channel replacement', async () => {
    const harness = createHarness({ maxChatMessages: 1 });
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
    const peer = harness.peerConnections[0];
    const originalChannel = peer?.channels[0];
    if (peer === undefined || originalChannel === undefined) {
      throw new Error('Expected a participant DataChannel');
    }
    const firstMessage = {
      type: 'chat.message',
      id: 'message-first',
      senderId: 'peer-a',
      sentAt: 1_600,
      text: 'first',
    };
    originalChannel.receive(firstMessage);
    originalChannel.receive({
      type: 'chat.message',
      id: 'message-second',
      senderId: 'peer-a',
      sentAt: 1_601,
      text: 'second',
    });

    const replacementChannel = new FakeDataChannel();
    peer.ondatachannel?.({
      channel: replacementChannel,
    } as unknown as RTCDataChannelEvent);
    replacementChannel.receive(firstMessage);

    expect(harness.session.getSnapshot().messages).toEqual([
      expect.objectContaining({ id: 'message-second', text: 'second' }),
    ]);
    expect(
      replacementChannel.sent
        .map((raw) => JSON.parse(raw) as { type: string; messageId?: string })
        .filter((message) => message.type === 'chat.ack' && message.messageId === 'message-first'),
    ).toHaveLength(1);
    await harness.session.leave();
  });

  it('fails an unacknowledged chat at its absolute delivery deadline and ignores a late ack', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({
        createId: () => 'message-timeout',
        wallClockNow: () => 1_700,
      });
      await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
      await answerPeer(harness, 'peer-a');
      const peer = harness.peerConnections[0];
      const channel = peer?.channels[0];
      if (peer === undefined || channel === undefined) {
        throw new Error('Expected a connected participant DataChannel');
      }
      peer.setConnectionState('connected');

      const local = harness.session.sendChat('확인 제한 시간');
      await vi.advanceTimersByTimeAsync(44_999);
      expect(harness.session.getSnapshot().messages).toContainEqual(
        expect.objectContaining({ id: local.id, deliveryState: 'pending' }),
      );

      await vi.advanceTimersByTimeAsync(1);
      expect(harness.session.getSnapshot().messages).toContainEqual(
        expect.objectContaining({ id: local.id, deliveryState: 'failed' }),
      );
      acknowledgeChat(channel, local.id);
      expect(harness.session.getSnapshot().messages).toContainEqual(
        expect.objectContaining({ id: local.id, deliveryState: 'failed' }),
      );
      await harness.session.leave();
    } finally {
      vi.useRealTimers();
    }
  });
});
