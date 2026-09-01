import type { SerializedIceCandidate } from '@round/protocol';
import type { PeerDataChannel } from './peer-data-channel.js';

type PeerTimer = 'connection' | 'offer-retry' | 'disconnected' | 'recovery';
type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

const MAX_RETIRED_NEGOTIATION_IDS = 8;

interface PendingRemoteCandidates {
  readonly candidates: (SerializedIceCandidate | null)[];
  readonly overflowWarned: boolean;
}

/** 단일 RTCPeerConnection의 협상 세대, ICE 대기열, 복구 타이머를 소유한다. */
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
  readonly #remoteOffersInProgress = new Set<string | null>();
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

  beginRemoteOffer(negotiationId: string | null): void {
    this.#remoteOffersInProgress.add(negotiationId);
  }

  endRemoteOffer(negotiationId: string | null): void {
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

  replaceNegotiationId(negotiationId: string | null): void {
    if (this.#negotiationId === negotiationId) {
      return;
    }
    this.#rememberRetiredNegotiation(this.#negotiationId);
    this.#negotiationId = negotiationId;
    this.clearPendingRemoteCandidates();
    this.resetLocalDescription();
    this.#localIceUsernameFragments.clear();
  }

  canAcceptRemoteOffer(negotiationId?: string): boolean {
    const normalizedNegotiationId = negotiationId ?? null;
    if (this.#remoteOffersInProgress.has(normalizedNegotiationId)) {
      return false;
    }
    if (negotiationId === undefined) {
      return (
        this.#negotiationId === null &&
        this.#retiredNegotiationIds.size === 0 &&
        this.connectionAttempt === 0 &&
        !this.remoteDescriptionSet &&
        !this.localDescriptionPublished
      );
    }
    if (this.#retiredNegotiationIds.has(negotiationId)) {
      return false;
    }
    if (this.#negotiationId !== negotiationId) {
      return true;
    }
    return !this.remoteDescriptionSet && !this.localDescriptionPublished;
  }

  matchesNegotiation(negotiationId?: string): boolean {
    if (negotiationId === undefined) {
      return this.#negotiationId === null && this.#retiredNegotiationIds.size === 0;
    }
    return this.#negotiationId === negotiationId && !this.#retiredNegotiationIds.has(negotiationId);
  }

  adoptOrMatchCandidateNegotiation(negotiationId?: string): boolean {
    if (this.matchesNegotiation(negotiationId)) {
      return true;
    }
    if (
      negotiationId === undefined ||
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

  rememberCurrentNegotiation(): void {
    this.#rememberRetiredNegotiation(this.#negotiationId);
  }

  retiredNegotiationIdsSnapshot(): ReadonlySet<string> {
    return new Set(this.#retiredNegotiationIds);
  }

  queueRemoteCandidate(candidate: SerializedIceCandidate | null, limit: number): boolean {
    let shouldWarn = false;
    if (this.#pendingRemoteCandidates.length >= limit) {
      this.#pendingRemoteCandidates.shift();
      if (!this.#pendingCandidateOverflowWarned) {
        this.#pendingCandidateOverflowWarned = true;
        shouldWarn = true;
      }
    }
    this.#pendingRemoteCandidates.push(candidate);
    return shouldWarn;
  }

  takePendingRemoteCandidates(): (SerializedIceCandidate | null)[] {
    const candidates = this.#pendingRemoteCandidates.splice(0);
    this.#pendingCandidateOverflowWarned = false;
    return candidates;
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
