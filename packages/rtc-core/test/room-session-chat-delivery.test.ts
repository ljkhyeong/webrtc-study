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

  it('rejects a reused local message id before mutating history or peer queues', async () => {
    const harness = createHarness({
      createId: () => 'message-collision',
      wallClockNow: () => 1_500,
    });
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
    const channel = harness.peerConnections[0]?.channels[0];
    if (channel === undefined) {
      throw new Error('Expected a participant DataChannel');
    }

    harness.session.sendChat('first');

    expect(() => harness.session.sendChat('must be rejected')).toThrow(
      'Chat message id message-collision is already in use',
    );
    expect(harness.session.getSnapshot().messages).toHaveLength(1);
    expect(
      channel.sent
        .map((raw) => JSON.parse(raw) as { type: string })
        .filter((message) => message.type === 'chat.message'),
    ).toHaveLength(1);
    await harness.session.leave();
  });

  it('keeps a completed local message id reserved after visible history eviction', async () => {
    const harness = createHarness({
      createId: () => 'message-completed-collision',
      maxChatMessages: 1,
      wallClockNow: () => 1_550,
    });
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
    const channel = harness.peerConnections[0]?.channels[0];
    if (channel === undefined) {
      throw new Error('Expected a participant DataChannel');
    }

    const local = harness.session.sendChat('completed before eviction');
    acknowledgeChat(channel, local.id);
    channel.receive({
      type: 'chat.message',
      id: 'message-remote',
      senderId: 'peer-a',
      sentAt: 1_551,
      text: 'evicts the local message',
    });

    expect(harness.session.getSnapshot().messages).toEqual([
      expect.objectContaining({ id: 'message-remote' }),
    ]);
    expect(() => harness.session.sendChat('must still be rejected')).toThrow(
      'Chat message id message-completed-collision is already in use',
    );
    expect(
      channel.sent
        .map((raw) => JSON.parse(raw) as { type: string })
        .filter((message) => message.type === 'chat.message'),
    ).toHaveLength(1);
    await harness.session.leave();
  });

  it('bounds retired local ids while pinning an evicted pending id through channel replacement', async () => {
    const replayWindowSize = 128;
    const generatedIds = [
      'message-pinned',
      ...Array.from({ length: replayWindowSize + 2 }, (_, index) => `message-retired-${index}`),
      'message-pinned',
      'message-pinned',
      'message-retired-0',
    ];
    let idIndex = 0;
    let now = 2_000;
    const harness = createHarness({
      createId: () => generatedIds[idIndex++] ?? 'unexpected-message-id',
      maxChatMessages: 1,
      wallClockNow: () => now,
      monotonicNow: () => now,
    });
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
    const peer = harness.peerConnections[0];
    const originalChannel = peer?.channels[0];
    if (peer === undefined || originalChannel === undefined) {
      throw new Error('Expected an initial peer and DataChannel');
    }

    const pinned = harness.session.sendChat('stay pending beyond the replay window');
    for (let index = 0; index < replayWindowSize + 2; index += 1) {
      now += 10_001;
      const completed = harness.session.sendChat(`completed ${index}`);
      acknowledgeChat(originalChannel, completed.id);
    }

    expect(harness.session.getSnapshot().messages).toEqual([
      expect.objectContaining({
        id: `message-retired-${replayWindowSize + 1}`,
        deliveryState: 'sent',
      }),
    ]);
    const sentChatCount = originalChannel.sent
      .map((raw) => JSON.parse(raw) as { type: string })
      .filter((message) => message.type === 'chat.message').length;
    expect(() => harness.session.sendChat('must not reuse the pending id')).toThrow(
      'Chat message id message-pinned is already in use',
    );
    expect(
      originalChannel.sent
        .map((raw) => JSON.parse(raw) as { type: string })
        .filter((message) => message.type === 'chat.message'),
    ).toHaveLength(sentChatCount);

    const replacementChannel = new FakeDataChannel();
    replacementChannel.readyState = 'connecting';
    peer.ondatachannel?.({ channel: replacementChannel } as unknown as RTCDataChannelEvent);

    acknowledgeChat(originalChannel, pinned.id);
    replacementChannel.open();
    expect(
      replacementChannel.sent
        .map((raw) => JSON.parse(raw) as { type: string; id?: string })
        .filter((message) => message.type === 'chat.message'),
    ).toEqual([expect.objectContaining({ id: pinned.id })]);

    now += 10_001;
    acknowledgeChat(replacementChannel, pinned.id);
    expect(() => harness.session.sendChat('must not immediately reuse the late-acked id')).toThrow(
      'Chat message id message-pinned is already in use',
    );

    const recycled = harness.session.sendChat('the oldest retired id is reusable');
    expect(recycled.id).toBe('message-retired-0');
    expect(harness.session.getSnapshot().messages).toEqual([
      expect.objectContaining({
        id: 'message-retired-0',
        text: 'the oldest retired id is reusable',
        isLocal: true,
        deliveryState: 'pending',
      }),
    ]);
    acknowledgeChat(originalChannel, recycled.id);
    expect(harness.session.getSnapshot().messages).toEqual([
      expect.objectContaining({
        id: 'message-retired-0',
        deliveryState: 'pending',
      }),
    ]);
    acknowledgeChat(replacementChannel, recycled.id);
    expect(harness.session.getSnapshot().messages).toEqual([
      expect.objectContaining({
        id: 'message-retired-0',
        deliveryState: 'sent',
      }),
    ]);
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
