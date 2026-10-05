import type { PeerConnectionLifecycle } from './peer-connection-lifecycle.js';
import type { PeerNegotiationLifecycle } from './peer-negotiation-lifecycle.js';
import { getErrorMessage } from './errors.js';

type SenderRecoveryWarningCode = 'screen-share-sender-recovery' | 'media-device-sender-recovery';
type PeerRecoveryWarningCode =
  | SenderRecoveryWarningCode
  | 'peer-connection-recovering'
  | 'peer-connection-recreated'
  | 'peer-ice-restart-failed'
  | 'peer-restart-deferred'
  | 'peer-negotiation-retrying'
  | 'ice-candidate-queue-overflow'
  | 'ice-candidate-rejected';

// 연결이 복구되면 지우는 경고다.
const RECOVERY_WARNING_CODES: readonly PeerRecoveryWarningCode[] = [
  'peer-connection-recovering',
  'peer-connection-recreated',
  'peer-ice-restart-failed',
  'peer-restart-deferred',
  'peer-negotiation-retrying',
  'screen-share-sender-recovery',
  'media-device-sender-recovery',
  'ice-candidate-queue-overflow',
  'ice-candidate-rejected',
];

interface PeerRecoveryLifecycleOptions {
  readonly maxReconnectAttempts: number;
  readonly peerConnectionTimeoutMs: number;
  readonly peerDisconnectedGraceMs: number;
  readonly peerRecoveryTimeoutMs: number;
  readonly reconnectDelay: (attempt: number) => number;
  readonly negotiation: Pick<PeerNegotiationLifecycle, 'createOffer'>;
  readonly getPeer: (peerId: string) => PeerConnectionLifecycle | undefined;
  readonly isCurrentPeer: (peer: PeerConnectionLifecycle) => boolean;
  readonly selfId: () => string | null;
  readonly isActive: () => boolean;
  readonly isDisposed: () => boolean;
  readonly replacePeer: (
    peerId: string,
    preservePendingCandidates: boolean,
  ) => PeerConnectionLifecycle;
  readonly failPeer: (peerId: string, error: unknown) => void;
  readonly failPeerConnectionTimeout: (peer: PeerConnectionLifecycle) => void;
  readonly setPeerConnectionStatus: (peerId: string, status: RTCPeerConnectionState) => void;
  /** 참가자 연결 상태를 connected로 되돌렸으면 true를 돌려준다. 알림은 호출하는 쪽이 보낸다. */
  readonly restoreConnectedStatus: (peerId: string) => boolean;
  readonly setPeerWarning: (peerId: string, code: PeerRecoveryWarningCode, message: string) => void;
  readonly clearPeerWarning: (peerId: string, codes: readonly PeerRecoveryWarningCode[]) => boolean;
  readonly onStateChanged: () => void;
}

/** 피어 연결의 첫 offer 재시도, 연결 제한 시간, ICE 복구와 연결 재생성을 관리한다. */
export class PeerRecoveryLifecycle {
  readonly #options: PeerRecoveryLifecycleOptions;

  constructor(options: PeerRecoveryLifecycleOptions) {
    this.#options = options;
  }

  /** 두 참가자 중 ID가 작은 쪽만 ICE restart와 재생성 offer를 보낸다. */
  isInitiator(peerId: string): boolean {
    const selfId = this.#options.selfId();
    return selfId !== null && selfId < peerId;
  }

