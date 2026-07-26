import { describe, expect, it, vi } from 'vitest';

import {
  createRoomSession,
  type RoomSession,
  type RoomSessionRecoveryOptions,
} from '../src/index.js';

const ROOM_ID = 'abcd-efgh-jkmp';

type Listener = {
  callback: (event: unknown) => void;
  once: boolean;
};

class FakeWebSocket {
  readyState = 0;
  readonly sent: string[] = [];
  readonly closeCalls: { code?: number; reason?: string }[] = [];
  readonly #listeners = new Map<string, Listener[]>();

  addEventListener(
    type: string,
    callback: (event: unknown) => void,
    options?: AddEventListenerOptions | boolean,
  ): void {
    const once = typeof options === 'object' && options.once === true;
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push({ callback, once });
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type: string, callback: (event: unknown) => void): void {
    const listeners = this.#listeners.get(type) ?? [];
    this.#listeners.set(
      type,
      listeners.filter((listener) => listener.callback !== callback),
    );
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
    });
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.#dispatch('open', {});
  }

  serverMessage(message: unknown): void {
    this.#dispatch('message', { data: JSON.stringify(message) });
  }

  serverClose(code = 1006, reason = ''): void {
    this.readyState = 3;
    this.#dispatch('close', { code, reason });
  }

  error(): void {
    this.#dispatch('error', {});
  }

  messagesOfType(type: string): Record<string, unknown>[] {
    return this.sent
      .map((value) => JSON.parse(value) as Record<string, unknown>)
      .filter((message) => message.type === type);
  }

  #dispatch(type: string, event: unknown): void {
    const listeners = [...(this.#listeners.get(type) ?? [])];
    for (const listener of listeners) {
      listener.callback(event);
      if (listener.once) {
        this.removeEventListener(type, listener.callback);
      }
    }
  }
}

class FakeTrack {
  enabled = true;
  stopped = false;

  constructor(readonly kind: 'audio' | 'video') {}

  stop(): void {
    this.stopped = true;
  }
}

class FakeMediaStream {
  readonly #tracks: FakeTrack[];

  constructor(tracks: FakeTrack[] = []) {
    this.#tracks = tracks;
  }

  getTracks(): MediaStreamTrack[] {
    return this.#tracks as unknown as MediaStreamTrack[];
  }

  getAudioTracks(): MediaStreamTrack[] {
    return this.#tracks.filter((track) => track.kind === 'audio') as unknown as MediaStreamTrack[];
  }

  getVideoTracks(): MediaStreamTrack[] {
    return this.#tracks.filter((track) => track.kind === 'video') as unknown as MediaStreamTrack[];
  }

  addTrack(track: MediaStreamTrack): void {
    this.#tracks.push(track as unknown as FakeTrack);
  }
}

class FakeDataChannel {
  readyState: RTCDataChannelState = 'open';
  readonly sent: string[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 'closed';
  }

  open(): void {
    this.readyState = 'open';
    this.onopen?.({} as Event);
  }

  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }

  fail(): void {
    this.onerror?.({} as Event);
  }
}

class FakePeerConnection {
  connectionState: RTCPeerConnectionState = 'new';
  signalingState: RTCSignalingState = 'stable';
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null;
  onconnectionstatechange: ((event: Event) => void) | null = null;
  readonly addedTracks: MediaStreamTrack[] = [];
  readonly addedCandidates: (RTCIceCandidateInit | null)[] = [];
  readonly channels: FakeDataChannel[] = [];
  readonly offerOptions: (RTCOfferOptions | undefined)[] = [];
  readonly configurationCalls: RTCConfiguration[] = [];
  setConfigurationError: Error | null = null;
  closed = false;

  constructor(readonly initialConfiguration: RTCConfiguration | undefined) {}

  addTrack(track: MediaStreamTrack): RTCRtpSender {
    this.addedTracks.push(track);
    return {} as RTCRtpSender;
  }

  createDataChannel(): RTCDataChannel {
    const channel = new FakeDataChannel();
    this.channels.push(channel);
    return channel as unknown as RTCDataChannel;
  }

