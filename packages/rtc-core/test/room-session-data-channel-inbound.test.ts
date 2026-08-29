import { describe, expect, it, vi } from 'vitest';

import { PROTOCOL_VERSION } from '@round/protocol';

import {
  FakeDataChannel,
  FakeMediaStream,
  FakeTrack,
  ROOM_ID,
  answerPeer,
  createHarness,
  flushMicrotasks,
  joinSession,
} from './room-session.test-support.js';

function exceedInboundDataBudget(channel: FakeDataChannel): void {
  for (let index = 0; index <= 120; index += 1) {
    channel.receiveRaw('not-json');
  }
}

describe('RoomSession', () => {
  it('rejects oversized and structurally invalid DataChannel messages', async () => {
    const harness = createHarness();
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
    const channel = harness.peerConnections[0]?.channels[0];
    expect(channel).toBeDefined();
    if (channel === undefined) {
      return;
    }

    channel.receive({
      type: 'chat.message',
      id: 'message-invalid-date',
      senderId: 'peer-a',
      text: 'invalid date',
      sentAt: 1e300,
    });
    channel.receive({
      type: 'chat.message',
      id: 'x'.repeat(129),
      senderId: 'peer-a',
      text: 'oversized id',
      sentAt: 1_000,
    });
    channel.receive({
      type: 'chat.message',
      id: 'message-oversized-sender',
      senderId: 'x'.repeat(129),
      text: 'oversized sender',
      sentAt: 1_000,
    });
    channel.receive({
      type: 'chat.message',
      id: 'message-extra-key',
      senderId: 'peer-a',
      text: 'extra key',
      sentAt: 1_000,
      unexpected: true,
    });
    channel.receive({
      type: 'participant.media',
      audioEnabled: true,
      videoEnabled: true,
      unexpected: true,
    });

    expect(
      harness.session
        .getSnapshot()
        .participants.find((participant) => participant.peerId === 'peer-a'),
    ).toMatchObject({
      audioEnabled: false,
      videoEnabled: false,
    });

    const oversizedRaw = JSON.stringify({
      type: 'chat.message',
      id: 'message-oversized-raw',
      senderId: 'peer-a',
      text: '가'.repeat(12_000),
      sentAt: 1_000,
    });
    expect(oversizedRaw.length).toBeLessThan(32 * 1024);
    expect(new TextEncoder().encode(oversizedRaw).byteLength).toBeGreaterThan(32 * 1024);
    const parseSpy = vi.spyOn(JSON, 'parse');
    try {
      channel.receiveRaw(oversizedRaw);
      expect(parseSpy).not.toHaveBeenCalled();
    } finally {
      parseSpy.mockRestore();
    }

    channel.receive({
      type: 'participant.media',
      audioEnabled: true,
      videoEnabled: true,
    });
    channel.receive({
      type: 'chat.message',
      id: 'message-valid',
      senderId: 'spoofed-peer',
      text: 'valid message',
      sentAt: 1_001,
    });

    expect(
      harness.session
        .getSnapshot()
        .participants.find((participant) => participant.peerId === 'peer-a'),
    ).toMatchObject({
      audioEnabled: true,
      videoEnabled: true,
    });
    expect(harness.session.getSnapshot().messages).toEqual([
      {
        id: 'message-valid',
        senderId: 'peer-a',
        senderName: 'Ara',
        text: 'valid message',
        sentAt: 1_001,
        isLocal: false,
        deliveryState: 'received',
      },
    ]);
  });

  it('preserves semantic remote media state when an enabled track arrives late', async () => {
    const harness = createHarness();
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
    const peer = harness.peerConnections[0];
    const channel = peer?.channels[0];
    if (peer === undefined || channel === undefined) {
      throw new Error('Expected a peer and DataChannel');
    }
    channel.receive({
      type: 'participant.media',
      audioEnabled: false,
      videoEnabled: false,
      videoSource: 'screen',
    });

    const remoteAudio = new FakeTrack('audio');
    const remoteVideo = new FakeTrack('video');
    const remoteStream = new FakeMediaStream([remoteAudio, remoteVideo]);
    peer.ontrack?.({
      track: remoteVideo as unknown as MediaStreamTrack,
      streams: [remoteStream as unknown as MediaStream],
    } as unknown as RTCTrackEvent);

    expect(
      harness.session
        .getSnapshot()
        .participants.find((participant) => participant.peerId === 'peer-a'),
    ).toMatchObject({
      audioEnabled: false,
      videoEnabled: false,
      videoSource: 'screen',
    });
    await harness.session.leave();
  });

  it('rate-limits DataChannel work per peer and expires the warning with its fixed window', async () => {
    vi.useFakeTimers();
    try {
      let wallClockNow = 50_000;
      let monotonicNow = 10_000;
      const harness = createHarness({
        wallClockNow: () => wallClockNow,
        monotonicNow: () => monotonicNow,
      });
      await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
      const channel = harness.peerConnections[0]?.channels[0];
      expect(channel).toBeDefined();
      if (channel === undefined) {
        return;
      }

      for (let index = 0; index < 120; index += 1) {
        channel.receiveRaw('not-json');
      }
      channel.receive({
        type: 'chat.message',
        id: 'message-over-limit',
        senderId: 'peer-a',
        text: 'must be dropped',
        sentAt: wallClockNow,
      });

      expect(harness.session.getSnapshot()).toMatchObject({
        messages: [],
        warning: {
          code: 'data-channel-rate-limit',
          message: 'Ignored excessive DataChannel messages from peer-a',
        },
      });

      wallClockNow = 40_000;
      expect(harness.session.sendChat('wall clock rollback')).toMatchObject({ sentAt: 40_000 });
      expect(harness.session.getSnapshot().warning).toEqual(
        expect.objectContaining({ code: 'data-channel-rate-limit' }),
      );

      monotonicNow = 19_999;
      await vi.advanceTimersByTimeAsync(9_999);
      channel.receive({
        type: 'chat.message',
        id: 'message-before-window-boundary',
        senderId: 'peer-a',
        text: 'must remain limited at 9999ms',
        sentAt: wallClockNow,
      });
      expect(harness.session.getSnapshot().messages).not.toContainEqual(
        expect.objectContaining({ id: 'message-before-window-boundary' }),
      );
      expect(harness.session.getSnapshot().warning).toEqual(
        expect.objectContaining({ code: 'data-channel-rate-limit' }),
      );

      monotonicNow = 20_000;
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.session.getSnapshot().warning).toBeNull();

      channel.receive({
        type: 'chat.message',
        id: 'message-after-window',
        senderId: 'peer-a',
        text: 'accepted after reset',
        sentAt: wallClockNow,
      });

      expect(harness.session.getSnapshot().messages).toContainEqual({
        id: 'message-after-window',
        senderId: 'peer-a',
        senderName: 'Ara',
        text: 'accepted after reset',
        sentAt: wallClockNow,
        isLocal: false,
        deliveryState: 'received',
      });
      await harness.session.leave();
    } finally {
      vi.useRealTimers();
    }
  });

  it('lazily clears a rate-limit warning when the fixed-window timer is delayed', async () => {
    vi.useFakeTimers();
    try {
      let now = 10_000;
      const harness = createHarness({ monotonicNow: () => now });
      await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
      const channel = harness.peerConnections[0]?.channels[0];
      if (channel === undefined) {
        throw new Error('Expected an initial DataChannel');
      }

      exceedInboundDataBudget(channel);
      expect(harness.session.getSnapshot().warning).toEqual(
        expect.objectContaining({ code: 'data-channel-rate-limit' }),
      );

      now = 20_000;
      channel.receiveRaw('still-not-json');

      expect(harness.session.getSnapshot().warning).toBeNull();
      await harness.session.leave();
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves the inbound quota and expiry deadline across peer replacement', async () => {
    vi.useFakeTimers();
    try {
      let now = 10_000;
      const harness = createHarness({
        monotonicNow: () => now,
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

      exceedInboundDataBudget(initialChannel);
      initialPeer.setConnectionState('failed');
      await flushMicrotasks();

      now = 10_030;
      await vi.advanceTimersByTimeAsync(30);
      await flushMicrotasks();
      const replacement = harness.peerConnections[1];
      const replacementChannel = replacement?.channels[0];
      if (replacement === undefined || replacementChannel === undefined) {
        throw new Error('Expected a replacement peer and DataChannel');
      }
      expect(initialPeer.closed).toBe(true);

      await answerPeer(harness, 'z-peer');
      replacement.setConnectionState('connected');
      replacementChannel.receive({
        type: 'chat.message',
        id: 'message-before-rate-window-expiry',
        senderId: 'z-peer',
        text: 'must remain limited after replacement',
        sentAt: now,
      });

      expect(harness.session.getSnapshot()).toMatchObject({
        messages: [],
        warning: { code: 'data-channel-rate-limit' },
      });

      now = 20_000;
      await vi.advanceTimersByTimeAsync(9_970);
      expect(harness.session.getSnapshot().warning).toBeNull();

      replacementChannel.receive({
        type: 'chat.message',
        id: 'message-after-replacement-window',
        senderId: 'z-peer',
        text: 'accepted after the original deadline',
        sentAt: now,
      });

      expect(harness.session.getSnapshot().messages).toEqual([
        expect.objectContaining({
          id: 'message-after-replacement-window',
          deliveryState: 'received',
        }),
      ]);
      await harness.session.leave();
    } finally {
      vi.useRealTimers();
    }
  });

  it('accounts for a post-window frame before notifying warning-clear subscribers', async () => {
    vi.useFakeTimers();
    try {
      let now = 10_000;
      const harness = createHarness({ monotonicNow: () => now });
      await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
      const channel = harness.peerConnections[0]?.channels[0];
      if (channel === undefined) {
        throw new Error('Expected an initial DataChannel');
      }

      exceedInboundDataBudget(channel);
      let reentered = false;
      const unsubscribe = harness.session.subscribe((snapshot) => {
        if (reentered || snapshot.warning !== null) {
          return;
        }
        reentered = true;
        for (let index = 0; index < 120; index += 1) {
          channel.receiveRaw('reentered-not-json');
        }
      });

      now = 20_000;
      channel.receiveRaw('post-window-not-json');

      expect(reentered).toBe(true);
      expect(harness.session.getSnapshot().warning).toEqual(
        expect.objectContaining({ code: 'data-channel-rate-limit' }),
      );
      unsubscribe();
      await harness.session.leave();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps rate-limit warning ownership stable and hands off continued excess', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      await joinSession(harness, [
        { peerId: 'peer-a', displayName: 'Ara' },
        { peerId: 'peer-b', displayName: 'Bo' },
        { peerId: 'peer-c', displayName: 'Cy' },
      ]);
      const firstChannel = harness.peerConnections[0]?.channels[0];
      const secondChannel = harness.peerConnections[1]?.channels[0];
      if (firstChannel === undefined || secondChannel === undefined) {
        throw new Error('Expected both initial DataChannels');
      }

      exceedInboundDataBudget(firstChannel);
      exceedInboundDataBudget(secondChannel);
      expect(harness.session.getSnapshot().warning).toEqual({
        code: 'data-channel-rate-limit',
        message: 'Ignored excessive DataChannel messages from peer-a',
      });

      harness.socket.serverMessage({
        v: PROTOCOL_VERSION,
        type: 'peer.left',
        roomId: ROOM_ID,
        payload: { peerId: 'peer-c' },
      });
      await flushMicrotasks();
      expect(harness.session.getSnapshot().warning).toEqual({
        code: 'data-channel-rate-limit',
        message: 'Ignored excessive DataChannel messages from peer-a',
      });

      harness.socket.serverMessage({
        v: PROTOCOL_VERSION,
        type: 'peer.left',
        roomId: ROOM_ID,
        payload: { peerId: 'peer-a' },
      });
      await flushMicrotasks();

      expect(harness.session.getSnapshot().warning).toBeNull();

      secondChannel.receiveRaw('still-over-limit');
      expect(harness.session.getSnapshot().warning).toEqual({
        code: 'data-channel-rate-limit',
        message: 'Ignored excessive DataChannel messages from peer-b',
      });

      harness.socket.serverMessage({
        v: PROTOCOL_VERSION,
        type: 'peer.left',
        roomId: ROOM_ID,
        payload: { peerId: 'peer-b' },
      });
      await flushMicrotasks();
      expect(harness.session.getSnapshot().warning).toBeNull();
      await harness.session.leave();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears a peer-owned rate-limit warning and its timer on local leave', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
      const channel = harness.peerConnections[0]?.channels[0];
      if (channel === undefined) {
        throw new Error('Expected an initial DataChannel');
      }

      exceedInboundDataBudget(channel);
      expect(harness.session.getSnapshot().warning).toEqual(
        expect.objectContaining({ code: 'data-channel-rate-limit' }),
      );

      await harness.session.leave();
      await vi.advanceTimersByTimeAsync(10_000);

      expect(harness.session.getSnapshot()).toMatchObject({
        status: 'ended',
        warning: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let a rate-limit warning replace a current operational warning', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
      const peer = harness.peerConnections[0];
      const channel = peer?.channels[0];
      if (peer === undefined || channel === undefined) {
        throw new Error('Expected an initial peer and DataChannel');
      }
      peer.setConfigurationError = new DOMException(
        'configuration rejected',
        'InvalidModificationError',
      );
      harness.session.updateRtcConfiguration({
        iceServers: [{ urls: 'turn:refreshed.example.test' }],
      });

      exceedInboundDataBudget(channel);

      expect(harness.session.getSnapshot().warning).toEqual({
        code: 'rtc-configuration-update-failed',
        message:
          'Could not apply refreshed ICE configuration to 1 peer connection(s); existing connections remain active',
      });

      harness.socket.serverMessage({
        v: PROTOCOL_VERSION,
        type: 'peer.left',
        roomId: ROOM_ID,
        payload: { peerId: 'peer-a' },
      });
      await flushMicrotasks();

      expect(harness.session.getSnapshot().warning).toEqual(
        expect.objectContaining({ code: 'rtc-configuration-update-failed' }),
      );
      await harness.session.leave();
    } finally {
      vi.useRealTimers();
    }
  });
});
