import { describe, expect, it, vi } from 'vitest';

import { createRoomSession, type RoomSession } from '../src/index.js';

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
}

class FakePeerConnection {
  connectionState: RTCPeerConnectionState = 'new';
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null;
  onconnectionstatechange: ((event: Event) => void) | null = null;
  readonly addedTracks: MediaStreamTrack[] = [];
  readonly addedCandidates: (RTCIceCandidateInit | null)[] = [];
  readonly channels: FakeDataChannel[] = [];
  closed = false;

  addTrack(track: MediaStreamTrack): RTCRtpSender {
    this.addedTracks.push(track);
    return {} as RTCRtpSender;
  }

  createDataChannel(): RTCDataChannel {
    const channel = new FakeDataChannel();
    this.channels.push(channel);
    return channel as unknown as RTCDataChannel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'offer-sdp' };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: 'answer-sdp' };
  }

  async setLocalDescription(description: RTCLocalSessionDescriptionInit): Promise<void> {
    this.localDescription = description as RTCSessionDescription;
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description as RTCSessionDescription;
  }

  async addIceCandidate(candidate?: RTCIceCandidateInit | null): Promise<void> {
    this.addedCandidates.push(candidate ?? null);
  }

  close(): void {
    this.closed = true;
    this.connectionState = 'closed';
  }
}

interface Harness {
  readonly session: RoomSession;
  readonly socket: FakeWebSocket;
  readonly peerConnections: FakePeerConnection[];
  readonly audioTrack: FakeTrack;
  readonly videoTrack: FakeTrack;
}

function createHarness(
  overrides: {
    getUserMedia?: () => Promise<MediaStream>;
    createId?: () => string;
    now?: () => number;
  } = {},
): Harness {
  const socket = new FakeWebSocket();
  const peerConnections: FakePeerConnection[] = [];
  const audioTrack = new FakeTrack('audio');
  const videoTrack = new FakeTrack('video');
  const localStream = new FakeMediaStream([audioTrack, videoTrack]);

  const session = createRoomSession({
    roomId: 'study-room',
    displayName: 'Jin',
    signalingUrl: 'ws://localhost:8787',
    webSocketFactory: () => socket as unknown as WebSocket,
    peerConnectionFactory: () => {
      const peer = new FakePeerConnection();
      peerConnections.push(peer);
      return peer as unknown as RTCPeerConnection;
    },
    mediaDevices: {
      getUserMedia:
        overrides.getUserMedia ?? vi.fn(async () => localStream as unknown as MediaStream),
    },
    mediaStreamFactory: () => new FakeMediaStream() as unknown as MediaStream,
    ...(overrides.createId === undefined ? {} : { createId: overrides.createId }),
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
  });

  return {
    session,
    socket,
    peerConnections,
    audioTrack,
    videoTrack,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function joinSession(
  harness: Harness,
  participants: { peerId: string; displayName: string }[] = [],
): Promise<void> {
  const joining = harness.session.join();
  await flushMicrotasks();
  harness.socket.open();
  await flushMicrotasks();
  harness.socket.serverMessage({
    v: 1,
    type: 'room.joined',
    roomId: 'study-room',
    payload: {
      peerId: 'self',
      participants,
    },
  });
  await joining;
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
      roomId: 'study-room',
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
        roomId: 'study-room',
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

  it('queues ICE received before the remote description and flushes it on offer', async () => {
    const harness = createHarness();
    await joinSession(harness);

    harness.socket.serverMessage({
      v: 1,
      type: 'peer.joined',
      roomId: 'study-room',
      payload: {
        participant: { peerId: 'peer-a', displayName: 'Ara' },
      },
    });
    harness.socket.serverMessage({
      v: 1,
      type: 'rtc.ice',
      roomId: 'study-room',
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
      roomId: 'study-room',
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
        roomId: 'study-room',
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
      roomId: 'study-room',
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
      roomId: 'study-room',
      payload: { peerId: 'peer-a' },
    });

    expect(peer?.closed).toBe(true);
    expect(remoteAudio.stopped).toBe(true);
    expect(harness.session.getRemoteStream('peer-a')).toBeNull();
    expect(
      harness.session.getSnapshot().participants.some(({ peerId }) => peerId === 'peer-a'),
    ).toBe(false);
  });

  it('cleans resources and exposes an error when signaling closes', async () => {
    const harness = createHarness();
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
    const peer = harness.peerConnections[0];

    harness.socket.serverClose(1006, 'network lost');

    expect(peer?.closed).toBe(true);
    expect(harness.audioTrack.stopped).toBe(true);
    expect(harness.videoTrack.stopped).toBe(true);
    expect(harness.session.getSnapshot()).toMatchObject({
      status: 'error',
      selfId: null,
      participants: [],
      error: {
        code: 'signaling-closed',
        message: 'Signaling connection closed (network lost)',
      },
    });
  });
});
