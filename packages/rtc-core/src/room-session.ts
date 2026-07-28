import {
  parseServerMessage,
  serializeClientMessage,
  type AnswerDescription,
  type ClientMessage,
  type OfferDescription,
  type Participant,
  type SerializedIceCandidate,
  type ServerMessage,
} from '@round/protocol';

export type RoomSessionStatus =
  | 'idle'
  | 'preparing-media'
  | 'connecting-signal'
  | 'joining'
  | 'active'
  | 'reconnecting'
  | 'ended'
  | 'error';

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

export type ChatDeliveryState = 'pending' | 'sent' | 'failed' | 'received';

export interface ChatMessage {
  readonly id: string;
  readonly senderId: string;
  readonly senderName: string;
  readonly text: string;
  readonly sentAt: number;
  readonly isLocal: boolean;
  readonly deliveryState: ChatDeliveryState;
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

export interface RoomSessionRecoveryOptions {
  readonly signalingConnectTimeoutMs?: number;
  readonly roomJoinTimeoutMs?: number;
  readonly maxReconnectAttempts?: number;
  readonly reconnectInitialDelayMs?: number;
  readonly reconnectMaxDelayMs?: number;
  readonly peerDisconnectedGraceMs?: number;
  readonly peerRecoveryTimeoutMs?: number;
}

export interface RoomSessionOptions {
  readonly roomId: string;
  readonly displayName: string;
  readonly signalingUrl: string;
  /**
   * A stream transferred from pre-join. Passing `null` explicitly joins
   * without requesting browser media; omitting the option keeps legacy
   * in-session acquisition.
   */
  readonly preparedMediaStream?: MediaStream | null;
  readonly mediaConstraints?: MediaStreamConstraints;
  readonly rtcConfiguration?: RTCConfiguration;
  readonly maxChatMessages?: number;
  /**
   * Optional timing overrides for recovery tests and constrained deployments.
   * Production callers normally rely on the bounded defaults.
   */
  readonly recovery?: RoomSessionRecoveryOptions;
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
  readonly pendingLocalCandidates: (SerializedIceCandidate | null)[];
  readonly pendingChatMessages: ChatDataMessage[];
  pendingCandidateOverflowWarned: boolean;
  inboundDataWindowStartedAt: number | null;
  inboundDataMessagesInWindow: number;
  inboundDataRateLimitWarned: boolean;
  offerRetryAttempts: number;
  channel: RTCDataChannel | null;
  remoteDescriptionSet: boolean;
  localDescriptionPublished: boolean;
  makingOffer: boolean;
  recovering: boolean;
  disconnectedTimer: TimerHandle | null;
  recoveryTimer: TimerHandle | null;
  dataChannelErrorTimer: TimerHandle | null;
  closed: boolean;
}

interface ResolvedRecoveryOptions {
  readonly signalingConnectTimeoutMs: number;
  readonly roomJoinTimeoutMs: number;
  readonly maxReconnectAttempts: number;
  readonly reconnectInitialDelayMs: number;
  readonly reconnectMaxDelayMs: number;
  readonly peerDisconnectedGraceMs: number;
  readonly peerRecoveryTimeoutMs: number;
}

interface SocketBinding {
  readonly socket: WebSocket;
  readonly generation: number;
  readonly message: (event: MessageEvent<unknown>) => void;
  readonly close: (event: CloseEvent) => void;
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
type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;
const MAX_CHAT_TEXT_LENGTH = 4_000;
const MAX_DATA_MESSAGE_ID_LENGTH = 128;
// Covers a maximum chat after JSON escaping while keeping parse work bounded.
const MAX_DATA_CHANNEL_MESSAGE_BYTES = 32 * 1024;
// ECMAScript Date's inclusive TimeClip boundary.
const MAX_DATE_TIMESTAMP_MS = 8_640_000_000_000_000;
// Normal ICE gathering stays far below this; retain newest candidates on overflow.
const MAX_PENDING_REMOTE_ICE_CANDIDATES = 256;
const DATA_CHANNEL_RATE_WINDOW_MS = 10_000;
// Allows short UI bursts but caps sustained work at 12 frames per second per peer.
const MAX_DATA_CHANNEL_MESSAGES_PER_WINDOW = 120;
const MAX_PENDING_CHAT_MESSAGES_PER_PEER = 50;
const DATA_CHANNEL_ERROR_GRACE_MS = 250;
const DEFAULT_SIGNALING_CONNECT_TIMEOUT_MS = 8_000;
const DEFAULT_ROOM_JOIN_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 6;
const DEFAULT_RECONNECT_INITIAL_DELAY_MS = 500;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 4_000;
const DEFAULT_PEER_DISCONNECTED_GRACE_MS = 3_000;
const DEFAULT_PEER_RECOVERY_TIMEOUT_MS = 8_000;
const UTF8_ENCODER = new TextEncoder();

class RoomSessionFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RoomSessionFailure';
  }
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return resolved;
}

function nonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return resolved;
}

function resolveRecoveryOptions(
  options: RoomSessionRecoveryOptions | undefined,
): ResolvedRecoveryOptions {
  return {
    signalingConnectTimeoutMs: positiveInteger(
      options?.signalingConnectTimeoutMs,
      DEFAULT_SIGNALING_CONNECT_TIMEOUT_MS,
      'recovery.signalingConnectTimeoutMs',
    ),
    roomJoinTimeoutMs: positiveInteger(
      options?.roomJoinTimeoutMs,
      DEFAULT_ROOM_JOIN_TIMEOUT_MS,
      'recovery.roomJoinTimeoutMs',
    ),
    maxReconnectAttempts: positiveInteger(
      options?.maxReconnectAttempts,
      DEFAULT_MAX_RECONNECT_ATTEMPTS,
      'recovery.maxReconnectAttempts',
    ),
    reconnectInitialDelayMs: nonNegativeInteger(
      options?.reconnectInitialDelayMs,
      DEFAULT_RECONNECT_INITIAL_DELAY_MS,
      'recovery.reconnectInitialDelayMs',
    ),
    reconnectMaxDelayMs: nonNegativeInteger(
      options?.reconnectMaxDelayMs,
      DEFAULT_RECONNECT_MAX_DELAY_MS,
      'recovery.reconnectMaxDelayMs',
    ),
    peerDisconnectedGraceMs: positiveInteger(
      options?.peerDisconnectedGraceMs,
      DEFAULT_PEER_DISCONNECTED_GRACE_MS,
      'recovery.peerDisconnectedGraceMs',
    ),
    peerRecoveryTimeoutMs: positiveInteger(
      options?.peerRecoveryTimeoutMs,
      DEFAULT_PEER_RECOVERY_TIMEOUT_MS,
      'recovery.peerRecoveryTimeoutMs',
    ),
  };
}

