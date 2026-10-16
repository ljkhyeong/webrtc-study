import {
  ParticipationGrantAccessError,
  ParticipationGrantLeaseManager,
} from './participation-grant';
import { RoomRefreshLifetime } from './room-refresh-lifetime';
import { loadRtcConfiguration } from './rtc-configuration';
import { renewSignalingLease } from './signaling-lease';
import { turnCredentialRefreshDelayMs, TurnCredentialRateLimitError } from './turn';

const REFRESH_RETRY_DELAY_MS = 30_000;
// 참여권은 만료 약 1분 전에 갱신하므로 연결 연장 실패는 그 안에서 두 번까지 다시 시도한다.
const LEASE_RETRY_DELAY_MS = 10_000;
const MAX_LEASE_RETRIES = 2;
const PARTICIPATION_GRANT_WARNING =
  '스터디 참여 권한을 갱신하지 못했습니다. 현재 통화는 유지하며 곧 다시 시도합니다.';
const TURN_WARNING =
  '통화 중계 정보를 갱신하지 못했습니다. 현재 통화는 유지하며 곧 다시 시도합니다.';

interface RoomRefreshCoordinatorOptions {
  readonly participationGrantLeaseManager?: ParticipationGrantLeaseManager | undefined;
  readonly isCurrent: () => boolean;
  readonly updateRtcConfiguration: (configuration: RTCConfiguration) => void;
  readonly onParticipationGrantWarning: (message: string) => void;
  readonly onTurnWarning: (message: string) => void;
  readonly onParticipationGrantAccessFailure?: (error: ParticipationGrantAccessError) => void;
  /** 입장한 시그널링 연결의 참가자 ID다. 입장 전이거나 재연결 중이면 `null`이다. */
  readonly currentSignalingPeerId?: () => string | null;
}

/** 활성 방의 참여권·TURN 갱신 일정과 진행 중인 요청을 관리한다. */
export class RoomRefreshCoordinator {
  readonly #options: RoomRefreshCoordinatorOptions;
  readonly #lifetime = new RoomRefreshLifetime();
  readonly #requestController = new AbortController();

  #participationGrantLeaseManager: ParticipationGrantLeaseManager | null;
  #ownsParticipationGrantLeaseManager = false;
  #turnCredentialsUrl: string | null = null;
  #signalingUrl: string | null = null;
  #leaseGrantCount: number | null = null;
  #connectGrantCount: number | null = null;
  #joinedGrantCount: number | null = null;
  // 예약 타이머는 운영체제 절전 중 단조 증가 시계와 함께 멈출 수 있어 갱신 시점을 기기 시각으로도 둔다.
  #turnRefreshDueAtWallMs: number | null = null;

  constructor(options: RoomRefreshCoordinatorOptions) {
    this.#options = options;
    this.#participationGrantLeaseManager = options.participationGrantLeaseManager ?? null;
  }

  get turnRequestSignal(): AbortSignal {
    return this.#requestController.signal;
  }

  hasParticipationGrantManager(): boolean {
    return this.#participationGrantLeaseManager !== null;
  }

