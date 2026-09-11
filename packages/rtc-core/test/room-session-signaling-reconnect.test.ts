import { describe, expect, it, vi } from 'vitest';

import { PROTOCOL_VERSION } from '@round/protocol';

import {
  FakeMediaStream,
  FakeTrack,
  ROOM_ID,
  createHarness,
  createPromiseGate,
  flushMicrotasks,
  joinSession,
} from './room-session.test-support.js';

describe('RoomSession', () => {
  it('ends without reconnecting when a newer BATON participation session supersedes it', async () => {
    let connectGuardCalls = 0;
    const harness = createHarness({
      beforeSignalingConnect: () => {
        connectGuardCalls += 1;
      },
    });
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
    const peer = harness.peerConnections[0];

    harness.socket.serverClose(4002, 'Participation session superseded');
    await flushMicrotasks();

    expect(connectGuardCalls).toBe(1);
    expect(harness.sockets).toHaveLength(1);
    expect(peer?.closed).toBe(true);
    expect(harness.audioTrack.stopped).toBe(true);
    expect(harness.videoTrack.stopped).toBe(true);
    expect(harness.session.getSnapshot()).toMatchObject({
      status: 'error',
      selfId: null,
      participants: [],
      warning: null,
      error: {
        code: 'connection-superseded',
        message: 'Participation session superseded',
      },
    });
  });

  it('시그널링 재연결 후 로컬 미디어와 채팅 기록, 손들기 상태를 유지한다', async () => {
    const reconnectGate = createPromiseGate();
    let hookCallCount = 0;
    const harness = createHarness({
      createId: () => 'message-before-reconnect',
      wallClockNow: () => 4_567,
      beforeSignalingConnect: () => {
        hookCallCount += 1;
        return hookCallCount === 2 ? reconnectGate.promise : undefined;
      },
    });
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
    const oldSocket = harness.socket;
    const oldPeer = harness.peerConnections[0];
    const remoteAudio = new FakeTrack('audio');
    const remoteStream = new FakeMediaStream([remoteAudio]);
    oldPeer?.ontrack?.({
      streams: [remoteStream as unknown as MediaStream],
      track: remoteAudio as unknown as MediaStreamTrack,
    } as unknown as RTCTrackEvent);
    const chat = harness.session.sendChat('keep this');
    harness.session.setHandRaised(true);

    oldSocket.serverClose(4001, 'Participation grant expired');
    await flushMicrotasks();

    expect(hookCallCount).toBe(2);
    expect(harness.sockets).toHaveLength(1);
    expect(oldPeer?.closed).toBe(true);
    expect(remoteAudio.stopped).toBe(true);
    expect(harness.audioTrack.stopped).toBe(false);
    expect(harness.videoTrack.stopped).toBe(false);
    expect(harness.session.getSnapshot()).toMatchObject({
      status: 'reconnecting',
      selfId: null,
      participants: [],
      messages: [
        {
          ...chat,
          deliveryState: 'failed',
          recipients: [{ peerId: 'peer-a', displayName: 'Ara', state: 'failed', canRetry: false }],
        },
      ],
      error: null,
    });

    reconnectGate.resolve();
    await flushMicrotasks();

    expect(harness.sockets).toHaveLength(2);
    const reconnectSocket = harness.socket;
    reconnectSocket.open();
    await flushMicrotasks();
    reconnectSocket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'room.joined',
      roomId: ROOM_ID,
      payload: {
        peerId: 'self-after-reconnect',
        participants: [
          { peerId: 'self', displayName: 'Jin' },
          { peerId: 'peer-a', displayName: 'Ara' },
        ],
      },
    });
    await flushMicrotasks();

    const participantIds = harness.session.getSnapshot().participants.map(({ peerId }) => peerId);
    expect(harness.session.getSnapshot()).toMatchObject({
      status: 'active',
      selfId: 'self-after-reconnect',
      messages: [
        {
          ...chat,
          deliveryState: 'failed',
          recipients: [{ peerId: 'peer-a', displayName: 'Ara', state: 'failed', canRetry: false }],
        },
      ],
      error: null,
    });
    expect(participantIds).toEqual(['self-after-reconnect', 'peer-a']);
    expect(new Set(participantIds).size).toBe(participantIds.length);
    expect(
      harness.session.getSnapshot().participants.find((participant) => participant.isLocal),
    ).toMatchObject({ handRaised: true });
    expect(
      harness.peerConnections[1]?.channels[0]?.sent.map((raw) => JSON.parse(raw)),
    ).toContainEqual({ type: 'participant.hand', raised: true });
    expect(harness.peerConnections).toHaveLength(2);
    expect(harness.session.getRemoteStream('peer-a')).toBeNull();
  });

  it('counts a failed reconnect hook as an attempt and applies backoff before retrying', async () => {
    vi.useFakeTimers();
    try {
      let hookCallCount = 0;
      const beforeSignalingConnect = vi.fn(async () => {
        hookCallCount += 1;
        if (hookCallCount === 2) {
          throw new Error('participation grant refresh failed');
        }
      });
      const harness = createHarness({
        beforeSignalingConnect,
        recovery: {
          maxReconnectAttempts: 3,
          reconnectInitialDelayMs: 25,
          reconnectMaxDelayMs: 25,
        },
      });
      await joinSession(harness);

      harness.socket.serverClose(1006, 'network lost');
      await flushMicrotasks();

      expect(beforeSignalingConnect).toHaveBeenCalledTimes(2);
      expect(harness.sockets).toHaveLength(1);
      expect(harness.session.getSnapshot().status).toBe('reconnecting');

      await vi.advanceTimersByTimeAsync(24);
      await flushMicrotasks();
      expect(beforeSignalingConnect).toHaveBeenCalledTimes(2);
      expect(harness.sockets).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1);
      await flushMicrotasks();
      expect(beforeSignalingConnect).toHaveBeenCalledTimes(3);
      expect(harness.sockets).toHaveLength(2);

      const reconnectSocket = harness.socket;
      reconnectSocket.open();
      await flushMicrotasks();
      reconnectSocket.serverMessage({
        v: PROTOCOL_VERSION,
        type: 'room.joined',
        roomId: ROOM_ID,
        payload: {
          peerId: 'self-after-hook-retry',
          participants: [],
        },
      });
      await flushMicrotasks();

      expect(harness.session.getSnapshot()).toMatchObject({
        status: 'active',
        selfId: 'self-after-hook-retry',
        warning: null,
        error: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('온라인 복귀 요청 시 재연결 대기를 끝내고 다음 시도를 시작한다', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({
        recovery: {
          maxReconnectAttempts: 3,
          reconnectInitialDelayMs: 100,
          reconnectMaxDelayMs: 100,
        },
      });
      await joinSession(harness);

      expect(harness.session.retrySignalingNow()).toBe(false);

      harness.socket.serverClose(1006, 'network lost');
      await flushMicrotasks();
      expect(harness.sockets).toHaveLength(2);

      harness.socket.serverClose(1006, 'still offline');
      await flushMicrotasks();
      expect(harness.session.getSnapshot().status).toBe('reconnecting');
      expect(harness.sockets).toHaveLength(2);

      expect(harness.session.retrySignalingNow()).toBe(true);
      await flushMicrotasks();
      expect(harness.sockets).toHaveLength(3);
      expect(harness.session.retrySignalingNow()).toBe(false);

      await harness.session.leave();
    } finally {
      vi.useRealTimers();
    }
  });

  it('performs bounded reconnect attempts and stops local media when they are exhausted', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({
        recovery: {
          signalingConnectTimeoutMs: 10,
          maxReconnectAttempts: 2,
          reconnectInitialDelayMs: 5,
          reconnectMaxDelayMs: 5,
        },
      });
      await joinSession(harness);

      harness.socket.serverClose(1006, 'network lost');
      await vi.runAllTimersAsync();
      await flushMicrotasks();

      expect(harness.sockets).toHaveLength(3);
      expect(harness.audioTrack.stopped).toBe(true);
      expect(harness.videoTrack.stopped).toBe(true);
      expect(harness.session.getLocalStream()).toBeNull();
      expect(harness.session.getSnapshot()).toMatchObject({
        status: 'error',
        selfId: null,
        participants: [],
        warning: null,
        error: {
          code: 'reconnect-exhausted',
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies exponential backoff once when every replacement socket emits error then close', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    try {
      const socketCreationTimes: number[] = [];
      const harness = createHarness({
        recovery: {
          signalingConnectTimeoutMs: 1_000,
          maxReconnectAttempts: 4,
          reconnectInitialDelayMs: 100,
          reconnectMaxDelayMs: 400,
        },
        onSocketCreated: (socket, index) => {
          socketCreationTimes.push(Date.now());
          if (index > 0) {
            queueMicrotask(() => {
              socket.error();
              socket.serverClose(1006, 'connection refused');
            });
          }
        },
      });
      await joinSession(harness);

      harness.socket.serverClose(1006, 'signaling stopped');
      await vi.runAllTimersAsync();
      await flushMicrotasks();

      expect(socketCreationTimes).toEqual([10_000, 10_000, 10_100, 10_300, 10_700]);
      expect(harness.sockets).toHaveLength(5);
      expect(harness.session.getSnapshot()).toMatchObject({
        status: 'error',
        error: { code: 'reconnect-exhausted' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels reconnect backoff and creates no later socket after leave', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({
        recovery: {
          maxReconnectAttempts: 4,
          reconnectInitialDelayMs: 100,
          reconnectMaxDelayMs: 100,
        },
      });
      await joinSession(harness);

      harness.socket.serverClose(1006, 'network lost');
      await flushMicrotasks();
      expect(harness.sockets).toHaveLength(2);
      harness.socket.serverClose(1006, 'still offline');
      await flushMicrotasks();

      await harness.session.leave();
      await vi.runAllTimersAsync();
      await flushMicrotasks();

      expect(harness.sockets).toHaveLength(2);
      expect(harness.audioTrack.stopped).toBe(true);
      expect(harness.videoTrack.stopped).toBe(true);
      expect(harness.session.getSnapshot()).toMatchObject({
        status: 'ended',
        selfId: null,
        participants: [],
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