function cloneRtcConfiguration(
  configuration: RTCConfiguration | undefined,
): RTCConfiguration | undefined {
  if (configuration === undefined) {
    return undefined;
  }

  return {
    ...configuration,
    ...(configuration.certificates === undefined
      ? {}
      : { certificates: [...configuration.certificates] }),
    ...(configuration.iceServers === undefined
      ? {}
      : {
          iceServers: configuration.iceServers.map((server) => ({
            ...server,
            urls: Array.isArray(server.urls) ? [...server.urls] : server.urls,
          })),
        }),
  };
}

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

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isDateSafeTimestamp(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_DATE_TIMESTAMP_MS
  );
}

function isWithinDataChannelPayloadBudget(raw: string): boolean {
  // The character check bounds encoding work; the byte check handles multi-byte UTF-8 input.
  return (
    raw.length <= MAX_DATA_CHANNEL_MESSAGE_BYTES &&
    UTF8_ENCODER.encode(raw).byteLength <= MAX_DATA_CHANNEL_MESSAGE_BYTES
  );
}

function isChatDataMessage(value: unknown): value is ChatDataMessage {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['type', 'id', 'senderId', 'sentAt', 'text']) &&
    value.type === 'chat.message' &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    value.id.length <= MAX_DATA_MESSAGE_ID_LENGTH &&
    typeof value.senderId === 'string' &&
    value.senderId.length > 0 &&
    value.senderId.length <= MAX_DATA_MESSAGE_ID_LENGTH &&
    isDateSafeTimestamp(value.sentAt) &&
    typeof value.text === 'string' &&
    value.text.length > 0 &&
    value.text.length <= MAX_CHAT_TEXT_LENGTH
  );
}