  async createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit> {
    this.offerOptions.push(options);
    return {
      type: 'offer',
      sdp: options?.iceRestart === true ? 'restart-offer-sdp' : 'offer-sdp',
    };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: 'answer-sdp' };
  }

  async setLocalDescription(description: RTCLocalSessionDescriptionInit): Promise<void> {
    this.localDescription = description as RTCSessionDescription;
    if (description.type === 'offer') {
      this.signalingState = 'have-local-offer';
    } else if (description.type === 'answer' || description.type === 'rollback') {
      this.signalingState = 'stable';
    }
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description as RTCSessionDescription;
    if (description.type === 'offer') {
      this.signalingState = 'have-remote-offer';
    } else if (description.type === 'answer') {
      this.signalingState = 'stable';
    }
  }

  async addIceCandidate(candidate?: RTCIceCandidateInit | null): Promise<void> {
    this.addedCandidates.push(candidate ?? null);
  }

  setConfiguration(configuration: RTCConfiguration): void {
    this.configurationCalls.push(configuration);
    if (this.setConfigurationError !== null) {
      throw this.setConfigurationError;
    }
  }

  close(): void {
    this.closed = true;
    this.connectionState = 'closed';
    this.signalingState = 'closed';
  }

  setConnectionState(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    this.onconnectionstatechange?.({} as Event);
  }
}

interface Harness {
  readonly session: RoomSession;
  readonly socket: FakeWebSocket;
  readonly sockets: FakeWebSocket[];
  readonly peerConnections: FakePeerConnection[];
  readonly audioTrack: FakeTrack;
  readonly videoTrack: FakeTrack;
}

function createHarness(
  overrides: {
    getUserMedia?: () => Promise<MediaStream>;
    preparedMediaStream?: MediaStream | null;
    createId?: () => string;
    now?: () => number;
    recovery?: RoomSessionRecoveryOptions;
    rtcConfiguration?: RTCConfiguration;
    onSocketCreated?: (socket: FakeWebSocket, index: number) => void;
  } = {},
): Harness {
  const sockets: FakeWebSocket[] = [];
  const peerConnections: FakePeerConnection[] = [];
  const audioTrack = new FakeTrack('audio');
  const videoTrack = new FakeTrack('video');
  const localStream = new FakeMediaStream([audioTrack, videoTrack]);

  const session = createRoomSession({
    roomId: ROOM_ID,
    displayName: 'Jin',
    signalingUrl: 'ws://localhost:8787',
    webSocketFactory: () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      overrides.onSocketCreated?.(socket, sockets.length - 1);
      return socket as unknown as WebSocket;
    },
    peerConnectionFactory: (configuration) => {
      const peer = new FakePeerConnection(configuration);
      peerConnections.push(peer);
      return peer as unknown as RTCPeerConnection;
    },
    mediaDevices: {
      getUserMedia:
        overrides.getUserMedia ?? vi.fn(async () => localStream as unknown as MediaStream),
    },
    mediaStreamFactory: () => new FakeMediaStream() as unknown as MediaStream,
    ...(overrides.rtcConfiguration === undefined
      ? {}
      : { rtcConfiguration: overrides.rtcConfiguration }),
    ...(Object.hasOwn(overrides, 'preparedMediaStream')
      ? { preparedMediaStream: overrides.preparedMediaStream ?? null }
      : {}),
    ...(overrides.createId === undefined ? {} : { createId: overrides.createId }),
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
    ...(overrides.recovery === undefined ? {} : { recovery: overrides.recovery }),
  });

  return {
    session,
    get socket() {
      const socket = sockets.at(-1);
      if (socket === undefined) {
        throw new Error('No signaling socket has been created');
      }
      return socket;
    },
    sockets,
    peerConnections,
    audioTrack,
    videoTrack,
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}

async function joinSession(
  harness: Harness,
  participants: { peerId: string; displayName: string }[] = [],
  selfId = 'self',
): Promise<void> {
  const joining = harness.session.join();
  await flushMicrotasks();
  harness.socket.open();
  await flushMicrotasks();
  harness.socket.serverMessage({
    v: 1,
    type: 'room.joined',
    roomId: ROOM_ID,
    payload: {
      peerId: selfId,
      participants,
    },
  });
  await joining;
  await flushMicrotasks();
}

