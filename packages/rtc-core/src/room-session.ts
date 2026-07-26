import {
  parseServerMessage,
  type AnswerDescription,
  type ClientMessage,
  type OfferDescription,
  type Participant,
  type SerializedIceCandidate,
  type ServerMessage,
} from '@round/protocol';

export type RoomSessionStatus =
  'idle' | 'preparing-media' | 'connecting-signal' | 'joining' | 'active' | 'ended' | 'error';

export type PeerConnectionStatus =
  'new' | 'negotiating' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed';

export interface RoomIssue {
  readonly code: string;
  readonly message: string;
}

export interface LocalMediaSnapshot {
  readonly audioAvailable: boolean;
  readonly audioEnabled: boolean;
  readonly videoAvailable: boolean;
  readonly videoEnabled: boolean;
}

export interface ParticipantSnapshot {
  readonly peerId: string;
  readonly displayName: string;
  readonly isLocal: boolean;
  readonly connectionState: PeerConnectionStatus;
  readonly audioEnabled: boolean;
  readonly videoEnabled: boolean;
}

export interface ChatMessage {
  readonly id: string;
  readonly senderId: string;
  readonly senderName: string;
  readonly text: string;
  readonly sentAt: number;
  readonly isLocal: boolean;
}

export interface RoomSessionSnapshot {
  readonly roomId: string;
  readonly status: RoomSessionStatus;
  readonly selfId: string | null;
  readonly participants: readonly ParticipantSnapshot[];
  readonly localMedia: LocalMediaSnapshot;
  readonly messages: readonly ChatMessage[];
  readonly warning: RoomIssue | null;
  readonly error: RoomIssue | null;
}

export type RoomSessionListener = (snapshot: RoomSessionSnapshot) => void;

export interface RoomSessionOptions {
  readonly roomId: string;
  readonly displayName: string;
  readonly signalingUrl: string;
  readonly mediaConstraints?: MediaStreamConstraints;
  readonly rtcConfiguration?: RTCConfiguration;
  readonly maxChatMessages?: number;
  readonly webSocketFactory?: (url: string) => WebSocket;
  readonly peerConnectionFactory?: (
    configuration: RTCConfiguration | undefined,
  ) => RTCPeerConnection;
  readonly mediaDevices?: Pick<MediaDevices, 'getUserMedia'>;
  readonly mediaStreamFactory?: () => MediaStream;
  readonly now?: () => number;
  readonly createId?: () => string;
}

interface MutableParticipant {
  peerId: string;
  displayName: string;
  isLocal: boolean;
  connectionState: PeerConnectionStatus;
  audioEnabled: boolean;
  videoEnabled: boolean;
}

interface PeerContext {
  readonly peerId: string;
  readonly connection: RTCPeerConnection;
  readonly pendingCandidates: (SerializedIceCandidate | null)[];
  readonly pendingChatMessages: ChatDataMessage[];
  channel: RTCDataChannel | null;
  remoteDescriptionSet: boolean;
  closed: boolean;
}

interface ChatDataMessage {
  readonly type: 'chat.message';
  readonly id: string;
  readonly senderId: string;
  readonly sentAt: number;
  readonly text: string;
}

interface MediaDataMessage {
  readonly type: 'participant.media';
  readonly audioEnabled: boolean;
  readonly videoEnabled: boolean;
}

type DataMessage = ChatDataMessage | MediaDataMessage;

const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;
const MAX_CHAT_TEXT_LENGTH = 4_000;
const MAX_PENDING_CHAT_MESSAGES_PER_PEER = 50;
const DATA_CHANNEL_ERROR_GRACE_MS = 250;

function defaultCreateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isChatDataMessage(value: unknown): value is ChatDataMessage {
  return (
    isRecord(value) &&
    value.type === 'chat.message' &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.senderId === 'string' &&
    value.senderId.length > 0 &&
    typeof value.sentAt === 'number' &&
    Number.isFinite(value.sentAt) &&
    typeof value.text === 'string' &&
    value.text.length > 0 &&
    value.text.length <= MAX_CHAT_TEXT_LENGTH
  );
}

