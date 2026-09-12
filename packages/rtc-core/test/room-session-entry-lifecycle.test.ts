import { describe, expect, it, vi } from 'vitest';

import { PROTOCOL_VERSION, SIGNALING_ERROR_CODES, type SignalingErrorCode } from '@round/protocol';

import {
  FakeDataChannel,
  FakeMediaStream,
  FakeTrack,
  FakeWebSocket,
  OTHER_ROOM_ID,
  ROOM_ID,
  createHarness,
  createPromiseGate,
  flushMicrotasks,
  joinSession,
} from './room-session.test-support.js';

function latestOutgoingRequestId(
  socket: FakeWebSocket,
  type: 'rtc.offer' | 'rtc.answer' | 'rtc.ice',
  peerId: string,
): string {
  const messages = socket.messagesOfType(type);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.to === peerId && typeof message.requestId === 'string') {
      return message.requestId;
    }
  }
  throw new Error(`Expected ${type} requestId for ${peerId}`);
}

describe('RoomSession', () => {
  it('publishes the room lifecycle as serializable snapshots', async () => {
    const harness = createHarness();
    const statuses: string[] = [];
    const unsubscribe = harness.session.subscribe((snapshot) => {
      statuses.push(snapshot.status);
      expect(() => JSON.stringify(snapshot)).not.toThrow();
    });

    await joinSession(harness);

    expect(statuses.filter((status, index) => status !== statuses[index - 1])).toEqual([
      'preparing-media',
      'connecting-signal',
      'joining',
      'active',
    ]);

    const notificationCount = statuses.length;
    unsubscribe();
    harness.session.toggleAudio();
    expect(statuses).toHaveLength(notificationCount);
  });

  it('waits for the pre-connect hook before creating the initial socket', async () => {
    const gate = createPromiseGate();
    const beforeSignalingConnect = vi.fn(() => gate.promise);
    const harness = createHarness({ beforeSignalingConnect });
    const joining = harness.session.join();

    await flushMicrotasks();

    expect(beforeSignalingConnect).toHaveBeenCalledTimes(1);
    expect(harness.sockets).toHaveLength(0);
    expect(harness.session.getSnapshot().status).toBe('connecting-signal');

    gate.resolve();
    await flushMicrotasks();

    expect(harness.sockets).toHaveLength(1);
    harness.socket.open();
    await flushMicrotasks();
    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'room.joined',
      roomId: ROOM_ID,
      payload: { peerId: 'self', participants: [] },
    });
    await joining;

    expect(harness.session.getSnapshot().status).toBe('active');
  });

  it('uses the normal fatal join flow when the pre-connect hook fails initially', async () => {
    const beforeSignalingConnect = vi.fn(async () => {
      throw new Error('participation grant refresh failed');
    });
    const harness = createHarness({ beforeSignalingConnect });

    await expect(harness.session.join()).rejects.toThrow('participation grant refresh failed');

    expect(beforeSignalingConnect).toHaveBeenCalledTimes(1);
    expect(harness.sockets).toHaveLength(0);
    expect(harness.audioTrack.stopped).toBe(true);
    expect(harness.videoTrack.stopped).toBe(true);
    expect(harness.session.getSnapshot()).toMatchObject({
      status: 'error',
      error: {
        code: 'join-failed',
        message: 'participation grant refresh failed',
      },
    });
  });

  it('does not create a late socket when leave happens while the pre-connect hook waits', async () => {
    const gate = createPromiseGate();
    const harness = createHarness({
      beforeSignalingConnect: () => gate.promise,
    });
    const joining = harness.session.join();
    const rejectedJoin = expect(joining).rejects.toThrow('Room session ended while connecting');

    await flushMicrotasks();
    expect(harness.sockets).toHaveLength(0);

    await harness.session.leave();
    gate.resolve();
    await rejectedJoin;
    await flushMicrotasks();

    expect(harness.sockets).toHaveLength(0);
    expect(harness.audioTrack.stopped).toBe(true);
    expect(harness.videoTrack.stopped).toBe(true);
    expect(harness.session.getSnapshot().status).toBe('ended');
  });

  it('joins without media when permission is denied', async () => {
    const harness = createHarness({
      getUserMedia: vi.fn(async () => {
        throw new DOMException('Permission denied', 'NotAllowedError');
      }),
    });
    const joining = harness.session.join();

    await flushMicrotasks();
    expect(harness.session.getSnapshot().status).toBe('connecting-signal');
    harness.socket.open();
    await flushMicrotasks();
    expect(harness.socket.messagesOfType('room.join')).toHaveLength(1);

    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'room.joined',
      roomId: 'abcd-efgh-jkmp',
      payload: { peerId: 'self', participants: [] },
    });
    await joining;

    expect(harness.session.getSnapshot()).toMatchObject({
      status: 'active',
      selfId: 'self',
      localMedia: {
        audioAvailable: false,
        audioEnabled: false,
        videoAvailable: false,
        videoEnabled: false,
      },
      warning: { code: 'media-permission-denied' },
      error: null,
    });
    expect(harness.session.getLocalStream()).toBeNull();
  });

  it('validates room entry before requesting media or opening a socket', () => {
    const getUserMedia = vi.fn();
    const onSocketCreated = vi.fn();

    expect(() =>
      createHarness({
        displayName: 'J'.repeat(65),
        getUserMedia,
        onSocketCreated,
      }),
    ).toThrow('must contain at most 64 characters');

    expect(getUserMedia).not.toHaveBeenCalled();
    expect(onSocketCreated).not.toHaveBeenCalled();
  });

  it('adopts prepared pre-join media without requesting it again and stops it on leave', async () => {
    const preparedAudio = new FakeTrack('audio');
    preparedAudio.enabled = false;
    const preparedVideo = new FakeTrack('video');
    const preparedStream = new FakeMediaStream([preparedAudio, preparedVideo]);
    const getUserMedia = vi.fn(async () => {
      throw new Error('getUserMedia must not run for prepared media');
    });
    const harness = createHarness({
      getUserMedia,
      preparedMediaStream: preparedStream as unknown as MediaStream,
    });

    await joinSession(harness);

    expect(getUserMedia).not.toHaveBeenCalled();
    expect(harness.session.getLocalStream()).toBe(preparedStream as unknown as MediaStream);
    expect(harness.session.getSnapshot().localMedia).toEqual({
      audioAvailable: true,
      audioEnabled: false,
      videoAvailable: true,
      videoEnabled: true,
      videoSource: 'camera',
    });

    await harness.session.leave();

    expect(preparedAudio.stopped).toBe(true);
    expect(preparedVideo.stopped).toBe(true);
  });

  it('normalizes multiple prepared video tracks to one owned camera track', async () => {
    const preparedAudio = new FakeTrack('audio');
    const primaryVideo = new FakeTrack('video');
    const extraVideo = new FakeTrack('video');
    const preparedStream = new FakeMediaStream([preparedAudio, primaryVideo, extraVideo]);
    const harness = createHarness({
      preparedMediaStream: preparedStream as unknown as MediaStream,
    });

    expect(preparedStream.getVideoTracks()).toEqual([primaryVideo as unknown as MediaStreamTrack]);
    expect(extraVideo.stopped).toBe(true);
    expect(extraVideo.endedListenerCount()).toBe(0);

    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);

    expect(
      harness.peerConnections[0]?.addedTracks.filter((track) => track.kind === 'video'),
    ).toEqual([primaryVideo as unknown as MediaStreamTrack]);
    expect(harness.session.getSnapshot().localMedia).toMatchObject({
      videoAvailable: true,
      videoEnabled: true,
      videoSource: 'camera',
    });

    await harness.session.leave();
    expect(primaryVideo.stopped).toBe(true);
  });

  it('drops an already-ended prepared track and still observes the remaining live track', async () => {
    const endedAudio = new FakeTrack('audio');
    endedAudio.stop();
    const liveVideo = new FakeTrack('video');
    const preparedStream = new FakeMediaStream([endedAudio, liveVideo]);
    const harness = createHarness({
      preparedMediaStream: preparedStream as unknown as MediaStream,
    });

    expect(harness.session.getSnapshot()).toMatchObject({
      localMedia: {
        audioAvailable: false,
        audioEnabled: false,
        videoAvailable: true,
        videoEnabled: true,
      },
      warning: { code: 'local-media-ended' },
    });
    expect(preparedStream.getAudioTracks()).toEqual([]);
    expect(endedAudio.endedListenerCount()).toBe(0);
    expect(liveVideo.endedListenerCount()).toBe(1);

    await joinSession(harness);
    await harness.session.leave();

    expect(liveVideo.stopped).toBe(true);
    expect(liveVideo.endedListenerCount()).toBe(0);
  });

  it('treats an explicit null pre-join stream as a media-less join', async () => {
    const getUserMedia = vi.fn(async () => {
      throw new Error('getUserMedia must not run for a media-less join');
    });
    const harness = createHarness({
      getUserMedia,
      preparedMediaStream: null,
    });

    await joinSession(harness);

    expect(getUserMedia).not.toHaveBeenCalled();
    expect(harness.session.getLocalStream()).toBeNull();
    expect(harness.session.getSnapshot().localMedia).toEqual({
      audioAvailable: false,
      audioEnabled: false,
      videoAvailable: false,
      videoEnabled: false,
      videoSource: 'camera',
    });
  });

  it('bounds the signaling connect wait', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({
        recovery: { signalingConnectTimeoutMs: 25 },
      });
      const joining = harness.session.join();
      const rejected = expect(joining).rejects.toThrow(
        'Signaling connection did not open within 25ms',
      );
      await flushMicrotasks();

      await vi.advanceTimersByTimeAsync(25);
      await rejected;

      expect(harness.socket.closeCalls).toEqual([
        { code: 1000, reason: 'signaling connect timeout' },
      ]);
      expect(harness.audioTrack.stopped).toBe(true);
      expect(harness.videoTrack.stopped).toBe(true);
      expect(harness.session.getSnapshot()).toMatchObject({
        status: 'error',
        error: { code: 'signaling-connect-timeout' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds the room.joined wait', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({
        recovery: { roomJoinTimeoutMs: 30 },
      });
      const joining = harness.session.join();
      const rejected = expect(joining).rejects.toThrow('did not confirm room entry within 30ms');
      await flushMicrotasks();
      harness.socket.open();
      await flushMicrotasks();

      expect(harness.socket.messagesOfType('room.join')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(30);
      await rejected;

      expect(harness.audioTrack.stopped).toBe(true);
      expect(harness.videoTrack.stopped).toBe(true);
      expect(harness.session.getSnapshot()).toMatchObject({
        status: 'error',
        error: { code: 'room-join-timeout' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(SIGNALING_ERROR_CODES)(
    'fails an initial room join with a safe %s description',
    async (code) => {
      const harness = createHarness();
      const joining = harness.session.join();
      const rejected = expect(joining).rejects.toThrow();
      await flushMicrotasks();
      harness.socket.open();
      await flushMicrotasks();

      harness.socket.serverMessage({
        v: PROTOCOL_VERSION,
        type: 'error',
        roomId: ROOM_ID,
        payload: {
          code,
          message: 'raw server detail with internal-peer-id',
        },
      });
      await rejected;

      expect(harness.audioTrack.stopped).toBe(true);
      expect(harness.videoTrack.stopped).toBe(true);
      expect(harness.session.getSnapshot()).toMatchObject({
        status: 'error',
        error: { code },
      });
      expect(harness.session.getSnapshot().error?.message).not.toContain('internal-peer-id');
    },
  );

  it('rejects a non-positive peer connection timeout', () => {
    expect(() =>
      createHarness({
        recovery: { peerConnectionTimeoutMs: 0 },
      }),
    ).toThrow('recovery.peerConnectionTimeoutMs must be a positive integer');
  });

  it('creates ordered data channels and offers from the new peer', async () => {
    const harness = createHarness();
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);

    expect(harness.peerConnections).toHaveLength(1);
    const peer = harness.peerConnections[0];
    expect(peer?.addedTracks).toHaveLength(2);
    expect(peer?.channels).toHaveLength(1);
    expect(peer?.channels[0]).toMatchObject({
      label: 'round-room',
      ordered: true,
      maxRetransmits: null,
      maxPacketLifeTime: null,
    });
    expect(harness.socket.messagesOfType('rtc.offer')).toEqual([
      {
        v: PROTOCOL_VERSION,
        type: 'rtc.offer',
        roomId: 'abcd-efgh-jkmp',
        requestId: expect.any(String),
        to: 'peer-a',
        payload: {
          negotiationId: expect.any(String),
          description: { type: 'offer', sdp: 'offer-sdp' },
        },
      },
    ]);
    expect(harness.session.getSnapshot().participants.map(({ peerId }) => peerId)).toEqual([
      'self',
      'peer-a',
    ]);
  });

  it('최근 구간의 손실만 계산하고 참가자 ID·네트워크 주소를 진단에서 제외한다', async () => {
    const harness = createHarness();
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
    const peer = harness.peerConnections[0];
    if (peer === undefined) {
      throw new Error('Expected a peer connection');
    }
    peer.setConnectionState('connected');
    peer.statsReport = new Map<string, RTCStats>([
      [
        'transport',
        {
          id: 'transport',
          timestamp: 1,
          type: 'transport',
          dtlsState: 'connected',
          selectedCandidatePairId: 'selected-pair',
        } as RTCTransportStats,
      ],
      [
        'selected-pair',
        {
          id: 'selected-pair',
          timestamp: 1,
          type: 'candidate-pair',
          localCandidateId: 'local-candidate',
          remoteCandidateId: 'remote-candidate',
          state: 'succeeded',
          transportId: 'transport',
          currentRoundTripTime: 0.034,
        } as RTCIceCandidatePairStats,
      ],
      [
        'local-candidate',
        {
          id: 'local-candidate',
          timestamp: 1,
          type: 'local-candidate',
          candidateType: 'relay',
          address: '192.0.2.10',
        } as RTCStats,
      ],
      [
        'remote-candidate',
        {
          id: 'remote-candidate',
          timestamp: 1,
          type: 'remote-candidate',
          candidateType: 'srflx',
          address: '198.51.100.20',
        } as RTCStats,
      ],
      [
        'audio-inbound',
        {
          id: 'audio-inbound',
          timestamp: 1,
          type: 'inbound-rtp',
          packetsReceived: 990,
          packetsLost: 10,
          jitter: 0.012,
        } as RTCInboundRtpStreamStats,
      ],
      [
        'video-inbound',
        {
          id: 'video-inbound',
          timestamp: 1,
          type: 'inbound-rtp',
          packetsReceived: 480,
          packetsLost: 20,
          jitter: 0.018,
        } as RTCInboundRtpStreamStats,
      ],
    ]) as unknown as RTCStatsReport;

    const before = new Map(peer.statsReport);
    const after = new Map(before);
    after.set('audio-inbound', {
      ...before.get('audio-inbound'),
      timestamp: 3001,
      packetsReceived: 1089,
      packetsLost: 11,
    } as RTCStats);
    after.set('video-inbound', {
      ...before.get('video-inbound'),
      timestamp: 3001,
      packetsReceived: 579,
      packetsLost: 21,
    } as RTCStats);
    vi.spyOn(peer, 'getStats')
      .mockResolvedValueOnce(before as RTCStatsReport)
      .mockResolvedValueOnce(after as RTCStatsReport);
    vi.useFakeTimers();
    let diagnostics;
    try {
      const collecting = harness.session.collectConnectionDiagnostics();
      await vi.advanceTimersByTimeAsync(3_000);
      diagnostics = await collecting;
    } finally {
      vi.useRealTimers();
    }

    expect(diagnostics).toEqual({
      status: 'active',
      connections: [
        {
          connectionNumber: 1,
          participantName: 'Ara',
          connectionState: 'connected',
          localCandidateType: 'relay',
          remoteCandidateType: 'srflx',
          roundTripTimeMs: 34,
          packetLossPercent: 1,
          jitterMs: 18,
        },
      ],
    });
    expect(JSON.stringify(diagnostics)).not.toContain('peer-a');
    expect(JSON.stringify(diagnostics)).not.toContain('192.0.2.10');
    expect(JSON.stringify(diagnostics)).not.toContain('198.51.100.20');
  });

  it('closes incoming DataChannels that do not match the reliable ordered chat contract', async () => {
    const harness = createHarness({ createId: () => 'message-after-invalid-channel' });
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
    const peer = harness.peerConnections[0];
    const originalChannel = peer?.channels[0];
    if (peer === undefined || originalChannel === undefined) {
      throw new Error('Expected an initial DataChannel');
    }

    const invalidChannels = [
      new FakeDataChannel('unexpected-channel'),
      new FakeDataChannel('round-room', { ordered: false }),
      new FakeDataChannel('round-room', { maxRetransmits: 1 }),
      new FakeDataChannel('round-room', { maxPacketLifeTime: 1_000 }),
    ];
    for (const channel of invalidChannels) {
      peer.ondatachannel?.({ channel } as unknown as RTCDataChannelEvent);
    }

    expect(invalidChannels.every((channel) => channel.readyState === 'closed')).toBe(true);
    harness.session.sendChat('keep the valid channel');
    expect(
      originalChannel.sent
        .map((raw) => JSON.parse(raw) as { type: string; id?: string })
        .filter((message) => message.type === 'chat.message'),
    ).toEqual([expect.objectContaining({ id: 'message-after-invalid-channel' })]);
    await harness.session.leave();
  });

  it('removes only the peer targeted by a correlated TARGET_NOT_FOUND error', async () => {
    const harness = createHarness();
    await joinSession(harness, [
      { peerId: 'peer-a', displayName: 'Ara' },
      { peerId: 'peer-b', displayName: 'Bora' },
    ]);
    const peerA = harness.peerConnections[0];
    const peerB = harness.peerConnections[1];
    const requestId = latestOutgoingRequestId(harness.socket, 'rtc.offer', 'peer-a');

    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'error',
      roomId: ROOM_ID,
      requestId,
      payload: {
        code: 'TARGET_NOT_FOUND',
        message: 'raw target detail with internal-peer-id',
      },
    });
    await flushMicrotasks();

    expect(peerA?.closed).toBe(true);
    expect(peerB?.closed).toBe(false);
    expect(harness.session.getSnapshot()).toMatchObject({
      status: 'active',
      participants: [{ peerId: 'self' }, { peerId: 'peer-b' }],
      warning: null,
      error: null,
    });
  });

  it.each([
    { code: 'NOT_IN_ROOM', correlation: 'none', roomId: ROOM_ID },
    {
      code: 'ROOM_MISMATCH',
      correlation: 'unknown',
      roomId: OTHER_ROOM_ID,
    },
    { code: 'TARGET_SELF', correlation: 'known', roomId: ROOM_ID },
  ] satisfies readonly {
    code: Extract<SignalingErrorCode, 'NOT_IN_ROOM' | 'ROOM_MISMATCH' | 'TARGET_SELF'>;
    correlation: 'none' | 'unknown' | 'known';
    roomId: string;
  }[])(
    'reconnects safely on a valid $code error without orphaning the current socket',
    async ({ code, correlation, roomId }) => {
      const harness = createHarness();
      await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
      const oldSocket = harness.socket;
      const oldPeer = harness.peerConnections[0];
      const requestId =
        correlation === 'known'
          ? latestOutgoingRequestId(oldSocket, 'rtc.offer', 'peer-a')
          : correlation === 'unknown'
            ? 'unknown-membership-request'
            : undefined;

      oldSocket.serverMessage({
        v: PROTOCOL_VERSION,
        type: 'error',
        roomId,
        ...(requestId === undefined ? {} : { requestId }),
        payload: {
          code,
          message: 'raw room state detail',
        },
      });
      await flushMicrotasks();

      expect(oldSocket.closeCalls).toEqual([
        {
          code: 1000,
          reason:
            code === 'TARGET_SELF' ? 'signaling identity mismatch' : 'signaling state mismatch',
        },
      ]);
      expect(oldPeer?.closed).toBe(true);
      expect(harness.sockets).toHaveLength(2);
      expect(harness.audioTrack.stopped).toBe(false);
      expect(harness.videoTrack.stopped).toBe(false);
      expect(harness.session.getSnapshot()).toMatchObject({
        status: 'reconnecting',
        selfId: null,
        participants: [],
        warning: { code: 'signaling-reconnecting' },
        error: null,
      });

      oldSocket.serverClose(1011, 'late close from detached socket');
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
          peerId: 'self-after-resync',
          participants: [],
        },
      });
      await flushMicrotasks();

      expect(harness.session.getSnapshot()).toMatchObject({
        status: 'active',
        selfId: 'self-after-resync',
        warning: null,
        error: null,
      });
    },
  );

  it('terminates an active session safely on INVALID_MESSAGE', async () => {
    const harness = createHarness();
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);

    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'error',
      roomId: ROOM_ID,
      payload: {
        code: 'INVALID_MESSAGE',
        message: 'raw fatal detail with internal-peer-id',
      },
    });
    await flushMicrotasks();

    expect(harness.socket.closeCalls).toEqual([{ code: 1000, reason: 'fatal signaling error' }]);
    expect(harness.audioTrack.stopped).toBe(true);
    expect(harness.videoTrack.stopped).toBe(true);
    expect(harness.session.getSnapshot()).toMatchObject({
      status: 'error',
      selfId: null,
      participants: [],
      warning: null,
      error: { code: 'INVALID_MESSAGE' },
    });
    expect(harness.session.getSnapshot().error?.message).not.toContain('internal-peer-id');
  });

  it('keeps the room active with a safe INTERNAL_ERROR warning', async () => {
    const harness = createHarness();
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);

    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'error',
      roomId: ROOM_ID,
      payload: {
        code: 'INTERNAL_ERROR',
        message: 'raw warning detail with internal-peer-id',
      },
    });
    await flushMicrotasks();

    expect(harness.session.getSnapshot()).toMatchObject({
      status: 'active',
      participants: [{ peerId: 'self' }, { peerId: 'peer-a' }],
      warning: { code: 'INTERNAL_ERROR' },
      error: null,
    });
    expect(harness.session.getSnapshot().warning?.message).not.toContain('internal-peer-id');
  });

  it('does not replace a more actionable warning with INTERNAL_ERROR', async () => {
    const harness = createHarness();
    await joinSession(harness);
    harness.socket.serverMessage({ invalid: 'server message' });
    await flushMicrotasks();
    expect(harness.session.getSnapshot().warning?.code).toBe('invalid-signal-message');

    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'error',
      roomId: ROOM_ID,
      payload: {
        code: 'INTERNAL_ERROR',
        message: 'raw internal detail',
      },
    });
    await flushMicrotasks();

    expect(harness.session.getSnapshot().warning?.code).toBe('invalid-signal-message');
  });

  it.each(['ALREADY_JOINED', 'ROOM_FULL'] satisfies readonly SignalingErrorCode[])(
    'ignores late join-only $code errors while the room is active',
    async (code) => {
      const harness = createHarness();
      await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
      const requestId = latestOutgoingRequestId(harness.socket, 'rtc.offer', 'peer-a');

      harness.socket.serverMessage({
        v: PROTOCOL_VERSION,
        type: 'error',
        roomId: ROOM_ID,
        requestId,
        payload: {
          code,
          message: 'late join response',
        },
      });
      await flushMicrotasks();

      expect(harness.session.getSnapshot()).toMatchObject({
        status: 'active',
        participants: [{ peerId: 'self' }, { peerId: 'peer-a' }],
        warning: null,
        error: null,
      });

      harness.socket.serverMessage({
        v: PROTOCOL_VERSION,
        type: 'error',
        roomId: ROOM_ID,
        requestId,
        payload: {
          code: 'TARGET_NOT_FOUND',
          message: 'replayed request id',
        },
      });
      await flushMicrotasks();
      expect(harness.session.getSnapshot().participants).toContainEqual(
        expect.objectContaining({ peerId: 'peer-a' }),
      );
    },
  );

  it.each(['TARGET_NOT_FOUND', 'TARGET_SELF'] satisfies readonly SignalingErrorCode[])(
    'ignores $code with an unknown requestId without changing active room state',
    async (code) => {
      const harness = createHarness();
      await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);

      harness.socket.serverMessage({
        v: PROTOCOL_VERSION,
        type: 'error',
        roomId: ROOM_ID,
        requestId: `unknown-${code}`,
        payload: {
          code,
          message: 'stale error detail',
        },
      });
      await flushMicrotasks();

      expect(harness.session.getSnapshot()).toMatchObject({
        status: 'active',
        participants: [{ peerId: 'self' }, { peerId: 'peer-a' }],
        warning: null,
        error: null,
      });
    },
  );

  it('bounds relay request correlation and accepts only a retained requestId', async () => {
    const harness = createHarness();
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
    const peer = harness.peerConnections[0];
    const evictedRequestId = latestOutgoingRequestId(harness.socket, 'rtc.offer', 'peer-a');

    for (let index = 0; index < 256; index += 1) {
      peer?.emitIceCandidate(`candidate-${index}`);
    }
    const retainedRequestId = latestOutgoingRequestId(harness.socket, 'rtc.ice', 'peer-a');

    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'error',
      roomId: ROOM_ID,
      requestId: evictedRequestId,
      payload: {
        code: 'TARGET_NOT_FOUND',
        message: 'stale target detail',
      },
    });
    await flushMicrotasks();
    expect(harness.session.getSnapshot().participants).toContainEqual(
      expect.objectContaining({ peerId: 'peer-a' }),
    );

    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'error',
      roomId: ROOM_ID,
      requestId: retainedRequestId,
      payload: {
        code: 'TARGET_NOT_FOUND',
        message: 'current target detail',
      },
    });
    await flushMicrotasks();

    expect(harness.session.getSnapshot()).toMatchObject({
      status: 'active',
      participants: [{ peerId: 'self' }],
      warning: null,
      error: null,
    });
  });

  it('cleans peer, socket, channel, and media resources on leave', async () => {
    const harness = createHarness();
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
    const peer = harness.peerConnections[0];
    const channel = peer?.channels[0];
    expect(harness.audioTrack.endedListenerCount()).toBe(1);
    expect(harness.videoTrack.endedListenerCount()).toBe(1);

    await harness.session.leave();

    expect(harness.socket.messagesOfType('room.leave')).toHaveLength(1);
    expect(harness.socket.closeCalls).toEqual([{ code: 1000, reason: 'client leave' }]);
    expect(peer?.closed).toBe(true);
    expect(channel?.readyState).toBe('closed');
    expect(harness.audioTrack.stopped).toBe(true);
    expect(harness.videoTrack.stopped).toBe(true);
    expect(harness.audioTrack.endedListenerCount()).toBe(0);
    expect(harness.videoTrack.endedListenerCount()).toBe(0);
    expect(harness.session.getLocalStream()).toBeNull();
    expect(harness.session.getSnapshot()).toMatchObject({
      status: 'ended',
      selfId: null,
      participants: [],
    });
  });

  it('removes a departed peer and stops its remote tracks', async () => {
    const harness = createHarness();
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
    const peer = harness.peerConnections[0];
    const remoteAudio = new FakeTrack('audio');
    const remoteStream = new FakeMediaStream([remoteAudio]);
    peer?.ontrack?.({
      streams: [remoteStream as unknown as MediaStream],
      track: remoteAudio as unknown as MediaStreamTrack,
    } as unknown as RTCTrackEvent);

    expect(harness.session.getRemoteStream('peer-a')).toBe(remoteStream as unknown as MediaStream);
    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'peer.left',
      roomId: 'abcd-efgh-jkmp',
      payload: { peerId: 'peer-a' },
    });

    expect(peer?.closed).toBe(true);
    expect(remoteAudio.stopped).toBe(true);
    expect(harness.session.getRemoteStream('peer-a')).toBeNull();
    expect(
      harness.session.getSnapshot().participants.some(({ peerId }) => peerId === 'peer-a'),
    ).toBe(false);
  });
});
