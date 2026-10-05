import { ParticipantActivityTracker } from './participant-activity.js';
import type { ParticipantActivity } from './participant-monitor.js';
import {
  PROTOCOL_VERSION,
  serializeClientMessage,
  serializePeerDataMessage,
  type ChatDataMessage,
  type StudyCommand,
  type HandQueueState,
  type ModeratedMediaKind,
  type Participant,
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
import { PeerRecoveryLifecycle } from './peer-recovery-lifecycle.js';
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
import { getErrorMessage } from './errors.js';
import { RoomStudy, type RoomStudySnapshot } from './room-study.js';
export type { PeerConnectionDiagnostics } from './connection-diagnostics.js';
export type { RoomStudySnapshot } from './room-study.js';

export type RoomSessionStatus =
  'idle' | 'connecting-signal' | 'joining' | 'active' | 'reconnecting' | 'ended' | 'error';

export type PeerConnectionStatus = RTCPeerConnectionState | 'negotiating';

export type RoomIssueCode =
  | SignalingErrorCode
  | 'video-quality-update-failed'
  | 'rtc-configuration-update-failed'
  | 'join-failed'
  | 'room-join-timeout'
  | 'signaling-reconnecting'
  | 'reconnect-exhausted'
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
  readonly kind: ModeratedMediaKind;
}