function isMediaDataMessage(value: unknown): value is MediaDataMessage {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['type', 'audioEnabled', 'videoEnabled']) &&
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
  readonly #recoveryOptions: ResolvedRecoveryOptions;
  readonly #listeners = new Set<RoomSessionListener>();
  readonly #participants = new Map<string, MutableParticipant>();
  readonly #peers = new Map<string, PeerContext>();
  readonly #remoteStreams = new Map<string, MediaStream>();
  readonly #seenMessageIds = new Set<string>();
  readonly #staleSelfIds = new Set<string>();
  readonly #messages: ChatMessage[] = [];

  #rtcConfiguration: RTCConfiguration | undefined;
  #socket: WebSocket | null = null;
  #socketBinding: SocketBinding | null = null;
  #socketGeneration = 0;
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
  #joinTimeout: TimerHandle | null = null;
  #reconnectDelayTimer: TimerHandle | null = null;
  #cancelReconnectDelay: (() => void) | null = null;
  #reconnectPromise: Promise<void> | null = null;
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
    this.#recoveryOptions = resolveRecoveryOptions(options.recovery);
    this.#rtcConfiguration = cloneRtcConfiguration(options.rtcConfiguration);
    if (options.preparedMediaStream !== undefined) {
      this.#localStream = options.preparedMediaStream;
    }
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

  /**
   * Replaces the ICE configuration used by current and future peer
   * connections. Existing media and DataChannels are left intact. Set
   * `restartIce` after rotating TURN credentials so only the deterministic
   * offer initiator renegotiates current peers.
   *
   * A refresh that cannot be applied to one or more current peers is reported
   * as one non-fatal snapshot warning. Calls after terminal cleanup are no-ops.
   */
  updateRtcConfiguration(
    configuration: RTCConfiguration,
    options: { readonly restartIce?: boolean } = {},
  ): void {
    if (this.#disposed) {
      return;
    }

    const nextConfiguration = cloneRtcConfiguration(configuration) as RTCConfiguration;
    this.#rtcConfiguration = nextConfiguration;

    let failedPeerCount = 0;
    const restartPeers: PeerContext[] = [];
    for (const peer of this.#peers.values()) {
      if (peer.closed || peer.connection.connectionState === 'closed') {
        continue;
      }
      try {
        peer.connection.setConfiguration(
          cloneRtcConfiguration(nextConfiguration) as RTCConfiguration,
        );
        if (
          options.restartIce === true &&
          this.#status === 'active' &&
          this.#isPeerRecoveryInitiator(peer.peerId)
        ) {
          restartPeers.push(peer);
        }
      } catch {
        failedPeerCount += 1;
      }
    }

    for (const peer of restartPeers) {
      this.#beginPeerRecovery(peer);
    }

    if (failedPeerCount > 0) {
      this.#setWarning(
        'rtc-configuration-update-failed',
        `Could not apply refreshed ICE configuration to ${failedPeerCount} peer connection(s); existing connections remain active`,
      );
      return;
    }
    if (this.#warning?.code === 'rtc-configuration-update-failed') {
      this.#warning = null;
      this.#emit();
    }
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
    this.#cancelReconnectWait();

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
    this.#clearJoinedWait();
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
      deliveryState: 'pending',
    };

    const targetPeers = this.#enqueueOutboundChat(wireMessage);
    const initialMessage =
      targetPeers.length === 0 ? { ...message, deliveryState: 'sent' as const } : message;
    this.#rememberMessage(initialMessage);
    for (const peer of targetPeers) {
      if (peer.channel?.readyState === 'open' && !peer.recovering) {
        this.#flushPendingData(peer, peer.channel, false);
      }
    }
    this.#emit();
    return this.#messages.find((candidate) => candidate.id === message.id) ?? initialMessage;
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
      await this.#joinRoom();
    } catch (error) {
      if (!this.#leaving) {
        this.#cleanupAllResources();
        this.#closeSocket();
        this.#disposed = true;
        if (this.#status !== 'error') {
          const issue = this.#issueFromError(error, 'join-failed');
          this.#setFatalError(issue.code, issue.message);
        }
      }
      throw error;
    }
  }

  async #prepareMedia(): Promise<void> {
    if (this.#options.preparedMediaStream !== undefined) {
      this.#emit();
      return;
    }

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

  #joinRoom(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settleJoined = () => {
        if (settled) {
          return;
        }
        settled = true;
        this.#clearJoinedWait();
        resolve();
      };
      const settleError = (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        this.#clearJoinedWait();
        reject(error);
      };

      this.#resolveJoined = settleJoined;
      this.#rejectJoined = settleError;
      this.#joinTimeout = globalThis.setTimeout(() => {
        settleError(
          new RoomSessionFailure(
            'room-join-timeout',
            `The signaling server did not confirm room entry within ${this.#recoveryOptions.roomJoinTimeoutMs}ms`,
          ),
        );
      }, this.#recoveryOptions.roomJoinTimeoutMs);

      try {
        this.#send({
          v: 1,
          type: 'room.join',
          roomId: this.#options.roomId,
          payload: { displayName: this.#options.displayName },
        });
      } catch (error) {
        settleError(error);
      }
    });
  }

  #clearJoinedWait(): void {
    if (this.#joinTimeout !== null) {
      globalThis.clearTimeout(this.#joinTimeout);
      this.#joinTimeout = null;
    }
    this.#resolveJoined = null;
    this.#rejectJoined = null;
  }

  #rememberStaleSelfId(): void {
    if (this.#selfId === null) {
      return;
    }
    this.#staleSelfIds.add(this.#selfId);
    while (this.#staleSelfIds.size > 32) {
      const oldest = this.#staleSelfIds.values().next().value as string | undefined;
      if (oldest === undefined) {
        return;
      }
      this.#staleSelfIds.delete(oldest);
    }
  }

  #beginReconnect(reason: RoomSessionFailure): void {
    if (this.#leaving || this.#disposed) {
      return;
    }

    this.#rememberStaleSelfId();
    this.#cleanupPeerResources();
    this.#participants.clear();
    this.#selfId = null;
    this.#error = null;
    this.#warning = {
      code: 'signaling-reconnecting',
      message: reason.message,
    };
    this.#setStatus('reconnecting');

    if (this.#reconnectPromise !== null) {
      return;
    }

    const reconnect = this.#performReconnect(reason);
    this.#reconnectPromise = reconnect;
    void reconnect
      .catch((error: unknown) => {
        if (!this.#leaving && !this.#disposed) {
          this.#finishReconnectFailure(this.#issueFromError(error, 'reconnect-exhausted'));
        }
      })
      .finally(() => {
        if (this.#reconnectPromise === reconnect) {
          this.#reconnectPromise = null;
        }
      });
  }

  async #performReconnect(initialFailure: RoomSessionFailure): Promise<void> {
    let lastIssue: RoomIssue = {
      code: initialFailure.code,
      message: initialFailure.message,
    };

    for (let attempt = 0; attempt < this.#recoveryOptions.maxReconnectAttempts; attempt += 1) {
      if (this.#leaving || this.#disposed) {
        return;
      }

      if (attempt > 0) {
        await this.#waitForReconnectDelay(this.#reconnectDelay(attempt));
        if (this.#leaving || this.#disposed) {
          return;
        }
      }

      try {
        await this.#connectSocket();
        if (this.#leaving || this.#disposed) {
          return;
        }

        const attemptSocket = this.#socket;
        await this.#joinRoom();
        if (
          attemptSocket !== null &&
          this.#socket === attemptSocket &&
          attemptSocket.readyState === SOCKET_OPEN &&
          this.#status === 'active'
        ) {
          return;
        }
        throw new RoomSessionFailure(
          'signaling-closed',
          'Signaling connection closed while room entry was completing',
        );
      } catch (error) {
        if (this.#leaving || this.#disposed) {
          return;
        }
        lastIssue = this.#issueFromError(error, 'reconnect-attempt-failed');
        this.#rejectConnecting = null;
        this.#clearJoinedWait();
        this.#closeSocket(1000, 'reconnect retry');
        this.#cleanupPeerResources();
        this.#participants.clear();
        this.#selfId = null;
        this.#warning = {
          code: 'signaling-reconnecting',
          message: lastIssue.message,
        };
        this.#setStatus('reconnecting');
      }
    }

    this.#finishReconnectFailure({
      code: 'reconnect-exhausted',
      message: `Could not reconnect after ${this.#recoveryOptions.maxReconnectAttempts} attempts. ${lastIssue.message}`,
    });
  }

  #reconnectDelay(attempt: number): number {
    const exponential =
      this.#recoveryOptions.reconnectInitialDelayMs * 2 ** Math.max(0, attempt - 1);
    return Math.min(exponential, this.#recoveryOptions.reconnectMaxDelayMs);
  }

  #waitForReconnectDelay(delayMs: number): Promise<void> {
    if (delayMs === 0) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const finish = () => {
        if (this.#reconnectDelayTimer !== null) {
          globalThis.clearTimeout(this.#reconnectDelayTimer);
          this.#reconnectDelayTimer = null;
        }
        this.#cancelReconnectDelay = null;
        resolve();
      };
      this.#cancelReconnectDelay = finish;
      this.#reconnectDelayTimer = globalThis.setTimeout(finish, delayMs);
    });
  }

  #cancelReconnectWait(): void {
    this.#cancelReconnectDelay?.();
    this.#cancelReconnectDelay = null;
    if (this.#reconnectDelayTimer !== null) {
      globalThis.clearTimeout(this.#reconnectDelayTimer);
      this.#reconnectDelayTimer = null;
    }
  }

  #finishReconnectFailure(issue: RoomIssue): void {
    if (this.#leaving || this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#cancelReconnectWait();
    this.#rejectConnecting = null;
    this.#clearJoinedWait();
    this.#closeSocket(1000, 'reconnect exhausted');
    this.#cleanupAllResources();
    this.#participants.clear();
    this.#selfId = null;
    if (this.#warning?.code === 'signaling-reconnecting') {
      this.#warning = null;
    }
    this.#setFatalError(issue.code, issue.message);
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
      const generation = ++this.#socketGeneration;
      this.#bindSocket(socket, generation);

      let timeout: TimerHandle | null = null;
      const cleanupAttemptListeners = () => {
        socket.removeEventListener('open', settleOpen);
        socket.removeEventListener('error', settleErrorEvent);
        socket.removeEventListener('close', settleClose);
        if (timeout !== null) {
          globalThis.clearTimeout(timeout);
          timeout = null;
        }
      };

      const settleOpen = () => {
        if (!settled) {
          settled = true;
          cleanupAttemptListeners();
          this.#rejectConnecting = null;
          resolve();
        }
      };
      const settleError = (
        error: unknown = new RoomSessionFailure(
          'signaling-connect-failed',
          'Could not connect to the signaling server',
        ),
      ) => {
        if (!settled) {
          settled = true;
          cleanupAttemptListeners();
          this.#rejectConnecting = null;
          reject(error);
        }
      };
      const settleErrorEvent = () => {
        settleError();
      };
      const settleClose = (event: Event) => {
        const close = event as CloseEvent;
        const reason = close.reason || `close code ${close.code}`;
        settleError(
          new RoomSessionFailure(
            'signaling-closed',
            `Signaling connection closed before it opened (${reason})`,
          ),
        );
      };

      this.#rejectConnecting = settleError;
      socket.addEventListener('open', settleOpen);
      socket.addEventListener('error', settleErrorEvent);
      socket.addEventListener('close', settleClose);
      timeout = globalThis.setTimeout(() => {
        const error = new RoomSessionFailure(
          'signaling-connect-timeout',
          `Signaling connection did not open within ${this.#recoveryOptions.signalingConnectTimeoutMs}ms`,
        );
        settleError(error);
        if (this.#isCurrentSocket(socket, generation)) {
          this.#closeSocket(1000, 'signaling connect timeout');
        }
      }, this.#recoveryOptions.signalingConnectTimeoutMs);

      if (socket.readyState === SOCKET_OPEN) {
        settleOpen();
      } else if (socket.readyState !== SOCKET_CONNECTING) {
        settleError();
      }
    });
  }

  #bindSocket(socket: WebSocket, generation: number): void {
    const message = (event: MessageEvent<unknown>) => {
      this.#handleSocketMessage(socket, generation, event);
    };
    const close = (event: CloseEvent) => {
      this.#handleSocketClose(socket, generation, event);
    };
    this.#socketBinding = { socket, generation, message, close };
    socket.addEventListener('message', message);
    socket.addEventListener('close', close);
  }

  #handleSocketMessage(socket: WebSocket, generation: number, event: MessageEvent<unknown>): void {
    if (!this.#isCurrentSocket(socket, generation)) {
      return;
    }
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

    void this.#routeServerMessage(message, socket, generation);
  }

  #handleSocketClose(socket: WebSocket, generation: number, event: CloseEvent): void {
    if (!this.#isCurrentSocket(socket, generation)) {
      return;
    }

    this.#detachSocket(socket);
    this.#socket = null;
    const reason = event.reason || `close code ${event.code}`;
    const error = new RoomSessionFailure(
      'signaling-closed',
      `Signaling connection closed (${reason})`,
    );
    this.#rejectConnecting?.(error);
    this.#rejectConnecting = null;
    this.#rejectJoined?.(error);
    this.#clearJoinedWait();

    if (this.#leaving || this.#disposed) {
      return;
    }
    if (this.#status === 'active') {
      this.#beginReconnect(error);
    }
  }

  async #routeServerMessage(
    message: ServerMessage,
    socket: WebSocket,
    generation: number,
  ): Promise<void> {
    if (!this.#isCurrentSocket(socket, generation)) {
      return;
    }
    try {
      switch (message.type) {
        case 'room.joined':
          await this.#handleRoomJoined(message.payload.peerId, message.payload.participants);
          return;
        case 'peer.joined':
          if (this.#staleSelfIds.has(message.payload.participant.peerId)) {
            return;
          }
          this.#upsertParticipant(message.payload.participant, false);
          this.#ensurePeer(message.payload.participant.peerId);
          this.#emit();
          return;
        case 'rtc.offer':
          if (this.#staleSelfIds.has(message.from)) {
            return;
          }
          await this.#handleOffer(message.from, message.payload.description);
          return;
        case 'rtc.answer':
          if (this.#staleSelfIds.has(message.from)) {
            return;
          }
          await this.#handleAnswer(message.from, message.payload.description);
          return;
        case 'rtc.ice':
          if (this.#staleSelfIds.has(message.from)) {
            return;
          }
          await this.#handleIce(message.from, message.payload.candidate);
          return;
        case 'peer.left':
          this.#removePeer(message.payload.peerId);
          this.#staleSelfIds.delete(message.payload.peerId);
          return;
        case 'error':
          this.#handleServerError(message.payload.code, message.payload.message);
          return;
      }
    } catch (error) {
      if (!this.#isCurrentSocket(socket, generation)) {
        return;
      }
      const peerId = 'from' in message ? message.from : null;
      if (peerId !== null) {
        this.#failPeer(peerId, error);
      } else {
        this.#setWarning('signal-handler-failed', getErrorMessage(error));
      }
    }
  }

  async #handleRoomJoined(peerId: string, participants: readonly Participant[]): Promise<void> {
    if ((this.#status !== 'joining' && this.#status !== 'reconnecting') || this.#selfId !== null) {
      return;
    }

    this.#staleSelfIds.delete(peerId);
    this.#selfId = peerId;
    this.#upsertParticipant({ peerId, displayName: this.#options.displayName }, true);
    this.#syncLocalParticipantMedia();

    for (const participant of participants) {
      if (participant.peerId !== peerId && !this.#staleSelfIds.has(participant.peerId)) {
        this.#upsertParticipant(participant, false);
      }
    }

    const offerPromises = participants
      .filter(
        (participant) =>
          participant.peerId !== peerId && !this.#staleSelfIds.has(participant.peerId),
      )
      .map(async (participant) => {
        try {
          await this.#createOffer(participant.peerId);
        } catch (error) {
          this.#scheduleInitialOfferRetry(participant.peerId, error);
        }
      });

    if (this.#warning?.code === 'signaling-reconnecting') {
      this.#warning = null;
    }
    this.#setStatus('active');
    this.#resolveJoined?.();
    this.#resolveJoined = null;
    this.#rejectJoined = null;

    await Promise.all(offerPromises);
  }

  async #createOffer(
    peerId: string,
    options: { readonly iceRestart?: boolean } = {},
  ): Promise<void> {
    const peer = this.#ensurePeer(peerId);
    if (peer.makingOffer) {
      return;
    }
    if (options.iceRestart === true && peer.connection.signalingState !== 'stable') {
      this.#setWarning(
        'peer-restart-deferred',
        `ICE restart for ${peerId} is waiting for stable signaling`,
      );
      return;
    }

    peer.makingOffer = true;
    peer.remoteDescriptionSet = false;
    peer.localDescriptionPublished = false;
    peer.pendingLocalCandidates.length = 0;
    if (options.iceRestart === true) {
      peer.pendingCandidates.length = 0;
    }
    this.#setPeerConnectionStatus(peerId, 'negotiating');

    if (peer.channel === null) {
      this.#attachDataChannel(
        peer,
        peer.connection.createDataChannel('round-room', {
          ordered: true,
        }),
      );
    }

    try {
      const offer =
        options.iceRestart === true
          ? await peer.connection.createOffer({ iceRestart: true })
          : await peer.connection.createOffer();
      if (!this.#isCurrentPeer(peer)) {
        return;
      }
      await peer.connection.setLocalDescription(offer);
      if (!this.#isCurrentPeer(peer)) {
        return;
      }
      const description = peer.connection.localDescription ?? offer;
      this.#publishLocalDescription(peer, {
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
    } catch (error) {
      if (!this.#isCurrentPeer(peer)) {
        return;
      }
      throw error;
    } finally {
      peer.makingOffer = false;
    }
  }

  async #handleOffer(peerId: string, description: OfferDescription): Promise<void> {
    const existing = this.#peers.get(peerId);
    const peer =
      existing?.connection.connectionState === 'failed'
        ? this.#replacePeer(peerId, true)
        : this.#ensurePeer(peerId);
    try {
      peer.remoteDescriptionSet = false;
      this.#setPeerConnectionStatus(peerId, 'negotiating');
      await peer.connection.setRemoteDescription(description);
      if (!this.#isCurrentPeer(peer)) {
        return;
      }
      peer.remoteDescriptionSet = true;
      await this.#flushPendingCandidates(peer);
      if (!this.#isCurrentPeer(peer)) {
        return;
      }

      peer.localDescriptionPublished = false;
      peer.pendingLocalCandidates.length = 0;
      const answer = await peer.connection.createAnswer();
      if (!this.#isCurrentPeer(peer)) {
        return;
      }
      await peer.connection.setLocalDescription(answer);
      if (!this.#isCurrentPeer(peer)) {
        return;
      }
      const localDescription = peer.connection.localDescription ?? answer;
      this.#publishLocalDescription(peer, {
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
      if (peer.connection.connectionState === 'connected') {
        this.#finishPeerRecovery(peer);
      }
    } catch (error) {
      if (!this.#isCurrentPeer(peer)) {
        return;
      }
      throw error;
    }
  }

  async #handleAnswer(peerId: string, description: AnswerDescription): Promise<void> {
    const peer = this.#ensurePeer(peerId);
    try {
      await peer.connection.setRemoteDescription(description);
      if (!this.#isCurrentPeer(peer)) {
        return;
      }
      peer.remoteDescriptionSet = true;
      await this.#flushPendingCandidates(peer);
      if (!this.#isCurrentPeer(peer)) {
        return;
      }
      if (peer.connection.connectionState === 'connected') {
        this.#finishPeerRecovery(peer);
      }
    } catch (error) {
      if (!this.#isCurrentPeer(peer)) {
        return;
      }
      throw error;
    }
  }

  async #handleIce(peerId: string, candidate: SerializedIceCandidate | null): Promise<void> {
    const peer = this.#ensurePeer(peerId);
    if (peer.connection.connectionState === 'failed' || !peer.remoteDescriptionSet) {
      if (peer.pendingCandidates.length >= MAX_PENDING_REMOTE_ICE_CANDIDATES) {
        peer.pendingCandidates.shift();
        if (!peer.pendingCandidateOverflowWarned) {
          peer.pendingCandidateOverflowWarned = true;
          this.#setWarning(
            'ice-candidate-queue-overflow',
            `Oldest pending ICE candidate for ${peer.peerId} was discarded`,
          );
        }
      }
      peer.pendingCandidates.push(candidate);
      return;
    }

    await this.#addIceCandidate(peer, candidate);
  }

  async #flushPendingCandidates(peer: PeerContext): Promise<void> {
    const candidates = peer.pendingCandidates.splice(0, peer.pendingCandidates.length);
    peer.pendingCandidateOverflowWarned = false;
    for (const candidate of candidates) {
      if (!this.#isCurrentPeer(peer)) {
        return;
      }
      await this.#addIceCandidate(peer, candidate);
    }
  }

  async #addIceCandidate(
    peer: PeerContext,
    candidate: SerializedIceCandidate | null,
  ): Promise<void> {
    try {
      await peer.connection.addIceCandidate(candidate);
    } catch (error) {
      if (this.#isCurrentPeer(peer)) {
        this.#setWarning(
          'ice-candidate-rejected',
          `Ignored an ICE candidate for ${peer.peerId}: ${getErrorMessage(error)}`,
        );
      }
    }
  }

  #publishLocalDescription(peer: PeerContext, message: ClientMessage): void {
    if (!this.#isCurrentPeer(peer)) {
      return;
    }
    this.#send(message);
    peer.localDescriptionPublished = true;
    const candidates = peer.pendingLocalCandidates.splice(0, peer.pendingLocalCandidates.length);
    for (const candidate of candidates) {
      this.#sendLocalCandidate(peer, candidate);
    }
  }

  #sendLocalCandidate(peer: PeerContext, candidate: SerializedIceCandidate | null): void {
    if (
      !this.#isCurrentPeer(peer) ||
      this.#socket?.readyState !== SOCKET_OPEN ||
      this.#status === 'reconnecting'
    ) {
      return;
    }
    this.#send({
      v: 1,
      type: 'rtc.ice',
      roomId: this.#options.roomId,
      to: peer.peerId,
      payload: { candidate },
    });
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
    const connection = factory(cloneRtcConfiguration(this.#rtcConfiguration));
    const peer: PeerContext = {
      peerId,
      connection,
      pendingCandidates: [],
      pendingLocalCandidates: [],
      pendingChatMessages: [],
      pendingCandidateOverflowWarned: false,
      inboundDataWindowStartedAt: null,
      inboundDataMessagesInWindow: 0,
      inboundDataRateLimitWarned: false,
      offerRetryAttempts: 0,
      channel: null,
      remoteDescriptionSet: connection.remoteDescription !== null,
      localDescriptionPublished: false,
      makingOffer: false,
      recovering: false,
      disconnectedTimer: null,
      recoveryTimer: null,
      dataChannelErrorTimer: null,
      closed: false,
    };
    this.#peers.set(peerId, peer);

    for (const track of this.#localStream?.getTracks() ?? []) {
      connection.addTrack(track, this.#localStream as MediaStream);
    }

    connection.onicecandidate = (event) => {
      if (!this.#isCurrentPeer(peer) || this.#socket?.readyState !== SOCKET_OPEN) {
        return;
      }
      const candidate = serializeCandidate(event.candidate);
      if (!peer.localDescriptionPublished) {
        peer.pendingLocalCandidates.push(candidate);
        return;
      }
      this.#sendLocalCandidate(peer, candidate);
    };

    connection.ontrack = (event) => {
      if (!this.#isCurrentPeer(peer)) {
        return;
      }
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
      if (!this.#isCurrentPeer(peer)) {
        return;
      }
      this.#attachDataChannel(peer, event.channel);
    };

    connection.onconnectionstatechange = () => {
      if (!this.#isCurrentPeer(peer)) {
        return;
      }
      const status = toPeerConnectionStatus(connection.connectionState);
      this.#setPeerConnectionStatus(peerId, status);
      switch (status) {
        case 'connected':
          this.#finishPeerRecovery(peer);
          return;
        case 'disconnected':
          this.#scheduleDisconnectedRecovery(peer);
          return;
        case 'failed':
          this.#cancelDisconnectedTimer(peer);
          this.#beginPeerRecovery(peer);
          return;
        case 'closed':
          this.#cleanupPeer(peerId, false);
          this.#emit();
          return;
      }
    };

    return peer;
  }

  #isCurrentPeer(peer: PeerContext): boolean {
    return !peer.closed && this.#peers.get(peer.peerId) === peer;
  }

  #isPeerRecoveryInitiator(peerId: string): boolean {
    return this.#selfId !== null && this.#selfId < peerId;
  }

  #scheduleInitialOfferRetry(peerId: string, error: unknown): void {
    const peer = this.#peers.get(peerId);
    if (
      peer === undefined ||
      !this.#isCurrentPeer(peer) ||
      this.#disposed ||
      peer.recoveryTimer !== null
    ) {
      return;
    }

    if (peer.offerRetryAttempts >= this.#recoveryOptions.maxReconnectAttempts) {
      this.#failPeer(peerId, error);
      return;
    }
    peer.offerRetryAttempts += 1;
    const retryAttempt = peer.offerRetryAttempts;
    peer.recovering = true;
    this.#setPeerConnectionStatus(peerId, 'connecting');
    this.#setWarning(
      'peer-negotiation-retrying',
      `Initial connection to ${peerId} failed; retry ${retryAttempt}/${this.#recoveryOptions.maxReconnectAttempts} is scheduled: ${getErrorMessage(error)}`,
    );
    peer.recoveryTimer = globalThis.setTimeout(() => {
      peer.recoveryTimer = null;
      if (!this.#isCurrentPeer(peer) || this.#status !== 'active') {
        return;
      }

      const retryPeer =
        peer.connection.connectionState === 'failed' ? this.#replacePeer(peer.peerId, true) : peer;
      void this.#createOffer(retryPeer.peerId)
        .then(() => {
          retryPeer.offerRetryAttempts = 0;
          if (
            this.#isCurrentPeer(retryPeer) &&
            this.#warning?.code === 'peer-negotiation-retrying'
          ) {
            this.#warning = null;
            this.#emit();
          }
        })
        .catch((retryError: unknown) => {
          if (this.#isCurrentPeer(retryPeer)) {
            this.#scheduleInitialOfferRetry(retryPeer.peerId, retryError);
          }
        });
    }, this.#reconnectDelay(retryAttempt));
  }

  #scheduleDisconnectedRecovery(peer: PeerContext): void {
    if (!this.#isCurrentPeer(peer) || peer.disconnectedTimer !== null) {
      return;
    }
    peer.recovering = true;
    peer.disconnectedTimer = globalThis.setTimeout(() => {
      peer.disconnectedTimer = null;
      if (
        !this.#isCurrentPeer(peer) ||
        (peer.connection.connectionState !== 'disconnected' &&
          peer.connection.connectionState !== 'failed')
      ) {
        return;
      }
      this.#beginPeerRecovery(peer);
    }, this.#recoveryOptions.peerDisconnectedGraceMs);
  }

  #cancelDisconnectedTimer(peer: PeerContext): void {
    if (peer.disconnectedTimer !== null) {
      globalThis.clearTimeout(peer.disconnectedTimer);
      peer.disconnectedTimer = null;
    }
  }

  #beginPeerRecovery(peer: PeerContext): void {
    if (
      !this.#isCurrentPeer(peer) ||
      this.#status !== 'active' ||
      this.#selfId === null ||
      peer.recoveryTimer !== null
    ) {
      return;
    }

    peer.recovering = true;
    peer.recoveryTimer = globalThis.setTimeout(() => {
      peer.recoveryTimer = null;
      if (!this.#isCurrentPeer(peer)) {
        return;
      }
      if (peer.connection.connectionState === 'connected' && peer.channel?.readyState === 'open') {
        this.#finishPeerRecovery(peer);
        return;
      }

      const shouldOffer = this.#isPeerRecoveryInitiator(peer.peerId);
      const replacement = this.#replacePeer(peer.peerId, false);
      this.#setWarning(
        'peer-connection-recreated',
        `Recreated the connection to ${peer.peerId} after ICE recovery timed out`,
      );
      if (shouldOffer) {
        void this.#createOffer(replacement.peerId).catch((error: unknown) => {
          if (this.#isCurrentPeer(replacement)) {
            this.#failPeer(replacement.peerId, error);
          }
        });
      }
    }, this.#recoveryOptions.peerRecoveryTimeoutMs);

    if (!this.#isPeerRecoveryInitiator(peer.peerId)) {
      return;
    }
    void this.#createOffer(peer.peerId, { iceRestart: true }).catch((error: unknown) => {
      if (this.#isCurrentPeer(peer)) {
        this.#setWarning(
          'peer-ice-restart-failed',
          `ICE restart for ${peer.peerId} failed: ${getErrorMessage(error)}`,
        );
      }
    });
  }

  #finishPeerRecovery(peer: PeerContext): void {
    const shouldFlush =
      peer.recovering || peer.disconnectedTimer !== null || peer.recoveryTimer !== null;
    const participant = this.#participants.get(peer.peerId);
    const restoredConnectedState =
      peer.connection.connectionState === 'connected' &&
      participant !== undefined &&
      participant.connectionState !== 'connected';
    if (restoredConnectedState) {
      participant.connectionState = 'connected';
    }
    this.#cancelDisconnectedTimer(peer);
    if (peer.recoveryTimer !== null) {
      globalThis.clearTimeout(peer.recoveryTimer);
      peer.recoveryTimer = null;
    }
    peer.offerRetryAttempts = 0;
    peer.recovering = false;
    if (shouldFlush && peer.channel?.readyState === 'open') {
      this.#flushPendingData(peer, peer.channel, true);
    }
    if (restoredConnectedState) {
      this.#emit();
    }
  }

  #replacePeer(peerId: string, preservePendingCandidates: boolean): PeerContext {
    const existing = this.#peers.get(peerId);
    const pendingCandidates =
      preservePendingCandidates && existing !== undefined
        ? existing.pendingCandidates.splice(0, existing.pendingCandidates.length)
        : [];
    const pendingCandidateOverflowWarned =
      preservePendingCandidates && existing?.pendingCandidateOverflowWarned === true;
    const pendingChatMessages =
      existing?.pendingChatMessages.splice(0, existing.pendingChatMessages.length) ?? [];
    const inboundDataWindowStartedAt = existing?.inboundDataWindowStartedAt ?? null;
    const inboundDataMessagesInWindow = existing?.inboundDataMessagesInWindow ?? 0;
    const inboundDataRateLimitWarned = existing?.inboundDataRateLimitWarned ?? false;
    const offerRetryAttempts = existing?.offerRetryAttempts ?? 0;

    if (existing !== undefined) {
      this.#disposePeerContext(existing);
      this.#peers.delete(peerId);
    }
    this.#stopRemoteStream(peerId);

    const participant = this.#participants.get(peerId);
    if (participant !== undefined) {
      participant.connectionState = 'connecting';
      participant.audioEnabled = false;
      participant.videoEnabled = false;
    }

    const replacement = this.#ensurePeer(peerId);
    replacement.recovering = true;
    replacement.pendingCandidates.push(...pendingCandidates);
    replacement.pendingCandidateOverflowWarned = pendingCandidateOverflowWarned;
    replacement.pendingChatMessages.push(...pendingChatMessages);
    replacement.inboundDataWindowStartedAt = inboundDataWindowStartedAt;
    replacement.inboundDataMessagesInWindow = inboundDataMessagesInWindow;
    replacement.inboundDataRateLimitWarned = inboundDataRateLimitWarned;
    replacement.offerRetryAttempts = offerRetryAttempts;
    this.#emit();
    return replacement;
  }

  #attachDataChannel(peer: PeerContext, channel: RTCDataChannel): void {
    if (peer.channel !== null && peer.channel !== channel) {
      this.#detachAndCloseChannel(peer.channel);
    }
    if (peer.dataChannelErrorTimer !== null) {
      globalThis.clearTimeout(peer.dataChannelErrorTimer);
      peer.dataChannelErrorTimer = null;
    }

    peer.channel = channel;
    channel.onopen = () => {
      if (peer.recovering && peer.connection.connectionState === 'connected') {
        this.#finishPeerRecovery(peer);
        return;
      }
      this.#flushPendingData(peer, channel, true);
    };
    channel.onmessage = (event) => {
      this.#handleDataMessage(peer.peerId, event.data);
    };
    channel.onclose = () => {
      this.#recoverDataChannel(
        peer,
        channel,
        'data-channel-closed',
        `Chat channel to ${peer.peerId} closed and is being recovered`,
      );
    };
    channel.onerror = () => {
      if (peer.dataChannelErrorTimer !== null) {
        globalThis.clearTimeout(peer.dataChannelErrorTimer);
      }
      peer.dataChannelErrorTimer = globalThis.setTimeout(() => {
        peer.dataChannelErrorTimer = null;
        if (!this.#isCurrentPeer(peer)) {
          return;
        }
        this.#recoverDataChannel(
          peer,
          channel,
          'data-channel-error',
          `Chat channel to ${peer.peerId} encountered an error and is being recovered`,
        );
      }, DATA_CHANNEL_ERROR_GRACE_MS);
    };

    if (channel.readyState === 'open' && !peer.recovering) {
      this.#flushPendingData(peer, channel, true);
    }
  }

  #recoverDataChannel(
    peer: PeerContext,
    channel: RTCDataChannel,
    code: string,
    message: string,
  ): void {
    if (!this.#isCurrentPeer(peer) || peer.channel !== channel) {
      return;
    }
    if (peer.dataChannelErrorTimer !== null) {
      globalThis.clearTimeout(peer.dataChannelErrorTimer);
      peer.dataChannelErrorTimer = null;
    }

    peer.channel = null;
    this.#detachAndCloseChannel(channel);
    this.#setWarning(code, message);
    this.#beginPeerRecovery(peer);
  }

  #handleDataMessage(peerId: string, raw: unknown): void {
    const peer = this.#peers.get(peerId);
    if (
      peer === undefined ||
      !this.#isCurrentPeer(peer) ||
      !this.#consumeInboundDataBudget(peer) ||
      typeof raw !== 'string' ||
      !isWithinDataChannelPayloadBudget(raw)
    ) {
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
      deliveryState: 'received',
    });
    this.#emit();
  }

  #consumeInboundDataBudget(peer: PeerContext): boolean {
    const now = this.#now();
    const windowStartedAt = peer.inboundDataWindowStartedAt;
    if (
      windowStartedAt === null ||
      (now >= windowStartedAt && now - windowStartedAt >= DATA_CHANNEL_RATE_WINDOW_MS)
    ) {
      peer.inboundDataWindowStartedAt = now;
      peer.inboundDataMessagesInWindow = 0;
      peer.inboundDataRateLimitWarned = false;
    }

    if (peer.inboundDataMessagesInWindow >= MAX_DATA_CHANNEL_MESSAGES_PER_WINDOW) {
      if (!peer.inboundDataRateLimitWarned) {
        peer.inboundDataRateLimitWarned = true;
        this.#setWarning(
          'data-channel-rate-limit',
          `Ignored excessive DataChannel messages from ${peer.peerId}`,
        );
      }
      return false;
    }

    peer.inboundDataMessagesInWindow += 1;
    return true;
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

  #enqueueOutboundChat(message: ChatDataMessage): PeerContext[] {
    const peers = [...this.#peers.values()].filter((peer) => this.#isCurrentPeer(peer));
    const unavailableParticipant = [...this.#participants.values()].find(
      (participant) =>
        !participant.isLocal && !peers.some((peer) => peer.peerId === participant.peerId),
    );
    if (unavailableParticipant !== undefined) {
      throw new Error(
        `Chat delivery to ${unavailableParticipant.peerId} is unavailable while the peer connection is failed`,
      );
    }
    const saturatedPeer = peers.find(
      (peer) => peer.pendingChatMessages.length >= MAX_PENDING_CHAT_MESSAGES_PER_PEER,
    );
    if (saturatedPeer !== undefined) {
      throw new Error(`Chat delivery queue for ${saturatedPeer.peerId} is full`);
    }

    for (const peer of peers) {
      peer.pendingChatMessages.push(message);
    }
    return peers;
  }

  #broadcastData(message: MediaDataMessage): void {
    for (const peer of this.#peers.values()) {
      if (peer.channel?.readyState === 'open' && !peer.recovering) {
        this.#sendData(peer, peer.channel, message);
      }
    }
  }

  #flushPendingData(peer: PeerContext, channel: RTCDataChannel, sendMediaState: boolean): void {
    if (
      !this.#isCurrentPeer(peer) ||
      peer.recovering ||
      peer.channel !== channel ||
      channel.readyState !== 'open'
    ) {
      return;
    }

    if (sendMediaState && !this.#sendData(peer, channel, this.#currentMediaDataMessage())) {
      return;
    }
    while (peer.pendingChatMessages.length > 0) {
      const message = peer.pendingChatMessages[0];
      if (message === undefined || !this.#sendData(peer, channel, message)) {
        return;
      }
      peer.pendingChatMessages.shift();
      this.#markLocalChatSentIfComplete(message.id);
    }
  }

  #sendData(peer: PeerContext, channel: RTCDataChannel, message: DataMessage): boolean {
    try {
      channel.send(JSON.stringify(message));
      return true;
    } catch (error) {
      this.#recoverDataChannel(
        peer,
        channel,
        'data-channel-send-failed',
        `Chat channel to ${peer.peerId} rejected a send and is being recovered: ${getErrorMessage(error)}`,
      );
      return false;
    }
  }

  #markLocalChatSentIfComplete(messageId: string): void {
    const stillPending = [...this.#peers.values()].some((peer) =>
      peer.pendingChatMessages.some((message) => message.id === messageId),
    );
    if (!stillPending && this.#setLocalChatDeliveryState(messageId, 'sent')) {
      this.#emit();
    }
  }

  #setLocalChatDeliveryState(messageId: string, deliveryState: 'sent' | 'failed'): boolean {
    const index = this.#messages.findIndex(
      (message) => message.id === messageId && message.isLocal,
    );
    const message = this.#messages[index];
    if (
      index < 0 ||
      message === undefined ||
      message.deliveryState === deliveryState ||
      message.deliveryState === 'failed'
    ) {
      return false;
    }
    this.#messages[index] = { ...message, deliveryState };
    return true;
  }

  #markQueuedChatsFailed(peer: PeerContext): void {
    for (const message of peer.pendingChatMessages) {
      this.#setLocalChatDeliveryState(message.id, 'failed');
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
      this.#markQueuedChatsFailed(peer);
      this.#disposePeerContext(peer);
      this.#peers.delete(peerId);
    }

    this.#stopRemoteStream(peerId);
    if (removeParticipant) {
      this.#participants.delete(peerId);
    }
  }

  #disposePeerContext(peer: PeerContext): void {
    peer.closed = true;
    this.#cancelDisconnectedTimer(peer);
    if (peer.recoveryTimer !== null) {
      globalThis.clearTimeout(peer.recoveryTimer);
      peer.recoveryTimer = null;
    }
    if (peer.dataChannelErrorTimer !== null) {
      globalThis.clearTimeout(peer.dataChannelErrorTimer);
      peer.dataChannelErrorTimer = null;
    }
    peer.connection.onicecandidate = null;
    peer.connection.ontrack = null;
    peer.connection.ondatachannel = null;
    peer.connection.onconnectionstatechange = null;
    if (peer.channel !== null) {
      this.#detachAndCloseChannel(peer.channel);
      peer.channel = null;
    }
    if (peer.connection.connectionState !== 'closed') {
      peer.connection.close();
    }
    peer.pendingCandidates.length = 0;
    peer.pendingLocalCandidates.length = 0;
    peer.pendingChatMessages.length = 0;
  }

  #stopRemoteStream(peerId: string): void {
    const remoteStream = this.#remoteStreams.get(peerId);
    for (const track of remoteStream?.getTracks() ?? []) {
      track.stop();
    }
    this.#remoteStreams.delete(peerId);
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

  #cleanupPeerResources(): void {
    for (const peerId of [...this.#peers.keys()]) {
      this.#cleanupPeer(peerId, false);
    }
    this.#remoteStreams.clear();
  }

  #cleanupAllResources(): void {
    this.#cleanupPeerResources();

    for (const track of this.#localStream?.getTracks() ?? []) {
      track.stop();
    }
    this.#localStream = null;
  }

  #closeSocket(code = 1000, reason = 'client leave'): void {
    const socket = this.#socket;
    if (socket === null) {
      return;
    }

    this.#detachSocket(socket);
    if (socket.readyState === SOCKET_CONNECTING || socket.readyState === SOCKET_OPEN) {
      socket.close(code, reason);
    }
    this.#socket = null;
  }

  #detachSocket(socket: WebSocket): void {
    const binding = this.#socketBinding;
    if (binding === null || binding.socket !== socket) {
      return;
    }
    socket.removeEventListener('message', binding.message);
    socket.removeEventListener('close', binding.close);
    this.#socketBinding = null;
  }

  #isCurrentSocket(socket: WebSocket, generation: number): boolean {
    return (
      this.#socket === socket &&
      this.#socketBinding?.socket === socket &&
      this.#socketBinding.generation === generation
    );
  }

  #handleServerError(code: string, message: string): void {
    const error = new RoomSessionFailure(code, message);
    if (this.#rejectJoined !== null) {
      this.#rejectJoined?.(error);
      return;
    }
    this.#setWarning(code, message);
  }

  #send(message: ClientMessage): void {
    if (this.#socket?.readyState !== SOCKET_OPEN) {
      throw new Error('Signaling socket is not open');
    }
    this.#socket.send(serializeClientMessage(message));
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

  #issueFromError(error: unknown, fallbackCode: string): RoomIssue {
    if (error instanceof RoomSessionFailure) {
      return { code: error.code, message: error.message };
    }
    return { code: fallbackCode, message: getErrorMessage(error) };
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
    const value = (this.#options.now ?? Date.now)();
    if (isDateSafeTimestamp(value)) {
      return value;
    }
    const fallback = Date.now();
    return isDateSafeTimestamp(fallback) ? fallback : 0;
  }

  #createId(): string {
    return (this.#options.createId ?? defaultCreateId)();
  }
}

export function createRoomSession(options: RoomSessionOptions): RoomSession {
  return new RoomSession(options);
}
