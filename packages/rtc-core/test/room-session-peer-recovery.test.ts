import { describe, expect, it, vi } from 'vitest';

import { PROTOCOL_VERSION } from '@round/protocol';

import {
  ROOM_ID,
  acknowledgeChat,
  answerPeer,
  createHarness,
  flushMicrotasks,
  joinSession,
  latestOutgoingNegotiationId,
} from './room-session.test-support.js';

describe('RoomSession', () => {
  it('recovers a peer stuck before first connection, recreates it once, then fails only that peer', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({
        recovery: {
          peerConnectionTimeoutMs: 20,
          peerRecoveryTimeoutMs: 30,
        },
      });
      await joinSession(
        harness,
        [
          { peerId: 'y-healthy', displayName: 'Yuna' },
          { peerId: 'z-stuck', displayName: 'Zoe' },
        ],
        'a-self',
      );
      await answerPeer(harness, 'y-healthy');
      await answerPeer(harness, 'z-stuck');
      const healthyPeer = harness.peerConnections[0];
      const stuckPeer = harness.peerConnections[1];
      healthyPeer?.setConnectionState('connected');

      await vi.advanceTimersByTimeAsync(20);
      await flushMicrotasks();

      expect(stuckPeer?.offerOptions).toEqual([undefined, { iceRestart: true }]);
      expect(harness.session.getSnapshot()).toMatchObject({
        status: 'active',
        warning: { code: 'peer-connection-recovering' },
      });
      await answerPeer(harness, 'z-stuck');

      await vi.advanceTimersByTimeAsync(30);
      await flushMicrotasks();

      const replacement = harness.peerConnections[2];
      expect(stuckPeer?.closed).toBe(true);
      expect(replacement?.offerOptions).toEqual([undefined]);
      await answerPeer(harness, 'z-stuck');

      await vi.advanceTimersByTimeAsync(20);
      await flushMicrotasks();

      expect(replacement?.closed).toBe(true);
      expect(harness.peerConnections).toHaveLength(3);
      expect(healthyPeer?.closed).toBe(false);
      expect(harness.socket.closeCalls).toEqual([]);
      expect(harness.audioTrack.stopped).toBe(false);
      expect(harness.videoTrack.stopped).toBe(false);
      expect(harness.session.getSnapshot()).toMatchObject({
        status: 'active',
        warning: { code: 'peer-connection-timeout' },
        participants: [
          expect.objectContaining({ peerId: 'a-self', connectionState: 'connected' }),
          expect.objectContaining({ peerId: 'y-healthy', connectionState: 'connected' }),
          expect.objectContaining({ peerId: 'z-stuck', connectionState: 'failed' }),
        ],
      });
      const partialChat = harness.session.sendChat('healthy peers stay connected');
      expect(partialChat.deliveryState).toBe('pending');
      const healthyChannel = healthyPeer?.channels[0];
      if (healthyChannel === undefined) {
        throw new Error('Expected a healthy peer DataChannel');
      }
      expect(
        healthyChannel.sent
          .map((raw) => JSON.parse(raw) as { type: string; text?: string })
          .filter(({ type }) => type === 'chat.message'),
      ).toEqual([
        expect.objectContaining({
          type: 'chat.message',
          text: 'healthy peers stay connected',
        }),
      ]);
      acknowledgeChat(healthyChannel, partialChat.id);
      expect(harness.session.getSnapshot().messages).toContainEqual(
        expect.objectContaining({
          id: partialChat.id,
          deliveryState: 'partial',
        }),
      );

      harness.socket.serverMessage({
        v: PROTOCOL_VERSION,
        type: 'peer.joined',
        roomId: ROOM_ID,
        payload: {
          participant: { peerId: 'z-stuck', displayName: 'Zoe' },
        },
      });
      harness.socket.serverMessage({
        v: PROTOCOL_VERSION,
        type: 'rtc.offer',
        roomId: ROOM_ID,
        from: 'z-stuck',
        payload: {
          description: { type: 'offer', sdp: 'late-offer' },
        },
      });
      harness.socket.serverMessage({
        v: PROTOCOL_VERSION,
        type: 'rtc.answer',
        roomId: ROOM_ID,
        from: 'z-stuck',
        payload: {
          description: { type: 'answer', sdp: 'late-answer' },
        },
      });
      harness.socket.serverMessage({
        v: PROTOCOL_VERSION,
        type: 'rtc.ice',
        roomId: ROOM_ID,
        from: 'z-stuck',
        payload: { candidate: null },
      });
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(harness.peerConnections).toHaveLength(3);

      harness.socket.serverMessage({
        v: PROTOCOL_VERSION,
        type: 'peer.left',
        roomId: ROOM_ID,
        payload: { peerId: 'z-stuck' },
      });
      harness.socket.serverMessage({
        v: PROTOCOL_VERSION,
        type: 'peer.joined',
        roomId: ROOM_ID,
        payload: {
          participant: { peerId: 'z-stuck', displayName: 'Zoe' },
        },
      });
      await flushMicrotasks();
      expect(harness.peerConnections).toHaveLength(4);
      expect(harness.session.getSnapshot().warning).toBeNull();
      await harness.session.leave();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels the initial connection deadline once a peer connects', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({
        recovery: {
          peerConnectionTimeoutMs: 20,
          peerRecoveryTimeoutMs: 30,
        },
      });
      await joinSession(harness, [{ peerId: 'z-peer', displayName: 'Zoe' }], 'a-self');
      await answerPeer(harness, 'z-peer');
      const peer = harness.peerConnections[0];
      const channel = peer?.channels[0];
      if (channel === undefined) {
        throw new Error('Expected an initial DataChannel');
      }
      channel.readyState = 'connecting';

      peer?.setConnectionState('connected');
      await vi.advanceTimersByTimeAsync(19);
      channel.open();
      await vi.advanceTimersByTimeAsync(100);

      expect(peer?.closed).toBe(false);
      expect(peer?.offerOptions).toEqual([undefined]);
      expect(harness.peerConnections).toHaveLength(1);
      expect(harness.session.getSnapshot()).toMatchObject({
        status: 'active',
        warning: null,
        error: null,
      });
      await harness.session.leave();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the initial connection deadline until the data channel opens', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({
        recovery: {
          peerConnectionTimeoutMs: 20,
          peerRecoveryTimeoutMs: 30,
        },
      });
      await joinSession(harness, [{ peerId: 'z-peer', displayName: 'Zoe' }], 'a-self');
      await answerPeer(harness, 'z-peer');
      const peer = harness.peerConnections[0];
      const channel = peer?.channels[0];
      if (channel === undefined) {
        throw new Error('Expected an initial DataChannel');
      }
      channel.readyState = 'connecting';

      peer?.setConnectionState('connected');
      await vi.advanceTimersByTimeAsync(20);
      await flushMicrotasks();

      expect(peer?.offerOptions).toEqual([undefined, { iceRestart: true }]);
      expect(harness.session.getSnapshot()).toMatchObject({
        status: 'active',
        warning: { code: 'peer-connection-recovering' },
      });

      channel.open();
      await vi.advanceTimersByTimeAsync(100);

      expect(peer?.closed).toBe(false);
      expect(harness.peerConnections).toHaveLength(1);
      expect(harness.session.getSnapshot()).toMatchObject({
        status: 'active',
        warning: null,
        error: null,
      });
      await harness.session.leave();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears a transient timeout warning when ICE recovery connects the peer', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({
        recovery: {
          peerConnectionTimeoutMs: 20,
          peerRecoveryTimeoutMs: 30,
        },
      });
      await joinSession(harness, [{ peerId: 'z-peer', displayName: 'Zoe' }], 'a-self');
      await answerPeer(harness, 'z-peer');
      const peer = harness.peerConnections[0];

      await vi.advanceTimersByTimeAsync(20);
      await flushMicrotasks();
      expect(harness.session.getSnapshot().warning).toMatchObject({
        code: 'peer-connection-recovering',
      });

      await answerPeer(harness, 'z-peer');
      peer?.setConnectionState('connected');
      await vi.advanceTimersByTimeAsync(100);

      expect(peer?.closed).toBe(false);
      expect(harness.peerConnections).toHaveLength(1);
      expect(harness.session.getSnapshot()).toMatchObject({
        status: 'active',
        warning: null,
        error: null,
      });
      await harness.session.leave();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a scheduled offer retry when the connection watchdog takes ownership', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({
        recovery: {
          peerConnectionTimeoutMs: 20,
          peerRecoveryTimeoutMs: 100,
          reconnectInitialDelayMs: 80,
        },
        onPeerConnectionCreated: (peer, index) => {
          if (index === 0) {
            peer.createOfferErrors.push(new Error('initial offer failure'));
          }
        },
      });
      await joinSession(harness, [{ peerId: 'z-peer', displayName: 'Zoe' }], 'a-self');
      const peer = harness.peerConnections[0];

      await vi.advanceTimersByTimeAsync(20);
      await flushMicrotasks();
      expect(peer?.offerOptions).toEqual([undefined, { iceRestart: true }]);

      await vi.advanceTimersByTimeAsync(70);
      await flushMicrotasks();
      expect(peer?.offerOptions).toEqual([undefined, { iceRestart: true }]);

      await answerPeer(harness, 'z-peer');
      peer?.setConnectionState('connected');
      await harness.session.leave();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a late offer retry after the connection watchdog takes ownership', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({
        recovery: {
          peerConnectionTimeoutMs: 20,
          peerRecoveryTimeoutMs: 100,
          reconnectInitialDelayMs: 10,
        },
        onPeerConnectionCreated: (peer, index) => {
          if (index === 0) {
            peer.createOfferDelayMs = 30;
            peer.createOfferErrors.push(new Error('delayed initial offer failure'));
          }
        },
      });
      await joinSession(harness, [{ peerId: 'z-peer', displayName: 'Zoe' }], 'a-self');
      const peer = harness.peerConnections[0];

      await vi.advanceTimersByTimeAsync(20);
      await flushMicrotasks();
      expect(harness.session.getSnapshot().warning).toMatchObject({
        code: 'peer-connection-recovering',
      });

      await vi.advanceTimersByTimeAsync(70);
      await flushMicrotasks();
      expect(peer?.offerOptions).toEqual([undefined]);
      expect(harness.peerConnections).toHaveLength(1);

      await harness.session.leave();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the initial connection deadline when the remote peer leaves', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({
        recovery: {
          peerConnectionTimeoutMs: 20,
          peerRecoveryTimeoutMs: 30,
        },
      });
      await joinSession(harness, [{ peerId: 'z-peer', displayName: 'Zoe' }], 'a-self');
      const peer = harness.peerConnections[0];

      harness.socket.serverMessage({
        v: PROTOCOL_VERSION,
        type: 'peer.left',
        roomId: ROOM_ID,
        payload: { peerId: 'z-peer' },
      });
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(100);

      expect(peer?.closed).toBe(true);
      expect(harness.peerConnections).toHaveLength(1);
      expect(harness.session.getSnapshot()).toMatchObject({
        status: 'active',
        warning: null,
        participants: [expect.objectContaining({ peerId: 'a-self' })],
      });
      await harness.session.leave();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the initial connection deadline on local leave', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({
        recovery: {
          peerConnectionTimeoutMs: 20,
          peerRecoveryTimeoutMs: 30,
        },
      });
      await joinSession(harness, [{ peerId: 'z-peer', displayName: 'Zoe' }], 'a-self');
      const peer = harness.peerConnections[0];

      await harness.session.leave();
      await vi.advanceTimersByTimeAsync(100);

      expect(peer?.closed).toBe(true);
      expect(harness.peerConnections).toHaveLength(1);
      expect(harness.session.getSnapshot()).toMatchObject({
        status: 'ended',
        participants: [],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps timeout recovery offers on the deterministic initiator only', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({
        recovery: {
          peerConnectionTimeoutMs: 20,
          peerRecoveryTimeoutMs: 30,
        },
      });
      await joinSession(harness, [{ peerId: 'a-peer', displayName: 'Ara' }], 'z-self');
      await answerPeer(harness, 'a-peer');
      const initialPeer = harness.peerConnections[0];

      await vi.advanceTimersByTimeAsync(20);
      await flushMicrotasks();
      expect(initialPeer?.offerOptions).toEqual([undefined]);

      await vi.advanceTimersByTimeAsync(30);
      await flushMicrotasks();

      expect(harness.peerConnections).toHaveLength(2);
      expect(harness.peerConnections[1]?.offerOptions).toEqual([]);
      expect(harness.socket.messagesOfType('rtc.offer')).toHaveLength(1);
      await harness.session.leave();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores an answer from a retired negotiation after recreating the peer', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({
        recovery: {
          peerConnectionTimeoutMs: 20,
          peerRecoveryTimeoutMs: 30,
        },
      });
      await joinSession(harness, [{ peerId: 'z-peer', displayName: 'Zoe' }], 'a-self');
      const retiredNegotiationId = latestOutgoingNegotiationId(harness, 'z-peer');
      expect(retiredNegotiationId).toBeDefined();
      if (retiredNegotiationId === undefined) {
        throw new Error('Expected the initial offer to carry a negotiation id');
      }

      await vi.advanceTimersByTimeAsync(20);
      await vi.advanceTimersByTimeAsync(30);
      await flushMicrotasks();

      const replacement = harness.peerConnections[1];
      const currentNegotiationId = latestOutgoingNegotiationId(harness, 'z-peer');
      expect(replacement).toBeDefined();
      expect(currentNegotiationId).toBeDefined();
      expect(currentNegotiationId).not.toBe(retiredNegotiationId);
      if (currentNegotiationId === undefined) {
        throw new Error('Expected the replacement offer to carry a negotiation id');
      }

      harness.socket.serverMessage({
        v: PROTOCOL_VERSION,
        type: 'rtc.offer',
        roomId: ROOM_ID,
        from: 'z-peer',
        payload: {
          negotiationId: retiredNegotiationId,
          description: { type: 'offer', sdp: 'retired-offer' },
        },
      });
      harness.socket.serverMessage({
        v: PROTOCOL_VERSION,
        type: 'rtc.answer',
        roomId: ROOM_ID,
        from: 'z-peer',
        payload: {
          negotiationId: retiredNegotiationId,
          description: { type: 'answer', sdp: 'retired-answer' },
        },
      });
      harness.socket.serverMessage({
        v: PROTOCOL_VERSION,
        type: 'rtc.ice',
        roomId: ROOM_ID,
        from: 'z-peer',
        payload: {
          negotiationId: retiredNegotiationId,
          candidate: {
            candidate: 'candidate:retired',
            sdpMid: '0',
            sdpMLineIndex: 0,
          },
        },
      });
      await flushMicrotasks();

      expect(replacement?.remoteDescription).toBeNull();
      expect(replacement?.addedCandidates).toEqual([]);
      expect(replacement?.closed).toBe(false);
      expect(harness.session.getSnapshot().participants).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ peerId: 'z-peer', connectionState: 'negotiating' }),
        ]),
      );

      await answerPeer(harness, 'z-peer');
      harness.socket.serverMessage({
        v: PROTOCOL_VERSION,
        type: 'rtc.ice',
        roomId: ROOM_ID,
        from: 'z-peer',
        payload: {
          negotiationId: currentNegotiationId,
          candidate: {
            candidate: 'candidate:current',
            sdpMid: '0',
            sdpMLineIndex: 0,
          },
        },
      });
      await flushMicrotasks();
      replacement?.setConnectionState('connected');
      expect(replacement?.remoteDescription?.sdp).toBe('remote-answer');
      expect(replacement?.addedCandidates).toEqual([
        {
          candidate: 'candidate:current',
          sdpMid: '0',
          sdpMLineIndex: 0,
        },
      ]);
      expect(harness.session.getSnapshot()).toMatchObject({
        status: 'active',
        warning: null,
      });
      await harness.session.leave();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let an in-flight old answer mutate a newer remote-offer generation', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
      const peer = harness.peerConnections[0];
      const previousNegotiationId = latestOutgoingNegotiationId(harness, 'peer-a');
      expect(previousNegotiationId).toBeDefined();
      if (peer === undefined || previousNegotiationId === undefined) {
        throw new Error('Expected an established outgoing negotiation');
      }
      peer.setRemoteDescriptionDelayMs = 20;

      harness.socket.serverMessage({
        v: PROTOCOL_VERSION,
        type: 'rtc.answer',
        roomId: ROOM_ID,
        from: 'peer-a',
        payload: {
          negotiationId: previousNegotiationId,
          description: { type: 'answer', sdp: 'old-answer' },
        },
      });
      harness.socket.serverMessage({
        v: PROTOCOL_VERSION,
        type: 'rtc.offer',
        roomId: ROOM_ID,
        from: 'peer-a',
        payload: {
          negotiationId: 'new-remote-generation',
          description: { type: 'offer', sdp: 'new-remote-offer' },
        },
      });

      await vi.advanceTimersByTimeAsync(20);
      await flushMicrotasks();

      expect(peer.closed).toBe(false);
      expect(peer.remoteDescription).toMatchObject({
        type: 'offer',
        sdp: 'new-remote-offer',
      });
      expect(harness.socket.messagesOfType('rtc.answer').at(-1)).toMatchObject({
        to: 'peer-a',
        payload: {
          negotiationId: 'new-remote-generation',
          description: { type: 'answer', sdp: 'answer-sdp' },
        },
      });
      expect(harness.session.getSnapshot()).toMatchObject({
        status: 'active',
        warning: null,
      });
      await harness.session.leave();
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a newer remote offer supersede an older offer still being applied', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
      const peer = harness.peerConnections[0];
      if (peer === undefined) {
        throw new Error('Expected an established peer connection');
      }
      peer.setRemoteDescriptionDelayMs = 20;

      harness.socket.serverMessage({
        v: PROTOCOL_VERSION,
        type: 'rtc.offer',
        roomId: ROOM_ID,
        from: 'peer-a',
        payload: {
          negotiationId: 'older-remote-generation',
          description: { type: 'offer', sdp: 'older-remote-offer' },
        },
      });
      harness.socket.serverMessage({
        v: PROTOCOL_VERSION,
        type: 'rtc.offer',
        roomId: ROOM_ID,
        from: 'peer-a',
        payload: {
          negotiationId: 'newer-remote-generation',
          description: { type: 'offer', sdp: 'newer-remote-offer' },
        },
      });

      await vi.advanceTimersByTimeAsync(20);
      await flushMicrotasks();

      expect(peer.remoteDescription).toMatchObject({
        type: 'offer',
        sdp: 'newer-remote-offer',
      });
      expect(harness.socket.messagesOfType('rtc.answer')).toEqual([
        expect.objectContaining({
          to: 'peer-a',
          payload: {
            negotiationId: 'newer-remote-generation',
            description: { type: 'answer', sdp: 'answer-sdp' },
          },
        }),
      ]);
      expect(harness.session.getSnapshot()).toMatchObject({
        status: 'active',
        warning: null,
      });
      await harness.session.leave();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not relabel a retired local ICE candidate as the new negotiation', async () => {
    const harness = createHarness();
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
    await answerPeer(harness, 'peer-a');
    const peer = harness.peerConnections[0];
    if (peer === undefined) {
      throw new Error('Expected a peer connection');
    }
    peer.answerIceUsernameFragment = 'current-local-ufrag';

    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'rtc.offer',
      roomId: ROOM_ID,
      from: 'peer-a',
      payload: {
        negotiationId: 'remote-next-generation',
        description: { type: 'offer', sdp: 'remote-next-offer' },
      },
    });
    peer.emitIceCandidate('retired-local-ufrag');
    await flushMicrotasks();
    peer.emitIceCandidate('current-local-ufrag');
    await flushMicrotasks();

    expect(harness.socket.messagesOfType('rtc.ice')).toEqual([
      expect.objectContaining({
        to: 'peer-a',
        payload: {
          negotiationId: 'remote-next-generation',
          candidate: {
            candidate: 'candidate:current-local-ufrag ufrag current-local-ufrag',
            sdpMid: '0',
            sdpMLineIndex: 0,
            usernameFragment: 'current-local-ufrag',
          },
        },
      }),
    ]);
    await harness.session.leave();
  });

  it('allows an exhausted peer id to start fresh after a full signaling reconnect', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({
        recovery: {
          peerConnectionTimeoutMs: 10,
          peerRecoveryTimeoutMs: 10,
        },
      });
      await joinSession(harness, [{ peerId: 'z-peer', displayName: 'Zoe' }], 'a-self');
      await answerPeer(harness, 'z-peer');

      await vi.advanceTimersByTimeAsync(10);
      await answerPeer(harness, 'z-peer');
      await vi.advanceTimersByTimeAsync(10);
      await flushMicrotasks();
      await answerPeer(harness, 'z-peer');
      await vi.advanceTimersByTimeAsync(10);
      await flushMicrotasks();

      expect(harness.peerConnections).toHaveLength(2);
      expect(harness.session.getSnapshot()).toMatchObject({
        status: 'active',
        warning: { code: 'peer-connection-timeout' },
      });

      harness.socket.serverClose(1006, 'reset exhausted peers');
      await flushMicrotasks();
      expect(harness.sockets).toHaveLength(2);
      harness.socket.open();
      await flushMicrotasks();
      harness.socket.serverMessage({
        v: PROTOCOL_VERSION,
        type: 'room.joined',
        roomId: ROOM_ID,
        payload: {
          peerId: 'b-self',
          participants: [{ peerId: 'z-peer', displayName: 'Zoe' }],
        },
      });
      await flushMicrotasks();

      expect(harness.peerConnections).toHaveLength(3);
      expect(harness.peerConnections[2]?.offerOptions).toEqual([undefined]);
      expect(harness.session.getSnapshot()).toMatchObject({
        status: 'active',
        warning: null,
      });
      await harness.session.leave();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([false, true])(
    '채팅 채널 생성 실패를 재시도하고 반복 실패는 제한한다: 반복=%s',
    async (persistent) => {
      vi.useFakeTimers();
      const harness = createHarness({
        recovery: { maxReconnectAttempts: 1, reconnectInitialDelayMs: 10 },
        onPeerConnectionCreated: (peer, index) => {
          if (index !== 0) return;
          const createChannel = vi.spyOn(peer, 'createDataChannel');
          const fail = () => {
            throw new Error('channel creation failed');
          };
          if (persistent) createChannel.mockImplementation(fail);
          else createChannel.mockImplementationOnce(fail);
        },
      });
      try {
        await joinSession(harness, [
          { peerId: 'peer-a', displayName: '가온' },
          { peerId: 'peer-b', displayName: '나래' },
        ]);
        const [target, healthy] = harness.peerConnections;
        await answerPeer(harness, 'peer-b');
        healthy!.setConnectionState('connected');
        const message = harness.session.sendChat('연결되면 전달할 메시지');
        acknowledgeChat(healthy!.channels[0]!, message.id);
        expect(harness.session.getSnapshot().warning?.code).toBe('peer-negotiation-retrying');

        await vi.advanceTimersByTimeAsync(10);
        expect(target!.createDataChannel).toHaveBeenCalledTimes(2);
        if (persistent) {
          expect(target!.closed).toBe(true);
          expect(harness.session.getSnapshot().warning?.code).toBe('peer-negotiation-failed');
        } else {
          await answerPeer(harness, 'peer-a');
          target!.setConnectionState('connected');
          const channel = target!.channels[0]!;
          expect(
            channel.sent
              .map((raw) => JSON.parse(raw))
              .filter((item) => item.type === 'chat.message'),
          ).toEqual([expect.objectContaining({ id: message.id, text: message.text })]);
          acknowledgeChat(channel, message.id);
          expect(target!.closed).toBe(false);
          expect(harness.session.getSnapshot().warning).toBeNull();
        }
        expect(harness.session.getSnapshot().messages[0]?.deliveryState).toBe(
          persistent ? 'partial' : 'sent',
        );
        expect(harness.session.getSnapshot().status).toBe('active');
        expect(healthy!.closed).toBe(false);
        expect(harness.audioTrack.stopped).toBe(false);
        expect(harness.videoTrack.stopped).toBe(false);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(target!.createDataChannel).toHaveBeenCalledTimes(2);
        expect(harness.peerConnections).toHaveLength(2);
      } finally {
        await harness.session.leave();
        vi.restoreAllMocks();
        vi.useRealTimers();
      }
    },
  );

  it('retries one transient initial offer failure instead of leaving the peer failed', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({
        recovery: {
          maxReconnectAttempts: 1,
          reconnectInitialDelayMs: 10,
        },
        onPeerConnectionCreated: (peer) => {
          peer.createOfferErrors.push(new Error('transient offer failure'));
        },
      });
      await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
      const peer = harness.peerConnections[0];

      expect(peer?.offerOptions).toEqual([undefined]);
      expect(harness.session.getSnapshot()).toMatchObject({
        status: 'active',
        warning: { code: 'peer-negotiation-retrying' },
        participants: [
          expect.objectContaining({ peerId: 'self' }),
          expect.objectContaining({ peerId: 'peer-a', connectionState: 'connecting' }),
        ],
      });

      await vi.advanceTimersByTimeAsync(10);
      await flushMicrotasks();

      expect(peer?.offerOptions).toEqual([undefined, undefined]);
      expect(peer?.closed).toBe(false);
      expect(harness.socket.messagesOfType('rtc.offer')).toHaveLength(1);
      expect(harness.session.getSnapshot().participants).toContainEqual(
        expect.objectContaining({
          peerId: 'peer-a',
          connectionState: 'negotiating',
        }),
      );
      await harness.session.leave();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails cleanly when an initial-offer replacement cannot attach local tracks', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({
        recovery: {
          maxReconnectAttempts: 1,
          reconnectInitialDelayMs: 10,
        },
        onPeerConnectionCreated: (peer, index) => {
          if (index === 0) {
            peer.createOfferErrors.push(new Error('initial offer failure'));
          } else {
            peer.addTrackErrors.push(new Error('replacement addTrack failure'));
          }
        },
      });
      await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
      const initialPeer = harness.peerConnections[0];
      if (initialPeer === undefined) {
        throw new Error('Expected an initial peer connection');
      }
      initialPeer.connectionState = 'failed';

      await vi.advanceTimersByTimeAsync(10);
      await flushMicrotasks();

      const replacement = harness.peerConnections[1];
      expect(initialPeer.closed).toBe(true);
      expect(replacement?.closed).toBe(true);
      expect(harness.session.getSnapshot()).toMatchObject({
        status: 'active',
        warning: { code: 'peer-negotiation-failed' },
        participants: [
          expect.objectContaining({ peerId: 'self' }),
          expect.objectContaining({ peerId: 'peer-a', connectionState: 'failed' }),
        ],
      });
      expect(() => harness.session.sendChat('must fail closed')).toThrow(
        'Chat delivery to peer-a is unavailable',
      );
      await harness.session.leave();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears an initial offer retry warning when a remote offer connects first', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({
        recovery: {
          maxReconnectAttempts: 1,
          reconnectInitialDelayMs: 100,
        },
        onPeerConnectionCreated: (peer) => {
          peer.createOfferErrors.push(new Error('transient offer failure'));
        },
      });
      await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
      const peer = harness.peerConnections[0];
      expect(harness.session.getSnapshot().warning).toMatchObject({
        code: 'peer-negotiation-retrying',
      });

      harness.socket.serverMessage({
        v: PROTOCOL_VERSION,
        type: 'rtc.offer',
        roomId: ROOM_ID,
        from: 'peer-a',
        payload: {
          negotiationId: 'remote-recovery',
          description: { type: 'offer', sdp: 'remote-recovery-offer' },
        },
      });
      await flushMicrotasks();
      peer?.setConnectionState('connected');
      await vi.advanceTimersByTimeAsync(150);

      expect(peer?.offerOptions).toEqual([undefined]);
      expect(peer?.closed).toBe(false);
      expect(harness.session.getSnapshot()).toMatchObject({
        status: 'active',
        warning: null,
      });
      await harness.session.leave();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops the initial offer retry after the bounded second failure', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({
        recovery: {
          maxReconnectAttempts: 1,
          reconnectInitialDelayMs: 10,
        },
        onPeerConnectionCreated: (peer) => {
          peer.createOfferErrors.push(
            new Error('initial offer failure'),
            new Error('retry offer failure'),
          );
        },
      });
      await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
      const peer = harness.peerConnections[0];

      await vi.advanceTimersByTimeAsync(10);
      await flushMicrotasks();
      await vi.runAllTimersAsync();

      expect(peer?.offerOptions).toEqual([undefined, undefined]);
      expect(peer?.closed).toBe(true);
      expect(harness.session.getSnapshot()).toMatchObject({
        status: 'active',
        warning: { code: 'peer-negotiation-failed' },
        participants: [
          expect.objectContaining({ peerId: 'self' }),
          expect.objectContaining({ peerId: 'peer-a', connectionState: 'failed' }),
        ],
      });
      expect(() => harness.session.sendChat('must not report success')).toThrow(
        'Chat delivery to peer-a is unavailable',
      );
      expect(harness.session.getSnapshot().messages).toEqual([]);

      harness.socket.serverMessage({
        v: PROTOCOL_VERSION,
        type: 'rtc.offer',
        roomId: ROOM_ID,
        from: 'peer-a',
        payload: {
          description: { type: 'offer', sdp: 'late-offer' },
        },
      });
      harness.socket.serverMessage({
        v: PROTOCOL_VERSION,
        type: 'rtc.ice',
        roomId: ROOM_ID,
        from: 'peer-a',
        payload: { candidate: null },
      });
      await flushMicrotasks();
      await vi.runAllTimersAsync();
      expect(harness.peerConnections).toHaveLength(1);
      await harness.session.leave();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let repeated offers replace an already retried failed connection', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({
        recovery: {
          peerConnectionTimeoutMs: 100,
          peerRecoveryTimeoutMs: 100,
        },
      });
      await joinSession(harness, [{ peerId: 'a-peer', displayName: 'Ara' }], 'z-self');
      await answerPeer(harness, 'a-peer');
      const initialPeer = harness.peerConnections[0];
      initialPeer?.setConnectionState('failed');

      harness.socket.serverMessage({
        v: PROTOCOL_VERSION,
        type: 'rtc.offer',
        roomId: ROOM_ID,
        from: 'a-peer',
        payload: {
          negotiationId: 'first-recovery',
          description: { type: 'offer', sdp: 'first-recovery-offer' },
        },
      });
      await flushMicrotasks();
      const replacement = harness.peerConnections[1];
      expect(initialPeer?.closed).toBe(true);
      expect(replacement).toBeDefined();

      replacement?.setConnectionState('failed');
      harness.socket.serverMessage({
        v: PROTOCOL_VERSION,
        type: 'rtc.offer',
        roomId: ROOM_ID,
        from: 'a-peer',
        payload: {
          negotiationId: 'second-recovery',
          description: { type: 'offer', sdp: 'second-recovery-offer' },
        },
      });
      await flushMicrotasks();

      expect(replacement?.closed).toBe(true);
      expect(harness.peerConnections).toHaveLength(2);
      expect(harness.session.getSnapshot()).toMatchObject({
        status: 'active',
        warning: { code: 'peer-connection-timeout' },
        participants: expect.arrayContaining([
          expect.objectContaining({ peerId: 'a-peer', connectionState: 'failed' }),
        ]),
      });

      harness.socket.serverMessage({
        v: PROTOCOL_VERSION,
        type: 'rtc.offer',
        roomId: ROOM_ID,
        from: 'a-peer',
        payload: {
          negotiationId: 'ignored-after-exhaustion',
          description: { type: 'offer', sdp: 'ignored-after-exhaustion' },
        },
      });
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(500);
      expect(harness.peerConnections).toHaveLength(2);
      await harness.session.leave();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a disconnected grace timer when the peer reconnects', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({
        recovery: {
          peerDisconnectedGraceMs: 20,
          peerRecoveryTimeoutMs: 50,
        },
      });
      await joinSession(harness, [{ peerId: 'z-peer', displayName: 'Zoe' }], 'a-self');
      await answerPeer(harness, 'z-peer');
      const peer = harness.peerConnections[0];
      expect(peer).toBeDefined();

      peer?.setConnectionState('connected');
      peer?.setConnectionState('disconnected');
      await vi.advanceTimersByTimeAsync(19);
      peer?.setConnectionState('connected');
      await vi.advanceTimersByTimeAsync(60);

      expect(peer?.offerOptions).toEqual([undefined]);
      expect(peer?.closed).toBe(false);
      expect(harness.peerConnections).toHaveLength(1);
      await harness.session.leave();
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets only the deterministic peer send one ICE restart offer and flushes queued chat', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({
        createId: () => 'message-during-recovery',
        wallClockNow: () => 5_678,
        recovery: {
          peerDisconnectedGraceMs: 20,
          peerRecoveryTimeoutMs: 100,
        },
      });
      await joinSession(harness, [{ peerId: 'z-peer', displayName: 'Zoe' }], 'a-self');
      await answerPeer(harness, 'z-peer');
      const peer = harness.peerConnections[0];
      const channel = peer?.channels[0];
      expect(peer).toBeDefined();
      expect(channel).toBeDefined();

      peer?.setConnectionState('connected');
      peer?.setConnectionState('failed');
      peer?.setConnectionState('failed');
      await flushMicrotasks();

      expect(harness.peerConnections[0]).toBe(peer);
      expect(peer?.channels[0]).toBe(channel);
      expect(peer?.offerOptions).toEqual([undefined, { iceRestart: true }]);
      expect(harness.socket.messagesOfType('rtc.offer').at(-1)).toMatchObject({
        to: 'z-peer',
        payload: {
          description: { type: 'offer', sdp: 'restart-offer-sdp' },
        },
      });

      harness.session.sendChat('queued during recovery');
      expect(
        channel?.sent
          .map((raw) => JSON.parse(raw) as { type: string })
          .filter(({ type }) => type === 'chat.message'),
      ).toEqual([]);

      await answerPeer(harness, 'z-peer');
      peer?.setConnectionState('connected');

      expect(
        channel?.sent
          .map((raw) => JSON.parse(raw) as { type: string; id?: string })
          .filter(({ type }) => type === 'chat.message'),
      ).toEqual([
        expect.objectContaining({
          type: 'chat.message',
          id: 'message-during-recovery',
        }),
      ]);
      await harness.session.leave();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not send an ICE restart offer from the non-designated peer', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({
        recovery: { peerRecoveryTimeoutMs: 100 },
      });
      await joinSession(harness, [{ peerId: 'a-peer', displayName: 'Ara' }], 'z-self');
      await answerPeer(harness, 'a-peer');
      const peer = harness.peerConnections[0];

      peer?.setConnectionState('failed');
      await flushMicrotasks();

      expect(peer?.offerOptions).toEqual([undefined]);
      expect(harness.socket.messagesOfType('rtc.offer')).toHaveLength(1);
      await harness.session.leave();
    } finally {
      vi.useRealTimers();
    }
  });

  it('recreates an unrecovered peer connection after the recovery deadline', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({
        recovery: { peerRecoveryTimeoutMs: 30 },
      });
      await joinSession(harness, [{ peerId: 'z-peer', displayName: 'Zoe' }], 'a-self');
      await answerPeer(harness, 'z-peer');
      const failedPeer = harness.peerConnections[0];

      failedPeer?.setConnectionState('failed');
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(30);
      await flushMicrotasks();

      expect(failedPeer?.closed).toBe(true);
      expect(harness.peerConnections).toHaveLength(2);
      expect(harness.peerConnections[1]?.offerOptions).toEqual([undefined]);
      expect(harness.socket.messagesOfType('rtc.offer').at(-1)).toMatchObject({
        to: 'z-peer',
        payload: {
          description: { type: 'offer', sdp: 'offer-sdp' },
        },
      });
      await harness.session.leave();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails cleanly when a recovery replacement cannot attach local tracks', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({
        createId: () => 'message-replacement-init-failure',
        recovery: { peerRecoveryTimeoutMs: 30 },
        onPeerConnectionCreated: (peer, index) => {
          if (index === 1) {
            peer.addTrackErrors.push(new Error('recovery addTrack failure'));
          }
        },
      });
      await joinSession(harness, [{ peerId: 'z-peer', displayName: 'Zoe' }], 'a-self');
      await answerPeer(harness, 'z-peer');
      const initialPeer = harness.peerConnections[0];
      initialPeer?.setConnectionState('connected');
      const local = harness.session.sendChat('fail with the replacement');

      initialPeer?.setConnectionState('failed');
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(30);
      await flushMicrotasks();

      const replacement = harness.peerConnections[1];
      expect(initialPeer?.closed).toBe(true);
      expect(replacement?.closed).toBe(true);
      expect(harness.session.getSnapshot()).toMatchObject({
        status: 'active',
        warning: { code: 'peer-negotiation-failed' },
        participants: expect.arrayContaining([
          expect.objectContaining({ peerId: 'z-peer', connectionState: 'failed' }),
        ]),
        messages: [
          expect.objectContaining({
            id: local.id,
            deliveryState: 'failed',
          }),
        ],
      });
      await harness.session.leave();
    } finally {
      vi.useRealTimers();
    }
  });

  it('recreates a failed connection before answering an incoming recovery offer', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({
        recovery: { peerRecoveryTimeoutMs: 100 },
      });
      await joinSession(harness, [{ peerId: 'a-peer', displayName: 'Ara' }], 'z-self');
      await answerPeer(harness, 'a-peer');
      const failedPeer = harness.peerConnections[0];
      failedPeer?.setConnectionState('failed');

      harness.socket.serverMessage({
        v: PROTOCOL_VERSION,
        type: 'rtc.offer',
        roomId: ROOM_ID,
        from: 'a-peer',
        payload: {
          negotiationId: 'remote-restart',
          description: { type: 'offer', sdp: 'remote-restart-offer' },
        },
      });
      await flushMicrotasks();

      expect(failedPeer?.closed).toBe(true);
      expect(harness.peerConnections).toHaveLength(2);
      expect(harness.peerConnections[1]?.remoteDescription).toMatchObject({
        type: 'offer',
        sdp: 'remote-restart-offer',
      });
      expect(harness.socket.messagesOfType('rtc.answer').at(-1)).toMatchObject({
        to: 'a-peer',
        payload: {
          negotiationId: 'remote-restart',
          description: { type: 'answer', sdp: 'answer-sdp' },
        },
      });
      await harness.session.leave();
    } finally {
      vi.useRealTimers();
    }
  });
});