  scheduleInitialOfferRetry(peerId: string, error: unknown): void {
    const peer = this.#options.getPeer(peerId);
    if (
      peer === undefined ||
      !this.#options.isCurrentPeer(peer) ||
      this.#options.isDisposed() ||
      peer.hasTimer('offer-retry') ||
      peer.hasTimer('recovery')
    ) {
      return;
    }

    if (peer.offerRetryAttempts >= this.#options.maxReconnectAttempts) {
      this.#options.failPeer(peerId, error);
      return;
    }
    peer.offerRetryAttempts += 1;
    const retryAttempt = peer.offerRetryAttempts;
    peer.recovering = true;
    this.#options.setPeerConnectionStatus(peerId, 'connecting');
    this.#options.setPeerWarning(
      peerId,
      'peer-negotiation-retrying',
      `Initial connection to ${peerId} failed; retry ${retryAttempt}/${this.#options.maxReconnectAttempts} is scheduled: ${getErrorMessage(error)}`,
    );
    peer.scheduleTimer('offer-retry', this.#options.reconnectDelay(retryAttempt), () => {
      if (!this.#options.isCurrentPeer(peer) || !this.#options.isActive()) {
        return;
      }

      let retryPeer = peer;
      if (peer.connection.connectionState === 'failed') {
        try {
          retryPeer = this.#options.replacePeer(peer.peerId, true);
        } catch (replacementError) {
          this.#options.failPeer(peer.peerId, replacementError);
          return;
        }
      }
      void this.#options.negotiation
        .createOffer(retryPeer.peerId)
        .then((offerPublished) => {
          if (!offerPublished) {
            return;
          }
          if (this.#options.isCurrentPeer(retryPeer) && !retryPeer.hasTimer('recovery')) {
            retryPeer.offerRetryAttempts = 0;
            if (this.#options.clearPeerWarning(retryPeer.peerId, ['peer-negotiation-retrying'])) {
              this.#options.onStateChanged();
            }
          }
        })
        .catch((retryError: unknown) => {
          if (this.#options.isCurrentPeer(retryPeer)) {
            this.scheduleInitialOfferRetry(retryPeer.peerId, retryError);
          }
        });
    });
  }

  scheduleConnectionTimeout(peer: PeerConnectionLifecycle): void {
    if (!this.#options.isCurrentPeer(peer) || peer.hasTimer('connection')) {
      return;
    }

    peer.scheduleTimer('connection', this.#options.peerConnectionTimeoutMs, () => {
      if (!this.#options.isCurrentPeer(peer) || !this.#options.isActive()) {
        return;
      }
      if (peer.connection.connectionState === 'connected' && peer.data.isOpen()) {
        this.finish(peer);
        return;
      }

      if (peer.connectionAttempt > 0) {
        this.#options.failPeerConnectionTimeout(peer);
        return;
      }

      this.#options.setPeerWarning(
        peer.peerId,
        'peer-connection-recovering',
        `Connection to ${peer.peerId} did not complete within ${this.#options.peerConnectionTimeoutMs}ms; attempting ICE recovery`,
      );
      this.begin(peer);
    });
  }

  scheduleDisconnectedRecovery(peer: PeerConnectionLifecycle): void {
    if (!this.#options.isCurrentPeer(peer) || peer.hasTimer('disconnected')) {
      return;
    }
    peer.recovering = true;
    peer.scheduleTimer('disconnected', this.#options.peerDisconnectedGraceMs, () => {
      if (
        !this.#options.isCurrentPeer(peer) ||
        (peer.connection.connectionState !== 'disconnected' &&
          peer.connection.connectionState !== 'failed')
      ) {
        return;
      }
      this.begin(peer);
    });
  }

  begin(peer: PeerConnectionLifecycle): void {
    if (
      !this.#options.isCurrentPeer(peer) ||
      !this.#options.isActive() ||
      this.#options.selfId() === null
    ) {
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
    peer.scheduleTimer('recovery', this.#options.peerRecoveryTimeoutMs, () => {
      if (!this.#options.isCurrentPeer(peer)) {
        return;
      }
      if (peer.connection.connectionState === 'connected' && peer.data.isOpen()) {
        this.finish(peer);
        return;
      }

      this.#recreate(
        peer.peerId,
        'peer-connection-recreated',
        `Recreated the connection to ${peer.peerId} after ICE recovery timed out`,
      );
    });

    if (!this.isInitiator(peer.peerId)) {
      return;
    }
    void this.#options.negotiation
      .createOffer(peer.peerId, { iceRestart: true })
      .catch((error: unknown) => {
        if (this.#options.isCurrentPeer(peer)) {
          this.#options.setPeerWarning(
            peer.peerId,
            'peer-ice-restart-failed',
            `ICE restart for ${peer.peerId} failed: ${getErrorMessage(error)}`,
          );
        }
      });
  }

  finish(peer: PeerConnectionLifecycle): void {
    if (peer.connection.connectionState !== 'connected' || !peer.data.isOpen()) {
      return;
    }
    const shouldFlush = peer.hasRecoveryActivity();
    const restoredConnectedState = this.#options.restoreConnectedStatus(peer.peerId);
    peer.cancelAllTimers();
    peer.offerRetryAttempts = 0;
    peer.connectionAttempt = 0;
    peer.recovering = false;
    const warningCleared =
      this.#options.clearPeerWarning(peer.peerId, RECOVERY_WARNING_CODES) ||
      peer.data.clearRecoveryWarning();
    if (shouldFlush) {
      peer.data.flush(true);
    }
    if (restoredConnectedState || warningCleared) {
      this.#options.onStateChanged();
    }
  }

  recoverAfterSenderFailure(
    failures: ReadonlyMap<PeerConnectionLifecycle, unknown>,
    phase: string,
    warningCode: SenderRecoveryWarningCode = 'screen-share-sender-recovery',
  ): void {
    if (this.#options.isDisposed() || failures.size === 0) {
      return;
    }
    for (const [failedPeer, error] of failures) {
      if (!this.#options.isCurrentPeer(failedPeer)) {
        continue;
      }
      this.#recreate(
        failedPeer.peerId,
        warningCode,
        `Recreated the connection to ${failedPeer.peerId} after ${phase} failed: ${getErrorMessage(error)}`,
      );
    }
  }

  // 실패한 연결을 새 연결로 바꾸고 경고를 남긴 뒤, 복구를 시작하는 쪽이면 새 offer를 보낸다.
  #recreate(peerId: string, warningCode: PeerRecoveryWarningCode, message: string): void {
    const shouldOffer = this.isInitiator(peerId);
    let replacement: PeerConnectionLifecycle;
    try {
      replacement = this.#options.replacePeer(peerId, false);
    } catch (error) {
      this.#options.failPeer(peerId, error);
      return;
    }
    this.#options.setPeerWarning(peerId, warningCode, message);
    if (shouldOffer) {
      void this.#options.negotiation.createOffer(peerId).catch((error: unknown) => {
        if (this.#options.isCurrentPeer(replacement)) {
          this.#options.failPeer(peerId, error);
        }
      });
    }
  }
}
