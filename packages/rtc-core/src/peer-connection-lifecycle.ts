import type { SerializedIceCandidate } from '@round/protocol';
import type { PeerDataChannel } from './peer-data-channel.js';

const MAX_PENDING_REMOTE_ICE_CANDIDATES = 256;

type PeerTimer = 'connection' | 'offer-retry' | 'disconnected' | 'recovery';
type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

const MAX_RETIRED_NEGOTIATION_IDS = 8;

export interface PeerMediaSenderUpdate {
  readonly peer: PeerConnectionLifecycle;
  readonly sender: RTCRtpSender;
  readonly previousTrack: MediaStreamTrack | null;
  readonly added: boolean;
}

interface PendingRemoteCandidates {
  readonly candidates: (SerializedIceCandidate | null)[];
  readonly overflowWarned: boolean;
}

/** RTCPeerConnection 하나의 협상 번호, ICE 대기열과 복구 타이머를 관리한다. */
export class PeerConnectionLifecycle {
  readonly trackReplacementAbort = new AbortController();

  videoSender: RTCRtpSender | null = null;
  videoQualityUpdate: Promise<boolean> = Promise.resolve(true);
  videoQualityLimited = false;
  videoQualityFailed = false;
  audioSender: RTCRtpSender | null = null;
  offerRetryAttempts = 0;
  pendingLocalRenegotiation = false;
  remoteDescriptionSet: boolean;
  localDescriptionPublished = false;
  makingOffer = false;
  recovering = false;
  closed = false;

  #negotiationId: string | null = null;
  readonly #retiredNegotiationIds: Set<string>;
  readonly #remoteOffersInProgress = new Set<string>();
  readonly #pendingRemoteCandidates: (SerializedIceCandidate | null)[] = [];
  readonly #pendingLocalCandidates: (SerializedIceCandidate | null)[] = [];
  readonly #localIceUsernameFragments = new Set<string>();
  #pendingCandidateOverflowWarned = false;
  readonly #timers = new Map<PeerTimer, TimerHandle>();

  constructor(
    readonly peerId: string,
    readonly connection: RTCPeerConnection,
    readonly data: PeerDataChannel,
    public connectionAttempt: number,
    retiredNegotiationIds: ReadonlySet<string>,
  ) {
    this.#retiredNegotiationIds = new Set(retiredNegotiationIds);
    this.remoteDescriptionSet = connection.remoteDescription !== null;
  }

  get negotiationId(): string | null {
    return this.#negotiationId;
  }

  hasRemoteOffersInProgress(): boolean {
    return this.#remoteOffersInProgress.size > 0;
  }

  beginRemoteOffer(negotiationId: string): void {
    this.#remoteOffersInProgress.add(negotiationId);
  }

  endRemoteOffer(negotiationId: string): void {
    this.#remoteOffersInProgress.delete(negotiationId);
  }

  startLocalNegotiation(createId: () => string): string {
    let negotiationId = createId();
    while (
      negotiationId === this.#negotiationId ||
      this.#retiredNegotiationIds.has(negotiationId)
    ) {
      negotiationId = createId();
    }
    this.replaceNegotiationId(negotiationId);
    return negotiationId;
  }

  replaceNegotiationId(negotiationId: string): void {
    if (this.#negotiationId === negotiationId) {
      return;
    }
    this.#rememberRetiredNegotiation(this.#negotiationId);
    this.#negotiationId = negotiationId;
    this.clearPendingRemoteCandidates();
    this.resetLocalDescription();
    this.#localIceUsernameFragments.clear();
  }

  canAcceptRemoteOffer(negotiationId: string): boolean {
    if (
      this.#remoteOffersInProgress.has(negotiationId) ||
      this.#retiredNegotiationIds.has(negotiationId)
    ) {
      return false;
    }
    if (this.#negotiationId !== negotiationId) {
      return true;
    }
    return !this.remoteDescriptionSet && !this.localDescriptionPublished;
  }

  matchesNegotiation(negotiationId: string): boolean {
    return this.#negotiationId === negotiationId && !this.#retiredNegotiationIds.has(negotiationId);
  }

  adoptOrMatchCandidateNegotiation(negotiationId: string): boolean {
    if (this.matchesNegotiation(negotiationId)) {
      return true;
    }
    if (
      this.#negotiationId !== null ||
      this.#retiredNegotiationIds.has(negotiationId) ||
      this.remoteDescriptionSet ||
      this.localDescriptionPublished
    ) {
      return false;
    }
    this.replaceNegotiationId(negotiationId);
    return true;
  }

  /** 교체할 연결의 현재 협상까지 폐기 목록에 넣어 돌려준다. 새 연결의 생성자가 복사한다. */
  retireNegotiations(): ReadonlySet<string> {
    this.#rememberRetiredNegotiation(this.#negotiationId);
    return this.#retiredNegotiationIds;
  }

