import { vi } from 'vitest';

import { PROTOCOL_VERSION, utf8ByteLength } from '@round/protocol';
import {
  RoomSession,
  type RoomSessionOptions,
  type RoomSessionRecoveryOptions,
} from '../src/index.js';

export const ROOM_ID = 'abcd-efgh-jkmp';
export const OTHER_ROOM_ID = 'bcde-fghj-kmnp';

type Listener = {
  callback: (event: unknown) => void;
  once: boolean;
};

export class FakeWebSocket {
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

export class FakeTrack {
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

export class FakeMediaStream {
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

export class FakeDataChannel {
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

export class FakeRtpSender {
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

export class FakePeerConnection {
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
  statsReport = new Map<string, RTCStats>() as unknown as RTCStatsReport;
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

  async getStats(): Promise<RTCStatsReport> {
    return this.statsReport;
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

export interface Harness {
  readonly session: RoomSession;
  readonly socket: FakeWebSocket;
  readonly sockets: FakeWebSocket[];
  readonly peerConnections: FakePeerConnection[];
  readonly audioTrack: FakeTrack;
  readonly videoTrack: FakeTrack;
}

export function createHarness(
  overrides: {
    getUserMedia?: () => Promise<MediaStream>;
    getDisplayMedia?: (constraints: DisplayMediaStreamOptions) => Promise<MediaStream>;
    preparedMediaStream?: MediaStream | null;
    initialInputEnabled?: RoomSessionOptions['initialInputEnabled'];
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

  const session = new RoomSession({
    roomId: ROOM_ID,
    displayName: overrides.displayName ?? 'Jin',
    signalingUrl: 'ws://localhost:8787',
    ...(overrides.initialInputEnabled === undefined
      ? {}
      : { initialInputEnabled: overrides.initialInputEnabled }),
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

export async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}

export function createPromiseGate(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

export async function joinSession(
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

export function latestOutgoingNegotiationId(harness: Harness, peerId: string): string | undefined {
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

export async function answerPeer(harness: Harness, peerId: string): Promise<void> {
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

export function acknowledgeChat(channel: FakeDataChannel, id: string): void {
  channel.receive({ type: 'chat.ack', messageId: id });
}