function isMediaDataMessage(value: unknown): value is MediaDataMessage {
  return (
    isRecord(value) &&
    value.type === 'participant.media' &&
    typeof value.audioEnabled === 'boolean' &&
    typeof value.videoEnabled === 'boolean'
  );
}

function toPeerConnectionStatus(state: RTCPeerConnectionState): PeerConnectionStatus {
  switch (state) {
    case 'new':
    case 'connecting':
    case 'connected':
    case 'disconnected':
    case 'failed':
    case 'closed':
      return state;
  }
}

function serializeCandidate(candidate: RTCIceCandidate | null): SerializedIceCandidate | null {
  if (candidate === null) {
    return null;
  }

  const serialized = typeof candidate.toJSON === 'function' ? candidate.toJSON() : candidate;

  return {
    candidate: serialized.candidate ?? candidate.candidate,
    sdpMid: serialized.sdpMid ?? null,
    sdpMLineIndex: serialized.sdpMLineIndex ?? null,
    usernameFragment: serialized.usernameFragment ?? null,
  };
}

/**
 * Framework-independent owner of a single room's browser WebRTC resources.
 *
 * A session is intentionally single-use. Callers should create a new instance
 * after `leave()` or a fatal signaling error.
 */
export class RoomSession {
  readonly #options: RoomSessionOptions;
  readonly #listeners = new Set<RoomSessionListener>();
  readonly #participants = new Map<string, MutableParticipant>();
  readonly #peers = new Map<string, PeerContext>();
  readonly #remoteStreams = new Map<string, MediaStream>();
  readonly #seenMessageIds = new Set<string>();
  readonly #messages: ChatMessage[] = [];

  #socket: WebSocket | null = null;
  #localStream: MediaStream | null = null;
  #status: RoomSessionStatus = 'idle';
  #selfId: string | null = null;
  #warning: RoomIssue | null = null;
  #error: RoomIssue | null = null;
  #snapshot: RoomSessionSnapshot;
  #joinPromise: Promise<void> | null = null;
  #rejectConnecting: ((reason: unknown) => void) | null = null;
  #resolveJoined: (() => void) | null = null;
  #rejectJoined: ((reason: unknown) => void) | null = null;
  #leaving = false;
  #disposed = false;

  constructor(options: RoomSessionOptions) {
    const roomId = options.roomId.trim();
    const displayName = options.displayName.trim();

    if (roomId.length === 0) {
      throw new Error('roomId must not be empty');
    }
    if (displayName.length === 0) {
      throw new Error('displayName must not be empty');
    }
    if (options.signalingUrl.trim().length === 0) {
      throw new Error('signalingUrl must not be empty');
    }
    if (
      options.maxChatMessages !== undefined &&
      (!Number.isInteger(options.maxChatMessages) || options.maxChatMessages < 1)
    ) {
      throw new Error('maxChatMessages must be a positive integer');
    }

    this.#options = { ...options, roomId, displayName };
    this.#snapshot = this.#buildSnapshot();
  }

  getSnapshot(): RoomSessionSnapshot {
    return this.#snapshot;
  }

  getLocalStream(): MediaStream | null {
    return this.#localStream;
  }

  getRemoteStream(peerId: string): MediaStream | null {
    return this.#remoteStreams.get(peerId) ?? null;
  }

  subscribe(listener: RoomSessionListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  join(): Promise<void> {
    if (this.#joinPromise !== null) {
      return this.#joinPromise;
    }
    if (this.#disposed || this.#status !== 'idle') {
      return Promise.reject(new Error('This room session cannot be joined again'));
    }

    this.#joinPromise = this.#performJoin();
    return this.#joinPromise;
  }

  async leave(): Promise<void> {
    if (this.#disposed) {
      return;
    }

    this.#leaving = true;
    this.#disposed = true;

    if (this.#socket?.readyState === SOCKET_OPEN) {
      try {
        this.#send({
          v: 1,
          type: 'room.leave',
          roomId: this.#options.roomId,
        });
      } catch {
        // Resource cleanup must continue even if the socket dies during leave.
      }
    }