  configureParticipationGrant(endpoint: string, roomId: string): void {
    if (!this.#lifetime.isActive() || this.#participationGrantLeaseManager !== null) return;
    this.#participationGrantLeaseManager = new ParticipationGrantLeaseManager({ endpoint, roomId });
    this.#ownsParticipationGrantLeaseManager = true;
  }

  setTurnCredentialsUrl(url: string): void {
    this.#turnCredentialsUrl = url;
  }

  setSignalingUrl(url: string): void {
    this.#signalingUrl = url;
  }

  /**
   * 시그널링 연결 직전에 호출한다. 서버는 끊긴 연결을 정리하기 전까지 같은 참여권의 두 번째
   * 연결을 거부하므로, 방에 입장했던 연결의 참여권이면 갱신 시점 전이어도 새로 받는다.
   */
  async prepareSignalingConnect(): Promise<void> {
    const manager = this.#participationGrantLeaseManager;
    if (manager === null) return;
    await this.ensureFreshParticipationGrant({
      force: manager.issuedGrantCount === this.#joinedGrantCount,
    });
    this.#connectGrantCount = manager.issuedGrantCount;
    this.refreshOverdueTurn();
  }

  /** 시그널링 연결이 방에 입장하면 호출한다. 그 연결에 쓴 참여권은 다음 재연결에 쓰지 않는다. */
  markSignalingJoined(): void {
    this.#joinedGrantCount = this.#connectGrantCount;
  }

  async ensureFreshParticipationGrant(options: { readonly force?: boolean } = {}): Promise<void> {
    const manager = this.#participationGrantLeaseManager;
    if (manager === null || !this.#canRefresh()) return;

    try {
      await manager.ensureFresh(options);
    } catch (error) {
      if (error instanceof ParticipationGrantAccessError) {
        this.stop();
        this.#options.onParticipationGrantWarning('');
        this.#options.onParticipationGrantAccessFailure?.(error);
        throw error;
      }
      if (this.#canRefresh()) {
        this.#options.onParticipationGrantWarning(PARTICIPATION_GRANT_WARNING);
        this.#scheduleParticipationGrantRefresh(REFRESH_RETRY_DELAY_MS);
      }
      throw error;
    }

    if (!this.#canRefresh()) return;
    this.#options.onParticipationGrantWarning('');
    if (manager.issuedGrantCount !== this.#leaseGrantCount) {
      this.#leaseGrantCount = manager.issuedGrantCount;
      void this.#renewSignalingLease(0);
    }
    const delayMs = manager.refreshDelayMs();
    if (delayMs !== null) {
      this.#scheduleParticipationGrantRefresh(delayMs);
    }
  }

  scheduleTurnRefresh(refreshDueAtMs: number): void {
    if (!this.#canRefresh()) return;
    const delayMs = turnCredentialRefreshDelayMs(refreshDueAtMs);
    this.#turnRefreshDueAtWallMs = Date.now() + delayMs;
    this.#lifetime.schedule(
      'turn',
      () => {
        void this.#refreshTurnConfiguration();
      },
      delayMs,
    );
  }

  /** 절전에서 깨어나 기기 시각으로 TURN 갱신 시점이 이미 지났으면 늦어진 예약 대신 바로 갱신한다. */
  refreshOverdueTurn(): void {
    const dueAt = this.#turnRefreshDueAtWallMs;
    if (dueAt === null || Date.now() < dueAt || !this.#canRefresh()) return;
    this.#turnRefreshDueAtWallMs = null;
    this.#lifetime.schedule(
      'turn',
      () => {
        void this.#refreshTurnConfiguration();
      },
      0,
    );
  }

  stop(): void {
    this.#lifetime.stop();
    if (this.#ownsParticipationGrantLeaseManager) {
      this.#participationGrantLeaseManager?.close();
    }
    this.#requestController.abort();
  }

  #canRefresh(): boolean {
    return this.#options.isCurrent() && this.#lifetime.isActive();
  }

  #scheduleParticipationGrantRefresh(delayMs: number): void {
    if (!this.#canRefresh()) return;
    this.#lifetime.schedule(
      'participation-grant',
      () => {
        void this.#refreshParticipationGrant();
      },
      delayMs,
    );
  }

  // 서버는 연결의 만료 시각을 연결할 때의 참여권으로 정하므로, 새 참여권을 받으면 현재 연결에 알린다.
  // 연장하지 못한 연결은 만료 때 닫히고 기존 재연결 절차로 복구한다.
  async #renewSignalingLease(retries: number): Promise<void> {
    const signalingUrl = this.#signalingUrl;
    const peerId = this.#options.currentSignalingPeerId?.() ?? null;
    if (signalingUrl === null || peerId === null || !this.#canRefresh()) return;
    try {
      await renewSignalingLease(signalingUrl, peerId, this.#requestController.signal);
    } catch {
      if (retries >= MAX_LEASE_RETRIES || !this.#canRefresh()) return;
      this.#lifetime.schedule(
        'signaling-lease',
        () => {
          void this.#renewSignalingLease(retries + 1);
        },
        LEASE_RETRY_DELAY_MS,
      );
    }
  }

  async #refreshParticipationGrant(): Promise<void> {
    try {
      await this.ensureFreshParticipationGrant();
    } catch {
      // ensureFreshParticipationGrant가 사용자 경고와 재시도를 함께 처리한다.
    }
  }

  #scheduleTurnRefreshRetry(error?: unknown): void {
    if (!this.#canRefresh()) return;
    this.#lifetime.schedule(
      'turn',
      () => {
        void this.#refreshTurnConfiguration();
      },
      error instanceof TurnCredentialRateLimitError
        ? Math.max(REFRESH_RETRY_DELAY_MS, error.retryAfterMs)
        : REFRESH_RETRY_DELAY_MS,
    );
  }

  async #refreshTurnConfiguration(): Promise<void> {
    const turnCredentialsUrl = this.#turnCredentialsUrl;
    if (turnCredentialsUrl === null || !this.#canRefresh()) return;

    try {
      await this.ensureFreshParticipationGrant();
    } catch {
      this.#scheduleTurnRefreshRetry();
      return;
    }
    if (!this.#canRefresh()) return;

    try {
      const loaded = await loadRtcConfiguration(turnCredentialsUrl, this.#requestController.signal);
      if (!this.#canRefresh()) return;
      this.#options.updateRtcConfiguration(loaded.configuration);
      this.#options.onTurnWarning('');
      if (loaded.turnRefreshDueAtMs !== null) {
        this.scheduleTurnRefresh(loaded.turnRefreshDueAtMs);
      }
    } catch (error) {
      if (!this.#canRefresh()) return;
      this.#options.onTurnWarning(TURN_WARNING);
      this.#scheduleTurnRefreshRetry(error);
    }
  }
}
