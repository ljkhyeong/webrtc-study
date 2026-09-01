import {
  PROTOCOL_VERSION,
  serializeClientMessage,
  serializePeerDataMessage,
  type AnswerDescription,
  type ChatDataMessage,
  type ClientMessage,
  type ModeratedMediaKind,
  type OfferDescription,
  type Participant,
  type ParticipantMediaDataMessage,
  type ParticipantRole,
  type SerializedIceCandidate,
  type ServerMessage,
  type SignalingErrorCode,
} from '@round/protocol';
import {
  measurePeerConnections,
  type PeerConnectionDiagnostics,
} from './connection-diagnostics.js';
import { PeerConnectionLifecycle } from './peer-connection-lifecycle.js';
import { PEER_DATA_CHANNEL_LABEL, PeerDataChannel } from './peer-data-channel.js';
import { SignalingTransport, SignalingTransportError } from './signaling-transport.js';
export type { PeerConnectionDiagnostics } from './connection-diagnostics.js';

export type RoomSessionStatus =
  | 'idle'
  | 'preparing-media'
  | 'connecting-signal'
  | 'joining'
  | 'active'
  | 'reconnecting'
  | 'ended'
  | 'error';

export type PeerConnectionStatus = RTCPeerConnectionState | 'negotiating';

export type RoomIssueCode =
  | SignalingErrorCode
  | 'media-unavailable'
  | 'media-permission-denied'
  | 'video-quality-update-failed'
  | 'rtc-configuration-update-failed'
  | 'join-failed'
  | 'room-join-timeout'
  | 'signaling-reconnecting'
  | 'reconnect-exhausted'
  | 'reconnect-attempt-failed'
  | 'signaling-connect-failed'
  | 'signaling-connect-timeout'
  | 'signaling-closed'
  | 'connection-superseded'
  | 'invalid-signal-message'
  | 'signal-handler-failed'
  | 'peer-restart-deferred'
  | 'ice-candidate-queue-overflow'
  | 'ice-candidate-rejected'
  | 'peer-negotiation-retrying'
  | 'peer-connection-recovering'
  | 'peer-connection-recreated'
  | 'peer-ice-restart-failed'
  | 'screen-share-sender-recovery'
  | 'media-device-sender-recovery'
  | 'data-channel-closed'
  | 'data-channel-error'
  | 'data-channel-send-failed'
  | 'data-channel-rate-limit'
  | 'peer-negotiation-failed'
  | 'peer-connection-timeout'
  | 'local-media-ended';

export interface RoomIssue {
  readonly code: RoomIssueCode;
  readonly message: string;
}

export type ScreenShareStartResult = 'started' | 'recovering' | 'cancelled' | 'failed';

export interface LocalMediaSnapshot {
  readonly audioAvailable: boolean;
  readonly audioEnabled: boolean;
  readonly videoAvailable: boolean;
  readonly videoEnabled: boolean;
  readonly videoSource: VideoSource;
}

export type VideoSource = ParticipantMediaDataMessage['videoSource'];
export type VideoQualityMode = 'standard' | 'data-saver';

export interface ParticipantSnapshot {
  readonly peerId: string;
  readonly displayName: string;
  readonly role: ParticipantRole;
  readonly isLocal: boolean;
  readonly connectionState: PeerConnectionStatus;
  readonly audioEnabled: boolean;
  readonly videoEnabled: boolean;
  readonly videoSource: VideoSource;
}

export interface RoomConnectionDiagnostics {
  readonly status: RoomSessionStatus;
  readonly connections: readonly PeerConnectionDiagnostics[];
}

export interface ModerationNotice {
  readonly id: string;
  readonly sequence: number;
  readonly fromPeerId: string;
  readonly kind: ModeratedMediaKind;
}

export type ChatDeliveryState = 'pending' | 'sent' | 'partial' | 'failed' | 'received';

export interface ChatMessage {
  readonly id: string;
  readonly senderId: string;
  readonly senderName: string;
  readonly text: string;
  readonly sentAt: number;
  readonly isLocal: boolean;
  readonly deliveryState: ChatDeliveryState;
}

export type ChatSendErrorCode =
  'room-not-active' | 'message-id-conflict' | 'peer-unavailable' | 'queue-full';

export class ChatSendError extends Error {
  constructor(
    readonly code: ChatSendErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ChatSendError';
  }
}

export interface RoomSessionSnapshot {
  readonly roomId: string;
  readonly status: RoomSessionStatus;
  readonly selfId: string | null;
  readonly selfRole: ParticipantRole | null;
  readonly canModerateMedia: boolean;
  readonly screenShareAvailable: boolean;
  readonly screenSharing: boolean;
  readonly videoQualityMode: VideoQualityMode;
  readonly participants: readonly ParticipantSnapshot[];
  readonly localMedia: LocalMediaSnapshot;
  readonly messages: readonly ChatMessage[];
  readonly lastModerationNotice: ModerationNotice | null;
  readonly warning: RoomIssue | null;
  readonly error: RoomIssue | null;
}

export type RoomSessionListener = (snapshot: RoomSessionSnapshot) => void;

export interface RoomSessionRecoveryOptions {
  readonly signalingConnectTimeoutMs?: number;
  readonly roomJoinTimeoutMs?: number;
  readonly peerConnectionTimeoutMs?: number;
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
  /** 선택적 standalone 증명으로, `room.join`에만 전달한다. */
  readonly hostCapability?: string;
  /**
   * 참여 전 단계에서 이전받은 스트림이다. `null`을 명시하면 브라우저 미디어를
   * 요청하지 않고 참여하며, 옵션을 생략하면 기존 세션 내부 획득 방식을 유지한다.
   */
  readonly preparedMediaStream?: MediaStream | null;
  /** 입장 전에 분리된 장치를 다시 선택할 때 적용할 마지막 켜기·끄기 상태다. */
  readonly initialInputEnabled?: Readonly<Record<'audio' | 'video', boolean>>;
  readonly mediaConstraints?: MediaStreamConstraints;
  readonly rtcConfiguration?: RTCConfiguration;
  readonly maxChatMessages?: number;
  /**
   * 복구 테스트와 제약된 배포 환경에서 사용하는 선택적 타이밍 재정의다.
   * 운영 호출자는 일반적으로 상한이 정해진 기본값을 사용한다.
   */
  readonly recovery?: RoomSessionRecoveryOptions;
  /**
   * 횟수가 제한된 재연결 시도를 포함해 각 시그널링 WebSocket을 생성하기 직전에 실행한다.
   */
  readonly beforeSignalingConnect?: () => void | Promise<void>;
  readonly webSocketFactory?: (url: string) => WebSocket;
  readonly peerConnectionFactory?: (
    configuration: RTCConfiguration | undefined,
  ) => RTCPeerConnection;
  readonly mediaDevices?: Pick<MediaDevices, 'getUserMedia'> &
    Partial<Pick<MediaDevices, 'getDisplayMedia'>>;
  readonly mediaStreamFactory?: () => MediaStream;
  /** 채팅 전송 메시지의 유닉스 시각 `sentAt`을 만드는 시스템 시계다. */
  readonly wallClockNow?: () => number;
  /** DataChannel 수신 제한 구간에 사용하는 단조 증가 시계다. */
  readonly monotonicNow?: () => number;
  readonly createId?: () => string;
}

interface MutableParticipant {
  peerId: string;
  displayName: string;
  role: ParticipantRole;
  isLocal: boolean;
  connectionState: PeerConnectionStatus;
  audioEnabled: boolean;
  videoEnabled: boolean;
  videoSource: VideoSource;
}

type PeerContext = PeerConnectionLifecycle;

type ChatRecipientDeliveryState = 'pending' | 'acknowledged' | 'failed';

interface OutboundChatTargets {
  readonly peers: PeerContext[];
  readonly recipientStates: Map<string, ChatRecipientDeliveryState>;
}

interface ResolvedRecoveryOptions {
  readonly signalingConnectTimeoutMs: number;
  readonly roomJoinTimeoutMs: number;
  readonly peerConnectionTimeoutMs: number;
  readonly maxReconnectAttempts: number;
  readonly reconnectInitialDelayMs: number;
  readonly reconnectMaxDelayMs: number;
  readonly peerDisconnectedGraceMs: number;
  readonly peerRecoveryTimeoutMs: number;
}

type RelayClientMessage = Extract<ClientMessage, { to: string }>;

interface MediaSenderUpdate {
  readonly peer: PeerContext;
  readonly sender: RTCRtpSender;
  readonly previousTrack: MediaStreamTrack | null;
  readonly added: boolean;
}

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

