import { ParticipantMonitor, type ParticipantActivity } from './participant-monitor.js';
import {
  PROTOCOL_VERSION,
  serializeClientMessage,
  serializePeerDataMessage,
  type ChatDataMessage,
  type StudyCommand,
  type StudyState,
  type HandQueueState,
  type ModeratedMediaKind,
  type Participant,
  type ParticipantHandDataMessage,
  type ParticipantMediaDataMessage,
  type ParticipantRole,
  type ServerMessage,
  type SignalingErrorCode,
} from '@round/protocol';
import {
  measurePeerConnections,
  type PeerConnectionDiagnostics,
} from './connection-diagnostics.js';
import { LocalInputLifecycle } from './local-input-lifecycle.js';
import type { LocalMediaLifecycleOptions } from './local-media-lifecycle.js';
import {
  PeerConnectionLifecycle,
  type PeerMediaSenderUpdate,
} from './peer-connection-lifecycle.js';
import { PEER_DATA_CHANNEL_LABEL, PeerDataChannel } from './peer-data-channel.js';
import { PeerNegotiationLifecycle } from './peer-negotiation-lifecycle.js';
import {
  ChatSendError,
  RoomChatLedger,
  type ChatMessage,
  type ChatRecipientDeliveryState,
} from './room-chat.js';
import {
  ScreenShareLifecycle,
  type ScreenShareStartResult,
  type ScreenShareQuality,
} from './screen-share-lifecycle.js';
import { SignalingRecoveryLifecycle } from './signaling-recovery-lifecycle.js';
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
  readonly handRaised: boolean;
  readonly activity?: ParticipantActivity;
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

export interface RoomStudySnapshot extends StudyState {
  readonly sampledAt: number;
}

export interface RoomSessionSnapshot {
  readonly handQueue?: HandQueueState | null;
  readonly study?: RoomStudySnapshot | null;
  readonly studyPending?: boolean;
  readonly studyNotice?: string | null;
  readonly roomId: string;
  readonly status: RoomSessionStatus;
  readonly selfId: string | null;
  readonly selfRole: ParticipantRole | null;
  readonly canModerateMedia: boolean;
  readonly screenShareAvailable: boolean;
  readonly screenSharing: boolean;
  readonly screenSharePending: 'starting' | 'stopping' | null;
  readonly screenShareQuality?: ScreenShareQuality;
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
  handRaised: boolean;
}

type PeerContext = PeerConnectionLifecycle;

interface OutboundChatTargets {
  readonly peers: PeerContext[];
  readonly recipientStates: Map<string, ChatRecipientDeliveryState>;
}

type ResolvedRecoveryOptions = Required<RoomSessionRecoveryOptions>;

// 일반적인 ICE 후보 수집량은 이 값보다 훨씬 적다. 초과 시 최신 후보를 유지한다.
const MAX_PENDING_REMOTE_ICE_CANDIDATES = 256;
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
 * 프레임워크와 무관하게 방 하나의 브라우저 WebRTC 자원을 관리한다.
 *
 * 세션은 의도적으로 일회용이다. `leave()` 또는 치명적인 시그널링 오류 후에는
 * 새 인스턴스를 생성해야 한다.
 */
export class RoomSession {
  readonly #options: RoomSessionOptions;
  readonly #recoveryOptions: ResolvedRecoveryOptions;
  readonly #listeners = new Set<RoomSessionListener>();
  readonly #participants = new Map<string, MutableParticipant>();
  readonly #peers = new Map<string, PeerContext>();
  readonly #remoteStreams = new Map<string, MediaStream>();
  readonly #remoteMediaStates = new Map<string, ParticipantMediaDataMessage>();
  readonly #staleSelfIds = new Set<string>();
  readonly #exhaustedPeerIds = new Set<string>();
  readonly #participantMonitors = new Map<string, ParticipantMonitor>();
  readonly #participantActivity = new Map<string, ParticipantActivity>();
  #study: RoomStudySnapshot | null = null;
  #studyNotice: string | null = null;
  #studyCommandId: string | null = null;
  #studyCommandTimer: ReturnType<typeof setTimeout> | null = null;
  #studySyncRequest: { id: string; sentAt: number } | null = null;
  #monitorGeneration = 0;
  #monitorPending = false;
  readonly #peerConnectionEpochs = new Map<string, string>();
  readonly #peerRetryRequests = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #signalingTransport: SignalingTransport;
  readonly #peerNegotiation: PeerNegotiationLifecycle;
  readonly #signalingRecovery: SignalingRecoveryLifecycle;
  readonly #chat: RoomChatLedger;
  readonly #screenShare: ScreenShareLifecycle;
  readonly #localInput: LocalInputLifecycle;

