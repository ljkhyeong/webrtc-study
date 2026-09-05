import {
  ParticipationGrantAccessError,
  ParticipationGrantLeaseManager,
} from './participation-grant';
import { RoomRefreshLifetime } from './room-refresh-lifetime';
import { loadRtcConfiguration } from './rtc-configuration';
import { turnCredentialRefreshDelayMs } from './turn';

const REFRESH_RETRY_DELAY_MS = 30_000;
const PARTICIPATION_GRANT_WARNING =
  '스터디 참여 권한을 갱신하지 못했습니다. 현재 통화는 유지하며 곧 다시 시도합니다.';
const TURN_WARNING =
  '통화 연결 정보를 갱신하지 못했습니다. 현재 통화는 유지하며 곧 다시 시도합니다.';

interface RoomRefreshCoordinatorOptions {
  readonly participationGrantLeaseManager?: ParticipationGrantLeaseManager | undefined;
  readonly isCurrent: () => boolean;
  readonly updateRtcConfiguration: (configuration: RTCConfiguration) => void;
  readonly onParticipationGrantWarning: (message: string) => void;
  readonly onTurnWarning: (message: string) => void;
  readonly onParticipationGrantAccessFailure?: (error: ParticipationGrantAccessError) => void;
}

/** 활성 방 하나의 참여권·TURN 갱신 타이머와 진행 중인 요청을 함께 소유한다. */
export class RoomRefreshCoordinator {
  readonly #options: RoomRefreshCoordinatorOptions;
  readonly #lifetime = new RoomRefreshLifetime();
  readonly #turnRequestController = new AbortController();

  #participationGrantLeaseManager: ParticipationGrantLeaseManager | null;
  #ownsParticipationGrantLeaseManager: boolean;
  #turnCredentialsUrl: string | null = null;

  constructor(options: RoomRefreshCoordinatorOptions) {
    this.#options = options;
    this.#participationGrantLeaseManager = options.participationGrantLeaseManager ?? null;
    this.#ownsParticipationGrantLeaseManager = false;
  }

  get turnRequestSignal(): AbortSignal {
    return this.#turnRequestController.signal;
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

  async ensureFreshParticipationGrant(): Promise<void> {
    const manager = this.#participationGrantLeaseManager;
    if (manager === null || !this.#canRefresh()) return;

    try {
      await manager.ensureFresh();
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
    const delayMs = manager.refreshDelayMs();
    if (delayMs !== null) {
      this.#scheduleParticipationGrantRefresh(delayMs);
    }
  }

  scheduleTurnRefresh(refreshDueAtMs: number): void {
    if (!this.#canRefresh()) return;
    this.#lifetime.schedule(
      'turn',
      () => {
        void this.#refreshTurnConfiguration();
      },
      turnCredentialRefreshDelayMs(refreshDueAtMs),
    );
  }

  stop(): void {
    this.#lifetime.stop();
    if (this.#ownsParticipationGrantLeaseManager) {
      this.#participationGrantLeaseManager?.close();
    }
    this.#turnRequestController.abort();
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

  async #refreshParticipationGrant(): Promise<void> {
    try {
      await this.ensureFreshParticipationGrant();
    } catch {
      // ensureFreshParticipationGrant가 사용자 경고와 재시도를 함께 처리한다.
    }
  }

  #scheduleTurnRefreshRetry(): void {
    if (!this.#canRefresh()) return;
    this.#lifetime.schedule(
      'turn',
      () => {
        void this.#refreshTurnConfiguration();
      },
      REFRESH_RETRY_DELAY_MS,
    );
  }

  async #refreshTurnConfiguration(): Promise<void> {
    const turnCredentialsUrl = this.#turnCredentialsUrl;
    if (turnCredentialsUrl === null || !this.#canRefresh()) return;

    try {
      await this.ensureFreshParticipationGrant();
    } catch {
      if (this.#canRefresh()) {
        this.#scheduleTurnRefreshRetry();
      }
      return;
    }
    if (!this.#canRefresh()) return;

    try {
      const loaded = await loadRtcConfiguration(
        turnCredentialsUrl,
        this.#turnRequestController.signal,
      );
      if (!this.#canRefresh()) return;
      this.#options.updateRtcConfiguration(loaded.configuration);
      this.#options.onTurnWarning('');
      if (loaded.turnRefreshDueAtMs !== null) {
        this.scheduleTurnRefresh(loaded.turnRefreshDueAtMs);
      }
    } catch {
      if (!this.#canRefresh()) return;
      this.#options.onTurnWarning(TURN_WARNING);
      this.#scheduleTurnRefreshRetry();
    }
  }
}