// 일반적인 ICE 후보 수집량은 이 값보다 훨씬 적다. 초과 시 최신 후보를 유지한다.
const MAX_PENDING_REMOTE_ICE_CANDIDATES = 256;
// 완전히 폐기된 로컬 ID에는 피어 ACK/중복 제거 윈도 크기를 동일하게 적용한다.
// 현재의 신뢰성·순서 보장 채널에서는 이보다 많은 새 확인 응답이 앞지를 수 없으며,
// 분리된 채널은 핸들러가 제거된다. 표시 중이거나 대기 중인 ID는 이 FIFO 한도와
// 별도로 계속 고정한다.
const MAX_RECENTLY_RETIRED_LOCAL_CHAT_IDS = 128;
const SIGNALING_SESSION_SUPERSEDED_CLOSE_CODE = 4002;
const SIGNALING_SESSION_SUPERSEDED_REASON = 'Participation session superseded';
const DEFAULT_SIGNALING_CONNECT_TIMEOUT_MS = 8_000;
const DEFAULT_ROOM_JOIN_TIMEOUT_MS = 8_000;
// 협상 재시도와 연결 watchdog이 경쟁하지 않도록 기본 초기 offer 재시도
// backoff 상한(15.5초)보다 길게 설정한다.
const DEFAULT_PEER_CONNECTION_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 6;
const DEFAULT_RECONNECT_INITIAL_DELAY_MS = 500;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 4_000;
const DEFAULT_PEER_DISCONNECTED_GRACE_MS = 3_000;
const DEFAULT_PEER_RECOVERY_TIMEOUT_MS = 8_000;
const SCREEN_SHARE_CONSTRAINTS: DisplayMediaStreamOptions = {
  video: {
    width: { ideal: 1280, max: 1280 },
    height: { ideal: 720, max: 720 },
    frameRate: { ideal: 15, max: 15 },
  },
  audio: false,
};
class RoomSessionFailure extends Error {
  constructor(
    readonly code: RoomIssueCode,
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
    peerConnectionTimeoutMs: positiveInteger(
      options?.peerConnectionTimeoutMs,
      DEFAULT_PEER_CONNECTION_TIMEOUT_MS,
      'recovery.peerConnectionTimeoutMs',
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

function snapshotRtcConfiguration(
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
  return globalThis.crypto.randomUUID();
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDisplayMediaCancellation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('name' in error)) {
    return false;
  }
  return error.name === 'NotAllowedError' || error.name === 'AbortError';
}

function preferDetailedScreenContent(track: MediaStreamTrack): void {
  if (!('contentHint' in track)) {
    return;
  }
  try {
    track.contentHint = 'detail';
  } catch {
    // 일부 엔진은 contentHint를 노출하지만 표준화된 모든 값을 허용하지는 않는다.
  }
}

function safeSignalingErrorMessage(code: SignalingErrorCode): string {
  switch (code) {
    case 'INVALID_MESSAGE':
      return 'The signaling server rejected an incompatible message.';
    case 'ALREADY_JOINED':
      return 'The signaling room membership state is inconsistent.';
    case 'ROOM_FULL':
      return 'The signaling room is full.';
    case 'NOT_IN_ROOM':
      return 'The signaling server no longer considers this browser joined.';
    case 'ROOM_MISMATCH':
      return 'The signaling server room does not match this session.';
    case 'TARGET_NOT_FOUND':
      return 'The signaling target is no longer in the room.';
    case 'TARGET_SELF':
      return 'The signaling target was invalid.';
    case 'FORBIDDEN':
      return 'The signaling server rejected an unauthorized request.';
    case 'INTERNAL_ERROR':
      return 'The signaling server could not process a request.';
  }
}

/**
 * 프레임워크와 무관하게 단일 방의 브라우저 WebRTC 리소스를 소유한다.
 *
 * 세션은 의도적으로 일회용이다. `leave()` 또는 치명적인 시그널링 오류 후에는
 * 새 인스턴스를 생성해야 한다.
 */
export class RoomSession {
  readonly #options: RoomSessionOptions;
  readonly #recoveryOptions: ResolvedRecoveryOptions;
  readonly #serializedJoinMessage: string;
  readonly #listeners = new Set<RoomSessionListener>();
  readonly #participants = new Map<string, MutableParticipant>();
  readonly #peers = new Map<string, PeerContext>();
  readonly #remoteStreams = new Map<string, MediaStream>();
  readonly #remoteMediaStates = new Map<string, ParticipantMediaDataMessage>();
  readonly #activeLocalMessageIds = new Set<string>();
  readonly #recentlyRetiredLocalMessageIds = new Set<string>();
  readonly #staleSelfIds = new Set<string>();
  readonly #exhaustedPeerIds = new Set<string>();
  readonly #localTrackEndedListeners = new Map<MediaStreamTrack, EventListener>();
  readonly #localChatRecipientStates = new Map<string, Map<string, ChatRecipientDeliveryState>>();
  readonly #messages: ChatMessage[] = [];
  readonly #lastInputEnabled = { audio: true, video: true };
  readonly #endedInputKinds = new Set<'audio' | 'video'>();
  readonly #signalingTransport: SignalingTransport;

  #rtcConfiguration: RTCConfiguration | undefined;
  #localStream: MediaStream | null = null;
  #cameraVideoTracks: MediaStreamTrack[] = [];
  #videoQualityMode: VideoQualityMode = 'standard';
  #inputChange: {
    kind: 'audio' | 'video';
    enabled: boolean;
    track: MediaStreamTrack | null;
  } | null = null;
  #pendingScreenTrack: MediaStreamTrack | null = null;
  #screenTrack: MediaStreamTrack | null = null;
  #screenTrackEndedListener: EventListener | null = null;
  #screenShareCreatedLocalStream = false;
  #screenShareStartPromise: Promise<ScreenShareStartResult> | null = null;
  #screenShareStopPromise: Promise<boolean> | null = null;
  #screenShareStopTrack: MediaStreamTrack | null = null;
  #screenShareStopGeneration = 0;
  #screenShareStopDisableCamera = false;
  #screenShareOperation = 0;
  #status: RoomSessionStatus = 'idle';
  #selfId: string | null = null;
  #selfRole: ParticipantRole | null = null;
  #canModerateMedia = false;
  #lastModerationNotice: ModerationNotice | null = null;
  #moderationNoticeSequence = 0;
  #warning: RoomIssue | null = null;
  #warningPeerId: string | null = null;
  #error: RoomIssue | null = null;
  #snapshot: RoomSessionSnapshot;
  #joinPromise: Promise<void> | null = null;
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
    this.#signalingTransport = new SignalingTransport({
      url: this.#options.signalingUrl,
      roomId,
      connectTimeoutMs: this.#recoveryOptions.signalingConnectTimeoutMs,
      ...(options.beforeSignalingConnect === undefined
        ? {}
        : { beforeConnect: options.beforeSignalingConnect }),
      ...(options.webSocketFactory === undefined
        ? {}
        : { webSocketFactory: options.webSocketFactory }),
      canConnect: () => !this.#leaving && !this.#disposed,
      onMessage: (message, socket, generation) => {
        void this.#routeServerMessage(message, socket, generation);
      },
      onInvalidMessage: (message) => {
        this.#setWarning('invalid-signal-message', message);
      },
      onClose: (error, event) => {
        this.#handleSocketClose(error, event);
      },
    });
    this.#serializedJoinMessage = serializeClientMessage({
      v: PROTOCOL_VERSION,
      type: 'room.join',
      roomId,
      payload: {
        displayName,
        ...(options.hostCapability === undefined ? {} : { hostCapability: options.hostCapability }),
      },
    });
    this.#rtcConfiguration = snapshotRtcConfiguration(options.rtcConfiguration);
    Object.assign(this.#lastInputEnabled, options.initialInputEnabled);
    if (options.preparedMediaStream !== undefined) {
      this.#localStream = options.preparedMediaStream;
      if (this.#localStream !== null) {
        this.#normalizeLocalVideoTracks(this.#localStream);
      }
      this.#attachLocalTrackEndedListeners(this.#localStream?.getTracks() ?? []);
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

  async setVideoQualityMode(mode: VideoQualityMode): Promise<boolean> {
    if (this.#disposed || this.#status !== 'active') return false;
    this.#videoQualityMode = mode;
    this.#emit();
    const results = await Promise.all(
      [...this.#peers.values()].map((peer) => this.#updateVideoQuality(peer)),
    );
    return !this.#disposed && results.every(Boolean);
  }

  #updateVideoQuality(peer: PeerContext): Promise<boolean> {
    const update = peer.videoQualityUpdate.then(async () => {
      const sender = peer.videoSender;
      if (!this.#isCurrentPeer(peer) || sender?.track == null) return true;
      const screen =
        sender.track === this.#screenTrack || sender.track === this.#pendingScreenTrack;
      const limited = this.#videoQualityMode === 'data-saver' && !screen;
      if (!limited && !peer.videoQualityLimited) return true;
      try {
        peer.videoQualityLimited = true;
        const parameters = sender.getParameters();
        // 협상 전에는 송신 인코딩이 없을 수 있다. SDP 적용 후 다시 적용한다.
        if (parameters.encodings.length === 0) return true;
        for (const encoding of parameters.encodings) {
          if (limited) {
            encoding.maxBitrate = 150_000;
            encoding.maxFramerate = 10;
            encoding.scaleResolutionDownBy = 2;
          } else {
            delete encoding.maxBitrate;
            delete encoding.maxFramerate;
            encoding.scaleResolutionDownBy = 1;
          }
        }
        if (!(await this.#waitForPeerMedia(peer, () => sender.setParameters(parameters))))
          return true;
        peer.videoQualityLimited = limited;
        peer.videoQualityFailed = false;
        if (this.#clearResolvedVideoQualityWarning()) {
          this.#emit();
        }
        return true;
      } catch {
        if (!this.#isCurrentPeer(peer)) return true;
        peer.videoQualityFailed = true;
        this.#setWarning(
          'video-quality-update-failed',
          '일부 연결에 카메라 송신 설정을 적용하지 못했습니다.',
        );
        return false;
      }
    });
    peer.videoQualityUpdate = update;
    return update;
  }

  #clearResolvedVideoQualityWarning(): boolean {
    if (
      this.#warning?.code !== 'video-quality-update-failed' ||
      [...this.#peers.values()].some((peer) => peer.videoQualityFailed)
    ) {
      return false;
    }
    this.#warning = null;
    this.#warningPeerId = null;
    return true;
  }

  /**
   * 요청 후 약 3초 동안의 수신 통계를 비교하며 주기적으로 수집하지 않는다.
   * candidate 주소, 방 코드, peer ID는 결과에 포함하지 않는다.
   */
  async collectConnectionDiagnostics(): Promise<RoomConnectionDiagnostics> {
    const peers = [...this.#peers.values()].filter(
      (peer) => !peer.closed && peer.connection.connectionState !== 'closed',
    );
    const connections = await measurePeerConnections(
      peers.map((peer) => ({
        connection: peer.connection,
        signal: peer.trackReplacementAbort.signal,
        isCurrent: () => this.#isCurrentPeer(peer),
      })),
    );
    return {
      status: this.#status,
      connections,
    };
  }

  /**
   * 현재 및 향후 피어 연결에서 사용하는 ICE 구성을 교체한다. 기존 미디어와
   * DataChannel은 그대로 유지한다. TURN 자격 증명을 교체한 뒤 `restartIce`를
   * 설정하면 결정론적으로 정해진 offer 시작자만 현재 피어를 재협상한다.
   *
   * 하나 이상의 현재 피어에 적용할 수 없는 갱신은 치명적이지 않은 snapshot 경고
   * 하나로 보고한다. 종료 정리 후 호출은 아무 작업도 하지 않는다.
   */
  updateRtcConfiguration(
    configuration: RTCConfiguration,
    options: { readonly restartIce?: boolean } = {},
  ): void {
    if (this.#disposed) {
      return;
    }

    this.#rtcConfiguration = snapshotRtcConfiguration(configuration);

    let failedPeerCount = 0;
    const restartPeers: PeerContext[] = [];
    for (const peer of this.#peers.values()) {
      if (peer.closed || peer.connection.connectionState === 'closed') {
        continue;
      }
      try {
        peer.connection.setConfiguration(
          snapshotRtcConfiguration(this.#rtcConfiguration) as RTCConfiguration,
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
      this.#warningPeerId = null;
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

    if (this.#signalingTransport.isOpen()) {
      try {
        this.#signalingTransport.send({
          v: PROTOCOL_VERSION,
          type: 'room.leave',
          roomId: this.#options.roomId,
        });
      } catch {
        // leave 중 소켓이 종료되더라도 리소스 정리는 계속되어야 한다.
      }
    }

    this.#resolveJoined = null;
    this.#signalingTransport.cancelConnect(
      new Error('Room session ended before signaling connected'),
    );
    this.#rejectJoined?.(new Error('Room session ended before joining'));
    this.#clearJoinedWait();
    this.#signalingTransport.close();
    this.#cleanupAllResources();
    this.#exhaustedPeerIds.clear();
    this.#selfId = null;
    this.#selfRole = null;
    this.#canModerateMedia = false;
    this.#participants.clear();
    this.#status = 'ended';
    this.#emit();
  }

  async selectInputDevice(kind: 'audio' | 'video', deviceId: string): Promise<boolean> {
    if (
      this.#disposed ||
      this.#status !== 'active' ||
      this.#inputChange !== null ||
      this.#screenShareStartPromise !== null ||
      this.#screenShareStopPromise !== null ||
      (kind === 'video' && this.#screenTrack !== null)
    )
      return false;

    const currentTracks = this.#liveLocalTracks(kind);
    const operation = {
      kind,
      enabled:
        currentTracks.length > 0
          ? currentTracks.some((track) => track.enabled)
          : this.#lastInputEnabled[kind],
      track: null as MediaStreamTrack | null,
    };
    this.#inputChange = operation;
    const updates: MediaSenderUpdate[] = [];
    let committed = false;
    try {
      const devices = this.#getMediaDevices();
      if (devices === undefined) return false;
      const defaults = this.#options.mediaConstraints?.[kind];
      const constraints = {
        ...(typeof defaults === 'object' ? defaults : {}),
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      };
      const acquired = await devices.getUserMedia({
        audio: false,
        video: false,
        [kind]: constraints,
      });
      const next = acquired
        .getTracks()
        .find((track) => track.kind === kind && track.readyState === 'live');
      for (const track of acquired.getTracks()) {
        if (track !== next) track.stop();
      }
      operation.track = next ?? null;
      if (next === undefined || this.#disposed) return false;
      // 모든 송신자 교체가 끝나기 전에는 새 장치의 소리·영상을 보내지 않는다.
      next.enabled = false;
      const stream =
        this.#localStream ?? (this.#options.mediaStreamFactory ?? (() => new MediaStream()))();

      for (const peer of this.#peers.values()) {
        if (!this.#isCurrentPeer(peer)) continue;
        const sender = kind === 'video' ? peer.videoSender : peer.audioSender;
        if (sender === null) {
          const added = peer.connection.addTrack(next, stream);
          if (kind === 'video') peer.videoSender = added;
          else peer.audioSender = added;
          updates.push({ peer, sender: added, previousTrack: null, added: true });
        } else {
          const previousTrack = sender.track;
          if (await this.#replacePeerTrack(peer, sender, next)) {
            updates.push({ peer, sender, previousTrack, added: false });
          }
        }
        if (this.#disposed || next.readyState === 'ended') return false;
      }

      for (const previous of stream.getTracks().filter((track) => track.kind === kind)) {
        this.#detachLocalTrackEndedListener(previous);
        stream.removeTrack(previous);
        previous.stop();
      }
      stream.addTrack(next);
      this.#localStream = stream;
      next.enabled = operation.enabled;
      committed = true;
      this.#endedInputKinds.delete(kind);
      this.#attachLocalTrackEndedListeners([next]);
      this.#syncLocalParticipantMedia();
      this.#broadcastMediaState();
      this.#emit();
      for (const update of updates) {
        if (update.added && this.#isCurrentPeer(update.peer))
          this.#requestLocalRenegotiation(update.peer);
      }
      return true;
    } catch {
      return false;
    } finally {
      if (!committed) {
        operation.track?.stop();
        const failures = await this.#rollbackSenderUpdates(updates);
        this.#recoverPeersAfterSenderFailure(
          failures,
          '장치 교체 취소',
          'media-device-sender-recovery',
        );
      }
      if (this.#inputChange === operation) this.#inputChange = null;
    }
  }

  toggleAudio(): boolean {
    const tracks = this.#liveLocalTracks('audio');
    if (tracks.length === 0) {
      return false;
    }

    const enabled = !tracks.some((track) => track.enabled);
    this.#lastInputEnabled.audio = enabled;
    if (this.#inputChange?.kind === 'audio') this.#inputChange.enabled = enabled;
    for (const track of tracks) {
      track.enabled = enabled;
    }
    this.#syncLocalParticipantMedia();
    this.#broadcastMediaState();
    this.#emit();
    return enabled;
  }

  toggleVideo(): boolean {
    if (this.#screenTrack !== null) {
      return false;
    }
    const tracks = this.#liveLocalTracks('video');
    if (tracks.length === 0) {
      return false;
    }

    const enabled = !tracks.some((track) => track.enabled);
    this.#lastInputEnabled.video = enabled;
    if (this.#inputChange?.kind === 'video') this.#inputChange.enabled = enabled;
    for (const track of tracks) {
      track.enabled = enabled;
    }
    this.#syncLocalParticipantMedia();
    this.#broadcastMediaState();
    this.#emit();
    return enabled;
  }

  startScreenShare(): Promise<ScreenShareStartResult> {
    if (
      this.#disposed ||
      this.#status !== 'active' ||
      this.#screenShareStopPromise !== null ||
      this.#inputChange !== null
    ) {
      return Promise.resolve('cancelled');
    }
    if (this.#screenShareStartPromise !== null) {
      return this.#screenShareStartPromise;
    }
    if (this.#pendingScreenTrack !== null || this.#screenTrack !== null) {
      return Promise.resolve('cancelled');
    }
    if (this.#getMediaDevices()?.getDisplayMedia === undefined) {
      return Promise.resolve('failed');
    }

    const operation = ++this.#screenShareOperation;
    const startPromise = this.#performStartScreenShare(operation).finally(() => {
      if (this.#screenShareStartPromise === startPromise) {
        this.#screenShareStartPromise = null;
      }
    });
    this.#screenShareStartPromise = startPromise;
    return startPromise;
  }

  stopScreenShare(): Promise<boolean> {
    return this.#requestScreenShareStop(false);
  }

  disableParticipantMedia(peerId: string, kind: ModeratedMediaKind): boolean {
    if (
      this.#disposed ||
      this.#status !== 'active' ||
      this.#selfId === null ||
      !this.#canModerateMedia
    ) {
      return false;
    }

    const participant = this.#participants.get(peerId);
    if (participant === undefined || participant.isLocal || participant.role !== 'participant') {
      return false;
    }

    try {
      this.#signalingTransport.sendRelay({
        v: PROTOCOL_VERSION,
        type: 'moderation.media.disable',
        roomId: this.#options.roomId,
        to: peerId,
        payload: { kind },
      });
      return true;
    } catch {
      return false;
    }
  }

  async #performStartScreenShare(operation: number): Promise<ScreenShareStartResult> {
    const mediaDevices = this.#getMediaDevices();
    if (mediaDevices?.getDisplayMedia === undefined) {
      return 'failed';
    }

    let displayStream: MediaStream;
    try {
      displayStream = await mediaDevices.getDisplayMedia(SCREEN_SHARE_CONSTRAINTS);
    } catch (error) {
      return isDisplayMediaCancellation(error) ? 'cancelled' : 'failed';
    }

    const screenTrack = displayStream.getVideoTracks().find((track) => track.readyState === 'live');
    for (const track of displayStream.getTracks()) {
      if (track !== screenTrack) {
        track.stop();
      }
    }
    if (screenTrack !== undefined) {
      preferDetailedScreenContent(screenTrack);
      this.#pendingScreenTrack = screenTrack;
    }
    if (screenTrack === undefined) {
      return 'failed';
    }
    if (!this.#ownsScreenShareStart(operation, screenTrack)) {
      screenTrack.stop();
      if (this.#pendingScreenTrack === screenTrack) {
        this.#pendingScreenTrack = null;
      }
      return 'cancelled';
    }

    let localStream = this.#localStream;
    const createdLocalStream = localStream === null;
    if (localStream === null) {
      try {
        const factory = this.#options.mediaStreamFactory ?? (() => new MediaStream());
        localStream = factory();
      } catch {
        screenTrack.stop();
        if (this.#pendingScreenTrack === screenTrack) {
          this.#pendingScreenTrack = null;
        }
        return 'failed';
      }
    }

    const cameraTracks = [...localStream.getVideoTracks()];
    const primaryCameraTrack = cameraTracks.find((track) => track.readyState === 'live') ?? null;
    const senderUpdates: MediaSenderUpdate[] = [];
    const senderFailures = new Map<PeerContext, unknown>();

    for (const peer of this.#peers.values()) {
      if (!this.#isCurrentPeer(peer)) {
        continue;
      }
      try {
        if (peer.videoSender === null) {
          const sender = peer.connection.addTrack(screenTrack, localStream);
          peer.videoSender = sender;
          senderUpdates.push({
            peer,
            sender,
            previousTrack: null,
            added: true,
          });
          continue;
        }

        const sender = peer.videoSender;
        const previousTrack = sender.track ?? primaryCameraTrack;
        if (await this.#replacePeerTrack(peer, sender, screenTrack)) {
          senderUpdates.push({ peer, sender, previousTrack, added: false });
        }
        if (!this.#ownsScreenShareStart(operation, screenTrack)) {
          break;
        }
      } catch (error) {
        senderFailures.set(peer, error);
        if (!this.#ownsScreenShareStart(operation, screenTrack)) {
          break;
        }
      }
    }

    if (!this.#ownsScreenShareStart(operation, screenTrack)) {
      screenTrack.stop();
      const rollbackFailures = await this.#rollbackSenderUpdates(senderUpdates);
      for (const [peer, error] of rollbackFailures) {
        senderFailures.set(peer, error);
      }
      if (this.#pendingScreenTrack === screenTrack) {
        this.#pendingScreenTrack = null;
      }
      this.#recoverPeersAfterSenderFailure(senderFailures, 'starting screen share');
      return 'cancelled';
    }

    for (const cameraTrack of cameraTracks) {
      localStream.removeTrack(cameraTrack);
    }
    localStream.addTrack(screenTrack);
    this.#localStream = localStream;
    this.#cameraVideoTracks = cameraTracks;
    this.#pendingScreenTrack = null;
    this.#screenTrack = screenTrack;
    this.#screenShareCreatedLocalStream = createdLocalStream;
    const endedListener: EventListener = () => {
      void this.#requestScreenShareStop(false);
    };
    this.#screenTrackEndedListener = endedListener;
    screenTrack.addEventListener('ended', endedListener);

    this.#syncLocalParticipantMedia();
    this.#broadcastMediaState();
    this.#emit();

    for (const update of senderUpdates) {
      if (!update.added || !this.#isCurrentPeer(update.peer)) {
        continue;
      }
      this.#requestLocalRenegotiation(update.peer);
    }
    this.#recoverPeersAfterSenderFailure(senderFailures, 'starting screen share');

    if (screenTrack.readyState === 'ended') {
      await this.#requestScreenShareStop(false);
      return 'cancelled';
    }
    return senderFailures.size === 0 ? 'started' : 'recovering';
  }

  async #replacePeerTrack(
    peer: PeerContext,
    sender: RTCRtpSender,
    track: MediaStreamTrack | null,
  ): Promise<boolean> {
    const replaced = await this.#waitForPeerMedia(peer, () => sender.replaceTrack(track));
    if (replaced && sender === peer.videoSender) await this.#updateVideoQuality(peer);
    return replaced;
  }

  async #waitForPeerMedia(peer: PeerContext, operation: () => Promise<void>): Promise<boolean> {
    const signal = peer.trackReplacementAbort.signal;
    let onAbort!: () => void;
    const closed = new Promise<void>((resolve) => {
      onAbort = resolve;
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      // WebKit은 연결 종료 후 replaceTrack Promise를 완료하지 않을 수 있다.
      await Promise.race([operation(), closed]);
      return this.#isCurrentPeer(peer);
    } catch (error) {
      if (this.#isCurrentPeer(peer)) throw error;
      return false;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  async #rollbackSenderUpdates(
    senderUpdates: readonly MediaSenderUpdate[],
  ): Promise<Map<PeerContext, unknown>> {
    const failures = new Map<PeerContext, unknown>();
    for (const update of [...senderUpdates].reverse()) {
      if (!this.#isCurrentPeer(update.peer)) {
        continue;
      }
      try {
        if (update.added) {
          update.peer.connection.removeTrack(update.sender);
          update.peer.pendingLocalRenegotiation = false;
          if (update.peer.videoSender === update.sender) {
            update.peer.videoSender = null;
          }
          if (update.peer.audioSender === update.sender) {
            update.peer.audioSender = null;
          }
        } else {
          await this.#replacePeerTrack(update.peer, update.sender, update.previousTrack);
        }
      } catch (error) {
        failures.set(update.peer, error);
      }
    }
    return failures;
  }

  #requestScreenShareStop(disableCamera: boolean): Promise<boolean> {
    if (this.#disposed) {
      return Promise.resolve(false);
    }
    if (this.#screenShareStopPromise !== null) {
      if (disableCamera && !this.#screenShareStopDisableCamera) {
        this.#screenShareStopDisableCamera = true;
        this.#disableCameraTracks();
      }
      return this.#screenShareStopPromise;
    }

    const screenTrack = this.#screenTrack;
    if (screenTrack === null) {
      this.#invalidatePendingScreenShareStart(disableCamera);
      return Promise.resolve(false);
    }

    const generation = ++this.#screenShareOperation;
    this.#screenShareStopTrack = screenTrack;
    this.#screenShareStopGeneration = generation;
    this.#screenShareStopDisableCamera = disableCamera;
    if (disableCamera) {
      this.#disableCameraTracks();
    }
    this.#detachScreenTrackEndedListener();
    screenTrack.stop();

    let resolveStop!: (result: boolean) => void;
    let rejectStop!: (reason: unknown) => void;
    const stopPromise = new Promise<boolean>((resolve, reject) => {
      resolveStop = resolve;
      rejectStop = reject;
    });
    const finishStop = () => {
      if (this.#screenShareStopPromise === stopPromise) {
        this.#screenShareStopPromise = null;
        this.#screenShareStopTrack = null;
        this.#screenShareStopGeneration = 0;
        this.#screenShareStopDisableCamera = false;
      }
    };
    this.#screenShareStopPromise = stopPromise;
    void this.#performStopScreenShare(screenTrack, generation).then(
      (result) => {
        finishStop();
        resolveStop(result);
      },
      (error: unknown) => {
        finishStop();
        rejectStop(error);
      },
    );
    return stopPromise;
  }

  async #performStopScreenShare(
    screenTrack: MediaStreamTrack,
    generation: number,
  ): Promise<boolean> {
    const cameraTracks = [...this.#cameraVideoTracks];
    const primaryCameraTrack = cameraTracks.find((track) => track.readyState === 'live') ?? null;
    const senderFailures = new Map<PeerContext, unknown>();

    const localStream = this.#localStream;
    localStream?.removeTrack(screenTrack);
    for (const cameraTrack of cameraTracks) {
      if (cameraTrack.readyState === 'live' && localStream !== null) {
        localStream.addTrack(cameraTrack);
      }
    }
    if (
      this.#screenShareCreatedLocalStream &&
      localStream !== null &&
      localStream.getTracks().length === 0
    ) {
      this.#localStream = null;
    }
    if (this.#screenShareStopDisableCamera) {
      this.#disableCameraTracks();
    }
    this.#syncLocalParticipantMedia();
    this.#broadcastMediaState();
    this.#emit();

    for (const peer of [...this.#peers.values()]) {
      if (!this.#ownsScreenShareStop(screenTrack, generation)) {
        return false;
      }
      if (!this.#isCurrentPeer(peer) || peer.videoSender === null) {
        continue;
      }
      try {
        await this.#replacePeerTrack(peer, peer.videoSender, primaryCameraTrack);
      } catch (error) {
        senderFailures.set(peer, error);
      }
      if (!this.#ownsScreenShareStop(screenTrack, generation)) {
        return false;
      }
    }

    if (!this.#ownsScreenShareStop(screenTrack, generation)) {
      return false;
    }
    if (this.#screenShareStopDisableCamera) {
      this.#disableCameraTracks();
    }
    this.#screenTrack = null;
    this.#cameraVideoTracks = [];
    this.#screenShareCreatedLocalStream = false;

    this.#recoverPeersAfterSenderFailure(senderFailures, 'restoring camera after screen share');
    return senderFailures.size === 0;
  }

  #ownsScreenShareStart(operation: number, screenTrack: MediaStreamTrack): boolean {
    return (
      !this.#disposed &&
      this.#status === 'active' &&
      this.#screenShareOperation === operation &&
      this.#pendingScreenTrack === screenTrack &&
      screenTrack.readyState === 'live' &&
      this.#screenTrack === null &&
      this.#screenShareStopPromise === null
    );
  }

  #ownsScreenShareStop(screenTrack: MediaStreamTrack, generation: number): boolean {
    return (
      !this.#disposed &&
      this.#screenShareOperation === generation &&
      this.#screenShareStopGeneration === generation &&
      this.#screenShareStopTrack === screenTrack &&
      this.#screenTrack === screenTrack
    );
  }

  #invalidatePendingScreenShareStart(disableCamera: boolean): boolean {
    if (this.#screenShareStartPromise === null || this.#screenTrack !== null) {
      return false;
    }
    ++this.#screenShareOperation;
    if (disableCamera) {
      this.#disableCameraTracks();
    }
    this.#pendingScreenTrack?.stop();
    return true;
  }

  #disableCameraTracks(): void {
    const cameraTracks = new Set([
      ...this.#cameraVideoTracks,
      ...(this.#localStream?.getVideoTracks() ?? []),
    ]);
    for (const track of cameraTracks) {
      if (track !== this.#screenTrack && track !== this.#pendingScreenTrack) {
        track.enabled = false;
      }
    }
  }

  #recoverPeersAfterSenderFailure(
    failures: ReadonlyMap<PeerContext, unknown>,
    phase: string,
    warningCode:
      | 'screen-share-sender-recovery'
      | 'media-device-sender-recovery' = 'screen-share-sender-recovery',
  ): void {
    if (this.#disposed || failures.size === 0) {
      return;
    }
    for (const [failedPeer, error] of failures) {
      if (!this.#isCurrentPeer(failedPeer)) {
        continue;
      }
      const shouldOffer = this.#isPeerRecoveryInitiator(failedPeer.peerId);
      let replacement: PeerContext;
      try {
        replacement = this.#replacePeer(failedPeer.peerId, false, failedPeer.connectionAttempt + 1);
      } catch (replacementError) {
        this.#failPeer(failedPeer.peerId, replacementError);
        continue;
      }
      this.#setPeerWarning(
        failedPeer.peerId,
        warningCode,
        `Recreated the connection to ${failedPeer.peerId} after ${phase} failed: ${getErrorMessage(error)}`,
      );
      if (shouldOffer) {
        void this.#createOffer(replacement.peerId).catch((offerError: unknown) => {
          if (this.#isCurrentPeer(replacement)) {
            this.#failPeer(replacement.peerId, offerError);
          }
        });
      }
    }
  }

  sendChat(text: string): ChatMessage {
    if (this.#status !== 'active' || this.#selfId === null) {
      throw new ChatSendError('room-not-active', 'Chat is only available after joining the room');
    }

    const normalizedText = text.trim();
    const messageId = (this.#options.createId ?? defaultCreateId)();
    if (
      this.#activeLocalMessageIds.has(messageId) ||
      this.#recentlyRetiredLocalMessageIds.has(messageId)
    ) {
      throw new ChatSendError(
        'message-id-conflict',
        `Chat message id ${messageId} is already in use`,
      );
    }
    const wireMessage: ChatDataMessage = {
      type: 'chat.message',
      id: messageId,
      senderId: this.#selfId,
      sentAt: this.#wallClockNow(),
      text: normalizedText,
    };
    const serializedMessage = serializePeerDataMessage(wireMessage);
    const message: ChatMessage = {
      id: wireMessage.id,
      senderId: wireMessage.senderId,
      senderName: this.#options.displayName,
      text: wireMessage.text,
      sentAt: wireMessage.sentAt,
      isLocal: true,
      deliveryState: 'pending',
    };

    const targets = this.#enqueueOutboundChat(wireMessage, serializedMessage);
    const deliveryState = this.#aggregateChatDeliveryState(targets.recipientStates);
    if (deliveryState === 'pending') {
      this.#localChatRecipientStates.set(wireMessage.id, targets.recipientStates);
    }
    const initialMessage: ChatMessage = {
      ...message,
      deliveryState,
    };
    this.#rememberMessage(initialMessage);
    for (const peer of targets.peers) {
      peer.data.flush();
    }
    this.#emit();
    return (
      this.#messages.find((candidate) => candidate.isLocal && candidate.id === message.id) ??
      initialMessage
    );
  }

  async #performJoin(): Promise<void> {
    try {
      this.#setStatus('preparing-media');
      await this.#prepareMedia();

      if (this.#disposed) {
        throw new Error('Room session ended while preparing media');
      }

      this.#setStatus('connecting-signal');
      await this.#signalingTransport.connect();

      if (this.#disposed) {
        throw new Error('Room session ended while connecting');
      }

      this.#setStatus('joining');
      await this.#joinRoom();
    } catch (error) {
      if (!this.#leaving) {
        this.#cleanupAllResources();
        this.#signalingTransport.close();
        this.#disposed = true;
        if (this.#status !== 'error') {
          const issue = this.#issueFromError(error, 'join-failed');
          this.#setFatalError(issue.code, issue.message);
        }
      }
      throw error;
    }
  }

  #getMediaDevices():
    | (Pick<MediaDevices, 'getUserMedia'> & Partial<Pick<MediaDevices, 'getDisplayMedia'>>)
    | undefined {
    return (
      this.#options.mediaDevices ??
      (typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined)
    );
  }

  #normalizeLocalVideoTracks(stream: MediaStream): void {
    const videoTracks = stream.getVideoTracks();
    const selectedTrack =
      videoTracks.find((track) => track.readyState === 'live') ?? videoTracks[0] ?? null;
    for (const track of videoTracks) {
      if (track === selectedTrack) {
        continue;
      }
      stream.removeTrack(track);
      track.stop();
    }
  }

  async #prepareMedia(): Promise<void> {
    if (this.#options.preparedMediaStream !== undefined) {
      this.#emit();
      return;
    }

    const mediaDevices = this.#getMediaDevices();

    if (mediaDevices === undefined) {
      this.#warning = {
        code: 'media-unavailable',
        message: 'Camera and microphone APIs are unavailable; joined without media.',
      };
      this.#warningPeerId = null;
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
      this.#normalizeLocalVideoTracks(stream);
      this.#localStream = stream;
      this.#attachLocalTrackEndedListeners(stream.getTracks());
    } catch (error) {
      this.#warning = {
        code: 'media-permission-denied',
        message: `Camera or microphone could not be opened; joined without media. ${getErrorMessage(error)}`,
      };
      this.#warningPeerId = null;
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
        this.#signalingTransport.sendSerialized(this.#serializedJoinMessage);
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
      const oldest = this.#staleSelfIds.values().next().value as string;
      this.#staleSelfIds.delete(oldest);
    }
  }

  #beginReconnect(reason: RoomIssue): void {
    if (this.#leaving || this.#disposed) {
      return;
    }

    this.#rememberStaleSelfId();
    this.#exhaustedPeerIds.clear();
    this.#cleanupPeerResources();
    this.#participants.clear();
    this.#remoteMediaStates.clear();
    this.#selfId = null;
    this.#selfRole = null;
    this.#canModerateMedia = false;
    this.#error = null;
    this.#warning = {
      code: 'signaling-reconnecting',
      message: reason.message,
    };
    this.#warningPeerId = null;
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

  async #performReconnect(initialFailure: RoomIssue): Promise<void> {
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
        await this.#signalingTransport.connect();
        if (this.#leaving || this.#disposed) {
          return;
        }

        const attemptSocket = this.#signalingTransport.socket;
        await this.#joinRoom();
        if (
          attemptSocket !== null &&
          this.#signalingTransport.socket === attemptSocket &&
          attemptSocket.readyState === attemptSocket.OPEN &&
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
        this.#clearJoinedWait();
        this.#signalingTransport.close(1000, 'reconnect retry');
        this.#cleanupPeerResources();
        this.#participants.clear();
        this.#remoteMediaStates.clear();
        this.#selfId = null;
        this.#selfRole = null;
        this.#canModerateMedia = false;
        this.#warning = {
          code: 'signaling-reconnecting',
          message: lastIssue.message,
        };
        this.#warningPeerId = null;
        this.#setStatus('reconnecting');
      }
    }

    this.#finishReconnectFailure({
      code: 'reconnect-exhausted',
      message: `Could not reconnect after ${this.#recoveryOptions.maxReconnectAttempts} attempts. ${lastIssue.message}`,
    });
  }

  #reconnectDelay(attempt: number): number {
    const exponential = this.#recoveryOptions.reconnectInitialDelayMs * 2 ** (attempt - 1);
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
  }

  #finishReconnectFailure(issue: RoomIssue): void {
    if (this.#leaving || this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#cancelReconnectWait();
    this.#clearJoinedWait();
    this.#signalingTransport.close(1000, 'reconnect exhausted');
    this.#cleanupAllResources();
    this.#participants.clear();
    this.#selfId = null;
    this.#selfRole = null;
    this.#canModerateMedia = false;
    if (this.#warning?.code === 'signaling-reconnecting') {
      this.#warning = null;
      this.#warningPeerId = null;
    }
    this.#setFatalError(issue.code, issue.message);
  }

  #handleSocketClose(error: SignalingTransportError, event: CloseEvent): void {
    this.#rejectJoined?.(error);
    this.#clearJoinedWait();

    if (this.#leaving || this.#disposed) {
      return;
    }
    if (event.code === SIGNALING_SESSION_SUPERSEDED_CLOSE_CODE) {
      this.#finishFatalSignalingError(
        new RoomSessionFailure('connection-superseded', SIGNALING_SESSION_SUPERSEDED_REASON),
      );
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
    try {
      switch (message.type) {
        case 'room.joined':
          await this.#handleRoomJoined(
            message.payload.peerId,
            message.payload.selfRole,
            message.payload.capabilities.canModerateMedia,
            message.payload.participants,
          );
          return;
        case 'peer.joined':
          if (this.#staleSelfIds.has(message.payload.participant.peerId)) {
            return;
          }
          this.#upsertParticipant(message.payload.participant, false);
          if (!this.#exhaustedPeerIds.has(message.payload.participant.peerId)) {
            this.#ensurePeer(message.payload.participant.peerId);
          }
          this.#emit();
          return;
        case 'rtc.offer':
          if (this.#staleSelfIds.has(message.from) || this.#exhaustedPeerIds.has(message.from)) {
            return;
          }
          await this.#handleOffer(
            message.from,
            message.payload.description,
            message.payload.negotiationId,
          );
          return;
        case 'rtc.answer':
          if (this.#staleSelfIds.has(message.from) || this.#exhaustedPeerIds.has(message.from)) {
            return;
          }
          await this.#handleAnswer(
            message.from,
            message.payload.description,
            message.payload.negotiationId,
          );
          return;
        case 'rtc.ice':
          if (this.#staleSelfIds.has(message.from) || this.#exhaustedPeerIds.has(message.from)) {
            return;
          }
          await this.#handleIce(
            message.from,
            message.payload.candidate,
            message.payload.negotiationId,
          );
          return;
        case 'moderation.media.disabled':
          await this.#handleModerationMediaDisabled(
            message.from,
            message.payload.targetPeerId,
            message.payload.kind,
          );
          return;
        case 'peer.left':
          this.#removePeer(message.payload.peerId);
          this.#staleSelfIds.delete(message.payload.peerId);
          return;
        case 'error':
          this.#handleServerError(message.payload.code, message.requestId);
          return;
      }
    } catch (error) {
      if (!this.#signalingTransport.isCurrent(socket, generation)) {
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

  async #handleRoomJoined(
    peerId: string,
    selfRole: ParticipantRole,
    canModerateMedia: boolean,
    participants: readonly Participant[],
  ): Promise<void> {
    if ((this.#status !== 'joining' && this.#status !== 'reconnecting') || this.#selfId !== null) {
      return;
    }

    this.#staleSelfIds.delete(peerId);
    this.#selfId = peerId;
    this.#selfRole = selfRole;
    this.#canModerateMedia = canModerateMedia;
    this.#upsertParticipant(
      { peerId, displayName: this.#options.displayName, role: selfRole },
      true,
    );
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
      this.#warningPeerId = null;
    }
    this.#setStatus('active');
    this.#resolveJoined?.();

    await Promise.all(offerPromises);
  }

  async #handleModerationMediaDisabled(
    fromPeerId: string,
    targetPeerId: string,
    kind: ModeratedMediaKind,
  ): Promise<void> {
    if (this.#selfId === null || targetPeerId !== this.#selfId) {
      return;
    }

    this.#moderationNoticeSequence += 1;
    this.#lastModerationNotice = {
      id: `moderation-${this.#moderationNoticeSequence.toString(36)}`,
      sequence: this.#moderationNoticeSequence,
      fromPeerId,
      kind,
    };
    this.#lastInputEnabled[kind] = false;
    if (this.#inputChange?.kind === kind) {
      this.#inputChange.enabled = false;
    }

    if (kind === 'video') {
      if (this.#invalidatePendingScreenShareStart(true)) {
        this.#syncLocalParticipantMedia();
        this.#broadcastMediaState();
        this.#emit();
        return;
      }
      if (this.#screenTrack !== null || this.#screenShareStopPromise !== null) {
        const stopPromise = this.#requestScreenShareStop(true);
        this.#syncLocalParticipantMedia();
        this.#broadcastMediaState();
        this.#emit();
        await stopPromise;
        return;
      }
      this.#disableCameraTracks();
    } else {
      for (const track of this.#liveLocalTracks('audio')) {
        track.enabled = false;
      }
    }
    this.#syncLocalParticipantMedia();
    this.#broadcastMediaState();
    this.#emit();
  }

  async #createOffer(
    peerId: string,
    options: { readonly iceRestart?: boolean } = {},
  ): Promise<boolean> {
    const peer = this.#ensurePeer(peerId);
    if (peer.makingOffer || peer.hasRemoteOffersInProgress()) {
      return false;
    }
    if (peer.connection.signalingState !== 'stable') {
      if (options.iceRestart === true) {
        this.#setPeerWarning(
          peerId,
          'peer-restart-deferred',
          `ICE restart for ${peerId} is waiting for stable signaling`,
        );
      }
      return false;
    }

    peer.makingOffer = true;
    const negotiationId = peer.startLocalNegotiation(defaultCreateId);
    peer.remoteDescriptionSet = false;
    peer.resetLocalDescription();
    if (options.iceRestart === true) {
      peer.clearPendingRemoteCandidates();
    }
    this.#setPeerConnectionStatus(peerId, 'negotiating');

    if (!peer.data.isAttached()) {
      peer.data.attach(
        peer.connection.createDataChannel(PEER_DATA_CHANNEL_LABEL, {
          ordered: true,
        }),
      );
    }

    try {
      const offer =
        options.iceRestart === true
          ? await peer.connection.createOffer({ iceRestart: true })
          : await peer.connection.createOffer();
      if (!this.#isCurrentNegotiation(peer, negotiationId)) {
        return false;
      }
      await peer.connection.setLocalDescription(offer);
      if (!this.#isCurrentNegotiation(peer, negotiationId)) {
        return false;
      }
      void this.#updateVideoQuality(peer);
      const description = peer.connection.localDescription ?? offer;
      peer.captureLocalIceUsernameFragments(description.sdp);
      this.#publishLocalDescription(peer, {
        v: PROTOCOL_VERSION,
        type: 'rtc.offer',
        roomId: this.#options.roomId,
        to: peerId,
        payload: {
          negotiationId,
          description: {
            type: 'offer',
            ...(description.sdp === undefined ? {} : { sdp: description.sdp }),
          },
        },
      });
      return true;
    } catch (error) {
      if (!this.#isCurrentNegotiation(peer, negotiationId)) {
        return false;
      }
      throw error;
    } finally {
      peer.makingOffer = false;
      this.#drainPendingLocalRenegotiation(peer);
    }
  }

  async #handleOffer(
    peerId: string,
    description: OfferDescription,
    negotiationId?: string,
  ): Promise<void> {
    const existing = this.#peers.get(peerId);
    if (existing !== undefined && !existing.canAcceptRemoteOffer(negotiationId)) {
      return;
    }
    if (existing?.connection.connectionState === 'failed' && existing.connectionAttempt > 0) {
      this.#failPeerConnectionTimeout(existing);
      return;
    }
    const peer =
      existing?.connection.connectionState === 'failed'
        ? this.#replacePeer(peerId, true, existing.connectionAttempt + 1)
        : this.#ensurePeer(peerId);
    peer.replaceNegotiationId(negotiationId ?? null);
    const acceptedNegotiationId = peer.negotiationId;
    peer.beginRemoteOffer(acceptedNegotiationId);
    try {
      peer.remoteDescriptionSet = false;
      this.#setPeerConnectionStatus(peerId, 'negotiating');
      await peer.connection.setRemoteDescription(description);
      if (!this.#isCurrentNegotiation(peer, acceptedNegotiationId)) {
        return;
      }
      peer.remoteDescriptionSet = true;
      await this.#flushPendingCandidates(peer, acceptedNegotiationId);
      if (!this.#isCurrentNegotiation(peer, acceptedNegotiationId)) {
        return;
      }

      peer.resetLocalDescription();
      const answer = await peer.connection.createAnswer();
      if (!this.#isCurrentNegotiation(peer, acceptedNegotiationId)) {
        return;
      }
      await peer.connection.setLocalDescription(answer);
      if (!this.#isCurrentNegotiation(peer, acceptedNegotiationId)) {
        return;
      }
      void this.#updateVideoQuality(peer);
      const localDescription = peer.connection.localDescription ?? answer;
      peer.captureLocalIceUsernameFragments(localDescription.sdp);
      this.#publishLocalDescription(peer, {
        v: PROTOCOL_VERSION,
        type: 'rtc.answer',
        roomId: this.#options.roomId,
        to: peerId,
        payload: {
          ...(peer.negotiationId === null ? {} : { negotiationId: peer.negotiationId }),
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
      if (!this.#isCurrentNegotiation(peer, acceptedNegotiationId)) {
        return;
      }
      throw error;
    } finally {
      peer.endRemoteOffer(acceptedNegotiationId);
      this.#drainPendingLocalRenegotiation(peer);
    }
  }

  async #handleAnswer(
    peerId: string,
    description: AnswerDescription,
    negotiationId?: string,
  ): Promise<void> {
    const peer = this.#peers.get(peerId);
    if (
      peer === undefined ||
      !peer.matchesNegotiation(negotiationId) ||
      !peer.localDescriptionPublished ||
      peer.connection.signalingState !== 'have-local-offer'
    ) {
      return;
    }
    const acceptedNegotiationId = peer.negotiationId;
    try {
      await peer.connection.setRemoteDescription(description);
      if (!this.#isCurrentNegotiation(peer, acceptedNegotiationId)) {
        return;
      }
      peer.remoteDescriptionSet = true;
      await this.#flushPendingCandidates(peer, acceptedNegotiationId);
      if (!this.#isCurrentNegotiation(peer, acceptedNegotiationId)) {
        return;
      }
      if (peer.connection.connectionState === 'connected') {
        this.#finishPeerRecovery(peer);
      }
      void this.#updateVideoQuality(peer);
      this.#drainPendingLocalRenegotiation(peer);
    } catch (error) {
      if (!this.#isCurrentNegotiation(peer, acceptedNegotiationId)) {
        return;
      }
      throw error;
    }
  }

  async #handleIce(
    peerId: string,
    candidate: SerializedIceCandidate | null,
    negotiationId?: string,
  ): Promise<void> {
    const peer = this.#ensurePeer(peerId);
    if (!peer.adoptOrMatchCandidateNegotiation(negotiationId)) {
      return;
    }
    const acceptedNegotiationId = peer.negotiationId;
    if (peer.connection.connectionState === 'failed' || !peer.remoteDescriptionSet) {
      if (peer.queueRemoteCandidate(candidate, MAX_PENDING_REMOTE_ICE_CANDIDATES)) {
        this.#setPeerWarning(
          peer.peerId,
          'ice-candidate-queue-overflow',
          `Oldest pending ICE candidate for ${peer.peerId} was discarded`,
        );
      }
      return;
    }

    await this.#addIceCandidate(peer, candidate, acceptedNegotiationId);
  }

  async #flushPendingCandidates(peer: PeerContext, negotiationId: string | null): Promise<void> {
    const candidates = peer.takePendingRemoteCandidates();
    for (const candidate of candidates) {
      if (!this.#isCurrentNegotiation(peer, negotiationId)) {
        return;
      }
      await this.#addIceCandidate(peer, candidate, negotiationId);
    }
  }

  async #addIceCandidate(
    peer: PeerContext,
    candidate: SerializedIceCandidate | null,
    negotiationId: string | null,
  ): Promise<void> {
    try {
      await peer.connection.addIceCandidate(candidate);
    } catch (error) {
      if (this.#isCurrentNegotiation(peer, negotiationId)) {
        this.#setPeerWarning(
          peer.peerId,
          'ice-candidate-rejected',
          `Ignored an ICE candidate for ${peer.peerId}: ${getErrorMessage(error)}`,
        );
      }
    }
  }

  #publishLocalDescription(peer: PeerContext, message: RelayClientMessage): void {
    if (!this.#isCurrentPeer(peer)) {
      return;
    }
    this.#signalingTransport.sendRelay(message);
    const candidates = peer.publishLocalDescription();
    for (const candidate of candidates) {
      this.#sendLocalCandidate(peer, candidate);
    }
  }

  #sendLocalCandidate(peer: PeerContext, candidate: SerializedIceCandidate | null): void {
    if (
      !this.#isCurrentPeer(peer) ||
      !peer.candidateMatchesCurrentLocalNegotiation(candidate) ||
      !this.#signalingTransport.isOpen() ||
      this.#status === 'reconnecting'
    ) {
      return;
    }
    this.#signalingTransport.sendRelay({
      v: PROTOCOL_VERSION,
      type: 'rtc.ice',
      roomId: this.#options.roomId,
      to: peer.peerId,
      payload: {
        ...(peer.negotiationId === null ? {} : { negotiationId: peer.negotiationId }),
        candidate,
      },
    });
  }

  #createPeerDataChannel(peerId: string): PeerDataChannel {
    let dataChannel!: PeerDataChannel;
    dataChannel = new PeerDataChannel({
      peerId,
      isCurrent: () => this.#peers.get(peerId)?.data === dataChannel,
      isRecovering: () => this.#peers.get(peerId)?.recovering ?? true,
      monotonicNow: () => this.#monotonicNow(),
      currentMediaState: () => this.#currentMediaDataMessage(),
      onOpen: () => {
        const peer = this.#peers.get(peerId);
        if (peer?.data === dataChannel) {
          this.#handleDataChannelOpen(peer);
        }
      },
      canReceiveChat: () => this.#participants.has(peerId),
      onChatMessage: (message) => {
        const participant = this.#participants.get(peerId);
        if (participant === undefined) {
          return;
        }
        this.#rememberMessage({
          id: message.id,
          senderId: peerId,
          senderName: participant.displayName,
          text: message.text,
          sentAt: message.sentAt,
          isLocal: false,
          deliveryState: 'received',
        });
        this.#emit();
      },
      onMediaState: (message) => {
        const participant = this.#participants.get(peerId);
        if (participant === undefined) {
          return;
        }
        this.#remoteMediaStates.set(peerId, message);
        participant.audioEnabled = message.audioEnabled;
        participant.videoEnabled = message.videoEnabled;
        participant.videoSource = message.videoSource;
        this.#emit();
      },
      onChatAcknowledged: (messageId) =>
        this.#markLocalChatRecipientState(messageId, peerId, 'acknowledged'),
      onChatFailed: (messageId) => this.#markLocalChatRecipientState(messageId, peerId, 'failed'),
      onRateLimited: () => {
        if (this.#warning === null) {
          this.#setPeerWarning(
            peerId,
            'data-channel-rate-limit',
            `Ignored excessive DataChannel messages from ${peerId}`,
          );
        }
      },
      onRecoveryRequired: (code, message) => {
        const peer = this.#peers.get(peerId);
        if (peer?.data !== dataChannel) {
          return;
        }
        this.#setPeerWarning(peerId, code, message);
        this.#beginPeerRecovery(peer);
      },
      clearWarning: (codes) => this.#clearPeerWarning(peerId, codes),
      onStateChanged: () => this.#emit(),
    });
    return dataChannel;
  }

  #ensurePeer(
    peerId: string,
    connectionAttempt = 0,
    retiredNegotiationIds: ReadonlySet<string> = new Set(),
    dataChannel?: PeerDataChannel,
  ): PeerContext {
    const existing = this.#peers.get(peerId);
    if (existing !== undefined) {
      return existing;
    }

    if (!this.#participants.has(peerId)) {
      this.#upsertParticipant(
        {
          peerId,
          displayName: `Participant ${peerId.slice(0, 6)}`,
          role: 'participant',
        },
        false,
      );
    }

    const factory =
      this.#options.peerConnectionFactory ??
      ((configuration: RTCConfiguration | undefined) => new RTCPeerConnection(configuration));
    const connection = factory(snapshotRtcConfiguration(this.#rtcConfiguration));
    const peer = new PeerConnectionLifecycle(
      peerId,
      connection,
      dataChannel ?? this.#createPeerDataChannel(peerId),
      connectionAttempt,
      retiredNegotiationIds,
    );
    this.#peers.set(peerId, peer);

    for (const track of this.#localStream?.getTracks() ?? []) {
      const sender = connection.addTrack(track, this.#localStream as MediaStream);
      if (track.kind === 'video') {
        peer.videoSender = sender;
      } else if (track.kind === 'audio') {
        peer.audioSender = sender;
      }
    }

    connection.onicecandidate = (event) => {
      if (!this.#isCurrentPeer(peer) || !this.#signalingTransport.isOpen()) {
        return;
      }
      const candidate =
        event.candidate === null ? null : (event.candidate.toJSON() as SerializedIceCandidate);
      if (!peer.localDescriptionPublished) {
        peer.queueLocalCandidate(candidate);
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
      const channel = event.channel;
      if (
        !this.#isCurrentPeer(peer) ||
        channel.label !== PEER_DATA_CHANNEL_LABEL ||
        channel.ordered !== true ||
        channel.maxRetransmits !== null ||
        channel.maxPacketLifeTime !== null
      ) {
        channel.close();
        return;
      }
      peer.data.attach(channel);
    };

    connection.onsignalingstatechange = () => {
      if (this.#isCurrentPeer(peer)) {
        this.#drainPendingLocalRenegotiation(peer);
      }
    };

    connection.onconnectionstatechange = () => {
      if (!this.#isCurrentPeer(peer)) {
        return;
      }
      const status = connection.connectionState;
      this.#setPeerConnectionStatus(peerId, status);
      switch (status) {
        case 'connected':
          this.#finishPeerRecovery(peer);
          return;
        case 'disconnected':
          this.#scheduleDisconnectedRecovery(peer);
          return;
        case 'failed':
          peer.cancelTimer('disconnected');
          this.#beginPeerRecovery(peer);
          return;
        case 'closed':
          this.#cleanupPeer(peerId, false);
          this.#emit();
          return;
      }
    };

    this.#schedulePeerConnectionTimeout(peer);
    return peer;
  }

  #isCurrentPeer(peer: PeerContext): boolean {
    return !peer.closed && this.#peers.get(peer.peerId) === peer;
  }

  #isCurrentNegotiation(peer: PeerContext, negotiationId: string | null): boolean {
    return this.#isCurrentPeer(peer) && peer.negotiationId === negotiationId;
  }

  #isPeerRecoveryInitiator(peerId: string): boolean {
    return this.#selfId !== null && this.#selfId < peerId;
  }

  #requestLocalRenegotiation(peer: PeerContext): void {
    if (!this.#isCurrentPeer(peer)) {
      return;
    }
    peer.pendingLocalRenegotiation = true;
    this.#drainPendingLocalRenegotiation(peer);
  }

  #drainPendingLocalRenegotiation(peer: PeerContext): void {
    if (
      !this.#isCurrentPeer(peer) ||
      !peer.pendingLocalRenegotiation ||
      this.#disposed ||
      this.#status !== 'active' ||
      !this.#signalingTransport.isOpen() ||
      peer.makingOffer ||
      peer.hasRemoteOffersInProgress() ||
      peer.connection.signalingState !== 'stable'
    ) {
      return;
    }

    peer.pendingLocalRenegotiation = false;
    void this.#createOffer(peer.peerId)
      .then((published) => {
        if (!published && this.#isCurrentPeer(peer)) {
          peer.pendingLocalRenegotiation = true;
        }
      })
      .catch((error: unknown) => {
        if (this.#isCurrentPeer(peer)) {
          this.#scheduleInitialOfferRetry(peer.peerId, error);
        }
      });
  }

  #scheduleInitialOfferRetry(peerId: string, error: unknown): void {
    const peer = this.#peers.get(peerId);
    if (
      peer === undefined ||
      !this.#isCurrentPeer(peer) ||
      this.#disposed ||
      peer.hasTimer('offer-retry') ||
      peer.hasTimer('recovery')
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
    this.#setPeerWarning(
      peerId,
      'peer-negotiation-retrying',
      `Initial connection to ${peerId} failed; retry ${retryAttempt}/${this.#recoveryOptions.maxReconnectAttempts} is scheduled: ${getErrorMessage(error)}`,
    );
    peer.scheduleTimer('offer-retry', this.#reconnectDelay(retryAttempt), () => {
      if (!this.#isCurrentPeer(peer) || this.#status !== 'active') {
        return;
      }

      let retryPeer = peer;
      if (peer.connection.connectionState === 'failed') {
        try {
          retryPeer = this.#replacePeer(peer.peerId, true, peer.connectionAttempt + 1);
        } catch (replacementError) {
          this.#failPeer(peer.peerId, replacementError);
          return;
        }
      }
      void this.#createOffer(retryPeer.peerId)
        .then((offerPublished) => {
          if (!offerPublished) {
            return;
          }
          if (this.#isCurrentPeer(retryPeer) && !retryPeer.hasTimer('recovery')) {
            retryPeer.offerRetryAttempts = 0;
            if (this.#clearPeerWarning(retryPeer.peerId, ['peer-negotiation-retrying'])) {
              this.#emit();
            }
          }
        })
        .catch((retryError: unknown) => {
          if (this.#isCurrentPeer(retryPeer)) {
            this.#scheduleInitialOfferRetry(retryPeer.peerId, retryError);
          }
        });
    });
  }

  #schedulePeerConnectionTimeout(peer: PeerContext): void {
    if (!this.#isCurrentPeer(peer) || peer.hasTimer('connection')) {
      return;
    }

    peer.scheduleTimer('connection', this.#recoveryOptions.peerConnectionTimeoutMs, () => {
      if (!this.#isCurrentPeer(peer) || this.#status !== 'active') {
        return;
      }
      if (peer.connection.connectionState === 'connected' && peer.data.isOpen()) {
        this.#finishPeerRecovery(peer);
        return;
      }

      if (peer.connectionAttempt > 0) {
        this.#failPeerConnectionTimeout(peer);
        return;
      }

      this.#setPeerWarning(
        peer.peerId,
        'peer-connection-recovering',
        `Connection to ${peer.peerId} did not complete within ${this.#recoveryOptions.peerConnectionTimeoutMs}ms; attempting ICE recovery`,
      );
      this.#beginPeerRecovery(peer);
    });
  }

  #scheduleDisconnectedRecovery(peer: PeerContext): void {
    if (!this.#isCurrentPeer(peer) || peer.hasTimer('disconnected')) {
      return;
    }
    peer.recovering = true;
    peer.scheduleTimer('disconnected', this.#recoveryOptions.peerDisconnectedGraceMs, () => {
      if (
        !this.#isCurrentPeer(peer) ||
        (peer.connection.connectionState !== 'disconnected' &&
          peer.connection.connectionState !== 'failed')
      ) {
        return;
      }
      this.#beginPeerRecovery(peer);
    });
  }

  #beginPeerRecovery(peer: PeerContext): void {
    if (!this.#isCurrentPeer(peer) || this.#status !== 'active' || this.#selfId === null) {
      return;
    }
    peer.cancelTimer('offer-retry');
    if (peer.hasTimer('recovery')) {
      return;
    }

    peer.recovering = true;
    if (peer.connectionAttempt > 0) {
      return;
    }
    peer.scheduleTimer('recovery', this.#recoveryOptions.peerRecoveryTimeoutMs, () => {
      if (!this.#isCurrentPeer(peer)) {
        return;
      }
      if (peer.connection.connectionState === 'connected' && peer.data.isOpen()) {
        this.#finishPeerRecovery(peer);
        return;
      }

      const shouldOffer = this.#isPeerRecoveryInitiator(peer.peerId);
      let replacement: PeerContext;
      try {
        replacement = this.#replacePeer(peer.peerId, false, peer.connectionAttempt + 1);
      } catch (replacementError) {
        this.#failPeer(peer.peerId, replacementError);
        return;
      }
      this.#setPeerWarning(
        peer.peerId,
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
    });

    if (!this.#isPeerRecoveryInitiator(peer.peerId)) {
      return;
    }
    void this.#createOffer(peer.peerId, { iceRestart: true }).catch((error: unknown) => {
      if (this.#isCurrentPeer(peer)) {
        this.#setPeerWarning(
          peer.peerId,
          'peer-ice-restart-failed',
          `ICE restart for ${peer.peerId} failed: ${getErrorMessage(error)}`,
        );
      }
    });
  }

  #finishPeerRecovery(peer: PeerContext): void {
    if (peer.connection.connectionState !== 'connected' || !peer.data.isOpen()) {
      return;
    }
    const shouldFlush = peer.hasRecoveryActivity();
    const participant = this.#participants.get(peer.peerId);
    const restoredConnectedState =
      peer.connection.connectionState === 'connected' &&
      participant !== undefined &&
      participant.connectionState !== 'connected';
    if (restoredConnectedState) {
      participant.connectionState = 'connected';
    }
    peer.cancelAllTimers();
    peer.offerRetryAttempts = 0;
    peer.connectionAttempt = 0;
    peer.recovering = false;
    const warningCleared =
      this.#clearPeerWarning(peer.peerId, [
        'peer-connection-recovering',
        'peer-connection-recreated',
        'peer-ice-restart-failed',
        'peer-restart-deferred',
        'peer-negotiation-retrying',
        'screen-share-sender-recovery',
        'media-device-sender-recovery',
        'ice-candidate-queue-overflow',
        'ice-candidate-rejected',
      ]) || peer.data.clearRecoveryWarning();
    if (shouldFlush) {
      peer.data.flush(true);
    }
    if (restoredConnectedState || warningCleared) {
      this.#emit();
    }
  }

  #replacePeer(
    peerId: string,
    preservePendingCandidates: boolean,
    connectionAttempt: number,
  ): PeerContext {
    const existing = this.#peers.get(peerId);
    const dataChannel = existing?.data;
    const pendingCandidates =
      preservePendingCandidates && existing !== undefined
        ? existing.extractPendingRemoteCandidates()
        : { candidates: [], overflowWarned: false };
    const offerRetryAttempts = existing?.offerRetryAttempts ?? 0;
    if (existing !== undefined) {
      existing.rememberCurrentNegotiation();
    }
    const retiredNegotiationIds = existing?.retiredNegotiationIdsSnapshot() ?? new Set<string>();

    if (existing !== undefined) {
      existing.data.detach();
      this.#disposePeerContext(existing);
      this.#peers.delete(peerId);
      this.#clearResolvedVideoQualityWarning();
    }
    this.#stopRemoteStream(peerId);

    const participant = this.#participants.get(peerId);
    if (participant !== undefined) {
      participant.connectionState = 'connecting';
      const semanticMedia = this.#remoteMediaStates.get(peerId);
      participant.audioEnabled = semanticMedia?.audioEnabled ?? false;
      participant.videoEnabled = semanticMedia?.videoEnabled ?? false;
      participant.videoSource = semanticMedia?.videoSource ?? participant.videoSource;
    }

    let replacement: PeerContext;
    try {
      replacement = this.#ensurePeer(peerId, connectionAttempt, retiredNegotiationIds, dataChannel);
    } catch (error) {
      dataChannel?.dispose();
      throw error;
    }
    replacement.recovering = true;
    replacement.restorePendingRemoteCandidates(pendingCandidates);
    replacement.offerRetryAttempts = offerRetryAttempts;
    this.#emit();
    return replacement;
  }

  #handleDataChannelOpen(peer: PeerContext): void {
    if (!this.#isCurrentPeer(peer) || !peer.data.isOpen()) {
      return;
    }
    if (peer.connection.connectionState === 'connected') {
      this.#finishPeerRecovery(peer);
      return;
    }
    const warningCleared = peer.data.clearRecoveryWarning();
    if (warningCleared) {
      this.#emit();
    }
    peer.data.flush(true);
  }

  #currentMediaDataMessage(): ParticipantMediaDataMessage {
    const media = this.#getLocalMediaSnapshot();
    return {
      type: 'participant.media',
      audioEnabled: media.audioEnabled,
      videoEnabled: media.videoEnabled,
      videoSource: media.videoSource,
    };
  }

  #broadcastMediaState(): void {
    const message = this.#currentMediaDataMessage();
    for (const peer of this.#peers.values()) {
      if (!this.#isCurrentPeer(peer)) {
        continue;
      }
      peer.data.publishMediaState(message);
    }
  }

  #enqueueOutboundChat(message: ChatDataMessage, serializedMessage: string): OutboundChatTargets {
    const peers = [...this.#peers.values()].filter((peer) => this.#isCurrentPeer(peer));
    const peersById = new Map(peers.map((peer) => [peer.peerId, peer]));
    const recipientIds = [...this.#participants.values()]
      .filter((participant) => !participant.isLocal)
      .map((participant) => participant.peerId);
    const targetPeers = recipientIds.flatMap((peerId) => {
      const peer = peersById.get(peerId);
      return peer === undefined ? [] : [peer];
    });
    if (recipientIds.length > 0 && targetPeers.length === 0) {
      throw new ChatSendError(
        'peer-unavailable',
        `Chat delivery to ${recipientIds[0]} is unavailable while the peer connection is failed`,
      );
    }
    const saturatedPeer = targetPeers.find((peer) => !peer.data.hasQueueCapacity());
    if (saturatedPeer !== undefined) {
      throw new ChatSendError(
        'queue-full',
        `Chat delivery queue for ${saturatedPeer.peerId} is full`,
      );
    }

    for (const peer of targetPeers) {
      peer.data.enqueueChat(message, serializedMessage);
    }
    return {
      peers: targetPeers,
      recipientStates: new Map(
        recipientIds.map((peerId) => [
          peerId,
          peersById.has(peerId) ? ('pending' as const) : ('failed' as const),
        ]),
      ),
    };
  }

  #markLocalChatRecipientState(
    messageId: string,
    peerId: string,
    state: Exclude<ChatRecipientDeliveryState, 'pending'>,
  ): boolean {
    const recipientStates = this.#localChatRecipientStates.get(messageId);
    if (recipientStates?.get(peerId) !== 'pending') {
      return false;
    }

    recipientStates.set(peerId, state);
    return this.#syncLocalChatDeliveryState(messageId, recipientStates);
  }

  #syncLocalChatDeliveryState(
    messageId: string,
    recipientStates: ReadonlyMap<string, ChatRecipientDeliveryState>,
  ): boolean {
    const index = this.#messages.findIndex(
      (message) => message.id === messageId && message.isLocal,
    );
    const deliveryState = this.#aggregateChatDeliveryState(recipientStates);
    if (deliveryState !== 'pending') {
      this.#localChatRecipientStates.delete(messageId);
      this.#retireLocalMessageIdIfUnused(messageId);
    }
    if (index < 0) {
      return false;
    }
    const message = this.#messages[index]!;
    if (message.deliveryState === deliveryState) {
      return false;
    }
    this.#messages[index] = { ...message, deliveryState };
    return true;
  }

  #aggregateChatDeliveryState(
    recipientStates: ReadonlyMap<string, ChatRecipientDeliveryState>,
  ): Exclude<ChatDeliveryState, 'received'> {
    let sentCount = 0;
    let failedCount = 0;
    for (const state of recipientStates.values()) {
      if (state === 'pending') {
        return 'pending';
      }
      if (state === 'acknowledged') {
        sentCount += 1;
      } else {
        failedCount += 1;
      }
    }

    if (failedCount === 0) {
      return 'sent';
    }
    return sentCount === 0 ? 'failed' : 'partial';
  }

  #rememberMessage(message: ChatMessage): void {
    if (message.isLocal) {
      this.#activeLocalMessageIds.add(message.id);
    }
    this.#messages.push(message);

    const maxMessages = this.#options.maxChatMessages ?? 200;
    while (this.#messages.length > maxMessages) {
      const removed = this.#messages.shift() as ChatMessage;
      if (removed.isLocal) {
        this.#retireLocalMessageIdIfUnused(removed.id);
      }
    }
  }

  #retireLocalMessageIdIfUnused(messageId: string): void {
    if (
      !this.#activeLocalMessageIds.has(messageId) ||
      this.#localChatRecipientStates.has(messageId) ||
      this.#messages.some((message) => message.isLocal && message.id === messageId)
    ) {
      return;
    }

    this.#activeLocalMessageIds.delete(messageId);
    this.#recentlyRetiredLocalMessageIds.add(messageId);
    while (this.#recentlyRetiredLocalMessageIds.size > MAX_RECENTLY_RETIRED_LOCAL_CHAT_IDS) {
      const oldest = this.#recentlyRetiredLocalMessageIds.values().next().value as string;
      this.#recentlyRetiredLocalMessageIds.delete(oldest);
    }
  }

  #upsertParticipant(participant: Participant, isLocal: boolean): void {
    const existing = this.#participants.get(participant.peerId);
    if (existing !== undefined) {
      existing.displayName = participant.displayName;
      existing.role = participant.role;
      existing.isLocal = isLocal;
      return;
    }

    this.#participants.set(participant.peerId, {
      peerId: participant.peerId,
      displayName: participant.displayName,
      role: participant.role,
      isLocal,
      connectionState: isLocal ? 'connected' : 'new',
      audioEnabled: false,
      videoEnabled: false,
      videoSource: 'camera',
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
    participant.videoSource = media.videoSource;
  }

  #syncRemoteParticipantTracks(peerId: string, stream: MediaStream): void {
    const participant = this.#participants.get(peerId);
    if (participant === undefined) {
      return;
    }
    const semanticMedia = this.#remoteMediaStates.get(peerId);
    if (semanticMedia !== undefined) {
      participant.audioEnabled = semanticMedia.audioEnabled;
      participant.videoEnabled = semanticMedia.videoEnabled;
      participant.videoSource = semanticMedia.videoSource;
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
    this.#exhaustedPeerIds.add(peerId);
    this.#setPeerConnectionStatus(peerId, 'failed');
    this.#cleanupPeer(peerId, false);
    this.#setPeerWarning(
      peerId,
      'peer-negotiation-failed',
      `Connection to ${peerId} failed: ${getErrorMessage(error)}`,
    );
  }

  #failPeerConnectionTimeout(peer: PeerContext): void {
    if (!this.#isCurrentPeer(peer)) {
      return;
    }

    const peerId = peer.peerId;
    this.#exhaustedPeerIds.add(peerId);
    this.#setPeerConnectionStatus(peerId, 'failed');
    this.#cleanupPeer(peerId, false);
    this.#setPeerWarning(
      peerId,
      'peer-connection-timeout',
      `Could not connect to ${peerId} after retrying. Check your network, then reconnect to the room or leave.`,
    );
  }

  #removePeer(peerId: string): void {
    this.#exhaustedPeerIds.delete(peerId);
    this.#cleanupPeer(peerId, true);
    this.#clearPeerWarning(peerId);
    this.#emit();
  }

  #cleanupPeer(peerId: string, removeParticipant: boolean): void {
    this.#signalingTransport.purgeRequestsForPeer(peerId);
    const peer = this.#peers.get(peerId);
    if (peer !== undefined) {
      peer.data.dispose();
      this.#disposePeerContext(peer);
      this.#peers.delete(peerId);
      this.#clearResolvedVideoQualityWarning();
    }

    this.#stopRemoteStream(peerId);
    if (removeParticipant) {
      this.#participants.delete(peerId);
      this.#remoteMediaStates.delete(peerId);
    }
  }

  #disposePeerContext(peer: PeerContext): void {
    peer.disposeConnection();
  }

  #stopRemoteStream(peerId: string): void {
    const remoteStream = this.#remoteStreams.get(peerId);
    for (const track of remoteStream?.getTracks() ?? []) {
      track.stop();
    }
    this.#remoteStreams.delete(peerId);
  }

  #cleanupPeerResources(): void {
    for (const peerId of [...this.#peers.keys()]) {
      this.#cleanupPeer(peerId, false);
      this.#clearPeerWarning(peerId);
    }
    this.#remoteStreams.clear();
  }

  #cleanupAllResources(): void {
    ++this.#screenShareOperation;
    this.#inputChange?.track?.stop();
    this.#inputChange = null;
    this.#signalingTransport.clearPendingRequests();
    this.#cleanupPeerResources();
    this.#remoteMediaStates.clear();

    this.#detachLocalTrackEndedListeners();
    this.#detachScreenTrackEndedListener();
    const ownedTracks = new Set([
      ...(this.#localStream?.getTracks() ?? []),
      ...this.#cameraVideoTracks,
      ...(this.#pendingScreenTrack === null ? [] : [this.#pendingScreenTrack]),
      ...(this.#screenTrack === null ? [] : [this.#screenTrack]),
    ]);
    for (const track of ownedTracks) {
      track.stop();
    }
    this.#localStream = null;
    this.#cameraVideoTracks = [];
    this.#pendingScreenTrack = null;
    this.#screenTrack = null;
    this.#screenShareCreatedLocalStream = false;
    this.#screenShareStopTrack = null;
    this.#screenShareStopGeneration = 0;
    this.#screenShareStopDisableCamera = false;
    this.#endedInputKinds.clear();
  }

  #attachLocalTrackEndedListeners(tracks: readonly MediaStreamTrack[]): void {
    for (const track of [...tracks]) {
      if (this.#localTrackEndedListeners.has(track)) {
        continue;
      }
      this.#lastInputEnabled[track.kind === 'audio' ? 'audio' : 'video'] = track.enabled;
      const listener: EventListener = () => {
        this.#handleLocalTrackEnded(track);
      };
      this.#localTrackEndedListeners.set(track, listener);
      track.addEventListener('ended', listener);
      if (track.readyState === 'ended') {
        this.#handleLocalTrackEnded(track);
      }
    }
  }

  #handleLocalTrackEnded(track: MediaStreamTrack): void {
    const stream = this.#localStream;
    if (this.#disposed || stream === null || !this.#localTrackEndedListeners.has(track)) {
      this.#detachLocalTrackEndedListener(track);
      return;
    }

    this.#detachLocalTrackEndedListener(track);
    this.#endedInputKinds.add(track.kind === 'audio' ? 'audio' : 'video');
    const retainedCameraIndex = this.#cameraVideoTracks.indexOf(track);
    if (retainedCameraIndex >= 0) {
      this.#cameraVideoTracks.splice(retainedCameraIndex, 1);
    }
    stream.removeTrack(track);
    this.#syncLocalParticipantMedia();
    this.#broadcastMediaState();
    this.#emit();
  }

  #detachLocalTrackEndedListener(track: MediaStreamTrack): void {
    const listener = this.#localTrackEndedListeners.get(track);
    if (listener === undefined) {
      return;
    }
    track.removeEventListener('ended', listener);
    this.#localTrackEndedListeners.delete(track);
  }

  #detachLocalTrackEndedListeners(): void {
    for (const track of [...this.#localTrackEndedListeners.keys()]) {
      this.#detachLocalTrackEndedListener(track);
    }
  }

  #detachScreenTrackEndedListener(): void {
    if (this.#screenTrack !== null && this.#screenTrackEndedListener !== null) {
      this.#screenTrack.removeEventListener('ended', this.#screenTrackEndedListener);
    }
    this.#screenTrackEndedListener = null;
  }

  #handleServerError(code: SignalingErrorCode, requestId: string | undefined): void {
    const error = new RoomSessionFailure(code, safeSignalingErrorMessage(code));
    if (this.#rejectJoined !== null) {
      this.#rejectJoined(error);
      return;
    }

    if (this.#status !== 'active') {
      return;
    }

    const request =
      requestId === undefined ? null : this.#signalingTransport.takePendingRequest(requestId);

    switch (code) {
      case 'TARGET_NOT_FOUND': {
        if (request !== null) {
          this.#removePeer(request.peerId);
        }
        return;
      }
      case 'TARGET_SELF': {
        if (request !== null) {
          this.#signalingTransport.close(1000, 'signaling identity mismatch');
          this.#beginReconnect(error);
        }
        return;
      }
      case 'NOT_IN_ROOM':
      case 'ROOM_MISMATCH':
        this.#signalingTransport.close(1000, 'signaling state mismatch');
        this.#beginReconnect(error);
        return;
      case 'ALREADY_JOINED':
      case 'ROOM_FULL':
        return;
      case 'INVALID_MESSAGE':
        this.#finishFatalSignalingError(error);
        return;
      case 'FORBIDDEN':
      case 'INTERNAL_ERROR':
        if (this.#warning === null || this.#warning.code === code) {
          this.#setWarning(code, error.message);
        }
        return;
    }
  }

  #finishFatalSignalingError(error: RoomSessionFailure): void {
    if (this.#leaving || this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#cancelReconnectWait();
    this.#clearJoinedWait();
    this.#signalingTransport.close(1000, 'fatal signaling error');
    this.#cleanupAllResources();
    this.#exhaustedPeerIds.clear();
    this.#participants.clear();
    this.#selfId = null;
    this.#selfRole = null;
    this.#canModerateMedia = false;
    this.#warning = null;
    this.#warningPeerId = null;
    this.#setFatalError(error.code, error.message);
  }

  #setStatus(status: RoomSessionStatus): void {
    this.#status = status;
    this.#emit();
  }

  #setWarning(code: RoomIssueCode, message: string): void {
    this.#warningPeerId = null;
    this.#warning = { code, message };
    this.#emit();
  }

  #setPeerWarning(peerId: string, code: RoomIssueCode, message: string): void {
    this.#warningPeerId = peerId;
    this.#warning = { code, message };
    this.#emit();
  }

  #clearPeerWarning(peerId: string, codes?: readonly RoomIssueCode[]): boolean {
    if (
      this.#warningPeerId !== peerId ||
      this.#warning === null ||
      (codes !== undefined && !codes.includes(this.#warning.code))
    ) {
      return false;
    }
    this.#warning = null;
    this.#warningPeerId = null;
    return true;
  }

  #setFatalError(code: RoomIssueCode, message: string): void {
    this.#error = { code, message };
    this.#status = 'error';
    this.#emit();
  }

  #issueFromError(error: unknown, fallbackCode: RoomIssueCode): RoomIssue {
    if (error instanceof RoomSessionFailure || error instanceof SignalingTransportError) {
      return { code: error.code, message: error.message };
    }
    return { code: fallbackCode, message: getErrorMessage(error) };
  }

  #getLocalMediaSnapshot(): LocalMediaSnapshot {
    const audioTracks = this.#liveLocalTracks('audio');
    const videoTracks = this.#liveLocalTracks('video');
    const screenSharing = this.#screenTrack !== null && this.#screenTrack.readyState === 'live';
    return {
      audioAvailable: audioTracks.length > 0,
      audioEnabled: audioTracks.some((track) => track.enabled),
      videoAvailable: videoTracks.length > 0,
      videoEnabled: videoTracks.some((track) => track.enabled),
      videoSource: screenSharing ? 'screen' : 'camera',
    };
  }

  #liveLocalTracks(kind: 'audio' | 'video'): MediaStreamTrack[] {
    const tracks =
      kind === 'audio'
        ? (this.#localStream?.getAudioTracks() ?? [])
        : (this.#localStream?.getVideoTracks() ?? []);
    return tracks.filter((track) => track.readyState === 'live');
  }

  #buildSnapshot(): RoomSessionSnapshot {
    return {
      roomId: this.#options.roomId,
      status: this.#status,
      selfId: this.#selfId,
      selfRole: this.#selfRole,
      canModerateMedia: this.#canModerateMedia,
      screenShareAvailable: this.#getMediaDevices()?.getDisplayMedia !== undefined,
      screenSharing: this.#screenTrack !== null && this.#screenTrack.readyState === 'live',
      videoQualityMode: this.#videoQualityMode,
      participants: [...this.#participants.values()].map((participant) => ({
        ...participant,
      })),
      localMedia: this.#getLocalMediaSnapshot(),
      messages: this.#messages.map((message) => ({ ...message })),
      lastModerationNotice:
        this.#lastModerationNotice === null ? null : { ...this.#lastModerationNotice },
      warning:
        this.#warning !== null
          ? { ...this.#warning }
          : this.#endedInputKinds.size > 0
            ? {
                code: 'local-media-ended',
                message: '마이크 또는 카메라 연결이 종료되었습니다.',
              }
            : null,
      error: this.#error === null ? null : { ...this.#error },
    };
  }

  #emit(): void {
    this.#snapshot = this.#buildSnapshot();
    for (const listener of [...this.#listeners]) {
      listener(this.#snapshot);
    }
  }

  #wallClockNow(): number {
    return this.#options.wallClockNow?.() ?? Date.now();
  }

  #monotonicNow(): number {
    return this.#options.monotonicNow?.() ?? globalThis.performance.now();
  }
}
