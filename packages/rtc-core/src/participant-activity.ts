import { ParticipantMonitor, type ParticipantActivity } from './participant-monitor.js';
import type { PeerConnectionLifecycle } from './peer-connection-lifecycle.js';

interface ParticipantActivityOptions {
  readonly monotonicNow: () => number;
  readonly isActive: () => boolean;
  readonly peers: () => Iterable<PeerConnectionLifecycle>;
  readonly isCurrentPeer: (peer: PeerConnectionLifecycle) => boolean;
  /** 측정 중 바뀐 상대 마이크 상태도 반영하도록 참가자 객체를 그대로 돌려준다. */
  readonly participant: (peerId: string) => { readonly audioEnabled: boolean } | undefined;
  readonly localAudioEnabled: () => boolean;
  readonly selfId: () => string | null;
  readonly onChanged: () => void;
}

/** 연결된 상대의 통계를 요청 시 측정해 발화·수신 품질 표시 상태만 보관한다. */
export class ParticipantActivityTracker {
  readonly #options: ParticipantActivityOptions;
  readonly #monitors = new Map<string, ParticipantMonitor>();
  readonly #activity = new Map<string, ParticipantActivity>();
  #generation = 0;
  #pending = false;

  constructor(options: ParticipantActivityOptions) {
    this.#options = options;
  }

  get(peerId: string): ParticipantActivity | undefined {
    return this.#activity.get(peerId);
  }

  forget(peerId: string): void {
    this.#monitors.delete(peerId);
    this.#activity.delete(peerId);
  }

  /** 진행 중인 측정의 결과도 반영하지 않는다. */
  reset(): void {
    this.#generation += 1;
    this.#monitors.clear();
    this.#activity.clear();
  }

  async sample(qualityEnabled: boolean): Promise<void> {
    if (!this.#options.isActive() || this.#pending) return;
    this.#pending = true;
    const generation = this.#generation;
    let localSpeaking = false;
    try {
      await Promise.all(
        [...this.#options.peers()].map(async (peer) => {
          if (peer.connection.connectionState !== 'connected') return;
          const participant = this.#options.participant(peer.peerId);
          if (!participant) return;
          if (!qualityEnabled && !participant.audioEnabled && !this.#options.localAudioEnabled()) {
            this.forget(peer.peerId);
            return;
          }
          try {
            const report = await peer.connection.getStats();
            if (
              generation !== this.#generation ||
              !this.#options.isCurrentPeer(peer) ||
              peer.connection.connectionState !== 'connected'
            )
              return;
            let monitor = this.#monitors.get(peer.peerId);
            if (!monitor) {
              monitor = new ParticipantMonitor();
              this.#monitors.set(peer.peerId, monitor);
            }
            const { localSpeaking: peerLocalSpeaking, ...activity } = monitor.sample(
              report,
              this.#options.monotonicNow(),
              participant.audioEnabled,
              this.#options.localAudioEnabled(),
              qualityEnabled,
            );
            this.#activity.set(peer.peerId, activity);
            localSpeaking ||= peerLocalSpeaking;
          } catch {
            if (generation === this.#generation && this.#options.isCurrentPeer(peer)) {
              this.forget(peer.peerId);
            }
          }
        }),
      );
      if (generation === this.#generation && this.#options.isActive()) {
        const selfId = this.#options.selfId();
        if (selfId) {
          this.#activity.set(selfId, { speaking: localSpeaking, receptionQuality: 'unavailable' });
        }
        this.#options.onChanged();
      }
    } finally {
      this.#pending = false;
    }
  }
}