  queueRemoteCandidate(candidate: SerializedIceCandidate | null): boolean {
    let shouldWarn = false;
    if (this.#pendingRemoteCandidates.length >= MAX_PENDING_REMOTE_ICE_CANDIDATES) {
      this.#pendingRemoteCandidates.shift();
      if (!this.#pendingCandidateOverflowWarned) {
        this.#pendingCandidateOverflowWarned = true;
        shouldWarn = true;
      }
    }
    this.#pendingRemoteCandidates.push(candidate);
    return shouldWarn;
  }

  extractPendingRemoteCandidates(): PendingRemoteCandidates {
    const pending = {
      candidates: this.#pendingRemoteCandidates.splice(0),
      overflowWarned: this.#pendingCandidateOverflowWarned,
    };
    this.#pendingCandidateOverflowWarned = false;
    return pending;
  }

  restorePendingRemoteCandidates(pending: PendingRemoteCandidates): void {
    this.#pendingRemoteCandidates.push(...pending.candidates);
    this.#pendingCandidateOverflowWarned = pending.overflowWarned;
  }

  clearPendingRemoteCandidates(): void {
    this.#pendingRemoteCandidates.length = 0;
    this.#pendingCandidateOverflowWarned = false;
  }

  queueLocalCandidate(candidate: SerializedIceCandidate | null): void {
    this.#pendingLocalCandidates.push(candidate);
  }

  resetLocalDescription(): void {
    this.localDescriptionPublished = false;
    this.#pendingLocalCandidates.length = 0;
  }

  publishLocalDescription(): (SerializedIceCandidate | null)[] {
    this.localDescriptionPublished = true;
    return this.#pendingLocalCandidates.splice(0);
  }

  captureLocalIceUsernameFragments(sdp: string | undefined): void {
    this.#localIceUsernameFragments.clear();
    if (sdp === undefined) {
      return;
    }
    for (const match of sdp.matchAll(/^a=ice-ufrag:([^\r\n]+)$/gm)) {
      const fragment = match[1]?.trim();
      if (fragment) {
        this.#localIceUsernameFragments.add(fragment);
      }
    }
  }

  candidateMatchesCurrentLocalNegotiation(candidate: SerializedIceCandidate | null): boolean {
    if (this.#retiredNegotiationIds.size === 0) {
      return true;
    }
    if (candidate === null) {
      return false;
    }
    const fragment = candidate.usernameFragment ?? null;
    return fragment !== null && this.#localIceUsernameFragments.has(fragment);
  }

  hasTimer(timer: PeerTimer): boolean {
    return this.#timers.has(timer);
  }

  hasRecoveryActivity(): boolean {
    return this.recovering || this.#timers.size > 0;
  }

  scheduleTimer(timer: PeerTimer, delayMs: number, callback: () => void): void {
    const handle = globalThis.setTimeout(() => {
      if (this.#timers.get(timer) !== handle) {
        return;
      }
      this.#timers.delete(timer);
      callback();
    }, delayMs);
    this.#timers.set(timer, handle);
  }

  cancelTimer(timer: PeerTimer): void {
    const handle = this.#timers.get(timer);
    if (handle === undefined) {
      return;
    }
    globalThis.clearTimeout(handle);
    this.#timers.delete(timer);
  }

  cancelAllTimers(): void {
    for (const handle of this.#timers.values()) {
      globalThis.clearTimeout(handle);
    }
    this.#timers.clear();
  }

  disposeConnection(): void {
    this.closed = true;
    this.trackReplacementAbort.abort();
    this.cancelAllTimers();
    this.connection.onicecandidate = null;
    this.connection.ontrack = null;
    this.connection.ondatachannel = null;
    this.connection.onconnectionstatechange = null;
    this.connection.onsignalingstatechange = null;
    this.connection.close();
    this.videoSender = null;
    this.audioSender = null;
    this.pendingLocalRenegotiation = false;
    this.clearPendingRemoteCandidates();
    this.#pendingLocalCandidates.length = 0;
    this.#remoteOffersInProgress.clear();
  }

  #rememberRetiredNegotiation(negotiationId: string | null): void {
    if (negotiationId === null || this.#retiredNegotiationIds.has(negotiationId)) {
      return;
    }
    while (this.#retiredNegotiationIds.size >= MAX_RETIRED_NEGOTIATION_IDS) {
      const oldestNegotiationId = this.#retiredNegotiationIds.values().next().value as string;
      this.#retiredNegotiationIds.delete(oldestNegotiationId);
    }
    this.#retiredNegotiationIds.add(negotiationId);
  }
}