export interface RoomSessionSnapshot {
  readonly handQueue?: HandQueueState | null;
  readonly study?: RoomStudySnapshot | null;
  readonly studyPending?: boolean;
  readonly studyNotice?: string | null;
  readonly status: RoomSessionStatus;
  readonly selfId: string | null;
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
   * 입장 준비 단계에서 넘겨받은 스트림이다. `null`이면 카메라·마이크 없이 참여한다.
   * 세션은 입장 중에 장치 권한을 따로 요청하지 않는다.
   */
  readonly preparedMediaStream: MediaStream | null;
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
const SIGNALING_SESSION_SUPERSEDED_CLOSE_CODE = 4002;
const SIGNALING_SESSION_SUPERSEDED_REASON = 'Participation session superseded';
// 복구 시간은 테스트만 줄여서 넘긴다.
const DEFAULT_RECOVERY_OPTIONS: ResolvedRecoveryOptions = {
  signalingConnectTimeoutMs: 8_000,
  roomJoinTimeoutMs: 8_000,
  // 협상 재시도와 연결 watchdog이 경쟁하지 않도록 기본 초기 offer 재시도
  // backoff 상한(15.5초)보다 길게 설정한다.
  peerConnectionTimeoutMs: 20_000,
  maxReconnectAttempts: 6,
  reconnectInitialDelayMs: 500,
  reconnectMaxDelayMs: 4_000,
  peerDisconnectedGraceMs: 3_000,
  peerRecoveryTimeoutMs: 8_000,
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

function defaultCreateId(): string {
  return globalThis.crypto.randomUUID();
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
  readonly #peerConnectionEpochs = new Map<string, string>();
  readonly #peerRetryRequests = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #signalingTransport: SignalingTransport;
  readonly #study: RoomStudy;
  readonly #participantActivity: ParticipantActivityTracker;
  readonly #peerNegotiation: PeerNegotiationLifecycle;
  readonly #peerRecovery: PeerRecoveryLifecycle;
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
  // peerId가 있으면 해당 참가자 연결에 대한 경고다.
  #warning: (RoomIssue & { readonly peerId: string | null }) | null = null;
  #error: RoomIssue | null = null;
  #snapshot: RoomSessionSnapshot;
  #joinPromise: Promise<void> | null = null;
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
    this.#recoveryOptions = { ...DEFAULT_RECOVERY_OPTIONS, ...options.recovery };
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
        this.#peerRecovery.recoverAfterSenderFailure(failures, phase),
      requestLocalRenegotiation: (peer) => this.#peerNegotiation.requestRenegotiation(peer),
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
          this.#peerRecovery.recoverAfterSenderFailure(
            failures,
            phase,
            'media-device-sender-recovery',
          ),
        onInputTrackEnded: (track) => this.#screenShare.removeRetainedCameraTrack(track),
      },
      options.initialInputEnabled,
    );
    this.#study = new RoomStudy({
      roomId,
      send: (message) => this.#signalingTransport.send(message),
      createId: defaultCreateId,
      monotonicNow: () => this.#monotonicNow(),
      isActive: () => this.#status === 'active',
      isHost: () => this.#selfRole === 'host',
      onChanged: () => this.#emit(),
    });
    this.#participantActivity = new ParticipantActivityTracker({
      monotonicNow: () => this.#monotonicNow(),
      isActive: () => this.#status === 'active',
      peers: () => this.#peers.values(),
      isCurrentPeer: (peer) => this.#isCurrentPeer(peer),
      participant: (peerId) => this.#participants.get(peerId),
      localAudioEnabled: () => this.#getLocalMediaSnapshot().audioEnabled,
      selfId: () => this.#selfId,
      onChanged: () => this.#emit(),
    });
    this.#signalingTransport = new SignalingTransport({
      url: this.#options.signalingUrl,
      roomId,
      connectTimeoutMs: this.#recoveryOptions.signalingConnectTimeoutMs,
      beforeConnect: options.beforeSignalingConnect,
      webSocketFactory: options.webSocketFactory,
      canConnect: () => !this.#disposed,
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
      createNegotiationId: (peerId) => {
        const epoch = this.#peerConnectionEpochs.get(peerId);
        return epoch === undefined ? defaultCreateId() : `${epoch}.${defaultCreateId()}`;
      },
      getPeer: (peerId) => this.#peers.get(peerId),
      ensurePeer: (peerId) => this.#ensurePeer(peerId),
      replacePeer: (peerId, preservePendingCandidates) =>
        this.#replacePeer(peerId, preservePendingCandidates),
      isCurrentPeer: (peer) => this.#isCurrentPeer(peer),
      isRoomActive: () => !this.#disposed && this.#status === 'active',
      isRoomReconnecting: () => this.#status === 'reconnecting',
      setPeerConnectionStatus: (peerId, status) => this.#setPeerConnectionStatus(peerId, status),
      setPeerWarning: (peerId, code, message) => this.#setPeerWarning(peerId, code, message),
      failPeerConnectionTimeout: (peer) => this.#failPeerConnectionTimeout(peer),
      finishPeerRecovery: (peer) => this.#peerRecovery.finish(peer),
      updateVideoQuality: (peer) => this.#updateVideoQuality(peer),
      onRenegotiationFailed: (peerId, error) =>
        this.#peerRecovery.scheduleInitialOfferRetry(peerId, error),
    });
    this.#peerRecovery = new PeerRecoveryLifecycle({
      maxReconnectAttempts: this.#recoveryOptions.maxReconnectAttempts,
      peerConnectionTimeoutMs: this.#recoveryOptions.peerConnectionTimeoutMs,
      peerDisconnectedGraceMs: this.#recoveryOptions.peerDisconnectedGraceMs,
      peerRecoveryTimeoutMs: this.#recoveryOptions.peerRecoveryTimeoutMs,
      reconnectDelay: (attempt) => this.#reconnectDelay(attempt),
      negotiation: this.#peerNegotiation,
      getPeer: (peerId) => this.#peers.get(peerId),
      isCurrentPeer: (peer) => this.#isCurrentPeer(peer),
      selfId: () => this.#selfId,
      isActive: () => this.#status === 'active',
      isDisposed: () => this.#disposed,
      replacePeer: (peerId, preservePendingCandidates) =>
        this.#replacePeer(peerId, preservePendingCandidates),
      failPeer: (peerId, error) => this.#failPeer(peerId, error),
      failPeerConnectionTimeout: (peer) => this.#failPeerConnectionTimeout(peer),
      setPeerConnectionStatus: (peerId, status) => this.#setPeerConnectionStatus(peerId, status),
      restoreConnectedStatus: (peerId) => {
        const participant = this.#participants.get(peerId);
        if (participant === undefined || participant.connectionState === 'connected') return false;
        participant.connectionState = 'connected';
        return true;
      },
      setPeerWarning: (peerId, code, message) => this.#setPeerWarning(peerId, code, message),
      clearPeerWarning: (peerId, codes) => this.#clearPeerWarning(peerId, codes),
      onStateChanged: () => this.#emit(),
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
      isCancelled: () => this.#disposed,
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
    this.#rtcConfiguration = structuredClone(options.rtcConfiguration);
    this.#localInput.adoptStream(options.preparedMediaStream);
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
    return true;
  }

  resetParticipantActivity(): void {
    this.#participantActivity.reset();
    this.#emit();
  }

  sampleParticipantActivity(qualityEnabled: boolean): Promise<void> {
    return this.#participantActivity.sample(qualityEnabled);
  }

  /**
   * 요청 후 약 3초 동안의 수신 통계를 비교하며 주기적으로 수집하지 않는다.
   * candidate 주소, 방 코드, peer ID는 결과에 포함하지 않는다.
   * 참가자 표시 이름은 현재 화면에서 연결을 구분하는 데 사용한다.
   */
  async collectConnectionDiagnostics(): Promise<RoomConnectionDiagnostics> {
    const peers = [...this.#peers.values()].filter(
      (peer) => peer.connection.connectionState !== 'closed',
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

    this.#rtcConfiguration = structuredClone(configuration);

    let failedPeerCount = 0;
    const restartPeers: PeerContext[] = [];
    for (const peer of this.#peers.values()) {
      if (peer.connection.connectionState === 'closed') {
        continue;
      }
      try {
        peer.connection.setConfiguration(
          structuredClone(this.#rtcConfiguration) as RTCConfiguration,
        );
        if (
          options.restartIce === true &&
          this.#status === 'active' &&
          this.#peerRecovery.isInitiator(peer.peerId)
        ) {
          restartPeers.push(peer);
        }
      } catch {
        failedPeerCount += 1;
      }
    }

    for (const peer of restartPeers) {
      this.#peerRecovery.begin(peer);
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

    this.#disposed = true;

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
    this.#terminate('client leave');
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

  syncStudy(): boolean {
    return this.#study.sync();
  }

  updateStudy(command: StudyCommand, expectedRevision?: number): boolean {
    return this.#study.update(command, expectedRevision);
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

  #acceptPeerSignal(peerId: string, negotiationId: string): boolean {
    if (this.#staleSelfIds.has(peerId) || this.#exhaustedPeerIds.has(peerId)) return false;
    const epoch = this.#peerConnectionEpochs.get(peerId);
    return epoch === undefined || negotiationId.startsWith(`${epoch}.`);
  }

  sendChat(text: string): ChatMessage {
    if (this.#status !== 'active' || this.#selfId === null) {
      throw new ChatSendError('room-not-active', 'Chat is only available after joining the room');
    }

    const normalizedText = text.trim();
    const messageId = (this.#options.createId ?? defaultCreateId)();
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
      this.#setStatus('connecting-signal');
      await this.#signalingTransport.connect();

      if (this.#disposed) {
        throw new Error('Room session ended while connecting');
      }

      this.#setStatus('joining');
      await this.#signalingRecovery.joinRoom();
    } catch (error) {
      if (!this.#disposed) {
        this.#terminate('join failed');
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
    this.#signalingTransport.close('reconnect retry');
    this.#resetRoomMembershipForReconnect();
    this.#warning = {
      code: 'signaling-reconnecting',
      message: getErrorMessage(error),
      peerId: null,
    };
    this.#setStatus('reconnecting');
    return this.#warning;
  }

  #beginReconnect(reason: RoomIssue): void {
    if (this.#disposed) {
      return;
    }

    this.#rememberStaleSelfId();
    this.#exhaustedPeerIds.clear();
    this.#resetRoomMembershipForReconnect();
    this.#error = null;
    this.#warning = {
      code: 'signaling-reconnecting',
      message: reason.message,
      peerId: null,
    };
    this.#setStatus('reconnecting');
    this.#signalingRecovery.startReconnect(reason);
  }

  #reconnectDelay(attempt: number): number {
    const exponential = this.#recoveryOptions.reconnectInitialDelayMs * 2 ** (attempt - 1);
    return Math.min(exponential, this.#recoveryOptions.reconnectMaxDelayMs);
  }

  #finishReconnectFailure(issue: RoomIssue): void {
    if (this.#disposed) {
      return;
    }
    this.#terminate('reconnect exhausted');
    if (this.#warning?.code === 'signaling-reconnecting') {
      this.#warning = null;
    }
    this.#setFatalError(issue.code, issue.message);
  }

  #handleSocketClose(error: SignalingTransportError, event: CloseEvent): void {
    this.#signalingRecovery.rejectJoin(error);

    if (this.#disposed) {
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
          this.#handQueue = { ...message.payload, peerIds: [...message.payload.peerIds] };
          const raised = new Set(message.payload.peerIds);
          for (const participant of this.#participants.values()) {
            participant.handRaised = raised.has(participant.peerId);
          }
          this.#handRaised = this.#selfId !== null && raised.has(this.#selfId);
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
        case 'room.study.state':
          if (this.#status !== 'active') return;
          this.#study.applyState(message.requestId, message.payload);
          this.#emit();
          return;
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
            this.#ensurePeer(peerId);
            this.#setPeerConnectionStatus(peerId, 'connecting');
            if (initiator) {
              await this.#peerNegotiation.createOffer(peerId);
            }
          } catch (error) {
            this.#failPeer(peerId, error);
          }
          return;
        }
        case 'rtc.offer':
          if (!this.#acceptPeerSignal(message.from, message.payload.negotiationId)) return;
          await this.#peerNegotiation.handleOffer(
            message.from,
            message.payload.description,
            message.payload.negotiationId,
          );
          return;
        case 'rtc.answer':
          if (!this.#acceptPeerSignal(message.from, message.payload.negotiationId)) return;
          await this.#peerNegotiation.handleAnswer(
            message.from,
            message.payload.description,
            message.payload.negotiationId,
          );
          return;
        case 'rtc.ice':
          if (!this.#acceptPeerSignal(message.from, message.payload.negotiationId)) return;
          await this.#peerNegotiation.handleIce(
            message.from,
            message.payload.candidate,
            message.payload.negotiationId,
          );
          return;
        case 'moderation.media.disabled':
          await this.#handleModerationMediaDisabled(
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

    const remoteParticipants = participants.filter(
      (participant) => participant.peerId !== peerId && !this.#staleSelfIds.has(participant.peerId),
    );
    for (const participant of remoteParticipants) {
      this.#upsertParticipant(participant, false);
    }

    const offerPromises = remoteParticipants.map(async (participant) => {
      try {
        await this.#peerNegotiation.createOffer(participant.peerId);
      } catch (error) {
        this.#peerRecovery.scheduleInitialOfferRetry(participant.peerId, error);
      }
    });

    if (this.#warning?.code === 'signaling-reconnecting') {
      this.#warning = null;
    }
    this.#setStatus('active');
    this.#sendHandRequest(this.#handRaised ? true : undefined);
    this.#signalingRecovery.resolveJoin();

    await Promise.all(offerPromises);
  }

  async #handleModerationMediaDisabled(
    targetPeerId: string,
    kind: ModeratedMediaKind,
  ): Promise<void> {
    if (this.#selfId === null || targetPeerId !== this.#selfId) {
      return;
    }

    this.#lastModerationNotice = { kind };
    this.#localInput.setDesiredEnabled(kind, false);

    let stopPromise: Promise<boolean> | null = null;
    if (kind === 'audio') {
      this.#localInput.disableTracks('audio');
    } else if (!this.#screenShare.cancelPendingStart(true)) {
      if (this.#screenShare.isSharingOrStopping()) stopPromise = this.#screenShare.stop(true);
      else this.#screenShare.disableCameraTracks();
    }
    this.#syncLocalParticipantMedia();
    this.#broadcastMediaState();
    this.#emit();
    if (stopPromise !== null) await stopPromise;
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
        this.#peerRecovery.begin(peer);
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
    const connection = factory(structuredClone(this.#rtcConfiguration));
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
      this.#peerNegotiation.drainRenegotiation(peer);
    };

    connection.onconnectionstatechange = () => {
      if (!this.#isCurrentPeer(peer)) {
        return;
      }
      const status = connection.connectionState;
      this.#setPeerConnectionStatus(peerId, status);
      switch (status) {
        case 'connected':
          this.#peerRecovery.finish(peer);
          return;
        case 'disconnected':
          this.#peerRecovery.scheduleDisconnectedRecovery(peer);
          return;
        case 'failed':
          peer.cancelTimer('disconnected');
          this.#peerRecovery.begin(peer);
          return;
        case 'closed':
          this.#cleanupPeer(peerId, false);
          this.#emit();
          return;
      }
    };

    this.#peerRecovery.scheduleConnectionTimeout(peer);
    return peer;
  }

  #isCurrentPeer(peer: PeerContext): boolean {
    return !peer.closed && this.#peers.get(peer.peerId) === peer;
  }

  // 호출하는 쪽은 맵에 있는 현재 피어를 교체한다. 시도 횟수는 그 피어에서 하나 늘린다.
  #replacePeer(peerId: string, preservePendingCandidates: boolean): PeerContext {
    const existing = this.#peers.get(peerId);
    const connectionAttempt = (existing?.connectionAttempt ?? 0) + 1;
    const dataChannel = existing?.data;
    const pendingCandidates =
      preservePendingCandidates && existing !== undefined
        ? existing.extractPendingRemoteCandidates()
        : { candidates: [], overflowWarned: false };
    const offerRetryAttempts = existing?.offerRetryAttempts ?? 0;
    const retiredNegotiationIds = existing?.retireNegotiations() ?? new Set<string>();

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
      this.#peerRecovery.finish(peer);
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
      peer.data.publishMediaState(message);
    }
  }

  #enqueueOutboundChat(message: ChatDataMessage, serializedMessage: string): OutboundChatTargets {
    // 정리한 피어는 곧바로 맵에서 지우므로 맵에 있는 피어는 모두 현재 피어다.
    const recipientIds = [...this.#participants.values()]
      .filter((participant) => !participant.isLocal)
      .map((participant) => participant.peerId);
    const targetPeers = recipientIds.flatMap((peerId) => {
      const peer = this.#peers.get(peerId);
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
          this.#peers.has(peerId) ? ('pending' as const) : ('failed' as const),
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
      handRaised: isLocal
        ? this.#handRaised
        : (this.#handQueue?.peerIds.includes(participant.peerId) ?? false),
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
    if (status !== 'connected') this.#participantActivity.forget(peerId);
    const participant = this.#participants.get(peerId);
    if (participant !== undefined) {
      participant.connectionState = status;
      this.#emit();
    }
  }

  #failPeer(
    peerId: string,
    error: unknown,
    code: RoomIssueCode = 'peer-negotiation-failed',
    message = `Connection to ${peerId} failed: ${getErrorMessage(error)}`,
  ): void {
    this.#exhaustedPeerIds.add(peerId);
    this.#setPeerConnectionStatus(peerId, 'failed');
    this.#cleanupPeer(peerId, false);
    this.#setPeerWarning(peerId, code, message);
  }

  #failPeerConnectionTimeout(peer: PeerContext): void {
    if (!this.#isCurrentPeer(peer)) {
      return;
    }
    this.#failPeer(
      peer.peerId,
      null,
      'peer-connection-timeout',
      `Could not connect to ${peer.peerId} after retrying. Check your network, then reconnect to the room or leave.`,
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
    this.#participantActivity.forget(peer.peerId);
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
    this.#study.reset();
    this.#participantActivity.reset();
    for (const peerId of this.#peerRetryRequests.keys()) this.#clearPeerRetry(peerId);
    this.#peerConnectionEpochs.clear();
    for (const peerId of [...this.#peers.keys()]) {
      this.#cleanupPeer(peerId, false);
      this.#clearPeerWarning(peerId);
    }
    this.#remoteStreams.clear();
  }

  // 퇴장·입장 실패·재연결 소진·치명적 오류로 세션을 끝낼 때 연결·미디어·참가자 상태를 한 번에 정리한다.
  #terminate(closeReason: string): void {
    this.#disposed = true;
    this.#signalingRecovery.cancelReconnectWait();
    this.#signalingTransport.close(closeReason);
    this.#cleanupPeerResources();
    this.#remoteMediaStates.clear();
    this.#exhaustedPeerIds.clear();
    this.#participants.clear();
    this.#selfId = null;
    this.#selfRole = null;
    this.#canModerateMedia = false;

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
    if (this.#study.rejectCommand(requestId)) {
      this.#emit();
    }
    const error = new RoomSessionFailure(
      code,
      `The signaling server rejected the request (${code}).`,
    );
    if (this.#signalingRecovery.rejectJoin(error)) {
      return;
    }

    if (this.#status !== 'active') {
      return;
    }

    const requestedPeerId =
      requestId === undefined ? null : this.#signalingTransport.takePendingPeerId(requestId);

    switch (code) {
      case 'TARGET_NOT_FOUND': {
        if (requestedPeerId !== null) {
          this.#removePeer(requestedPeerId);
        }
        return;
      }
      case 'TARGET_SELF': {
        if (requestedPeerId !== null) {
          this.#signalingTransport.close('signaling identity mismatch');
          this.#beginReconnect(error);
        }
        return;
      }
      case 'NOT_IN_ROOM':
      case 'ROOM_MISMATCH':
        this.#signalingTransport.close('signaling state mismatch');
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
    if (this.#disposed) {
      return;
    }
    this.#terminate('fatal signaling error');
    this.#warning = null;
    this.#setFatalError(error.code, error.message);
  }

  #setStatus(status: RoomSessionStatus): void {
    this.#status = status;
    this.#emit();
  }

  #setWarning(code: RoomIssueCode, message: string): void {
    this.#warning = { code, message, peerId: null };
    this.#emit();
  }

  #setPeerWarning(peerId: string, code: RoomIssueCode, message: string): void {
    this.#warning = { code, message, peerId };
    this.#emit();
  }

  #clearPeerWarning(peerId: string, codes?: readonly RoomIssueCode[]): boolean {
    if (
      this.#warning?.peerId !== peerId ||
      this.#warning === null ||
      (codes !== undefined && !codes.includes(this.#warning.code))
    ) {
      return false;
    }
    this.#warning = null;
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
      ...this.#study.snapshot(),
      handQueue:
        this.#handQueue === null
          ? null
          : { ...this.#handQueue, peerIds: [...this.#handQueue.peerIds] },
      status: this.#status,
      selfId: this.#selfId,
      canModerateMedia: this.#canModerateMedia,
      screenShareAvailable: this.#screenShare.isAvailable(),
      screenSharing: this.#screenShare.isSharing(),
      screenSharePending: this.#screenShare.getPending(),
      screenShareQuality: this.#screenShare.getQuality(),
      videoQualityMode: this.#videoQualityMode,
      participants: [...this.#participants.values()].map((participant) => {
        const activity = this.#participantActivity.get(participant.peerId);
        return { ...participant, ...(activity === undefined ? {} : { activity: { ...activity } }) };
      }),
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
          ? { code: this.#warning.code, message: this.#warning.message }
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