async function answerPeer(harness: Harness, peerId: string): Promise<void> {
  harness.socket.serverMessage({
    v: 1,
    type: 'rtc.answer',
    roomId: ROOM_ID,
    from: peerId,
    payload: {
      description: { type: 'answer', sdp: 'remote-answer' },
    },
  });
  await flushMicrotasks();
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
      v: 1,
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
    });

    await harness.session.leave();

    expect(preparedAudio.stopped).toBe(true);
    expect(preparedVideo.stopped).toBe(true);
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

  it('creates ordered data channels and offers from the new peer', async () => {
    const harness = createHarness();
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);

    expect(harness.peerConnections).toHaveLength(1);
    const peer = harness.peerConnections[0];
    expect(peer?.addedTracks).toHaveLength(2);
    expect(peer?.channels).toHaveLength(1);
    expect(harness.socket.messagesOfType('rtc.offer')).toEqual([
      {
        v: 1,
        type: 'rtc.offer',
        roomId: 'abcd-efgh-jkmp',
        to: 'peer-a',
        payload: {
          description: { type: 'offer', sdp: 'offer-sdp' },
        },
      },
    ]);
    expect(harness.session.getSnapshot().participants.map(({ peerId }) => peerId)).toEqual([
      'self',
      'peer-a',
    ]);
  });

  it('defensively replaces RTC configuration for current and future peers without renegotiation', async () => {
    const initialUrls = ['stun:initial.example.test'];
    const initialIceServers: RTCIceServer[] = [{ urls: initialUrls }];
    const initialConfiguration: RTCConfiguration = {
      iceServers: initialIceServers,
      iceCandidatePoolSize: 1,
    };
    const harness = createHarness({ rtcConfiguration: initialConfiguration });

    initialUrls[0] = 'stun:mutated-before-join.example.test';
    initialIceServers.push({ urls: 'stun:injected.example.test' });
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);

    const currentPeer = harness.peerConnections[0];
    const currentChannel = currentPeer?.channels[0];
    expect(currentPeer?.initialConfiguration).toEqual({
      iceServers: [{ urls: ['stun:initial.example.test'] }],
      iceCandidatePoolSize: 1,
    });

    const refreshedUrls = ['turn:relay.example.test?transport=udp'];
    const refreshedIceServers: RTCIceServer[] = [
      {
        urls: refreshedUrls,
        username: 'refresh-user',
        credential: 'refresh-credential',
      },
    ];
    const refreshedConfiguration: RTCConfiguration = {
      iceServers: refreshedIceServers,
      iceTransportPolicy: 'all',
    };
    const offerCount = harness.socket.messagesOfType('rtc.offer').length;

    harness.session.updateRtcConfiguration(refreshedConfiguration);

    expect(currentPeer?.configurationCalls).toEqual([
      {
        iceServers: [
          {
            urls: ['turn:relay.example.test?transport=udp'],
            username: 'refresh-user',
            credential: 'refresh-credential',
          },
        ],
        iceTransportPolicy: 'all',
      },
    ]);
    expect(harness.peerConnections).toHaveLength(1);
    expect(currentPeer?.channels[0]).toBe(currentChannel);
    expect(harness.sockets).toHaveLength(1);
    expect(harness.socket.messagesOfType('rtc.offer')).toHaveLength(offerCount);

    refreshedUrls[0] = 'turn:mutated.example.test';
    refreshedIceServers.push({ urls: 'turn:injected.example.test' });
    const appliedIceServers = currentPeer?.configurationCalls[0]?.iceServers;
    if (appliedIceServers !== undefined) {
      appliedIceServers[0] = { urls: 'turn:mutated-by-peer.example.test' };
      appliedIceServers.push({ urls: 'turn:injected-by-peer.example.test' });
    }
    harness.socket.serverMessage({
      v: 1,
      type: 'peer.joined',
      roomId: ROOM_ID,
      payload: {
        participant: { peerId: 'peer-b', displayName: 'Bo' },
      },
    });
    await flushMicrotasks();

    expect(harness.peerConnections).toHaveLength(2);
    expect(harness.peerConnections[1]?.initialConfiguration).toEqual({
      iceServers: [
        {
          urls: ['turn:relay.example.test?transport=udp'],
          username: 'refresh-user',
          credential: 'refresh-credential',
        },
      ],
      iceTransportPolicy: 'all',
    });
    expect(harness.peerConnections[1]?.initialConfiguration).not.toBe(
      currentPeer?.configurationCalls[0],
    );
    expect(harness.sockets).toHaveLength(1);
    expect(harness.socket.messagesOfType('rtc.offer')).toHaveLength(offerCount);
  });

  it('reports one non-fatal warning when configuration refresh fails for current peers', async () => {
    const harness = createHarness();
    await joinSession(harness, [
      { peerId: 'peer-a', displayName: 'Ara' },
      { peerId: 'peer-b', displayName: 'Bo' },
    ]);
    const firstPeer = harness.peerConnections[0];
    const secondPeer = harness.peerConnections[1];
    const firstChannel = firstPeer?.channels[0];
    const secondChannel = secondPeer?.channels[0];
    if (firstPeer === undefined) {
      throw new Error('Expected the first peer connection');
    }
    firstPeer.setConfigurationError = new DOMException(
      'configuration rejected',
      'InvalidModificationError',
    );

    const refreshedConfiguration: RTCConfiguration = {
      iceServers: [{ urls: 'turn:refreshed.example.test', username: 'u', credential: 'c' }],
    };
    harness.session.updateRtcConfiguration(refreshedConfiguration);

    expect(firstPeer.configurationCalls).toHaveLength(1);
    expect(secondPeer?.configurationCalls).toHaveLength(1);
    expect(firstPeer.channels[0]).toBe(firstChannel);
    expect(secondPeer?.channels[0]).toBe(secondChannel);
    expect(harness.session.getSnapshot()).toMatchObject({
      status: 'active',
      error: null,
      warning: {
        code: 'rtc-configuration-update-failed',
        message:
          'Could not apply refreshed ICE configuration to 1 peer connection(s); existing connections remain active',
      },
    });

    harness.socket.serverMessage({
      v: 1,
      type: 'peer.joined',
      roomId: ROOM_ID,
      payload: {
        participant: { peerId: 'peer-c', displayName: 'Cy' },
      },
    });
    await flushMicrotasks();
    expect(harness.peerConnections[2]?.initialConfiguration).toEqual(refreshedConfiguration);

    firstPeer.setConfigurationError = null;
    harness.session.updateRtcConfiguration({
      iceServers: [{ urls: 'turn:next.example.test', username: 'next', credential: 'next' }],
    });

    expect(harness.session.getSnapshot().warning).toBeNull();
    expect(harness.session.getSnapshot().error).toBeNull();
  });

  it('skips stale closed peers and safely ignores configuration updates after leave', async () => {
    const harness = createHarness();
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
    const stalePeer = harness.peerConnections[0];

    harness.socket.serverMessage({
      v: 1,
      type: 'peer.left',
      roomId: ROOM_ID,
      payload: { peerId: 'peer-a' },
    });
    await flushMicrotasks();
    expect(stalePeer?.closed).toBe(true);

    const refreshedConfiguration: RTCConfiguration = {
      iceServers: [{ urls: 'turn:future.example.test', username: 'future', credential: 'future' }],
    };
    harness.session.updateRtcConfiguration(refreshedConfiguration);
    expect(stalePeer?.configurationCalls).toEqual([]);

    harness.socket.serverMessage({
      v: 1,
      type: 'peer.joined',
      roomId: ROOM_ID,
      payload: {
        participant: { peerId: 'peer-b', displayName: 'Bo' },
      },
    });
    await flushMicrotasks();
    const futurePeer = harness.peerConnections[1];
    expect(futurePeer?.initialConfiguration).toEqual(refreshedConfiguration);

    await harness.session.leave();
    const callCountAfterLeave = futurePeer?.configurationCalls.length;
    expect(() => {
      harness.session.updateRtcConfiguration({
        iceServers: [{ urls: 'turn:ignored.example.test' }],
      });
    }).not.toThrow();

    expect(futurePeer?.configurationCalls).toHaveLength(callCountAfterLeave ?? 0);
    expect(harness.peerConnections).toHaveLength(2);
    expect(harness.sockets).toHaveLength(1);
    expect(harness.session.getSnapshot()).toMatchObject({
      status: 'ended',
      error: null,
    });
  });

  it('queues ICE received before the remote description and flushes it on offer', async () => {
    const harness = createHarness();
    await joinSession(harness);

    harness.socket.serverMessage({
      v: 1,
      type: 'peer.joined',
      roomId: 'abcd-efgh-jkmp',
      payload: {
        participant: { peerId: 'peer-a', displayName: 'Ara' },
      },
    });
    harness.socket.serverMessage({
      v: 1,
      type: 'rtc.ice',
      roomId: 'abcd-efgh-jkmp',
      from: 'peer-a',
      payload: {
        candidate: {
          candidate: 'candidate:1',
          sdpMid: '0',
          sdpMLineIndex: 0,
          usernameFragment: null,
        },
      },
    });
    await flushMicrotasks();

    const peer = harness.peerConnections[0];
    expect(peer?.addedCandidates).toEqual([]);

    harness.socket.serverMessage({
      v: 1,
      type: 'rtc.offer',
      roomId: 'abcd-efgh-jkmp',
      from: 'peer-a',
      payload: {
        description: { type: 'offer', sdp: 'remote-offer' },
      },
    });
    await flushMicrotasks();

    expect(peer?.addedCandidates).toEqual([
      {
        candidate: 'candidate:1',
        sdpMid: '0',
        sdpMLineIndex: 0,
        usernameFragment: null,
      },
    ]);
    expect(harness.socket.messagesOfType('rtc.answer')).toEqual([
      {
        v: 1,
        type: 'rtc.answer',
        roomId: 'abcd-efgh-jkmp',
        to: 'peer-a',
        payload: {
          description: { type: 'answer', sdp: 'answer-sdp' },
        },
      },
    ]);
  });

  it('toggles local tracks and announces media state', async () => {
    const harness = createHarness();
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
    const channel = harness.peerConnections[0]?.channels[0];
    expect(channel).toBeDefined();

    expect(harness.session.toggleAudio()).toBe(false);
    expect(harness.session.toggleVideo()).toBe(false);

    expect(harness.audioTrack.enabled).toBe(false);
    expect(harness.videoTrack.enabled).toBe(false);
    expect(harness.session.getSnapshot().localMedia).toMatchObject({
      audioEnabled: false,
      videoEnabled: false,
    });
    expect(channel?.sent.map((raw) => JSON.parse(raw)).slice(-2)).toEqual([
      {
        type: 'participant.media',
        audioEnabled: false,
        videoEnabled: true,
      },
      {
        type: 'participant.media',
        audioEnabled: false,
        videoEnabled: false,
      },
    ]);
  });

  it('fans chat out, echoes locally, and ignores duplicate message ids', async () => {
    const harness = createHarness({
      createId: () => 'message-local',
      now: () => 1_234,
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
    });
    expect(JSON.parse(channel?.sent.at(-1) ?? '')).toEqual({
      type: 'chat.message',
      id: 'message-local',
      senderId: 'self',
      text: 'hello',
      sentAt: 1_234,
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
      local,
      {
        id: 'message-remote',
        senderId: 'peer-a',
        senderName: 'Ara',
        text: 'hi back',
        sentAt: 1_235,
        isLocal: false,
      },
    ]);
  });

  it('flushes chat queued while the data channel is connecting exactly once', async () => {
    const harness = createHarness({
      createId: () => 'message-queued',
      now: () => 2_345,
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
      now: () => 3_456,
    });
    await joinSession(harness);

    harness.socket.serverMessage({
      v: 1,
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

  it('reports a data channel error when the peer remains active', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
      const channel = harness.peerConnections[0]?.channels[0];

      channel?.fail();
      await vi.advanceTimersByTimeAsync(251);

      expect(harness.session.getSnapshot().warning).toEqual({
        code: 'data-channel-error',
        message: 'Chat channel to peer-a encountered an error',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('suppresses a data channel error that races a normal peer departure', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
      const channel = harness.peerConnections[0]?.channels[0];

      channel?.fail();
      harness.socket.serverMessage({
        v: 1,
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

  it('cleans peer, socket, channel, and media resources on leave', async () => {
    const harness = createHarness();
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
    const peer = harness.peerConnections[0];
    const channel = peer?.channels[0];

    await harness.session.leave();

    expect(harness.socket.messagesOfType('room.leave')).toHaveLength(1);
    expect(harness.socket.closeCalls).toEqual([{ code: 1000, reason: 'client leave' }]);
    expect(peer?.closed).toBe(true);
    expect(channel?.readyState).toBe('closed');
    expect(harness.audioTrack.stopped).toBe(true);
    expect(harness.videoTrack.stopped).toBe(true);
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
      v: 1,
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

  it('re-enters on a fresh socket while retaining local media and chat history', async () => {
    const harness = createHarness({
      createId: () => 'message-before-reconnect',
      now: () => 4_567,
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

    oldSocket.serverClose(1006, 'network lost');
    await flushMicrotasks();

    expect(harness.sockets).toHaveLength(2);
    expect(oldPeer?.closed).toBe(true);
    expect(remoteAudio.stopped).toBe(true);
    expect(harness.audioTrack.stopped).toBe(false);
    expect(harness.videoTrack.stopped).toBe(false);
    expect(harness.session.getSnapshot()).toMatchObject({
      status: 'reconnecting',
      selfId: null,
      participants: [],
      messages: [chat],
      error: null,
    });

    const reconnectSocket = harness.socket;
    reconnectSocket.open();
    await flushMicrotasks();
    reconnectSocket.serverMessage({
      v: 1,
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
      messages: [chat],
      error: null,
    });
    expect(participantIds).toEqual(['self-after-reconnect', 'peer-a']);
    expect(new Set(participantIds).size).toBe(participantIds.length);
    expect(harness.peerConnections).toHaveLength(2);
    expect(harness.session.getRemoteStream('peer-a')).toBeNull();
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
        now: () => 5_678,
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
        v: 1,
        type: 'rtc.offer',
        roomId: ROOM_ID,
        from: 'a-peer',
        payload: {
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
          description: { type: 'answer', sdp: 'answer-sdp' },
        },
      });
      await harness.session.leave();
    } finally {
      vi.useRealTimers();
    }
  });
});
