import { describe, expect, it, vi } from 'vitest';

import {
  PROTOCOL_VERSION,
  SIGNALING_ERROR_CODES,
  utf8ByteLength,
  type SignalingErrorCode,
} from '@round/protocol';
import {
  createRoomSession,
  type RoomSession,
  type RoomSessionRecoveryOptions,
} from '../src/index.js';

const ROOM_ID = 'abcd-efgh-jkmp';
const OTHER_ROOM_ID = 'bcde-fghj-kmnp';

type Listener = {
  callback: (event: unknown) => void;
  once: boolean;
};

class FakeWebSocket {
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = this.CONNECTING;
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
    this.readyState = this.CLOSED;
  }

  open(): void {
    this.readyState = this.OPEN;
    this.#dispatch('open', {});
  }

  serverMessage(message: unknown): void {
    let normalized = message;
    if (typeof message === 'object' && message !== null && !Array.isArray(message)) {
      const serverMessage = message as Record<string, unknown>;
      if (
        serverMessage.type === 'room.joined' &&
        typeof serverMessage.payload === 'object' &&
        serverMessage.payload !== null &&
        !Array.isArray(serverMessage.payload)
      ) {
        const payload = serverMessage.payload as Record<string, unknown>;
        normalized = {
          ...serverMessage,
          payload: {
            selfRole: 'participant',
            capabilities: { canModerateMedia: false },
            ...payload,
            participants: Array.isArray(payload.participants)
              ? payload.participants.map((participant) =>
                  typeof participant === 'object' &&
                  participant !== null &&
                  !Array.isArray(participant)
                    ? { role: 'participant', ...participant }
                    : participant,
                )
              : payload.participants,
          },
        };
      } else if (
        serverMessage.type === 'peer.joined' &&
        typeof serverMessage.payload === 'object' &&
        serverMessage.payload !== null &&
        !Array.isArray(serverMessage.payload)
      ) {
        const payload = serverMessage.payload as Record<string, unknown>;
        normalized = {
          ...serverMessage,
          payload: {
            ...payload,
            participant:
              typeof payload.participant === 'object' &&
              payload.participant !== null &&
              !Array.isArray(payload.participant)
                ? { role: 'participant', ...payload.participant }
                : payload.participant,
          },
        };
      }
    }
    this.#dispatch('message', { data: JSON.stringify(normalized) });
  }

  serverClose(code = 1006, reason = ''): void {
    this.readyState = this.CLOSED;
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
  readyState: MediaStreamTrackState = 'live';
  readonly #endedListeners = new Set<EventListener>();

  constructor(readonly kind: 'audio' | 'video') {}

  addEventListener(type: string, listener: EventListener): void {
    if (type === 'ended') {
      this.#endedListeners.add(listener);
    }
  }

  removeEventListener(type: string, listener: EventListener): void {
    if (type === 'ended') {
      this.#endedListeners.delete(listener);
    }
  }

  stop(): void {
    this.stopped = true;
    this.readyState = 'ended';
  }

  end(): void {
    if (this.readyState === 'ended') {
      return;
    }
    this.readyState = 'ended';
    for (const listener of [...this.#endedListeners]) {
      listener({ type: 'ended' } as Event);
    }
  }

  endedListenerCount(): number {
    return this.#endedListeners.size;
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

  removeTrack(track: MediaStreamTrack): void {
    const index = this.#tracks.indexOf(track as unknown as FakeTrack);
    if (index >= 0) {
      this.#tracks.splice(index, 1);
    }
  }
}

class FakeDataChannel {
  readonly label: string;
  readonly ordered: boolean;
  readonly maxRetransmits: number | null;
  readonly maxPacketLifeTime: number | null;
  readyState: RTCDataChannelState = 'open';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readonly sent: string[] = [];
  readonly sendErrors: Error[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onbufferedamountlow: ((event: Event) => void) | null = null;

  constructor(label = 'round-room', options: RTCDataChannelInit = { ordered: true }) {
    this.label = label;
    this.ordered = options.ordered ?? true;
    this.maxRetransmits = options.maxRetransmits ?? null;
    this.maxPacketLifeTime = options.maxPacketLifeTime ?? null;
  }

  send(data: string): void {
    const error = this.sendErrors.shift();
    if (error !== undefined) {
      throw error;
    }
    this.sent.push(data);
    this.bufferedAmount += utf8ByteLength(data);
  }

  close(): void {
    this.readyState = 'closed';
  }

  open(): void {
    this.readyState = 'open';
    this.onopen?.({} as Event);
  }

  drainBufferedAmount(bufferedAmount = 0): void {
    const previousBufferedAmount = this.bufferedAmount;
    this.bufferedAmount = bufferedAmount;
    if (
      previousBufferedAmount > this.bufferedAmountLowThreshold &&
      bufferedAmount <= this.bufferedAmountLowThreshold
    ) {
      this.onbufferedamountlow?.({} as Event);
    }
  }

  receive(message: unknown): void {
    const normalized =
      typeof message === 'object' &&
      message !== null &&
      !Array.isArray(message) &&
      (message as { type?: unknown }).type === 'participant.media'
        ? { videoSource: 'camera', ...message }
        : message;
    this.receiveRaw(JSON.stringify(normalized));
  }

  receiveRaw(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  fail(): void {
    this.onerror?.({} as Event);
  }

  remoteClose(): void {
    this.readyState = 'closed';
    this.onclose?.({} as Event);
  }
}

class FakeRtpSender {
  readonly replaceTrackCalls: (MediaStreamTrack | null)[] = [];
  readonly replacements: (MediaStreamTrack | null)[] = [];
  readonly replaceTrackGates: Promise<void>[] = [];
  readonly replaceTrackErrors: (Error | undefined)[] = [];

  constructor(public track: MediaStreamTrack | null) {}

  async replaceTrack(track: MediaStreamTrack | null): Promise<void> {
    this.replaceTrackCalls.push(track);
    const gate = this.replaceTrackGates.shift();
    if (gate !== undefined) {
      await gate;
    }
    const error = this.replaceTrackErrors.shift();
    if (error !== undefined) {
      throw error;
    }
    this.track = track;
    this.replacements.push(track);
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
  onsignalingstatechange: ((event: Event) => void) | null = null;
  readonly addedTracks: MediaStreamTrack[] = [];
  readonly senders: FakeRtpSender[] = [];
  readonly removedSenders: FakeRtpSender[] = [];
  readonly addedCandidates: (RTCIceCandidateInit | null)[] = [];
  readonly channels: FakeDataChannel[] = [];
  readonly offerOptions: (RTCOfferOptions | undefined)[] = [];
  readonly configurationCalls: RTCConfiguration[] = [];
  readonly addTrackErrors: Error[] = [];
  readonly createOfferErrors: Error[] = [];
  createOfferDelayMs = 0;
  setRemoteDescriptionDelayMs = 0;
  answerIceUsernameFragment: string | null = null;
  setConfigurationError: Error | null = null;
  closed = false;

  constructor(readonly initialConfiguration: RTCConfiguration | undefined) {}

  addTrack(track: MediaStreamTrack): RTCRtpSender {
    const error = this.addTrackErrors.shift();
    if (error !== undefined) {
      throw error;
    }
    this.addedTracks.push(track);
    const sender = new FakeRtpSender(track);
    this.senders.push(sender);
    return sender as unknown as RTCRtpSender;
  }

  removeTrack(sender: RTCRtpSender): void {
    const fakeSender = sender as unknown as FakeRtpSender;
    fakeSender.track = null;
    this.removedSenders.push(fakeSender);
  }

  createDataChannel(label: string, options?: RTCDataChannelInit): RTCDataChannel {
    const channel = new FakeDataChannel(label, options);
    this.channels.push(channel);
    return channel as unknown as RTCDataChannel;
  }

  async createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit> {
    this.offerOptions.push(options);
    if (this.createOfferDelayMs > 0) {
      await new Promise<void>((resolve) => {
        globalThis.setTimeout(resolve, this.createOfferDelayMs);
      });
    }
    const error = this.createOfferErrors.shift();
    if (error !== undefined) {
      throw error;
    }
    return {
      type: 'offer',
      sdp: options?.iceRestart === true ? 'restart-offer-sdp' : 'offer-sdp',
    };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return {
      type: 'answer',
      sdp:
        this.answerIceUsernameFragment === null
          ? 'answer-sdp'
          : `answer-sdp\r\na=ice-ufrag:${this.answerIceUsernameFragment}`,
    };
  }

  async setLocalDescription(description: RTCLocalSessionDescriptionInit): Promise<void> {
    this.localDescription = description as RTCSessionDescription;
    if (description.type === 'offer') {
      this.signalingState = 'have-local-offer';
    } else if (description.type === 'answer' || description.type === 'rollback') {
      this.signalingState = 'stable';
    }
    this.onsignalingstatechange?.({} as Event);
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    if (this.setRemoteDescriptionDelayMs > 0) {
      await new Promise<void>((resolve) => {
        globalThis.setTimeout(resolve, this.setRemoteDescriptionDelayMs);
      });
    }
    this.remoteDescription = description as RTCSessionDescription;
    if (description.type === 'offer') {
      this.signalingState = 'have-remote-offer';
    } else if (description.type === 'answer') {
      this.signalingState = 'stable';
    }
    this.onsignalingstatechange?.({} as Event);
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

  emitIceCandidate(usernameFragment: string): void {
    const serialized = {
      candidate: `candidate:${usernameFragment} ufrag ${usernameFragment}`,
      sdpMid: '0',
      sdpMLineIndex: 0,
      usernameFragment,
    };
    this.onicecandidate?.({
      candidate: {
        ...serialized,
        toJSON: () => serialized,
      },
    } as unknown as RTCPeerConnectionIceEvent);
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
    getDisplayMedia?: (constraints: DisplayMediaStreamOptions) => Promise<MediaStream>;
    preparedMediaStream?: MediaStream | null;
    createId?: () => string;
    wallClockNow?: () => number;
    monotonicNow?: () => number;
    displayName?: string;
    hostCapability?: string;
    maxChatMessages?: number;
    recovery?: RoomSessionRecoveryOptions;
    rtcConfiguration?: RTCConfiguration;
    beforeSignalingConnect?: () => void | Promise<void>;
    onSocketCreated?: (socket: FakeWebSocket, index: number) => void;
    onPeerConnectionCreated?: (peer: FakePeerConnection, index: number) => void;
  } = {},
): Harness {
  const sockets: FakeWebSocket[] = [];
  const peerConnections: FakePeerConnection[] = [];
  const audioTrack = new FakeTrack('audio');
  const videoTrack = new FakeTrack('video');
  const localStream = new FakeMediaStream([audioTrack, videoTrack]);

  const session = createRoomSession({
    roomId: ROOM_ID,
    displayName: overrides.displayName ?? 'Jin',
    signalingUrl: 'ws://localhost:8787',
    ...(overrides.hostCapability === undefined ? {} : { hostCapability: overrides.hostCapability }),
    webSocketFactory: () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      overrides.onSocketCreated?.(socket, sockets.length - 1);
      return socket as unknown as WebSocket;
    },
    peerConnectionFactory: (configuration) => {
      const peer = new FakePeerConnection(configuration);
      peerConnections.push(peer);
      overrides.onPeerConnectionCreated?.(peer, peerConnections.length - 1);
      return peer as unknown as RTCPeerConnection;
    },
    mediaDevices: {
      getUserMedia:
        overrides.getUserMedia ?? vi.fn(async () => localStream as unknown as MediaStream),
      ...(overrides.getDisplayMedia === undefined
        ? {}
        : { getDisplayMedia: overrides.getDisplayMedia }),
    },
    mediaStreamFactory: () => new FakeMediaStream() as unknown as MediaStream,
    ...(overrides.rtcConfiguration === undefined
      ? {}
      : { rtcConfiguration: overrides.rtcConfiguration }),
    ...(Object.hasOwn(overrides, 'preparedMediaStream')
      ? { preparedMediaStream: overrides.preparedMediaStream ?? null }
      : {}),
    ...(overrides.createId === undefined ? {} : { createId: overrides.createId }),
    ...(overrides.wallClockNow === undefined ? {} : { wallClockNow: overrides.wallClockNow }),
    ...(overrides.monotonicNow === undefined ? {} : { monotonicNow: overrides.monotonicNow }),
    ...(overrides.maxChatMessages === undefined
      ? {}
      : { maxChatMessages: overrides.maxChatMessages }),
    ...(overrides.recovery === undefined ? {} : { recovery: overrides.recovery }),
    ...(overrides.beforeSignalingConnect === undefined
      ? {}
      : { beforeSignalingConnect: overrides.beforeSignalingConnect }),
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

function createPromiseGate(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function joinSession(
  harness: Harness,
  participants: { peerId: string; displayName: string; role?: 'host' | 'participant' }[] = [],
  selfId = 'self',
  authorization: {
    readonly selfRole?: 'host' | 'participant';
    readonly canModerateMedia?: boolean;
  } = {},
): Promise<void> {
  const joining = harness.session.join();
  await flushMicrotasks();
  harness.socket.open();
  await flushMicrotasks();
  harness.socket.serverMessage({
    v: PROTOCOL_VERSION,
    type: 'room.joined',
    roomId: ROOM_ID,
    payload: {
      peerId: selfId,
      selfRole: authorization.selfRole ?? 'participant',
      capabilities: {
        canModerateMedia: authorization.canModerateMedia ?? false,
      },
      participants: participants.map((participant) => ({
        role: participant.role ?? 'participant',
        ...participant,
      })),
    },
  });
  await joining;
  await flushMicrotasks();
}

function latestOutgoingNegotiationId(harness: Harness, peerId: string): string | undefined {
  const offers = harness.socket.messagesOfType('rtc.offer');
  for (let index = offers.length - 1; index >= 0; index -= 1) {
    const offer = offers[index];
    if (offer?.to !== peerId || typeof offer.payload !== 'object' || offer.payload === null) {
      continue;
    }
    const negotiationId = (offer.payload as Record<string, unknown>).negotiationId;
    return typeof negotiationId === 'string' ? negotiationId : undefined;
  }
  return undefined;
}

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

async function answerPeer(harness: Harness, peerId: string): Promise<void> {
  const negotiationId = latestOutgoingNegotiationId(harness, peerId);
  harness.socket.serverMessage({
    v: PROTOCOL_VERSION,
    type: 'rtc.answer',
    roomId: ROOM_ID,
    from: peerId,
    payload: {
      ...(negotiationId === undefined ? {} : { negotiationId }),
      description: { type: 'answer', sdp: 'remote-answer' },
    },
  });
  await flushMicrotasks();
}

function exceedInboundDataBudget(channel: FakeDataChannel): void {
  for (let index = 0; index <= 120; index += 1) {
    channel.receiveRaw('not-json');
  }
}

function acknowledgeChat(channel: FakeDataChannel, id: string): void {
  channel.receive({ type: 'chat.ack', messageId: id });
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

  it('validates an outbound signaling message before writing to the socket', async () => {
    const harness = createHarness({
      displayName: 'J'.repeat(65),
    });
    const joining = expect(harness.session.join()).rejects.toThrow(
      'must contain at most 64 characters',
    );

    await flushMicrotasks();
    harness.socket.open();
    await joining;

    expect(harness.socket.sent).toEqual([]);
    expect(harness.session.getSnapshot().status).toBe('error');
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

      peer?.setConnectionState('connected');
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

  it('isolates RTC configuration for current and future peers without renegotiation', async () => {
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
      v: PROTOCOL_VERSION,
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

  it('lets only the deterministic initiator restart ICE after a TURN refresh', async () => {
    const initiator = createHarness();
    await joinSession(initiator, [{ peerId: 'z-peer', displayName: 'Zoe' }], 'a-self');
    await answerPeer(initiator, 'z-peer');
    const initiatorPeer = initiator.peerConnections[0];
    const initiatorChannel = initiatorPeer?.channels[0];
    initiatorPeer?.setConnectionState('connected');

    const refreshedConfiguration: RTCConfiguration = {
      iceServers: [
        {
          urls: 'turn:refreshed.example.test',
          username: 'refresh-user',
          credential: 'refresh-credential',
        },
      ],
    };
    initiator.session.updateRtcConfiguration(refreshedConfiguration, {
      restartIce: true,
    });
    await flushMicrotasks();

    expect(initiatorPeer?.configurationCalls).toEqual([refreshedConfiguration]);
    expect(initiatorPeer?.offerOptions).toEqual([undefined, { iceRestart: true }]);
    expect(initiatorPeer?.channels[0]).toBe(initiatorChannel);
    expect(initiator.socket.messagesOfType('rtc.offer').at(-1)).toMatchObject({
      to: 'z-peer',
      payload: {
        description: { type: 'offer', sdp: 'restart-offer-sdp' },
      },
    });
    await answerPeer(initiator, 'z-peer');
    expect(initiator.session.getSnapshot().participants).toContainEqual(
      expect.objectContaining({
        peerId: 'z-peer',
        connectionState: 'connected',
      }),
    );
    await initiator.session.leave();

    const responder = createHarness();
    await joinSession(responder, [{ peerId: 'a-peer', displayName: 'Ara' }], 'z-self');
    await answerPeer(responder, 'a-peer');
    const responderPeer = responder.peerConnections[0];
    responderPeer?.setConnectionState('connected');

    responder.session.updateRtcConfiguration(refreshedConfiguration, {
      restartIce: true,
    });
    await flushMicrotasks();

    expect(responderPeer?.configurationCalls).toEqual([refreshedConfiguration]);
    expect(responderPeer?.offerOptions).toEqual([undefined]);
    expect(responder.socket.messagesOfType('rtc.offer')).toHaveLength(1);
    await responder.session.leave();
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
      v: PROTOCOL_VERSION,
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
      v: PROTOCOL_VERSION,
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
      v: PROTOCOL_VERSION,
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
      v: PROTOCOL_VERSION,
      type: 'peer.joined',
      roomId: 'abcd-efgh-jkmp',
      payload: {
        participant: { peerId: 'peer-a', displayName: 'Ara' },
      },
    });
    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
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
      v: PROTOCOL_VERSION,
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
        v: PROTOCOL_VERSION,
        type: 'rtc.answer',
        roomId: 'abcd-efgh-jkmp',
        requestId: expect.any(String),
        to: 'peer-a',
        payload: {
          description: { type: 'answer', sdp: 'answer-sdp' },
        },
      },
    ]);
  });

  it('bounds pending remote ICE candidates and retains the newest candidates', async () => {
    const harness = createHarness();
    await joinSession(harness);

    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'peer.joined',
      roomId: ROOM_ID,
      payload: {
        participant: { peerId: 'peer-a', displayName: 'Ara' },
      },
    });
    for (let index = 0; index <= 256; index += 1) {
      harness.socket.serverMessage({
        v: PROTOCOL_VERSION,
        type: 'rtc.ice',
        roomId: ROOM_ID,
        from: 'peer-a',
        payload: {
          candidate: {
            candidate: `candidate:${index}`,
            sdpMid: '0',
            sdpMLineIndex: 0,
            usernameFragment: null,
          },
        },
      });
    }
    await flushMicrotasks();

    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'rtc.offer',
      roomId: ROOM_ID,
      from: 'peer-a',
      payload: {
        description: { type: 'offer', sdp: 'remote-offer' },
      },
    });
    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, 0);
    });

    const peer = harness.peerConnections[0];
    expect(peer?.addedCandidates).toHaveLength(256);
    expect(peer?.addedCandidates.at(0)).toEqual({
      candidate: 'candidate:1',
      sdpMid: '0',
      sdpMLineIndex: 0,
      usernameFragment: null,
    });
    expect(peer?.addedCandidates.at(-1)).toEqual({
      candidate: 'candidate:256',
      sdpMid: '0',
      sdpMLineIndex: 0,
      usernameFragment: null,
    });
    expect(harness.session.getSnapshot().warning).toEqual({
      code: 'ice-candidate-queue-overflow',
      message: 'Oldest pending ICE candidate for peer-a was discarded',
    });

    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'peer.left',
      roomId: ROOM_ID,
      payload: { peerId: 'peer-a' },
    });
    await flushMicrotasks();
    expect(harness.session.getSnapshot().warning).toBeNull();
    await harness.session.leave();
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
        videoSource: 'camera',
      },
      {
        type: 'participant.media',
        audioEnabled: false,
        videoEnabled: false,
        videoSource: 'camera',
      },
    ]);
  });

  it('publishes ended local tracks as unavailable and detaches their listeners', async () => {
    const harness = createHarness();
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
    const channel = harness.peerConnections[0]?.channels[0];
    if (channel === undefined) {
      throw new Error('Expected an initial DataChannel');
    }
    expect(harness.audioTrack.endedListenerCount()).toBe(1);
    expect(harness.videoTrack.endedListenerCount()).toBe(1);

    harness.audioTrack.end();

    expect(harness.session.getLocalStream()?.getAudioTracks()).toEqual([]);
    expect(harness.session.getSnapshot()).toMatchObject({
      localMedia: {
        audioAvailable: false,
        audioEnabled: false,
        videoAvailable: true,
        videoEnabled: true,
      },
      participants: expect.arrayContaining([
        expect.objectContaining({
          peerId: 'self',
          audioEnabled: false,
          videoEnabled: true,
        }),
      ]),
      warning: { code: 'local-media-ended' },
    });
    expect(harness.session.toggleAudio()).toBe(false);
    expect(
      channel.sent
        .map((raw) => JSON.parse(raw) as { type: string; audioEnabled?: boolean })
        .filter(({ type }) => type === 'participant.media')
        .at(-1),
    ).toEqual({
      type: 'participant.media',
      audioEnabled: false,
      videoEnabled: true,
      videoSource: 'camera',
    });

    harness.videoTrack.end();

    expect(harness.session.getLocalStream()?.getVideoTracks()).toEqual([]);
    expect(harness.session.getSnapshot().localMedia).toEqual({
      audioAvailable: false,
      audioEnabled: false,
      videoAvailable: false,
      videoEnabled: false,
      videoSource: 'camera',
    });
    expect(harness.session.toggleVideo()).toBe(false);
    expect(
      channel.sent
        .map(
          (raw) =>
            JSON.parse(raw) as {
              type: string;
              audioEnabled?: boolean;
              videoEnabled?: boolean;
            },
        )
        .filter(({ type }) => type === 'participant.media')
        .at(-1),
    ).toEqual({
      type: 'participant.media',
      audioEnabled: false,
      videoEnabled: false,
      videoSource: 'camera',
    });
    expect(harness.audioTrack.endedListenerCount()).toBe(0);
    expect(harness.videoTrack.endedListenerCount()).toBe(0);

    await harness.session.leave();

    expect(harness.session.getSnapshot()).toMatchObject({
      status: 'ended',
      warning: null,
    });
    expect(harness.audioTrack.endedListenerCount()).toBe(0);
    expect(harness.videoTrack.endedListenerCount()).toBe(0);
  });

  it('keeps an existing operational warning when a local media track ends', async () => {
    const harness = createHarness();
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
    const peer = harness.peerConnections[0];
    if (peer === undefined) {
      throw new Error('Expected an initial peer connection');
    }
    peer.setConfigurationError = new DOMException(
      'configuration rejected',
      'InvalidModificationError',
    );
    harness.session.updateRtcConfiguration({
      iceServers: [{ urls: 'turn:refreshed.example.test' }],
    });

    harness.audioTrack.end();

    expect(harness.session.getSnapshot()).toMatchObject({
      localMedia: {
        audioAvailable: false,
        audioEnabled: false,
        videoAvailable: true,
        videoEnabled: true,
      },
      warning: {
        code: 'rtc-configuration-update-failed',
      },
    });
    await harness.session.leave();
  });

  it('classifies a denied display picker as a recoverable user cancellation', async () => {
    const harness = createHarness({
      getDisplayMedia: vi.fn(async () => {
        throw new DOMException('User cancelled the picker', 'NotAllowedError');
      }),
    });
    await joinSession(harness);

    await expect(harness.session.startScreenShare()).resolves.toBe('cancelled');
    expect(harness.session.getSnapshot()).toMatchObject({
      status: 'active',
      screenSharing: false,
      warning: null,
      error: null,
    });
    await harness.session.leave();
  });

  it('reports an operational display-capture rejection as a start failure', async () => {
    const harness = createHarness({
      getDisplayMedia: vi.fn(async () => {
        throw new DOMException('The display source could not be read', 'NotReadableError');
      }),
    });
    await joinSession(harness);

    await expect(harness.session.startScreenShare()).resolves.toBe('failed');
    expect(harness.session.getSnapshot()).toMatchObject({
      status: 'active',
      screenSharing: false,
      warning: null,
      error: null,
    });
    await harness.session.leave();
  });

  it('reports a display stream without a live video track as a start failure', async () => {
    const harness = createHarness({
      getDisplayMedia: vi.fn(async () => new FakeMediaStream([]) as unknown as MediaStream),
    });
    await joinSession(harness);

    await expect(harness.session.startScreenShare()).resolves.toBe('failed');
    expect(harness.session.getSnapshot().screenSharing).toBe(false);
    await harness.session.leave();
  });

  it('replaces camera senders with screen video and restores the disabled camera state', async () => {
    const screenTrack = Object.assign(new FakeTrack('video'), { contentHint: '' });
    const displayStream = new FakeMediaStream([screenTrack]);
    const getDisplayMedia = vi.fn(async () => displayStream as unknown as MediaStream);
    const harness = createHarness({ getDisplayMedia });
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
    const firstPeer = harness.peerConnections[0];
    const channel = firstPeer?.channels[0];
    const cameraSender = firstPeer?.senders.find(
      (sender) => sender.track === (harness.videoTrack as unknown as MediaStreamTrack),
    );
    if (firstPeer === undefined || channel === undefined || cameraSender === undefined) {
      throw new Error('Expected a camera sender and open DataChannel');
    }

    expect(harness.session.getSnapshot()).toMatchObject({
      screenShareAvailable: true,
      screenSharing: false,
      localMedia: { videoSource: 'camera' },
    });
    expect(harness.session.toggleVideo()).toBe(false);
    expect(harness.videoTrack.enabled).toBe(false);

    await expect(harness.session.startScreenShare()).resolves.toBe('started');

    expect(getDisplayMedia).toHaveBeenCalledWith({
      video: {
        width: { ideal: 1280, max: 1280 },
        height: { ideal: 720, max: 720 },
        frameRate: { ideal: 15, max: 15 },
      },
      audio: false,
    });
    expect(screenTrack.contentHint).toBe('detail');
    expect(cameraSender.track).toBe(screenTrack as unknown as MediaStreamTrack);
    expect(harness.session.getLocalStream()?.getVideoTracks()).toEqual([
      screenTrack as unknown as MediaStreamTrack,
    ]);
    expect(harness.session.getSnapshot()).toMatchObject({
      screenShareAvailable: true,
      screenSharing: true,
      localMedia: {
        videoAvailable: true,
        videoEnabled: true,
        videoSource: 'screen',
      },
      participants: expect.arrayContaining([
        expect.objectContaining({
          peerId: 'self',
          videoEnabled: true,
          videoSource: 'screen',
        }),
      ]),
    });
    const mediaFramesBeforeToggle = channel.sent.filter(
      (raw) => (JSON.parse(raw) as { type: string }).type === 'participant.media',
    ).length;
    expect(harness.session.toggleVideo()).toBe(false);
    expect(screenTrack.enabled).toBe(true);
    expect(
      channel.sent.filter(
        (raw) => (JSON.parse(raw) as { type: string }).type === 'participant.media',
      ),
    ).toHaveLength(mediaFramesBeforeToggle);

    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'peer.joined',
      roomId: ROOM_ID,
      payload: {
        participant: { peerId: 'peer-b', displayName: 'Bo', role: 'participant' },
      },
    });
    const secondPeer = harness.peerConnections[1];
    expect(secondPeer?.addedTracks).toContain(screenTrack as unknown as MediaStreamTrack);

    await expect(harness.session.stopScreenShare()).resolves.toBe(true);

    expect(cameraSender.track).toBe(harness.videoTrack as unknown as MediaStreamTrack);
    expect(secondPeer?.senders.find((sender) => sender.track?.kind === 'video')?.track).toBe(
      harness.videoTrack as unknown as MediaStreamTrack,
    );
    expect(harness.videoTrack.enabled).toBe(false);
    expect(screenTrack.stopped).toBe(true);
    expect(screenTrack.endedListenerCount()).toBe(0);
    expect(harness.session.getLocalStream()?.getVideoTracks()).toEqual([
      harness.videoTrack as unknown as MediaStreamTrack,
    ]);
    expect(harness.session.getSnapshot()).toMatchObject({
      screenSharing: false,
      localMedia: {
        videoEnabled: false,
        videoSource: 'camera',
      },
    });
    expect(
      channel.sent
        .map((raw) => JSON.parse(raw) as { type: string })
        .filter(({ type }) => type === 'participant.media')
        .at(-1),
    ).toEqual({
      type: 'participant.media',
      audioEnabled: true,
      videoEnabled: false,
      videoSource: 'camera',
    });
    await expect(harness.session.stopScreenShare()).resolves.toBe(false);
    await harness.session.leave();
  });

  it('restores the camera when the browser ends the display track', async () => {
    const screenTrack = new FakeTrack('video');
    const harness = createHarness({
      getDisplayMedia: vi.fn(
        async () => new FakeMediaStream([screenTrack]) as unknown as MediaStream,
      ),
    });
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
    const cameraSender = harness.peerConnections[0]?.senders.find(
      (sender) => sender.track === (harness.videoTrack as unknown as MediaStreamTrack),
    );
    if (cameraSender === undefined) {
      throw new Error('Expected a camera sender');
    }
    await harness.session.startScreenShare();

    screenTrack.end();
    await flushMicrotasks();

    expect(cameraSender.track).toBe(harness.videoTrack as unknown as MediaStreamTrack);
    expect(screenTrack.stopped).toBe(true);
    expect(screenTrack.endedListenerCount()).toBe(0);
    expect(harness.session.getSnapshot()).toMatchObject({
      screenSharing: false,
      localMedia: { videoEnabled: true, videoSource: 'camera' },
    });
    await harness.session.leave();
  });

  it('joins duplicate stop requests to the browser-ended screen stop operation', async () => {
    const screenTrack = new FakeTrack('video');
    const stopGate = createPromiseGate();
    const harness = createHarness({
      getDisplayMedia: vi.fn(
        async () => new FakeMediaStream([screenTrack]) as unknown as MediaStream,
      ),
    });
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
    const peer = harness.peerConnections[0];
    const cameraSender = peer?.senders.find(
      (sender) => sender.track === (harness.videoTrack as unknown as MediaStreamTrack),
    );
    const channel = peer?.channels[0];
    if (cameraSender === undefined || channel === undefined) {
      throw new Error('Expected a camera sender and DataChannel');
    }
    await harness.session.startScreenShare();
    cameraSender.replaceTrackCalls.length = 0;
    cameraSender.replacements.length = 0;
    cameraSender.replaceTrackGates.push(stopGate.promise);
    const mediaFramesBeforeStop = channel.sent.filter(
      (raw) => (JSON.parse(raw) as { type: string }).type === 'participant.media',
    ).length;
    let reentrantStop: Promise<boolean> | null = null;
    const unsubscribe = harness.session.subscribe((snapshot) => {
      if (!snapshot.screenSharing && reentrantStop === null) {
        reentrantStop = harness.session.stopScreenShare();
      }
    });

    screenTrack.end();
    await flushMicrotasks();
    const firstStop = harness.session.stopScreenShare();
    const duplicateStop = harness.session.stopScreenShare();

    expect(duplicateStop).toBe(firstStop);
    expect(reentrantStop).toBe(firstStop);
    expect(cameraSender.replaceTrackCalls).toEqual([
      harness.videoTrack as unknown as MediaStreamTrack,
    ]);
    await expect(harness.session.startScreenShare()).resolves.toBe('cancelled');
    expect(harness.session.getSnapshot()).toMatchObject({
      screenSharing: false,
      localMedia: { videoSource: 'camera' },
    });

    stopGate.resolve();
    await expect(firstStop).resolves.toBe(true);
    await expect(duplicateStop).resolves.toBe(true);
    expect(cameraSender.replacements).toEqual([harness.videoTrack as unknown as MediaStreamTrack]);
    expect(
      channel.sent.filter(
        (raw) => (JSON.parse(raw) as { type: string }).type === 'participant.media',
      ),
    ).toHaveLength(mediaFramesBeforeStop + 1);
    unsubscribe();
    await harness.session.leave();
  });

  it('escalates an in-flight user stop when video moderation disables the camera', async () => {
    const screenTrack = new FakeTrack('video');
    const stopGate = createPromiseGate();
    const harness = createHarness({
      getDisplayMedia: vi.fn(
        async () => new FakeMediaStream([screenTrack]) as unknown as MediaStream,
      ),
    });
    await joinSession(harness, [{ peerId: 'host-peer', displayName: 'Host', role: 'host' }]);
    const cameraSender = harness.peerConnections[0]?.senders.find(
      (sender) => sender.track === (harness.videoTrack as unknown as MediaStreamTrack),
    );
    if (cameraSender === undefined) {
      throw new Error('Expected a camera sender');
    }
    await harness.session.startScreenShare();
    cameraSender.replaceTrackCalls.length = 0;
    cameraSender.replaceTrackGates.push(stopGate.promise);

    const firstStop = harness.session.stopScreenShare();
    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'moderation.media.disabled',
      roomId: ROOM_ID,
      from: 'host-peer',
      payload: { targetPeerId: 'self', kind: 'video' },
    });
    await flushMicrotasks();

    expect(harness.session.stopScreenShare()).toBe(firstStop);
    expect(cameraSender.replaceTrackCalls).toEqual([
      harness.videoTrack as unknown as MediaStreamTrack,
    ]);
    expect(harness.videoTrack.enabled).toBe(false);
    expect(harness.session.getSnapshot()).toMatchObject({
      screenSharing: false,
      localMedia: { videoEnabled: false, videoSource: 'camera' },
      lastModerationNotice: { kind: 'video' },
    });

    stopGate.resolve();
    await expect(firstStop).resolves.toBe(true);
    expect(cameraSender.track).toBe(harness.videoTrack as unknown as MediaStreamTrack);
    expect(harness.videoTrack.enabled).toBe(false);
    await harness.session.leave();
  });

  it('invalidates a pending display picker immediately on video moderation', async () => {
    const screenTrack = new FakeTrack('video');
    const pickerGate = createPromiseGate();
    const getDisplayMedia = vi.fn(async () => {
      await pickerGate.promise;
      return new FakeMediaStream([screenTrack]) as unknown as MediaStream;
    });
    const harness = createHarness({ getDisplayMedia });
    await joinSession(harness, [{ peerId: 'host-peer', displayName: 'Host', role: 'host' }]);
    const cameraSender = harness.peerConnections[0]?.senders.find(
      (sender) => sender.track === (harness.videoTrack as unknown as MediaStreamTrack),
    );
    if (cameraSender === undefined) {
      throw new Error('Expected a camera sender');
    }

    const starting = harness.session.startScreenShare();
    await flushMicrotasks();
    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'moderation.media.disabled',
      roomId: ROOM_ID,
      from: 'host-peer',
      payload: { targetPeerId: 'self', kind: 'video' },
    });
    await flushMicrotasks();

    expect(getDisplayMedia).toHaveBeenCalledOnce();
    expect(harness.videoTrack.enabled).toBe(false);
    expect(harness.session.getSnapshot()).toMatchObject({
      screenSharing: false,
      localMedia: { videoEnabled: false, videoSource: 'camera' },
      lastModerationNotice: { kind: 'video' },
    });
    expect(cameraSender.replaceTrackCalls).toEqual([]);

    pickerGate.resolve();
    await expect(starting).resolves.toBe('cancelled');
    expect(screenTrack.stopped).toBe(true);
    expect(cameraSender.track).toBe(harness.videoTrack as unknown as MediaStreamTrack);
    expect(harness.session.getSnapshot().screenSharing).toBe(false);
    await harness.session.leave();
  });

  it('rolls a pending screen sender replacement back after video moderation', async () => {
    const screenTrack = new FakeTrack('video');
    const replaceGate = createPromiseGate();
    const harness = createHarness({
      getDisplayMedia: vi.fn(
        async () => new FakeMediaStream([screenTrack]) as unknown as MediaStream,
      ),
    });
    await joinSession(harness, [{ peerId: 'host-peer', displayName: 'Host', role: 'host' }]);
    const cameraSender = harness.peerConnections[0]?.senders.find(
      (sender) => sender.track === (harness.videoTrack as unknown as MediaStreamTrack),
    );
    if (cameraSender === undefined) {
      throw new Error('Expected a camera sender');
    }
    cameraSender.replaceTrackGates.push(replaceGate.promise);

    const starting = harness.session.startScreenShare();
    await flushMicrotasks();
    expect(cameraSender.replaceTrackCalls).toEqual([screenTrack as unknown as MediaStreamTrack]);

    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'moderation.media.disabled',
      roomId: ROOM_ID,
      from: 'host-peer',
      payload: { targetPeerId: 'self', kind: 'video' },
    });
    await flushMicrotasks();

    expect(screenTrack.stopped).toBe(true);
    expect(harness.videoTrack.enabled).toBe(false);
    expect(harness.session.getSnapshot()).toMatchObject({
      screenSharing: false,
      localMedia: { videoEnabled: false, videoSource: 'camera' },
    });

    replaceGate.resolve();
    await expect(starting).resolves.toBe('cancelled');
    expect(cameraSender.replaceTrackCalls).toEqual([
      screenTrack as unknown as MediaStreamTrack,
      harness.videoTrack as unknown as MediaStreamTrack,
    ]);
    expect(cameraSender.track).toBe(harness.videoTrack as unknown as MediaStreamTrack);
    expect(harness.videoTrack.enabled).toBe(false);
    await harness.session.leave();
  });

  it('recreates a sender when cancellation rollback cannot restore the camera', async () => {
    const screenTrack = new FakeTrack('video');
    const replaceGate = createPromiseGate();
    const harness = createHarness({
      getDisplayMedia: vi.fn(
        async () => new FakeMediaStream([screenTrack]) as unknown as MediaStream,
      ),
    });
    await joinSession(harness, [{ peerId: 'host-peer', displayName: 'Host', role: 'host' }]);
    const failedPeer = harness.peerConnections[0];
    const cameraSender = failedPeer?.senders.find(
      (sender) => sender.track === (harness.videoTrack as unknown as MediaStreamTrack),
    );
    if (failedPeer === undefined || cameraSender === undefined) {
      throw new Error('Expected a camera sender');
    }
    cameraSender.replaceTrackGates.push(replaceGate.promise);
    cameraSender.replaceTrackErrors.push(undefined, new Error('camera rollback failed'));

    const starting = harness.session.startScreenShare();
    await flushMicrotasks();
    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'moderation.media.disabled',
      roomId: ROOM_ID,
      from: 'host-peer',
      payload: { targetPeerId: 'self', kind: 'video' },
    });
    await flushMicrotasks();

    replaceGate.resolve();
    await expect(starting).resolves.toBe('cancelled');
    await flushMicrotasks();

    const replacementPeer = harness.peerConnections[1];
    const replacementVideo = replacementPeer?.addedTracks.find((track) => track.kind === 'video');
    expect(failedPeer.closed).toBe(true);
    expect(cameraSender.track).toBe(screenTrack as unknown as MediaStreamTrack);
    expect(replacementVideo).toBe(harness.videoTrack as unknown as MediaStreamTrack);
    expect(replacementVideo?.enabled).toBe(false);
    expect(screenTrack.stopped).toBe(true);
    expect(harness.session.getSnapshot()).toMatchObject({
      screenSharing: false,
      localMedia: { videoEnabled: false, videoSource: 'camera' },
      warning: { code: 'screen-share-sender-recovery' },
    });
    await harness.session.leave();
  });

  it('stops a display track returned after leave invalidates the pending picker', async () => {
    const screenTrack = new FakeTrack('video');
    const pickerGate = createPromiseGate();
    const harness = createHarness({
      getDisplayMedia: vi.fn(async () => {
        await pickerGate.promise;
        return new FakeMediaStream([screenTrack]) as unknown as MediaStream;
      }),
    });
    await joinSession(harness);

    const starting = harness.session.startScreenShare();
    await flushMicrotasks();
    await harness.session.leave();

    expect(harness.session.getSnapshot().status).toBe('ended');
    await expect(harness.session.startScreenShare()).resolves.toBe('cancelled');
    pickerGate.resolve();
    await expect(starting).resolves.toBe('cancelled');
    expect(screenTrack.stopped).toBe(true);
    expect(harness.session.getLocalStream()).toBeNull();
    expect(harness.session.getSnapshot()).toMatchObject({
      status: 'ended',
      screenSharing: false,
    });
  });

  it('ignores a pending screen sender replacement after leave disposes its peer', async () => {
    const screenTrack = new FakeTrack('video');
    const replaceGate = createPromiseGate();
    const harness = createHarness({
      getDisplayMedia: vi.fn(
        async () => new FakeMediaStream([screenTrack]) as unknown as MediaStream,
      ),
    });
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
    const disposedPeer = harness.peerConnections[0];
    const cameraSender = disposedPeer?.senders.find(
      (sender) => sender.track === (harness.videoTrack as unknown as MediaStreamTrack),
    );
    if (disposedPeer === undefined || cameraSender === undefined) {
      throw new Error('Expected a camera sender');
    }
    cameraSender.replaceTrackGates.push(replaceGate.promise);

    const starting = harness.session.startScreenShare();
    await flushMicrotasks();
    await harness.session.leave();

    expect(disposedPeer.closed).toBe(true);
    expect(screenTrack.stopped).toBe(true);
    replaceGate.resolve();
    await expect(starting).resolves.toBe('cancelled');
    expect(harness.peerConnections).toHaveLength(1);
    expect(harness.session.getSnapshot()).toMatchObject({
      status: 'ended',
      screenSharing: false,
      warning: null,
    });
  });

  it('recreates a failed screen sender and reports an active recovering share', async () => {
    const screenTrack = new FakeTrack('video');
    const harness = createHarness({
      getDisplayMedia: vi.fn(
        async () => new FakeMediaStream([screenTrack]) as unknown as MediaStream,
      ),
    });
    await joinSession(harness, [{ peerId: 'z-peer', displayName: 'Ara' }], 'a-self');
    const failedPeer = harness.peerConnections[0];
    const cameraSender = failedPeer?.senders.find(
      (sender) => sender.track === (harness.videoTrack as unknown as MediaStreamTrack),
    );
    if (failedPeer === undefined || cameraSender === undefined) {
      throw new Error('Expected a camera sender');
    }
    const offersBeforeRecovery = harness.socket.messagesOfType('rtc.offer').length;
    cameraSender.replaceTrackErrors.push(new Error('screen sender failed'));

    await expect(harness.session.startScreenShare()).resolves.toBe('recovering');
    await flushMicrotasks();

    const replacementPeer = harness.peerConnections[1];
    expect(failedPeer.closed).toBe(true);
    expect(replacementPeer?.addedTracks).toContain(screenTrack as unknown as MediaStreamTrack);
    expect(harness.socket.messagesOfType('rtc.offer')).toHaveLength(offersBeforeRecovery + 1);
    expect(harness.session.getSnapshot()).toMatchObject({
      screenSharing: true,
      localMedia: { videoSource: 'screen' },
      warning: { code: 'screen-share-sender-recovery' },
    });
    await harness.session.stopScreenShare();
    await harness.session.leave();
  });

  it('recreates a failed camera restore sender and reports a non-successful stop', async () => {
    const screenTrack = new FakeTrack('video');
    const harness = createHarness({
      getDisplayMedia: vi.fn(
        async () => new FakeMediaStream([screenTrack]) as unknown as MediaStream,
      ),
    });
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
    const failedPeer = harness.peerConnections[0];
    const videoSender = failedPeer?.senders.find(
      (sender) => sender.track === (harness.videoTrack as unknown as MediaStreamTrack),
    );
    if (failedPeer === undefined || videoSender === undefined) {
      throw new Error('Expected a video sender');
    }
    await harness.session.startScreenShare();
    const offersBeforeRecovery = harness.socket.messagesOfType('rtc.offer').length;
    videoSender.replaceTrackErrors.push(new Error('camera restore failed'));

    await expect(harness.session.stopScreenShare()).resolves.toBe(false);
    await flushMicrotasks();

    const replacementPeer = harness.peerConnections[1];
    expect(failedPeer.closed).toBe(true);
    expect(replacementPeer?.addedTracks).toContain(
      harness.videoTrack as unknown as MediaStreamTrack,
    );
    expect(harness.socket.messagesOfType('rtc.offer')).toHaveLength(offersBeforeRecovery);
    expect(screenTrack.stopped).toBe(true);
    expect(harness.session.getSnapshot()).toMatchObject({
      screenSharing: false,
      localMedia: { videoSource: 'camera' },
      warning: { code: 'screen-share-sender-recovery' },
    });
    await harness.session.leave();
  });

  it('shares to an existing peer without a camera and restores the media-less stream', async () => {
    const screenTrack = new FakeTrack('video');
    const harness = createHarness({
      preparedMediaStream: null,
      getDisplayMedia: vi.fn(
        async () => new FakeMediaStream([screenTrack]) as unknown as MediaStream,
      ),
    });
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
    await answerPeer(harness, 'peer-a');
    const peer = harness.peerConnections[0];
    if (peer === undefined) {
      throw new Error('Expected a peer connection');
    }
    const offersBeforeShare = harness.socket.messagesOfType('rtc.offer').length;

    await expect(harness.session.startScreenShare()).resolves.toBe('started');
    await flushMicrotasks();

    const screenSender = peer.senders.find(
      (sender) => sender.track === (screenTrack as unknown as MediaStreamTrack),
    );
    expect(screenSender).toBeDefined();
    expect(harness.session.getLocalStream()?.getVideoTracks()).toEqual([
      screenTrack as unknown as MediaStreamTrack,
    ]);
    expect(harness.socket.messagesOfType('rtc.offer')).toHaveLength(offersBeforeShare + 1);

    await expect(harness.session.stopScreenShare()).resolves.toBe(true);

    expect(screenSender?.track).toBeNull();
    expect(screenTrack.stopped).toBe(true);
    expect(harness.session.getLocalStream()).toBeNull();
    expect(harness.session.getSnapshot()).toMatchObject({
      screenSharing: false,
      localMedia: {
        videoAvailable: false,
        videoEnabled: false,
        videoSource: 'camera',
      },
    });
    await harness.session.leave();
  });

  it('drains a camera-less screen addTrack renegotiation after signaling becomes stable', async () => {
    const screenTrack = new FakeTrack('video');
    const harness = createHarness({
      preparedMediaStream: null,
      getDisplayMedia: vi.fn(
        async () => new FakeMediaStream([screenTrack]) as unknown as MediaStream,
      ),
    });
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
    const peer = harness.peerConnections[0];
    if (peer === undefined) {
      throw new Error('Expected a peer connection');
    }
    expect(peer.signalingState).toBe('have-local-offer');
    expect(harness.socket.messagesOfType('rtc.offer')).toHaveLength(1);

    await expect(harness.session.startScreenShare()).resolves.toBe('started');
    await flushMicrotasks();

    expect(peer.addedTracks).toContain(screenTrack as unknown as MediaStreamTrack);
    expect(harness.socket.messagesOfType('rtc.offer')).toHaveLength(1);

    await answerPeer(harness, 'peer-a');
    await flushMicrotasks();

    expect(harness.socket.messagesOfType('rtc.offer')).toHaveLength(2);
    expect(harness.socket.messagesOfType('rtc.offer').at(-1)).toMatchObject({
      to: 'peer-a',
      payload: {
        description: { type: 'offer' },
      },
    });
    await harness.session.stopScreenShare();
    await harness.session.leave();
  });

  it('stops both retained camera and active display ownership on leave', async () => {
    const screenTrack = new FakeTrack('video');
    const harness = createHarness({
      getDisplayMedia: vi.fn(
        async () => new FakeMediaStream([screenTrack]) as unknown as MediaStream,
      ),
    });
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
    await harness.session.startScreenShare();

    expect(harness.videoTrack.stopped).toBe(false);
    expect(screenTrack.stopped).toBe(false);
    expect(harness.videoTrack.endedListenerCount()).toBe(1);
    expect(screenTrack.endedListenerCount()).toBe(1);

    await harness.session.leave();

    expect(harness.videoTrack.stopped).toBe(true);
    expect(screenTrack.stopped).toBe(true);
    expect(harness.videoTrack.endedListenerCount()).toBe(0);
    expect(screenTrack.endedListenerCount()).toBe(0);
    expect(harness.session.getLocalStream()).toBeNull();
  });

  it('publishes roles and sends media-disable requests only with server capability', async () => {
    const host = createHarness();
    await joinSession(
      host,
      [
        { peerId: 'peer-a', displayName: 'Ara', role: 'participant' },
        { peerId: 'peer-host', displayName: 'Other host', role: 'host' },
      ],
      'self-host',
      { selfRole: 'host', canModerateMedia: true },
    );

    expect(host.session.getSnapshot()).toMatchObject({
      selfRole: 'host',
      canModerateMedia: true,
      participants: expect.arrayContaining([
        expect.objectContaining({ peerId: 'self-host', role: 'host' }),
        expect.objectContaining({ peerId: 'peer-a', role: 'participant' }),
      ]),
    });
    expect(host.session.disableParticipantMedia('peer-a', 'audio')).toBe(true);
    expect(host.socket.messagesOfType('moderation.media.disable')).toEqual([
      expect.objectContaining({
        v: PROTOCOL_VERSION,
        type: 'moderation.media.disable',
        roomId: ROOM_ID,
        to: 'peer-a',
        payload: { kind: 'audio' },
        requestId: expect.any(String),
      }),
    ]);
    expect(host.session.disableParticipantMedia('self-host', 'audio')).toBe(false);
    expect(host.session.disableParticipantMedia('peer-host', 'video')).toBe(false);
    expect(host.session.disableParticipantMedia('missing-peer', 'video')).toBe(false);

    const participant = createHarness();
    await joinSession(participant, [{ peerId: 'peer-a', displayName: 'Ara' }], 'self-participant', {
      selfRole: 'participant',
      canModerateMedia: false,
    });
    expect(participant.session.disableParticipantMedia('peer-a', 'audio')).toBe(false);
    expect(participant.socket.messagesOfType('moderation.media.disable')).toEqual([]);

    await host.session.leave();
    await participant.session.leave();
  });

  it('applies trusted moderation only to self and gives repeated notices unique ids', async () => {
    const harness = createHarness();
    await joinSession(harness, [{ peerId: 'host-peer', displayName: 'Host', role: 'host' }]);
    const channel = harness.peerConnections[0]?.channels[0];
    if (channel === undefined) {
      throw new Error('Expected an open DataChannel');
    }
    const mediaFramesBefore = channel.sent.length;

    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'moderation.media.disabled',
      roomId: ROOM_ID,
      from: 'host-peer',
      payload: { targetPeerId: 'someone-else', kind: 'audio' },
    });
    await flushMicrotasks();

    expect(harness.audioTrack.enabled).toBe(true);
    expect(harness.session.getSnapshot().lastModerationNotice).toBeNull();
    expect(channel.sent).toHaveLength(mediaFramesBefore);

    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'moderation.media.disabled',
      roomId: ROOM_ID,
      from: 'host-peer',
      requestId: 'moderation-request-1',
      payload: { targetPeerId: 'self', kind: 'audio' },
    });
    await flushMicrotasks();

    const firstNotice = harness.session.getSnapshot().lastModerationNotice;
    expect(harness.audioTrack.enabled).toBe(false);
    expect(firstNotice).toEqual({
      id: 'moderation-1',
      sequence: 1,
      fromPeerId: 'host-peer',
      kind: 'audio',
    });
    expect(
      channel.sent
        .map((raw) => JSON.parse(raw) as { type: string })
        .filter(({ type }) => type === 'participant.media')
        .at(-1),
    ).toEqual({
      type: 'participant.media',
      audioEnabled: false,
      videoEnabled: true,
      videoSource: 'camera',
    });

    expect(harness.session.toggleAudio()).toBe(true);
    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'moderation.media.disabled',
      roomId: ROOM_ID,
      from: 'host-peer',
      requestId: 'moderation-request-2',
      payload: { targetPeerId: 'self', kind: 'audio' },
    });
    await flushMicrotasks();

    const secondNotice = harness.session.getSnapshot().lastModerationNotice;
    expect(harness.audioTrack.enabled).toBe(false);
    expect(secondNotice?.sequence).toBe(2);
    expect(secondNotice?.id).not.toBe(firstNotice?.id);
    await harness.session.leave();
  });

  it('ends screen sharing and disables the restored camera on video moderation', async () => {
    const screenTrack = new FakeTrack('video');
    const harness = createHarness({
      getDisplayMedia: vi.fn(
        async () => new FakeMediaStream([screenTrack]) as unknown as MediaStream,
      ),
    });
    await joinSession(harness, [{ peerId: 'host-peer', displayName: 'Host', role: 'host' }]);
    const peer = harness.peerConnections[0];
    const channel = peer?.channels[0];
    const videoSender = peer?.senders.find(
      (sender) => sender.track === (harness.videoTrack as unknown as MediaStreamTrack),
    );
    if (channel === undefined || videoSender === undefined) {
      throw new Error('Expected video sender and DataChannel');
    }
    await harness.session.startScreenShare();

    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'moderation.media.disabled',
      roomId: ROOM_ID,
      from: 'host-peer',
      payload: { targetPeerId: 'self', kind: 'video' },
    });
    await flushMicrotasks();

    expect(screenTrack.stopped).toBe(true);
    expect(harness.videoTrack.enabled).toBe(false);
    expect(videoSender.track).toBe(harness.videoTrack as unknown as MediaStreamTrack);
    expect(harness.session.getSnapshot()).toMatchObject({
      screenSharing: false,
      localMedia: {
        videoEnabled: false,
        videoSource: 'camera',
      },
      lastModerationNotice: {
        fromPeerId: 'host-peer',
        kind: 'video',
      },
    });
    expect(
      channel.sent
        .map((raw) => JSON.parse(raw) as { type: string })
        .filter(({ type }) => type === 'participant.media')
        .at(-1),
    ).toEqual({
      type: 'participant.media',
      audioEnabled: true,
      videoEnabled: false,
      videoSource: 'camera',
    });
    await harness.session.leave();
  });

  it('forwards host capability only in every room.join frame', async () => {
    const hostCapability = 'standalone-host-proof-test-only-32-characters';
    const harness = createHarness({ hostCapability });
    await joinSession(harness);

    expect(harness.socket.messagesOfType('room.join')).toEqual([
      {
        v: PROTOCOL_VERSION,
        type: 'room.join',
        roomId: ROOM_ID,
        payload: { displayName: 'Jin', hostCapability },
      },
    ]);
    expect(JSON.stringify(harness.session.getSnapshot())).not.toContain(hostCapability);

    const initialSocket = harness.socket;
    initialSocket.serverClose(1006, 'network lost');
    await flushMicrotasks();
    const reconnectSocket = harness.socket;
    reconnectSocket.open();
    await flushMicrotasks();

    expect(reconnectSocket.messagesOfType('room.join')).toEqual([
      {
        v: PROTOCOL_VERSION,
        type: 'room.join',
        roomId: ROOM_ID,
        payload: { displayName: 'Jin', hostCapability },
      },
    ]);
    expect(
      [...initialSocket.sent, ...reconnectSocket.sent]
        .filter((raw) => (JSON.parse(raw) as { type: string }).type !== 'room.join')
        .some((raw) => raw.includes(hostCapability)),
    ).toBe(false);

    reconnectSocket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'room.joined',
      roomId: ROOM_ID,
      payload: {
        peerId: 'self-after-reconnect',
        selfRole: 'host',
        capabilities: { canModerateMedia: true },
        participants: [],
      },
    });
    await flushMicrotasks();
    await harness.session.leave();
  });

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

  it('re-enters on a fresh socket while retaining local media and chat history', async () => {
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
      messages: [{ ...chat, deliveryState: 'failed' }],
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
      messages: [{ ...chat, deliveryState: 'failed' }],
      error: null,
    });
    expect(participantIds).toEqual(['self-after-reconnect', 'peer-a']);
    expect(new Set(participantIds).size).toBe(participantIds.length);
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