  #rtcConfiguration: RTCConfiguration | undefined;
  #localStream: MediaStream | null = null;
  #videoQualityMode: VideoQualityMode = 'standard';
  #handRaised = false;
  #handQueue: HandQueueState | null = null;
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
    this.#chat = new RoomChatLedger(options.maxChatMessages ?? 200, () => this.#monotonicNow());
    const mediaLifecycleOptions: LocalMediaLifecycleOptions = {
      isRoomActive: () => !this.#disposed && this.#status === 'active',
      isDisposed: () => this.#disposed,
      createMediaStream: () => (this.#options.mediaStreamFactory ?? (() => new MediaStream()))(),
      getLocalStream: () => this.#localStream,
      setLocalStream: (stream) => {
        this.#localStream = stream;
      },
      getPeers: () => this.#peers.values(),
      isCurrentPeer: (peer) => this.#isCurrentPeer(peer),
      replacePeerTrack: (peer, sender, track) => this.#replacePeerTrack(peer, sender, track),
      rollbackSenderUpdates: (updates) => this.#rollbackSenderUpdates(updates),
      recoverPeersAfterSenderFailure: (failures, phase) =>
        this.#recoverPeersAfterSenderFailure(failures, phase),
      requestLocalRenegotiation: (peer) => this.#requestLocalRenegotiation(peer),
      onStateChanged: () => {
        this.#syncLocalParticipantMedia();
        this.#broadcastMediaState();
        this.#emit();
      },
    };
    this.#screenShare = new ScreenShareLifecycle({
      ...mediaLifecycleOptions,
      getMediaDevices: () => this.#getMediaDevices(),
      onTransitionChanged: () => this.#emit(),
    });
    this.#localInput = new LocalInputLifecycle(
      {
        ...mediaLifecycleOptions,
        canSelectInput: (kind) =>
          !this.#screenShare.isTransitioning() &&
          (kind !== 'video' || !this.#screenShare.isSharing()),
        isVideoToggleBlocked: () => this.#screenShare.hasActiveTrack(),
        getMediaDevices: () => this.#getMediaDevices(),
        getInputConstraints: (kind) => this.#options.mediaConstraints?.[kind],
        recoverPeersAfterSenderFailure: (failures, phase) =>
          this.#recoverPeersAfterSenderFailure(failures, phase, 'media-device-sender-recovery'),
        onInputTrackEnded: (track) => this.#screenShare.removeRetainedCameraTrack(track),
      },
      options.initialInputEnabled,
    );
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
    this.#peerNegotiation = new PeerNegotiationLifecycle({
      roomId,
      transport: this.#signalingTransport,
      maxPendingRemoteCandidates: MAX_PENDING_REMOTE_ICE_CANDIDATES,
      createNegotiationId: (peerId) => {
        const epoch = this.#peerConnectionEpochs.get(peerId);
        return epoch === undefined ? defaultCreateId() : `${epoch}.${defaultCreateId()}`;
      },
      getPeer: (peerId) => this.#peers.get(peerId),
      ensurePeer: (peerId) => this.#ensurePeer(peerId),
      replacePeer: (peerId, preservePendingCandidates, connectionAttempt) =>
        this.#replacePeer(peerId, preservePendingCandidates, connectionAttempt),
      isCurrentPeer: (peer) => this.#isCurrentPeer(peer),
      isRoomReconnecting: () => this.#status === 'reconnecting',
      setPeerConnectionStatus: (peerId, status) => this.#setPeerConnectionStatus(peerId, status),
      setPeerWarning: (peerId, code, message) => this.#setPeerWarning(peerId, code, message),
      failPeerConnectionTimeout: (peer) => this.#failPeerConnectionTimeout(peer),
      finishPeerRecovery: (peer) => this.#finishPeerRecovery(peer),
      updateVideoQuality: (peer) => this.#updateVideoQuality(peer),
      onNegotiationSettled: (peer) => this.#drainPendingLocalRenegotiation(peer),
    });
    const serializedJoinMessage = serializeClientMessage({
      v: PROTOCOL_VERSION,
      type: 'room.join',
      roomId,
      payload: {
        displayName,
        ...(options.hostCapability === undefined ? {} : { hostCapability: options.hostCapability }),
      },
    });
    this.#signalingRecovery = new SignalingRecoveryLifecycle({
      transport: this.#signalingTransport,
      serializedJoinMessage,
      roomJoinTimeoutMs: this.#recoveryOptions.roomJoinTimeoutMs,
      maxReconnectAttempts: this.#recoveryOptions.maxReconnectAttempts,
      reconnectDelay: (attempt) => this.#reconnectDelay(attempt),
      isCancelled: () => this.#leaving || this.#disposed,
      isRoomActive: () => this.#status === 'active',
      createJoinTimeoutError: () =>
        new RoomSessionFailure(
          'room-join-timeout',
          'The signaling server did not confirm room entry within ' +
            this.#recoveryOptions.roomJoinTimeoutMs +
            'ms',
        ),
      createJoinIncompleteError: () =>
        new RoomSessionFailure(
          'signaling-closed',
          'Signaling connection closed while room entry was completing',
        ),
      onReconnectAttemptFailed: (error) => this.#handleReconnectAttemptFailure(error),
      onReconnectExhausted: (lastFailureMessage) => {
        this.#finishReconnectFailure({
          code: 'reconnect-exhausted',
          message:
            'Could not reconnect after ' +
            this.#recoveryOptions.maxReconnectAttempts +
            ' attempts. ' +
            lastFailureMessage,
        });
      },
      onUnexpectedFailure: (error) => {
        this.#finishReconnectFailure(this.#issueFromError(error, 'reconnect-exhausted'));
      },
    });
    this.#rtcConfiguration = snapshotRtcConfiguration(options.rtcConfiguration);
    if (options.preparedMediaStream !== undefined) {
      this.#localInput.adoptStream(options.preparedMediaStream);
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
      const screen = this.#screenShare.ownsVideoTrack(sender.track);
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

  resetParticipantActivity(): void {
    this.#monitorGeneration += 1;
    this.#participantMonitors.clear();
    this.#participantActivity.clear();
    this.#emit();
  }

  async sampleParticipantActivity(qualityEnabled: boolean): Promise<void> {
    if (this.#status !== 'active' || this.#monitorPending) return;
    this.#monitorPending = true;
    const generation = this.#monitorGeneration;
    let localSpeaking = false;
    try {
      await Promise.all(
        [...this.#peers.values()].map(async (peer) => {
          if (peer.connection.connectionState !== 'connected') return;
          const participant = this.#participants.get(peer.peerId);
          if (!participant) return;
          const localAudio = this.#getLocalMediaSnapshot().audioEnabled;
          if (!qualityEnabled && !participant.audioEnabled && !localAudio) {
            this.#participantActivity.delete(peer.peerId);
            this.#participantMonitors.delete(peer.peerId);
            return;
          }
          try {
            const report = await peer.connection.getStats();
            if (
              generation !== this.#monitorGeneration ||
              !this.#isCurrentPeer(peer) ||
              peer.connection.connectionState !== 'connected'
            )
              return;
            let monitor = this.#participantMonitors.get(peer.peerId);
            if (!monitor) {
              monitor = new ParticipantMonitor();
              this.#participantMonitors.set(peer.peerId, monitor);
            }
            const activity = monitor.sample(
              report,
              this.#monotonicNow(),
              participant.audioEnabled,
              this.#getLocalMediaSnapshot().audioEnabled,
              qualityEnabled,
            );
            this.#participantActivity.set(peer.peerId, {
              speaking: activity.speaking,
              receptionQuality: activity.receptionQuality,
            });
            localSpeaking ||= activity.localSpeaking;
          } catch {
            if (generation === this.#monitorGeneration && this.#isCurrentPeer(peer)) {
              this.#participantActivity.delete(peer.peerId);
              this.#participantMonitors.delete(peer.peerId);
            }
          }
        }),
      );
      if (generation === this.#monitorGeneration && this.#status === 'active') {
        if (this.#selfId)
          this.#participantActivity.set(this.#selfId, {
            speaking: localSpeaking,
            receptionQuality: 'unavailable',
          });
        this.#emit();
      }
    } finally {
      this.#monitorPending = false;
    }
  }

  /**
   * 요청 후 약 3초 동안의 수신 통계를 비교하며 주기적으로 수집하지 않는다.
   * candidate 주소, 방 코드, peer ID는 결과에 포함하지 않는다.
   * 참가자 표시 이름은 현재 화면에서 연결을 구분하는 데 사용한다.
   */
  async collectConnectionDiagnostics(): Promise<RoomConnectionDiagnostics> {
    const peers = [...this.#peers.values()].filter(
      (peer) => !peer.closed && peer.connection.connectionState !== 'closed',
    );
    const connections = await measurePeerConnections(
      peers.map((peer) => {
        const participantName = this.#participants.get(peer.peerId)?.displayName;
        return {
          connection: peer.connection,
          ...(participantName === undefined ? {} : { participantName }),
          signal: peer.trackReplacementAbort.signal,
          isCurrent: () => this.#isCurrentPeer(peer),
        };
      }),
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
    this.#signalingRecovery.cancelReconnectWait();

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

    this.#signalingTransport.cancelConnect(
      new Error('Room session ended before signaling connected'),
    );
    this.#signalingRecovery.rejectJoin(new Error('Room session ended before joining'));
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

  retrySignalingNow(): boolean {
    return this.#status === 'reconnecting' && this.#signalingRecovery.cancelReconnectWait();
  }

  selectInputDevice(kind: 'audio' | 'video', deviceId: string): Promise<boolean> {
    return this.#localInput.select(kind, deviceId);
  }

  toggleAudio(): boolean {
    return this.#localInput.toggle('audio');
  }

  toggleVideo(): boolean {
    return this.#localInput.toggle('video');
  }

  setHandRaised(raised: boolean): boolean {
    if (this.#disposed || this.#status !== 'active' || this.#selfId === null) return false;
    if (this.#handRaised === raised) return true;
    if (!this.#sendHandRequest(raised)) return false;
    this.#handRaised = raised;
    const participant = this.#participants.get(this.#selfId);
    if (participant !== undefined) participant.handRaised = raised;
    this.#emit();
    const message = this.#currentHandDataMessage();
    for (const peer of this.#peers.values()) {
      peer.data.publishHandState(message);
    }
    return true;
  }

  #sendHandRequest(raised?: boolean): boolean {
    try {
      this.#signalingTransport.send(
        raised === undefined
          ? { v: PROTOCOL_VERSION, type: 'room.hand.sync', roomId: this.#options.roomId }
          : {
              v: PROTOCOL_VERSION,
              type: 'room.hand.update',
              roomId: this.#options.roomId,
              requestId: `hand-update-${defaultCreateId()}`,
              payload: { raised },
            },
      );
      return true;
    } catch {
      return false;
    }
  }

  setScreenShareQuality(quality: ScreenShareQuality): boolean {
    return this.#screenShare.setQuality(quality);
  }

  startScreenShare(): Promise<ScreenShareStartResult> {
    if (this.#disposed || this.#status !== 'active' || this.#localInput.isChanging()) {
      return Promise.resolve('cancelled');
    }
    return this.#screenShare.start();
  }

  stopScreenShare(): Promise<boolean> {
    return this.#screenShare.stop(false);
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
    senderUpdates: readonly PeerMediaSenderUpdate[],
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
        void this.#peerNegotiation.createOffer(replacement.peerId).catch((offerError: unknown) => {
          if (this.#isCurrentPeer(replacement)) {
            this.#failPeer(replacement.peerId, offerError);
          }
        });
      }
    }
  }

  syncStudy(): boolean {
    if (this.#status !== 'active') return false;
    const sentAt = this.#monotonicNow();
    if (this.#studySyncRequest && sentAt - this.#studySyncRequest.sentAt < 10_000) return false;
    const id = `study-sync-${defaultCreateId()}`;
    try {
      this.#signalingTransport.send({
        v: PROTOCOL_VERSION,
        type: 'room.study.sync',
        roomId: this.#options.roomId,
        requestId: id,
      });
      this.#studySyncRequest = { id, sentAt };
      return true;
    } catch {
      return false;
    }
  }

  updateStudy(command: StudyCommand, expectedRevision = this.#study?.revision): boolean {
    if (
      this.#status !== 'active' ||
      this.#selfRole !== 'host' ||
      !this.#study ||
      this.#studyCommandId ||
      expectedRevision !== this.#study.revision
    )
      return false;
    const id = `study-update-${defaultCreateId()}`;
    try {
      this.#signalingTransport.send({
        v: PROTOCOL_VERSION,
        type: 'room.study.update',
        roomId: this.#options.roomId,
        requestId: id,
        payload: { ...command, expectedRevision },
      });
      this.#studyCommandId = id;
      this.#studyNotice = null;
      this.#studyCommandTimer = globalThis.setTimeout(() => {
        this.#clearStudyCommand();
        this.#studyNotice = '변경 결과를 확인하지 못했습니다. 최신 상태를 불러옵니다.';
        this.syncStudy();
        this.#emit();
      }, 10_000);
      this.#emit();
      return true;
    } catch {
      return false;
    }
  }

  #clearStudyCommand(): void {
    if (this.#studyCommandTimer !== null) globalThis.clearTimeout(this.#studyCommandTimer);
    this.#studyCommandTimer = null;
    this.#studyCommandId = null;
  }

  retryPeer(peerId: string): boolean {
    if (
      this.#status !== 'active' ||
      !this.#exhaustedPeerIds.has(peerId) ||
      this.#peerRetryRequests.has(peerId)
    ) {
      return false;
    }
    try {
      this.#signalingTransport.sendRelay({
        v: PROTOCOL_VERSION,
        type: 'peer.reconnect',
        roomId: this.#options.roomId,
        to: peerId,
      });
      this.#peerRetryRequests.set(
        peerId,
        globalThis.setTimeout(() => {
          this.#peerRetryRequests.delete(peerId);
          this.#setPeerConnectionStatus(peerId, 'failed');
        }, 10_000),
      );
      this.#setPeerConnectionStatus(peerId, 'connecting');
      return true;
    } catch {
      return false;
    }
  }

  #clearPeerRetry(peerId: string): void {
    const timer = this.#peerRetryRequests.get(peerId);
    if (timer !== undefined) globalThis.clearTimeout(timer);
    this.#peerRetryRequests.delete(peerId);
  }

  #acceptPeerEpoch(peerId: string, negotiationId: string | undefined): boolean {
    const epoch = this.#peerConnectionEpochs.get(peerId);
    return epoch === undefined || negotiationId?.startsWith(`${epoch}.`) === true;
  }

  sendChat(text: string): ChatMessage {
    if (this.#status !== 'active' || this.#selfId === null) {
      throw new ChatSendError('room-not-active', 'Chat is only available after joining the room');
    }

    const normalizedText = text.trim();
    const messageId = (this.#options.createId ?? defaultCreateId)();
    this.#chat.assertLocalMessageIdAvailable(messageId);
    const wireMessage: ChatDataMessage = {
      type: 'chat.message',
      id: messageId,
      senderId: this.#selfId,
      sentAt: this.#wallClockNow(),
      text: normalizedText,
    };
    const serializedMessage = serializePeerDataMessage(wireMessage);
    const message: Omit<ChatMessage, 'deliveryState'> = {
      id: wireMessage.id,
      senderId: wireMessage.senderId,
      senderName: this.#options.displayName,
      text: wireMessage.text,
      sentAt: wireMessage.sentAt,
      isLocal: true,
    };

    const targets = this.#enqueueOutboundChat(wireMessage, serializedMessage);
    const storedMessage = this.#chat.recordOutgoing(
      {
        ...message,
        recipients: [...targets.recipientStates].map(([peerId, state]) => ({
          peerId,
          state,
          displayName: this.#participants.get(peerId)?.displayName ?? peerId,
        })),
      },
      targets.recipientStates,
    );
    for (const peer of targets.peers) {
      peer.data.flush();
    }
    this.#emit();
    return storedMessage;
  }

  retryChat(messageId: string, recipientId?: string): boolean {
    const message = this.#chat.retryCandidate(messageId);
    if (this.#status !== 'active' || !message || message.senderId !== this.#selfId) return false;
    const peers = this.#chat.failedRecipients(messageId).flatMap((peerId) => {
      const peer = this.#peers.get(peerId);
      return (recipientId === undefined || recipientId === peerId) &&
        peer?.data.isOpen() &&
        !peer.recovering &&
        peer.data.hasQueueCapacity()
        ? [peer]
        : [];
    });
    if (peers.length === 0) return false;
    const wire: ChatDataMessage = {
      type: 'chat.message',
      id: message.id,
      senderId: message.senderId,
      sentAt: message.sentAt,
      text: message.text,
    };
    const serialized = serializePeerDataMessage(wire);
    this.#chat.prepareRetry(
      messageId,
      peers.map((peer) => peer.peerId),
    );
    for (const peer of peers) peer.data.enqueueChat(wire, serialized);
    for (const peer of peers) peer.data.flush();
    this.#emit();
    return true;
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
      await this.#signalingRecovery.joinRoom();
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
      this.#localInput.adoptStream(stream);
    } catch (error) {
      this.#warning = {
        code: 'media-permission-denied',
        message: `Camera or microphone could not be opened; joined without media. ${getErrorMessage(error)}`,
      };
      this.#warningPeerId = null;
    }
    this.#emit();
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

  #resetRoomMembershipForReconnect(): void {
    this.#cleanupPeerResources();
    this.#participants.clear();
    this.#remoteMediaStates.clear();
    this.#selfId = null;
    this.#selfRole = null;
    this.#canModerateMedia = false;
  }

  #handleReconnectAttemptFailure(error: unknown): RoomIssue {
    const issue = this.#issueFromError(error, 'reconnect-attempt-failed');
    this.#signalingTransport.close(1000, 'reconnect retry');
    this.#resetRoomMembershipForReconnect();
    this.#warning = {
      code: 'signaling-reconnecting',
      message: issue.message,
    };
    this.#warningPeerId = null;
    this.#setStatus('reconnecting');
    return issue;
  }

  #beginReconnect(reason: RoomIssue): void {
    if (this.#leaving || this.#disposed) {
      return;
    }

    this.#rememberStaleSelfId();
    this.#exhaustedPeerIds.clear();
    this.#resetRoomMembershipForReconnect();
    this.#error = null;
    this.#warning = {
      code: 'signaling-reconnecting',
      message: reason.message,
    };
    this.#warningPeerId = null;
    this.#setStatus('reconnecting');
    this.#signalingRecovery.startReconnect(reason);
  }

  #reconnectDelay(attempt: number): number {
    const exponential = this.#recoveryOptions.reconnectInitialDelayMs * 2 ** (attempt - 1);
    return Math.min(exponential, this.#recoveryOptions.reconnectMaxDelayMs);
  }

  #finishReconnectFailure(issue: RoomIssue): void {
    if (this.#leaving || this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#signalingRecovery.cancelReconnectWait();
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
    this.#signalingRecovery.rejectJoin(error);

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
        case 'room.hand.state': {
          if (
            this.#status !== 'active' ||
            (this.#handQueue && message.payload.revision < this.#handQueue.revision)
          )
            return;
          this.#handQueue = {
            ...message.payload,
            peerIds: [...message.payload.peerIds],
            supportedPeerIds: [...message.payload.supportedPeerIds],
          };
          const raised = new Set(message.payload.peerIds);
          for (const id of message.payload.supportedPeerIds) {
            const participant = this.#participants.get(id);
            if (participant) participant.handRaised = raised.has(id);
          }
          const wasRaised = this.#handRaised;
          this.#handRaised = this.#selfId !== null && raised.has(this.#selfId);
          if (wasRaised !== this.#handRaised) {
            for (const peer of this.#peers.values())
              peer.data.publishHandState(this.#currentHandDataMessage());
          }
          this.#emit();
          return;
        }
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
        case 'room.study.state': {
          if (this.#status !== 'active') return;
          if (message.requestId === this.#studyCommandId) this.#clearStudyCommand();
          const { conflict, ...state } = message.payload;
          if (conflict)
            this.#studyNotice =
              '다른 방장이 먼저 변경했습니다. 최신 상태를 확인한 뒤 다시 조작해 주세요.';
          if (!this.#study || state.revision >= this.#study.revision) {
            const now = this.#monotonicNow();
            const request = this.#studySyncRequest;
            const transitMs =
              request !== null && request.id === message.requestId
                ? Math.max(0, now - request.sentAt) / 2
                : 0;
            this.#study = {
              ...state,
              remainingMs: Math.max(0, state.remainingMs - (state.running ? transitMs : 0)),
              sampledAt: now,
            };
          }
          if (message.requestId === this.#studySyncRequest?.id) this.#studySyncRequest = null;
          this.#emit();
          return;
        }
        case 'peer.reconnect': {
          const { peerId, connectionId, initiator } = message.payload;
          if (
            this.#status !== 'active' ||
            peerId === this.#selfId ||
            !this.#participants.has(peerId)
          )
            return;
          this.#cleanupPeer(peerId, false);
          this.#clearPeerRetry(peerId);
          this.#exhaustedPeerIds.delete(peerId);
          this.#peerConnectionEpochs.set(peerId, connectionId);
          this.#clearPeerWarning(peerId);
          try {
            const peer = this.#ensurePeer(peerId);
            this.#setPeerConnectionStatus(peerId, 'connecting');
            if (initiator) {
              await this.#peerNegotiation.createOffer(peerId);
            }
            if (!this.#isCurrentPeer(peer)) return;
          } catch (error) {
            this.#failPeer(peerId, error);
          }
          return;
        }
        case 'rtc.offer':
          if (
            this.#staleSelfIds.has(message.from) ||
            this.#exhaustedPeerIds.has(message.from) ||
            !this.#acceptPeerEpoch(message.from, message.payload.negotiationId)
          ) {
            return;
          }
          await this.#peerNegotiation.handleOffer(
            message.from,
            message.payload.description,
            message.payload.negotiationId,
          );
          return;
        case 'rtc.answer':
          if (
            this.#staleSelfIds.has(message.from) ||
            this.#exhaustedPeerIds.has(message.from) ||
            !this.#acceptPeerEpoch(message.from, message.payload.negotiationId)
          ) {
            return;
          }
          await this.#peerNegotiation.handleAnswer(
            message.from,
            message.payload.description,
            message.payload.negotiationId,
          );
          return;
        case 'rtc.ice':
          if (
            this.#staleSelfIds.has(message.from) ||
            this.#exhaustedPeerIds.has(message.from) ||
            !this.#acceptPeerEpoch(message.from, message.payload.negotiationId)
          ) {
            return;
          }
          await this.#peerNegotiation.handleIce(
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
          await this.#peerNegotiation.createOffer(participant.peerId);
        } catch (error) {
          this.#scheduleInitialOfferRetry(participant.peerId, error);
        }
      });

    if (this.#warning?.code === 'signaling-reconnecting') {
      this.#warning = null;
      this.#warningPeerId = null;
    }
    this.#setStatus('active');
    this.#sendHandRequest(this.#handRaised ? true : undefined);
    this.#signalingRecovery.resolveJoin();

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
    this.#localInput.setDesiredEnabled(kind, false);

    if (kind === 'video') {
      if (this.#screenShare.cancelPendingStart(true)) {
        this.#syncLocalParticipantMedia();
        this.#broadcastMediaState();
        this.#emit();
        return;
      }
      if (this.#screenShare.isSharingOrStopping()) {
        const stopPromise = this.#screenShare.stop(true);
        this.#syncLocalParticipantMedia();
        this.#broadcastMediaState();
        this.#emit();
        await stopPromise;
        return;
      }
      this.#screenShare.disableCameraTracks();
    } else {
      this.#localInput.disableTracks('audio');
    }
    this.#syncLocalParticipantMedia();
    this.#broadcastMediaState();
    this.#emit();
  }

  #createPeerDataChannel(peerId: string): PeerDataChannel {
    let dataChannel!: PeerDataChannel;
    dataChannel = new PeerDataChannel({
      peerId,
      isCurrent: () => this.#peers.get(peerId)?.data === dataChannel,
      isRecovering: () => this.#peers.get(peerId)?.recovering ?? true,
      monotonicNow: () => this.#monotonicNow(),
      currentMediaState: () => this.#currentMediaDataMessage(),
      currentHandState: () => this.#currentHandDataMessage(),
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
        this.#chat.recordReceived({
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
      onHandState: (message) => {
        if (this.#handQueue?.supportedPeerIds.includes(peerId)) return;
        const participant = this.#participants.get(peerId);
        if (participant === undefined || participant.handRaised === message.raised) return;
        participant.handRaised = message.raised;
        this.#emit();
      },
      onChatAcknowledged: (messageId) =>
        this.#chat.markLocalRecipient(messageId, peerId, 'acknowledged'),
      onChatFailed: (messageId) => this.#chat.markLocalRecipient(messageId, peerId, 'failed'),
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
      this.#peerNegotiation.handleLocalIceCandidate(peer, event.candidate);
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
    void this.#peerNegotiation
      .createOffer(peer.peerId)
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
      void this.#peerNegotiation
        .createOffer(retryPeer.peerId)
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
        void this.#peerNegotiation.createOffer(replacement.peerId).catch((error: unknown) => {
          if (this.#isCurrentPeer(replacement)) {
            this.#failPeer(replacement.peerId, error);
          }
        });
      }
    });

    if (!this.#isPeerRecoveryInitiator(peer.peerId)) {
      return;
    }
    void this.#peerNegotiation
      .createOffer(peer.peerId, { iceRestart: true })
      .catch((error: unknown) => {
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

  #currentHandDataMessage(): ParticipantHandDataMessage {
    return { type: 'participant.hand', raised: this.#handRaised };
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
      handRaised: isLocal && this.#handRaised,
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
    if (status !== 'connected') {
      this.#participantActivity.delete(peerId);
      this.#participantMonitors.delete(peerId);
    }
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
    this.#clearPeerRetry(peerId);
    this.#peerConnectionEpochs.delete(peerId);
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
    this.#participantMonitors.delete(peer.peerId);
    this.#participantActivity.delete(peer.peerId);
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
    this.#handQueue = null;
    this.#clearStudyCommand();
    this.#study = null;
    this.#studyNotice = null;
    this.#studySyncRequest = null;
    this.#monitorGeneration += 1;
    this.#participantMonitors.clear();
    this.#participantActivity.clear();
    for (const peerId of this.#peerRetryRequests.keys()) this.#clearPeerRetry(peerId);
    this.#peerConnectionEpochs.clear();
    for (const peerId of [...this.#peers.keys()]) {
      this.#cleanupPeer(peerId, false);
      this.#clearPeerWarning(peerId);
    }
    this.#remoteStreams.clear();
  }

  #cleanupAllResources(): void {
    this.#signalingTransport.clearPendingRequests();
    this.#cleanupPeerResources();
    this.#remoteMediaStates.clear();

    const ownedTracks = new Set([
      ...this.#localInput.takeOwnedTracks(),
      ...this.#screenShare.takeOwnedTracks(),
    ]);
    for (const track of ownedTracks) {
      track.stop();
    }
  }

  #handleServerError(code: SignalingErrorCode, requestId: string | undefined): void {
    if (requestId?.startsWith('hand-update-') && this.#status === 'active') this.#sendHandRequest();
    if (requestId === this.#studyCommandId) {
      this.#clearStudyCommand();
      this.#studyNotice = '타이머와 주제 변경 요청을 처리하지 못했습니다.';
      this.#emit();
    }
    const error = new RoomSessionFailure(code, safeSignalingErrorMessage(code));
    if (this.#signalingRecovery.rejectJoin(error)) {
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
    this.#signalingRecovery.cancelReconnectWait();
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
    const audioTracks = this.#localInput.liveTracks('audio');
    const videoTracks = this.#localInput.liveTracks('video');
    const screenSharing = this.#screenShare.isSharing();
    return {
      audioAvailable: audioTracks.length > 0,
      audioEnabled: audioTracks.some((track) => track.enabled),
      videoAvailable: videoTracks.length > 0,
      videoEnabled: videoTracks.some((track) => track.enabled),
      videoSource: screenSharing ? 'screen' : 'camera',
    };
  }

  #buildSnapshot(): RoomSessionSnapshot {
    return {
      roomId: this.#options.roomId,
      study: this.#study === null ? null : { ...this.#study },
      handQueue:
        this.#handQueue === null
          ? null
          : {
              ...this.#handQueue,
              peerIds: [...this.#handQueue.peerIds],
              supportedPeerIds: [...this.#handQueue.supportedPeerIds],
            },
      studyPending: this.#studyCommandId !== null,
      studyNotice: this.#studyNotice,
      status: this.#status,
      selfId: this.#selfId,
      selfRole: this.#selfRole,
      canModerateMedia: this.#canModerateMedia,
      screenShareAvailable: this.#screenShare.isAvailable(),
      screenSharing: this.#screenShare.isSharing(),
      screenSharePending: this.#screenShare.getPending(),
      screenShareQuality: this.#screenShare.getQuality(),
      videoQualityMode: this.#videoQualityMode,
      participants: [...this.#participants.values()].map((participant) => ({
        ...participant,
        ...(this.#participantActivity.has(participant.peerId)
          ? { activity: { ...this.#participantActivity.get(participant.peerId)! } }
          : {}),
      })),
      localMedia: this.#getLocalMediaSnapshot(),
      messages: this.#chat.snapshot().map((message) => ({
        ...message,
        ...(message.recipients
          ? {
              recipients: message.recipients.map((recipient) => ({
                ...recipient,
                canRetry:
                  this.#status === 'active' &&
                  message.senderId === this.#selfId &&
                  recipient.state === 'failed' &&
                  this.#chat.retryCandidate(message.id) !== undefined &&
                  this.#peers.get(recipient.peerId)?.data.isOpen() === true &&
                  this.#peers.get(recipient.peerId)?.recovering === false,
              })),
            }
          : {}),
      })),
      lastModerationNotice:
        this.#lastModerationNotice === null ? null : { ...this.#lastModerationNotice },
      warning:
        this.#warning !== null
          ? { ...this.#warning }
          : this.#localInput.hasEndedInput()
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