    this.#resolveJoined = null;
    this.#rejectConnecting?.(new Error('Room session ended before signaling connected'));
    this.#rejectConnecting = null;
    this.#rejectJoined?.(new Error('Room session ended before joining'));
    this.#rejectJoined = null;
    this.#closeSocket();
    this.#cleanupAllResources();
    this.#selfId = null;
    this.#participants.clear();
    this.#status = 'ended';
    this.#emit();
  }

  toggleAudio(): boolean {
    const tracks = this.#localStream?.getAudioTracks() ?? [];
    if (tracks.length === 0) {
      return false;
    }

    const enabled = !tracks.some((track) => track.enabled);
    for (const track of tracks) {
      track.enabled = enabled;
    }
    this.#syncLocalParticipantMedia();
    this.#broadcastMediaState();
    this.#emit();
    return enabled;
  }

  toggleVideo(): boolean {
    const tracks = this.#localStream?.getVideoTracks() ?? [];
    if (tracks.length === 0) {
      return false;
    }

    const enabled = !tracks.some((track) => track.enabled);
    for (const track of tracks) {
      track.enabled = enabled;
    }
    this.#syncLocalParticipantMedia();
    this.#broadcastMediaState();
    this.#emit();
    return enabled;
  }

  sendChat(text: string): ChatMessage {
    if (this.#status !== 'active' || this.#selfId === null) {
      throw new Error('Chat is only available after joining the room');
    }

    const normalizedText = text.trim();
    if (normalizedText.length === 0) {
      throw new Error('Chat message must not be empty');
    }
    if (normalizedText.length > MAX_CHAT_TEXT_LENGTH) {
      throw new Error(`Chat message must be at most ${MAX_CHAT_TEXT_LENGTH} characters`);
    }

    const wireMessage: ChatDataMessage = {
      type: 'chat.message',
      id: this.#createId(),
      senderId: this.#selfId,
      sentAt: this.#now(),
      text: normalizedText,
    };
    const message: ChatMessage = {
      id: wireMessage.id,
      senderId: wireMessage.senderId,
      senderName: this.#options.displayName,
      text: wireMessage.text,
      sentAt: wireMessage.sentAt,
      isLocal: true,
    };

    this.#rememberMessage(message);
    this.#broadcastData(wireMessage);
    this.#emit();
    return message;
  }

  async #performJoin(): Promise<void> {
    try {
      this.#setStatus('preparing-media');
      await this.#prepareMedia();

      if (this.#disposed) {
        throw new Error('Room session ended while preparing media');
      }

      this.#setStatus('connecting-signal');
      await this.#connectSocket();

      if (this.#disposed) {
        throw new Error('Room session ended while connecting');
      }

      this.#setStatus('joining');
      const joined = new Promise<void>((resolve, reject) => {
        this.#resolveJoined = resolve;
        this.#rejectJoined = reject;
      });

      this.#send({
        v: 1,
        type: 'room.join',
        roomId: this.#options.roomId,
        payload: { displayName: this.#options.displayName },
      });

      return await joined;
    } catch (error) {
      if (!this.#leaving) {
        this.#cleanupAllResources();
        this.#closeSocket();
        this.#disposed = true;
        if (this.#status !== 'error') {
          this.#setFatalError('join-failed', getErrorMessage(error));
        }
      }
      throw error;
    }
  }

  async #prepareMedia(): Promise<void> {
    const mediaDevices =
      this.#options.mediaDevices ??
      (typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined);

    if (mediaDevices === undefined) {
      this.#warning = {
        code: 'media-unavailable',
        message: 'Camera and microphone APIs are unavailable; joined without media.',
      };
      this.#emit();
      return;
    }

    try {
      const stream = await mediaDevices.getUserMedia(
        this.#options.mediaConstraints ?? { audio: true, video: true },
      );
      if (this.#disposed) {
        for (const track of stream.getTracks()) {
          track.stop();
        }
        return;
      }
      this.#localStream = stream;
    } catch (error) {
      this.#warning = {
        code: 'media-permission-denied',
        message: `Camera or microphone could not be opened; joined without media. ${getErrorMessage(error)}`,
      };
    }
    this.#emit();
  }

  #connectSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const factory = this.#options.webSocketFactory ?? ((url: string) => new WebSocket(url));

      let socket: WebSocket;
      try {
        socket = factory(this.#options.signalingUrl);
      } catch (error) {
        reject(error);
        return;
      }

      this.#socket = socket;

      const settleOpen = () => {
        if (!settled) {
          settled = true;
          this.#rejectConnecting = null;
          resolve();
        }
      };
      const settleError = (
        error: unknown = new Error('Could not connect to the signaling server'),
      ) => {
        if (!settled) {
          settled = true;
          this.#rejectConnecting = null;
          reject(error);
        }
      };
      const settleClose = () => {
        if (!settled) {
          settled = true;
          reject(new Error('Signaling connection closed before it could be opened'));
        }
      };

      this.#rejectConnecting = settleError;
      socket.addEventListener('open', settleOpen, { once: true });
      socket.addEventListener('error', () => settleError(), { once: true });
      socket.addEventListener('close', settleClose, { once: true });
      socket.addEventListener('message', this.#handleSocketMessage);
      socket.addEventListener('close', this.#handleSocketClose);

      if (socket.readyState === SOCKET_OPEN) {
        settleOpen();
      } else if (socket.readyState !== SOCKET_CONNECTING) {
        settleError();
      }
    });
  }

  readonly #handleSocketMessage = (event: MessageEvent<unknown>): void => {
    if (typeof event.data !== 'string') {
      this.#setWarning('invalid-signal-message', 'Ignored a non-text signaling message');
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      this.#setWarning('invalid-signal-message', 'Ignored malformed signaling JSON');
      return;
    }

    let message: ServerMessage;
    try {
      message = parseServerMessage(parsed);
    } catch (error) {
      this.#setWarning('invalid-signal-message', getErrorMessage(error));
      return;
    }

    if (message.type !== 'error' && message.roomId !== this.#options.roomId) {
      return;
    }
    if (
      message.type === 'error' &&
      message.roomId !== undefined &&
      message.roomId !== this.#options.roomId
    ) {
      return;
    }

    void this.#routeServerMessage(message);
  };

  readonly #handleSocketClose = (event: CloseEvent): void => {
    if (this.#leaving || this.#disposed) {
      return;
    }

    const reason = event.reason || `close code ${event.code}`;
    const error = new Error(`Signaling connection closed (${reason})`);
    this.#rejectConnecting?.(error);
    this.#rejectConnecting = null;
    this.#rejectJoined?.(error);
    this.#resolveJoined = null;
    this.#rejectJoined = null;
    this.#cleanupAllResources();
    this.#socket = null;
    this.#participants.clear();
    this.#selfId = null;
    this.#disposed = true;
    this.#setFatalError('signaling-closed', error.message);
  };

  async #routeServerMessage(message: ServerMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'room.joined':
          await this.#handleRoomJoined(message.payload.peerId, message.payload.participants);
          return;
        case 'peer.joined':
          this.#upsertParticipant(message.payload.participant, false);
          this.#ensurePeer(message.payload.participant.peerId);
          this.#emit();
          return;
        case 'rtc.offer':
          await this.#handleOffer(message.from, message.payload.description);
          return;
        case 'rtc.answer':
          await this.#handleAnswer(message.from, message.payload.description);
          return;
        case 'rtc.ice':
          await this.#handleIce(message.from, message.payload.candidate);
          return;
        case 'peer.left':
          this.#removePeer(message.payload.peerId);
          return;
        case 'error':
          this.#handleServerError(message.payload.code, message.payload.message);
          return;
      }
    } catch (error) {
      const peerId = 'from' in message ? message.from : null;
      if (peerId !== null) {
        this.#failPeer(peerId, error);
      } else {
        this.#setWarning('signal-handler-failed', getErrorMessage(error));
      }
    }
  }

  async #handleRoomJoined(peerId: string, participants: readonly Participant[]): Promise<void> {
    if (this.#status !== 'joining' || this.#selfId !== null) {
      return;
    }

    this.#selfId = peerId;
    this.#upsertParticipant({ peerId, displayName: this.#options.displayName }, true);
    this.#syncLocalParticipantMedia();

    for (const participant of participants) {
      if (participant.peerId !== peerId) {
        this.#upsertParticipant(participant, false);
      }
    }

    const offerPromises = participants
      .filter((participant) => participant.peerId !== peerId)
      .map(async (participant) => {
        try {
          await this.#createOffer(participant.peerId);
        } catch (error) {
          this.#failPeer(participant.peerId, error);
        }
      });

    this.#setStatus('active');
    this.#resolveJoined?.();
    this.#resolveJoined = null;
    this.#rejectJoined = null;

    await Promise.all(offerPromises);
  }

  async #createOffer(peerId: string): Promise<void> {
    const peer = this.#ensurePeer(peerId);
    this.#setPeerConnectionStatus(peerId, 'negotiating');

    if (peer.channel === null) {
      this.#attachDataChannel(
        peer,
        peer.connection.createDataChannel('round-room', {
          ordered: true,
        }),
      );
    }

    const offer = await peer.connection.createOffer();
    await peer.connection.setLocalDescription(offer);
    const description = peer.connection.localDescription ?? offer;
    this.#send({
      v: 1,
      type: 'rtc.offer',
      roomId: this.#options.roomId,
      to: peerId,
      payload: {
        description: {
          type: 'offer',
          ...(description.sdp === undefined ? {} : { sdp: description.sdp }),
        },
      },
    });
  }

  async #handleOffer(peerId: string, description: OfferDescription): Promise<void> {
    const peer = this.#ensurePeer(peerId);
    this.#setPeerConnectionStatus(peerId, 'negotiating');
    await peer.connection.setRemoteDescription(description);
    peer.remoteDescriptionSet = true;
    await this.#flushPendingCandidates(peer);

    const answer = await peer.connection.createAnswer();
    await peer.connection.setLocalDescription(answer);
    const localDescription = peer.connection.localDescription ?? answer;
    this.#send({
      v: 1,
      type: 'rtc.answer',
      roomId: this.#options.roomId,
      to: peerId,
      payload: {
        description: {
          type: 'answer',
          ...(localDescription.sdp === undefined ? {} : { sdp: localDescription.sdp }),
        },
      },
    });
  }

  async #handleAnswer(peerId: string, description: AnswerDescription): Promise<void> {
    const peer = this.#ensurePeer(peerId);
    await peer.connection.setRemoteDescription(description);
    peer.remoteDescriptionSet = true;
    await this.#flushPendingCandidates(peer);
  }

  async #handleIce(peerId: string, candidate: SerializedIceCandidate | null): Promise<void> {
    const peer = this.#ensurePeer(peerId);
    if (!peer.remoteDescriptionSet && peer.connection.remoteDescription === null) {
      peer.pendingCandidates.push(candidate);
      return;
    }

    await peer.connection.addIceCandidate(candidate);
  }

  async #flushPendingCandidates(peer: PeerContext): Promise<void> {
    const candidates = peer.pendingCandidates.splice(0, peer.pendingCandidates.length);
    for (const candidate of candidates) {
      await peer.connection.addIceCandidate(candidate);
    }
  }

  #ensurePeer(peerId: string): PeerContext {
    const existing = this.#peers.get(peerId);
    if (existing !== undefined) {
      return existing;
    }

    if (!this.#participants.has(peerId)) {
      this.#upsertParticipant({ peerId, displayName: `Participant ${peerId.slice(0, 6)}` }, false);
    }

    const factory =
      this.#options.peerConnectionFactory ??
      ((configuration: RTCConfiguration | undefined) => new RTCPeerConnection(configuration));
    const connection = factory(this.#options.rtcConfiguration);
    const peer: PeerContext = {
      peerId,
      connection,
      pendingCandidates: [],
      pendingChatMessages: [],
      channel: null,
      remoteDescriptionSet: connection.remoteDescription !== null,
      closed: false,
    };
    this.#peers.set(peerId, peer);

    for (const track of this.#localStream?.getTracks() ?? []) {
      connection.addTrack(track, this.#localStream as MediaStream);
    }

    connection.onicecandidate = (event) => {
      if (peer.closed || this.#socket?.readyState !== SOCKET_OPEN) {
        return;
      }
      this.#send({
        v: 1,
        type: 'rtc.ice',
        roomId: this.#options.roomId,
        to: peerId,
        payload: { candidate: serializeCandidate(event.candidate) },
      });
    };

    connection.ontrack = (event) => {
      let stream = event.streams[0];
      if (stream === undefined) {
        const factory = this.#options.mediaStreamFactory ?? (() => new MediaStream());
        stream = this.#remoteStreams.get(peerId) ?? factory();
        stream.addTrack(event.track);
      }
      this.#remoteStreams.set(peerId, stream);
      this.#syncRemoteParticipantTracks(peerId, stream);
      this.#emit();
    };

    connection.ondatachannel = (event) => {
      this.#attachDataChannel(peer, event.channel);
    };

    connection.onconnectionstatechange = () => {
      const status = toPeerConnectionStatus(connection.connectionState);
      this.#setPeerConnectionStatus(peerId, status);
      if (status === 'failed' || status === 'closed') {
        this.#cleanupPeer(peerId, false);
      }
    };

    return peer;
  }

  #attachDataChannel(peer: PeerContext, channel: RTCDataChannel): void {
    if (peer.channel !== null && peer.channel !== channel) {
      this.#detachAndCloseChannel(peer.channel);
    }

    peer.channel = channel;
    channel.onopen = () => {
      this.#flushPendingData(peer, channel);
    };
    channel.onmessage = (event) => {
      this.#handleDataMessage(peer.peerId, event.data);
    };
    channel.onclose = () => {
      if (peer.channel === channel) {
        peer.channel = null;
      }
    };
    channel.onerror = () => {
      globalThis.setTimeout(() => {
        if (peer.closed || this.#peers.get(peer.peerId) !== peer) {
          return;
        }
        this.#setWarning(
          'data-channel-error',
          `Chat channel to ${peer.peerId} encountered an error`,
        );
      }, DATA_CHANNEL_ERROR_GRACE_MS);
    };

    if (channel.readyState === 'open') {
      this.#flushPendingData(peer, channel);
    }
  }

  #handleDataMessage(peerId: string, raw: unknown): void {
    if (typeof raw !== 'string') {
      return;
    }

    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    if (isMediaDataMessage(data)) {
      const participant = this.#participants.get(peerId);
      if (participant !== undefined) {
        participant.audioEnabled = data.audioEnabled;
        participant.videoEnabled = data.videoEnabled;
        this.#emit();
      }
      return;
    }

    if (!isChatDataMessage(data) || this.#seenMessageIds.has(data.id)) {
      return;
    }

    const participant = this.#participants.get(peerId);
    if (participant === undefined) {
      return;
    }

    this.#rememberMessage({
      id: data.id,
      senderId: peerId,
      senderName: participant.displayName,
      text: data.text,
      sentAt: data.sentAt,
      isLocal: false,
    });
    this.#emit();
  }

  #currentMediaDataMessage(): MediaDataMessage {
    const media = this.#getLocalMediaSnapshot();
    return {
      type: 'participant.media',
      audioEnabled: media.audioEnabled,
      videoEnabled: media.videoEnabled,
    };
  }

  #broadcastMediaState(): void {
    this.#broadcastData(this.#currentMediaDataMessage());
  }

  #broadcastData(message: DataMessage): void {
    for (const peer of this.#peers.values()) {
      if (peer.channel?.readyState === 'open') {
        this.#sendData(peer.channel, message);
      } else if (message.type === 'chat.message') {
        if (peer.pendingChatMessages.length >= MAX_PENDING_CHAT_MESSAGES_PER_PEER) {
          peer.pendingChatMessages.shift();
          this.#setWarning(
            'chat-queue-overflow',
            `Oldest pending chat message for ${peer.peerId} was discarded`,
          );
        }
        peer.pendingChatMessages.push(message);
      }
    }
  }

  #flushPendingData(peer: PeerContext, channel: RTCDataChannel): void {
    if (peer.channel !== channel || channel.readyState !== 'open') {
      return;
    }

    this.#sendData(channel, this.#currentMediaDataMessage());
    const pendingMessages = peer.pendingChatMessages.splice(0, peer.pendingChatMessages.length);
    for (const message of pendingMessages) {
      this.#sendData(channel, message);
    }
  }

  #sendData(channel: RTCDataChannel, message: DataMessage): void {
    try {
      channel.send(JSON.stringify(message));
    } catch (error) {
      this.#setWarning('data-channel-send-failed', getErrorMessage(error));
    }
  }

  #rememberMessage(message: ChatMessage): void {
    this.#seenMessageIds.add(message.id);
    this.#messages.push(message);

    const maxMessages = this.#options.maxChatMessages ?? 200;
    while (this.#messages.length > maxMessages) {
      const removed = this.#messages.shift();
      if (removed !== undefined) {
        this.#seenMessageIds.delete(removed.id);
      }
    }
  }

  #upsertParticipant(participant: Participant, isLocal: boolean): void {
    const existing = this.#participants.get(participant.peerId);
    if (existing !== undefined) {
      existing.displayName = participant.displayName;
      existing.isLocal = isLocal;
      return;
    }

    this.#participants.set(participant.peerId, {
      peerId: participant.peerId,
      displayName: participant.displayName,
      isLocal,
      connectionState: isLocal ? 'connected' : 'new',
      audioEnabled: false,
      videoEnabled: false,
    });
  }

  #syncLocalParticipantMedia(): void {
    if (this.#selfId === null) {
      return;
    }
    const participant = this.#participants.get(this.#selfId);
    if (participant === undefined) {
      return;
    }
    const media = this.#getLocalMediaSnapshot();
    participant.audioEnabled = media.audioEnabled;
    participant.videoEnabled = media.videoEnabled;
  }

  #syncRemoteParticipantTracks(peerId: string, stream: MediaStream): void {
    const participant = this.#participants.get(peerId);
    if (participant === undefined) {
      return;
    }
    participant.audioEnabled = stream.getAudioTracks().some((track) => track.enabled);
    participant.videoEnabled = stream.getVideoTracks().some((track) => track.enabled);
  }

  #setPeerConnectionStatus(peerId: string, status: PeerConnectionStatus): void {
    const participant = this.#participants.get(peerId);
    if (participant !== undefined) {
      participant.connectionState = status;
      this.#emit();
    }
  }

  #failPeer(peerId: string, error: unknown): void {
    this.#setPeerConnectionStatus(peerId, 'failed');
    this.#cleanupPeer(peerId, false);
    this.#setWarning(
      'peer-negotiation-failed',
      `Connection to ${peerId} failed: ${getErrorMessage(error)}`,
    );
  }

  #removePeer(peerId: string): void {
    this.#cleanupPeer(peerId, true);
    this.#emit();
  }

  #cleanupPeer(peerId: string, removeParticipant: boolean): void {
    const peer = this.#peers.get(peerId);
    if (peer !== undefined) {
      peer.closed = true;
      peer.connection.onicecandidate = null;
      peer.connection.ontrack = null;
      peer.connection.ondatachannel = null;
      peer.connection.onconnectionstatechange = null;
      if (peer.channel !== null) {
        this.#detachAndCloseChannel(peer.channel);
      }
      if (peer.connection.connectionState !== 'closed') {
        peer.connection.close();
      }
      peer.pendingCandidates.length = 0;
      peer.pendingChatMessages.length = 0;
      this.#peers.delete(peerId);
    }

    const remoteStream = this.#remoteStreams.get(peerId);
    for (const track of remoteStream?.getTracks() ?? []) {
      track.stop();
    }
    this.#remoteStreams.delete(peerId);
    if (removeParticipant) {
      this.#participants.delete(peerId);
    }
  }

  #detachAndCloseChannel(channel: RTCDataChannel): void {
    channel.onopen = null;
    channel.onmessage = null;
    channel.onclose = null;
    channel.onerror = null;
    if (channel.readyState !== 'closed') {
      channel.close();
    }
  }

  #cleanupAllResources(): void {
    for (const peerId of [...this.#peers.keys()]) {
      this.#cleanupPeer(peerId, false);
    }
    this.#remoteStreams.clear();

    for (const track of this.#localStream?.getTracks() ?? []) {
      track.stop();
    }
    this.#localStream = null;
  }

  #closeSocket(): void {
    const socket = this.#socket;
    if (socket === null) {
      return;
    }

    socket.removeEventListener('message', this.#handleSocketMessage);
    socket.removeEventListener('close', this.#handleSocketClose);
    if (socket.readyState === SOCKET_CONNECTING || socket.readyState === SOCKET_OPEN) {
      socket.close(1000, 'client leave');
    }
    this.#socket = null;
  }

  #handleServerError(code: string, message: string): void {
    const error = new Error(`${code}: ${message}`);
    if (this.#status === 'joining') {
      this.#rejectJoined?.(error);
      this.#resolveJoined = null;
      this.#rejectJoined = null;
      this.#cleanupAllResources();
      this.#closeSocket();
      this.#disposed = true;
      this.#setFatalError(code, message);
      return;
    }
    this.#setWarning(code, message);
  }

  #send(message: ClientMessage): void {
    if (this.#socket?.readyState !== SOCKET_OPEN) {
      throw new Error('Signaling socket is not open');
    }
    this.#socket.send(JSON.stringify(message));
  }

  #setStatus(status: RoomSessionStatus): void {
    this.#status = status;
    this.#emit();
  }

  #setWarning(code: string, message: string): void {
    this.#warning = { code, message };
    this.#emit();
  }

  #setFatalError(code: string, message: string): void {
    this.#error = { code, message };
    this.#status = 'error';
    this.#emit();
  }

  #getLocalMediaSnapshot(): LocalMediaSnapshot {
    const audioTracks = this.#localStream?.getAudioTracks() ?? [];
    const videoTracks = this.#localStream?.getVideoTracks() ?? [];
    return {
      audioAvailable: audioTracks.length > 0,
      audioEnabled: audioTracks.length > 0 && audioTracks.some((track) => track.enabled),
      videoAvailable: videoTracks.length > 0,
      videoEnabled: videoTracks.length > 0 && videoTracks.some((track) => track.enabled),
    };
  }

  #buildSnapshot(): RoomSessionSnapshot {
    return {
      roomId: this.#options.roomId,
      status: this.#status,
      selfId: this.#selfId,
      participants: [...this.#participants.values()].map((participant) => ({
        ...participant,
      })),
      localMedia: this.#getLocalMediaSnapshot(),
      messages: this.#messages.map((message) => ({ ...message })),
      warning: this.#warning === null ? null : { ...this.#warning },
      error: this.#error === null ? null : { ...this.#error },
    };
  }

  #emit(): void {
    this.#snapshot = this.#buildSnapshot();
    for (const listener of [...this.#listeners]) {
      listener(this.#snapshot);
    }
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  #createId(): string {
    return (this.#options.createId ?? defaultCreateId)();
  }
}

export function createRoomSession(options: RoomSessionOptions): RoomSession {
  return new RoomSession(options);
}
