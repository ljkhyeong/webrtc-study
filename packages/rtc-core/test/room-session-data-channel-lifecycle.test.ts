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
  it('flushes chat queued while the data channel is connecting exactly once', async () => {
    const harness = createHarness({
      createId: () => 'message-queued',
      wallClockNow: () => 2_345,
    });
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
    const channel = harness.peerConnections[0]?.channels[0];
    expect(channel).toBeDefined();
    if (channel === undefined) {
      return;
    }

    channel.readyState = 'connecting';
    harness.session.sendChat('wait for the channel');

    expect(
      channel.sent
        .map((raw) => JSON.parse(raw) as { type: string })
        .filter((message) => message.type === 'chat.message'),
    ).toEqual([]);

    channel.open();
    channel.open();

    expect(
      channel.sent
        .map((raw) => JSON.parse(raw) as { type: string; id?: string })
        .filter((message) => message.type === 'chat.message'),
    ).toEqual([
      {
        type: 'chat.message',
        id: 'message-queued',
        senderId: 'self',
        sentAt: 2_345,
        text: 'wait for the channel',
      },
    ]);
  });

  it('queues chat for a newly announced peer until its incoming data channel opens', async () => {
    const harness = createHarness({
      createId: () => 'message-before-offer',
      wallClockNow: () => 3_456,
    });
    await joinSession(harness);

    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'peer.joined',
      roomId: 'abcd-efgh-jkmp',
      payload: {
        participant: { peerId: 'peer-a', displayName: 'Ara' },
      },
    });
    await flushMicrotasks();
    const peer = harness.peerConnections[0];
    expect(peer).toBeDefined();

    harness.session.sendChat('hello before offer');
    const incomingChannel = new FakeDataChannel();
    incomingChannel.readyState = 'connecting';
    peer?.ondatachannel?.({ channel: incomingChannel } as unknown as RTCDataChannelEvent);
    incomingChannel.open();

    expect(
      incomingChannel.sent
        .map((raw) => JSON.parse(raw) as { type: string; id?: string })
        .filter((message) => message.type === 'chat.message'),
    ).toEqual([
      {
        type: 'chat.message',
        id: 'message-before-offer',
        senderId: 'self',
        sentAt: 3_456,
        text: 'hello before offer',
      },
    ]);
  });

  it('preserves pending chat across a send exception and completes it after channel recovery', async () => {
    const harness = createHarness({
      createId: () => 'message-send-retry',
      wallClockNow: () => 3_500,
    });
    await joinSession(harness, [{ peerId: 'z-peer', displayName: 'Zoe' }], 'a-self');
    await answerPeer(harness, 'z-peer');
    const peer = harness.peerConnections[0];
    const failedChannel = peer?.channels[0];
    peer?.setConnectionState('connected');
    failedChannel?.sendErrors.push(new Error('buffer rejected'));

    const local = harness.session.sendChat('retry this message');
    await flushMicrotasks();

    expect(local.deliveryState).toBe('pending');
    expect(failedChannel?.readyState).toBe('closed');
    expect(peer?.channels).toHaveLength(2);
    expect(peer?.offerOptions).toEqual([undefined, { iceRestart: true }]);
    expect(harness.session.getSnapshot().messages).toContainEqual(
      expect.objectContaining({
        id: 'message-send-retry',
        deliveryState: 'pending',
      }),
    );
    expect(harness.session.getSnapshot().warning).toEqual(
      expect.objectContaining({ code: 'data-channel-send-failed' }),
    );

    const recoveredChannel = peer?.channels[1];
    if (recoveredChannel === undefined) {
      throw new Error('Expected a recovered DataChannel');
    }
    recoveredChannel.readyState = 'connecting';
    await answerPeer(harness, 'z-peer');
    expect(harness.session.getSnapshot().warning).toEqual(
      expect.objectContaining({ code: 'data-channel-send-failed' }),
    );
    recoveredChannel.open();

    expect(
      recoveredChannel.sent
        .map((raw) => JSON.parse(raw) as { type: string; id?: string })
        .filter(({ type }) => type === 'chat.message'),
    ).toEqual([
      expect.objectContaining({
        type: 'chat.message',
        id: 'message-send-retry',
      }),
    ]);
    acknowledgeChat(recoveredChannel, 'message-send-retry');
    expect(harness.session.getSnapshot().messages).toContainEqual(
      expect.objectContaining({
        id: 'message-send-retry',
        deliveryState: 'sent',
      }),
    );
    expect(harness.session.getSnapshot().warning).toBeNull();
    await harness.session.leave();
  });

  it('accepts an acknowledgement after a prior send and before replacement-channel retransmission', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({
        createId: () => 'message-ack-before-retransmit',
        wallClockNow: () => 3_550,
        recovery: { peerRecoveryTimeoutMs: 30 },
      });
      await joinSession(harness, [{ peerId: 'z-peer', displayName: 'Zoe' }], 'a-self');
      await answerPeer(harness, 'z-peer');
      const initialPeer = harness.peerConnections[0];
      const originalChannel = initialPeer?.channels[0];
      if (initialPeer === undefined || originalChannel === undefined) {
        throw new Error('Expected an initial peer and DataChannel');
      }
      initialPeer.setConnectionState('connected');

      const local = harness.session.sendChat('already accepted remotely');
      initialPeer.setConnectionState('failed');
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(30);
      await flushMicrotasks();

      const replacementChannel = harness.peerConnections[1]?.channels[0];
      if (replacementChannel === undefined) {
        throw new Error('Expected a replacement DataChannel');
      }
      expect(
        replacementChannel.sent
          .map((raw) => JSON.parse(raw) as { type: string })
          .filter((message) => message.type === 'chat.message'),
      ).toEqual([]);

      acknowledgeChat(replacementChannel, local.id);

      expect(harness.session.getSnapshot().messages).toContainEqual(
        expect.objectContaining({
          id: local.id,
          deliveryState: 'sent',
        }),
      );
      await harness.session.leave();
    } finally {
      vi.useRealTimers();
    }
  });

  it('recreates a closed channel and flushes chat that was waiting for it', async () => {
    const harness = createHarness({
      createId: () => 'message-channel-close',
      wallClockNow: () => 3_600,
    });
    await joinSession(harness, [{ peerId: 'z-peer', displayName: 'Zoe' }], 'a-self');
    await answerPeer(harness, 'z-peer');
    const peer = harness.peerConnections[0];
    const closedChannel = peer?.channels[0];
    peer?.setConnectionState('connected');
    if (peer === undefined || closedChannel === undefined) {
      throw new Error('Expected an initial peer and DataChannel');
    }
    closedChannel.readyState = 'connecting';
    harness.session.sendChat('wait through close');

    closedChannel.remoteClose();
    await flushMicrotasks();

    expect(peer.channels).toHaveLength(2);
    expect(peer.offerOptions).toEqual([undefined, { iceRestart: true }]);
    expect(harness.session.getSnapshot().messages).toContainEqual(
      expect.objectContaining({
        id: 'message-channel-close',
        deliveryState: 'pending',
      }),
    );
    expect(harness.session.getSnapshot().warning).toEqual(
      expect.objectContaining({ code: 'data-channel-closed' }),
    );

    const recoveredChannel = peer.channels[1];
    if (recoveredChannel === undefined) {
      throw new Error('Expected a recovered DataChannel');
    }
    recoveredChannel.readyState = 'connecting';
    await answerPeer(harness, 'z-peer');
    expect(harness.session.getSnapshot().warning).toEqual(
      expect.objectContaining({ code: 'data-channel-closed' }),
    );
    recoveredChannel.open();

    expect(
      recoveredChannel.sent
        .map((raw) => JSON.parse(raw) as { type: string; id?: string })
        .filter(({ type }) => type === 'chat.message'),
    ).toEqual([
      expect.objectContaining({
        type: 'chat.message',
        id: 'message-channel-close',
      }),
    ]);
    acknowledgeChat(recoveredChannel, 'message-channel-close');
    expect(harness.session.getSnapshot().messages).toContainEqual(
      expect.objectContaining({
        id: 'message-channel-close',
        deliveryState: 'sent',
      }),
    );
    expect(harness.session.getSnapshot().warning).toBeNull();
    await harness.session.leave();
  });

  it('keeps the recovery deadline active when an answered channel never opens', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({
        createId: () => 'message-stuck-channel',
        wallClockNow: () => 3_625,
        recovery: { peerRecoveryTimeoutMs: 30 },
      });
      await joinSession(harness, [{ peerId: 'z-peer', displayName: 'Zoe' }], 'a-self');
      await answerPeer(harness, 'z-peer');
      const initialPeer = harness.peerConnections[0];
      const initialChannel = initialPeer?.channels[0];
      initialPeer?.setConnectionState('connected');
      if (initialPeer === undefined || initialChannel === undefined) {
        throw new Error('Expected an initial peer and DataChannel');
      }

      initialChannel.remoteClose();
      await flushMicrotasks();
      const stuckChannel = initialPeer.channels[1];
      if (stuckChannel === undefined) {
        throw new Error('Expected a recovered DataChannel');
      }
      stuckChannel.readyState = 'connecting';
      harness.session.sendChat('survive a stuck recovery');

      await answerPeer(harness, 'z-peer');
      expect(harness.session.getSnapshot().warning).toEqual(
        expect.objectContaining({ code: 'data-channel-closed' }),
      );

      await vi.advanceTimersByTimeAsync(30);
      await flushMicrotasks();

      const replacement = harness.peerConnections[1];
      expect(initialPeer.closed).toBe(true);
      expect(replacement).toBeDefined();
      expect(harness.session.getSnapshot()).toMatchObject({
        warning: { code: 'peer-connection-recreated' },
        messages: [
          expect.objectContaining({
            id: 'message-stuck-channel',
            deliveryState: 'pending',
          }),
        ],
      });

      await answerPeer(harness, 'z-peer');
      replacement?.setConnectionState('connected');
      const replacementChannel = replacement?.channels[0];
      if (replacementChannel === undefined) {
        throw new Error('Expected a replacement DataChannel');
      }

      expect(
        replacementChannel.sent
          .map((raw) => JSON.parse(raw) as { type: string; id?: string })
          .filter(({ type }) => type === 'chat.message'),
      ).toEqual([
        expect.objectContaining({
          type: 'chat.message',
          id: 'message-stuck-channel',
        }),
      ]);
      acknowledgeChat(replacementChannel, 'message-stuck-channel');
      expect(harness.session.getSnapshot()).toMatchObject({
        warning: null,
        messages: [
          expect.objectContaining({
            id: 'message-stuck-channel',
            deliveryState: 'sent',
          }),
        ],
      });
      await harness.session.leave();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails a replacement whose peer connection connects without an open channel', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({
        createId: () => 'message-second-stuck-channel',
        wallClockNow: () => 3_630,
        recovery: {
          peerConnectionTimeoutMs: 20,
          peerRecoveryTimeoutMs: 30,
        },
      });
      await joinSession(harness, [{ peerId: 'z-peer', displayName: 'Zoe' }], 'a-self');
      await answerPeer(harness, 'z-peer');
      const initialPeer = harness.peerConnections[0];
      const initialChannel = initialPeer?.channels[0];
      initialPeer?.setConnectionState('connected');
      if (initialPeer === undefined || initialChannel === undefined) {
        throw new Error('Expected an initial peer and DataChannel');
      }

      initialChannel.remoteClose();
      await flushMicrotasks();
      const firstRecoveredChannel = initialPeer.channels[1];
      if (firstRecoveredChannel === undefined) {
        throw new Error('Expected a recovered DataChannel');
      }
      firstRecoveredChannel.readyState = 'connecting';
      harness.session.sendChat('fail after the bounded replacement');
      await answerPeer(harness, 'z-peer');

      await vi.advanceTimersByTimeAsync(30);
      await flushMicrotasks();
      const replacement = harness.peerConnections[1];
      const replacementChannel = replacement?.channels[0];
      if (replacement === undefined || replacementChannel === undefined) {
        throw new Error('Expected a replacement peer and DataChannel');
      }
      replacementChannel.readyState = 'connecting';

      await answerPeer(harness, 'z-peer');
      replacement.setConnectionState('connected');
      await vi.advanceTimersByTimeAsync(20);
      await flushMicrotasks();

      expect(replacement.closed).toBe(true);
      expect(harness.session.getSnapshot()).toMatchObject({
        warning: { code: 'peer-connection-timeout' },
        participants: expect.arrayContaining([
          expect.objectContaining({ peerId: 'z-peer', connectionState: 'failed' }),
        ]),
        messages: [
          expect.objectContaining({
            id: 'message-second-stuck-channel',
            deliveryState: 'failed',
          }),
        ],
      });
      await harness.session.leave();
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for the designated remote initiator after a responder channel closes', async () => {
    const harness = createHarness({
      createId: () => 'message-responder-close',
      wallClockNow: () => 3_650,
    });
    await joinSession(harness, [{ peerId: 'a-peer', displayName: 'Ara' }], 'z-self');
    await answerPeer(harness, 'a-peer');
    const peer = harness.peerConnections[0];
    const channel = peer?.channels[0];
    peer?.setConnectionState('connected');
    if (peer === undefined || channel === undefined) {
      throw new Error('Expected an initial peer and DataChannel');
    }
    channel.readyState = 'connecting';
    harness.session.sendChat('wait for the remote initiator');

    channel.remoteClose();
    await flushMicrotasks();

    expect(peer.channels).toHaveLength(1);
    expect(peer.offerOptions).toEqual([undefined]);
    expect(harness.socket.messagesOfType('rtc.offer')).toHaveLength(1);
    expect(harness.session.getSnapshot().messages).toContainEqual(
      expect.objectContaining({
        id: 'message-responder-close',
        deliveryState: 'pending',
      }),
    );
    await harness.session.leave();
  });

  it('rejects a saturated outbound queue without a false local success', async () => {
    let sequence = 0;
    const harness = createHarness({
      createId: () => `message-${sequence++}`,
      wallClockNow: () => 3_700,
    });
    await joinSession(harness, [
      { peerId: 'peer-a', displayName: 'Ara' },
      { peerId: 'peer-b', displayName: 'Bora' },
    ]);
    const saturatedChannel = harness.peerConnections[0]?.channels[0];
    const healthyChannel = harness.peerConnections[1]?.channels[0];
    if (saturatedChannel === undefined || healthyChannel === undefined) {
      throw new Error('Expected both initial DataChannels');
    }
    saturatedChannel.readyState = 'connecting';

    for (let index = 0; index < 50; index += 1) {
      harness.session.sendChat(`queued ${index}`);
    }
    const healthyChatCount = healthyChannel.sent
      .map((raw) => JSON.parse(raw) as { type: string })
      .filter((message) => message.type === 'chat.message').length;

    expect(() => harness.session.sendChat('must not appear locally')).toThrow(
      'Chat delivery queue for peer-a is full',
    );
    expect(harness.session.getSnapshot().messages).toHaveLength(50);
    expect(harness.session.getSnapshot().messages).not.toContainEqual(
      expect.objectContaining({ text: 'must not appear locally' }),
    );
    expect(
      harness.session
        .getSnapshot()
        .messages.every((message) => message.deliveryState === 'pending'),
    ).toBe(true);
    expect(
      healthyChannel.sent
        .map((raw) => JSON.parse(raw) as { type: string })
        .filter((message) => message.type === 'chat.message'),
    ).toHaveLength(healthyChatCount);
    await harness.session.leave();
  });

  it('bounds unacknowledged chat on an open channel and frees one slot per ack', async () => {
    let sequence = 0;
    const harness = createHarness({
      createId: () => `message-open-${sequence++}`,
      wallClockNow: () => 3_725,
    });
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
    const channel = harness.peerConnections[0]?.channels[0];
    if (channel === undefined) {
      throw new Error('Expected an open participant DataChannel');
    }

    for (let index = 0; index < 50; index += 1) {
      harness.session.sendChat(`unacknowledged ${index}`);
    }

    expect(() => harness.session.sendChat('queue full')).toThrow(
      'Chat delivery queue for peer-a is full',
    );
    acknowledgeChat(channel, 'message-open-0');
    expect(() => harness.session.sendChat('slot recovered')).not.toThrow();
    expect(
      channel.sent
        .map((raw) => JSON.parse(raw) as { type: string })
        .filter((message) => message.type === 'chat.message'),
    ).toHaveLength(51);
    await harness.session.leave();
  });

  it('pauses chat at the DataChannel high-water mark and resumes at low-water', async () => {
    const harness = createHarness({
      createId: () => 'message-backpressured',
      wallClockNow: () => 3_740,
    });
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
    const channel = harness.peerConnections[0]?.channels[0];
    if (channel === undefined) {
      throw new Error('Expected an open participant DataChannel');
    }
    channel.bufferedAmount = 256 * 1024;

    const local = harness.session.sendChat('wait for bufferedamountlow');
    expect(
      channel.sent
        .map((raw) => JSON.parse(raw) as { type: string })
        .filter((message) => message.type === 'chat.message'),
    ).toEqual([]);
    expect(local.deliveryState).toBe('pending');

    channel.drainBufferedAmount(64 * 1024);

    expect(
      channel.sent
        .map((raw) => JSON.parse(raw) as { type: string; id?: string })
        .filter((message) => message.type === 'chat.message'),
    ).toEqual([
      expect.objectContaining({
        type: 'chat.message',
        id: local.id,
      }),
    ]);
    acknowledgeChat(channel, local.id);
    expect(harness.session.getSnapshot().messages).toContainEqual(
      expect.objectContaining({ id: local.id, deliveryState: 'sent' }),
    );
    await harness.session.leave();
  });

  it('accounts for consecutive UTF-8 frames when pausing and resuming chat', async () => {
    let sequence = 0;
    const harness = createHarness({
      createId: () => `message-buffered-${sequence++}`,
      wallClockNow: () => 3_745,
    });
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
    const channel = harness.peerConnections[0]?.channels[0];
    if (channel === undefined) {
      throw new Error('Expected an open participant DataChannel');
    }
    channel.drainBufferedAmount();

    for (let index = 0; index < 25; index += 1) {
      harness.session.sendChat('가'.repeat(4_000));
    }

    const sentBeforeDrain = channel.sent
      .map((raw) => JSON.parse(raw) as { type: string })
      .filter((message) => message.type === 'chat.message').length;
    expect(sentBeforeDrain).toBeGreaterThan(0);
    expect(sentBeforeDrain).toBeLessThan(25);
    expect(channel.bufferedAmount).toBeLessThanOrEqual(256 * 1024);

    channel.drainBufferedAmount(64 * 1024);

    expect(
      channel.sent
        .map((raw) => JSON.parse(raw) as { type: string })
        .filter((message) => message.type === 'chat.message'),
    ).toHaveLength(25);
    expect(channel.bufferedAmount).toBeLessThanOrEqual(256 * 1024);
    await harness.session.leave();
  });

  it('prioritizes acknowledgements within the bounded control-frame reserve', async () => {
    const harness = createHarness({
      createId: () => 'message-waiting-behind-acks',
      wallClockNow: () => 3_746,
    });
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
    const channel = harness.peerConnections[0]?.channels[0];
    if (channel === undefined) {
      throw new Error('Expected an open participant DataChannel');
    }
    channel.bufferedAmount = 256 * 1024;
    const local = harness.session.sendChat('wait behind acknowledgement controls');

    for (let index = 0; index < 120; index += 1) {
      channel.receive({
        type: 'chat.message',
        id: `message-${index.toString().padStart(3, '0')}-${'가'.repeat(112)}`,
        senderId: 'peer-a',
        sentAt: 3_747 + index,
        text: `remote ${index}`,
      });
    }

    const acknowledgementsBeforeDrain = channel.sent
      .map((raw) => JSON.parse(raw) as { type: string })
      .filter((message) => message.type === 'chat.ack');
    expect(acknowledgementsBeforeDrain.length).toBeGreaterThan(0);
    expect(acknowledgementsBeforeDrain.length).toBeLessThan(120);
    expect(
      channel.sent
        .map((raw) => JSON.parse(raw) as { type: string })
        .filter((message) => message.type === 'chat.message'),
    ).toEqual([]);
    expect(channel.bufferedAmount).toBeGreaterThan(256 * 1024);
    expect(channel.bufferedAmount).toBeLessThanOrEqual(288 * 1024);

    const sentFrameCountBeforeDrain = channel.sent.length;
    channel.drainBufferedAmount(64 * 1024);
    const framesAfterDrain = channel.sent
      .slice(sentFrameCountBeforeDrain)
      .map((raw) => JSON.parse(raw) as { type: string; id?: string });

    expect(
      channel.sent
        .map((raw) => JSON.parse(raw) as { type: string })
        .filter((message) => message.type === 'chat.ack'),
    ).toHaveLength(120);
    expect(framesAfterDrain.at(-1)).toMatchObject({
      type: 'chat.message',
      id: local.id,
    });
    expect(channel.bufferedAmount).toBeLessThanOrEqual(256 * 1024);
    await harness.session.leave();
  });

  it('finishes evicted pending chat without restoring it to visible history', async () => {
    let sequence = 0;
    const harness = createHarness({
      createId: () => `message-evicted-${sequence++}`,
      maxChatMessages: 1,
      wallClockNow: () => 3_750,
    });
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
    const channel = harness.peerConnections[0]?.channels[0];
    if (channel === undefined) {
      throw new Error('Expected an initial DataChannel');
    }
    channel.readyState = 'connecting';

    harness.session.sendChat('first pending');
    harness.session.sendChat('second pending');

    expect(harness.session.getSnapshot().messages).toEqual([
      expect.objectContaining({
        id: 'message-evicted-1',
        deliveryState: 'pending',
      }),
    ]);

    channel.open();
    channel.open();

    expect(
      channel.sent
        .map((raw) => JSON.parse(raw) as { type: string; id?: string })
        .filter((message) => message.type === 'chat.message'),
    ).toEqual([
      expect.objectContaining({ id: 'message-evicted-0' }),
      expect.objectContaining({ id: 'message-evicted-1' }),
    ]);
    acknowledgeChat(channel, 'message-evicted-0');
    acknowledgeChat(channel, 'message-evicted-1');
    expect(harness.session.getSnapshot().messages).toEqual([
      expect.objectContaining({
        id: 'message-evicted-1',
        deliveryState: 'sent',
      }),
    ]);
  });

  it('marks queued local chat as failed when its peer leaves before delivery', async () => {
    const generatedIds = ['message-peer-left', 'message-after-left', 'message-peer-left'];
    let idIndex = 0;
    const harness = createHarness({
      createId: () => generatedIds[idIndex++] ?? 'unexpected-message-id',
      maxChatMessages: 1,
      wallClockNow: () => 3_800,
    });
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
    const channel = harness.peerConnections[0]?.channels[0];
    if (channel === undefined) {
      throw new Error('Expected an initial DataChannel');
    }
    channel.readyState = 'connecting';
    harness.session.sendChat('do not report this as sent');

    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'peer.left',
      roomId: ROOM_ID,
      payload: { peerId: 'peer-a' },
    });
    await flushMicrotasks();

    expect(harness.session.getSnapshot().messages).toContainEqual(
      expect.objectContaining({
        id: 'message-peer-left',
        deliveryState: 'failed',
      }),
    );

    harness.session.sendChat('evict the failed message after the peer leaves');
    expect(() => harness.session.sendChat('must not immediately reuse the retired id')).toThrow(
      'Chat message id message-peer-left is already in use',
    );

    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'peer.joined',
      roomId: ROOM_ID,
      payload: {
        participant: { peerId: 'peer-a', displayName: 'Ara' },
      },
    });
    await flushMicrotasks();
    const rejoinedPeer = harness.peerConnections[1];
    const rejoinedChannel = new FakeDataChannel();
    rejoinedPeer?.ondatachannel?.({ channel: rejoinedChannel } as unknown as RTCDataChannelEvent);
    expect(
      rejoinedChannel.sent
        .map((raw) => JSON.parse(raw) as { type: string })
        .filter((message) => message.type === 'chat.message'),
    ).toEqual([]);
    await harness.session.leave();
  });

  it('reports a data channel error when the peer remains active', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      await joinSession(harness, [{ peerId: 'z-peer', displayName: 'Zoe' }], 'a-self');
      await answerPeer(harness, 'z-peer');
      const peer = harness.peerConnections[0];
      const channel = peer?.channels[0];
      peer?.setConnectionState('connected');

      channel?.fail();
      await vi.advanceTimersByTimeAsync(251);

      expect(harness.session.getSnapshot().warning).toEqual({
        code: 'data-channel-error',
        message: 'Chat channel to z-peer encountered an error and is being recovered',
      });

      const recoveredChannel = peer?.channels[1];
      if (recoveredChannel === undefined) {
        throw new Error('Expected a recovered DataChannel');
      }
      recoveredChannel.readyState = 'connecting';
      await answerPeer(harness, 'z-peer');
      expect(harness.session.getSnapshot().warning).toEqual(
        expect.objectContaining({ code: 'data-channel-error' }),
      );

      recoveredChannel.open();

      expect(harness.session.getSnapshot().warning).toBeNull();
      await harness.session.leave();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears a closed channel warning when the owning peer leaves', async () => {
    const harness = createHarness();
    await joinSession(harness, [{ peerId: 'z-peer', displayName: 'Zoe' }], 'a-self');
    await answerPeer(harness, 'z-peer');
    const peer = harness.peerConnections[0];
    const channel = peer?.channels[0];
    peer?.setConnectionState('connected');
    if (channel === undefined) {
      throw new Error('Expected an initial DataChannel');
    }

    channel.remoteClose();
    await flushMicrotasks();

    expect(harness.session.getSnapshot().warning).toEqual(
      expect.objectContaining({ code: 'data-channel-closed' }),
    );

    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'peer.left',
      roomId: ROOM_ID,
      payload: { peerId: 'z-peer' },
    });
    await flushMicrotasks();

    expect(harness.session.getSnapshot().warning).toBeNull();
    expect(harness.session.getSnapshot().participants).not.toContainEqual(
      expect.objectContaining({ peerId: 'z-peer' }),
    );
    await harness.session.leave();
  });

  it('suppresses a data channel error that races a normal peer departure', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
      const channel = harness.peerConnections[0]?.channels[0];

      channel?.fail();
      harness.socket.serverMessage({
        v: PROTOCOL_VERSION,
        type: 'peer.left',
        roomId: 'abcd-efgh-jkmp',
        payload: { peerId: 'peer-a' },
      });
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(251);

      expect(harness.session.getSnapshot().warning).toBeNull();
      expect(harness.session.getSnapshot().participants).not.toContainEqual(
        expect.objectContaining({ peerId: 'peer-a' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
