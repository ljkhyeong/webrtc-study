import {
  PROTOCOL_VERSION,
  type AnswerDescription,
  type ClientMessage,
  type OfferDescription,
  type SerializedIceCandidate,
} from '@round/protocol';
import type { PeerConnectionLifecycle } from './peer-connection-lifecycle.js';
import { PEER_DATA_CHANNEL_LABEL } from './peer-data-channel.js';
import type { SignalingTransport } from './signaling-transport.js';
import { getErrorMessage } from './errors.js';

type RelayClientMessage = Extract<ClientMessage, { to: string }>;
type PeerNegotiationStatus = RTCPeerConnectionState | 'negotiating';
type PeerNegotiationWarningCode =
  'peer-restart-deferred' | 'ice-candidate-queue-overflow' | 'ice-candidate-rejected';

interface PeerNegotiationLifecycleOptions {
  readonly roomId: string;
  readonly transport: SignalingTransport;
  readonly createNegotiationId: (peerId: string) => string;
  readonly getPeer: (peerId: string) => PeerConnectionLifecycle | undefined;
  readonly ensurePeer: (peerId: string) => PeerConnectionLifecycle;
  readonly replacePeer: (
    peerId: string,
    preservePendingCandidates: boolean,
  ) => PeerConnectionLifecycle;
  readonly isCurrentPeer: (peer: PeerConnectionLifecycle) => boolean;
  readonly isRoomActive: () => boolean;
  readonly isRoomReconnecting: () => boolean;
  readonly setPeerConnectionStatus: (peerId: string, status: PeerNegotiationStatus) => void;
  readonly setPeerWarning: (
    peerId: string,
    code: PeerNegotiationWarningCode,
    message: string,
  ) => void;
  readonly failPeerConnectionTimeout: (peer: PeerConnectionLifecycle) => void;
  readonly finishPeerRecovery: (peer: PeerConnectionLifecycle) => void;
  readonly updateVideoQuality: (peer: PeerConnectionLifecycle) => Promise<boolean>;
  readonly onRenegotiationFailed: (peerId: string, error: unknown) => void;
}

/** 단일 방의 offer·answer·ICE 협상 순서와 협상 세대 확인을 맡는다. */
export class PeerNegotiationLifecycle {
  readonly #options: PeerNegotiationLifecycleOptions;

  constructor(options: PeerNegotiationLifecycleOptions) {
    this.#options = options;
  }

  async createOffer(
    peerId: string,
    options: { readonly iceRestart?: boolean } = {},
  ): Promise<boolean> {
    const peer = this.#options.ensurePeer(peerId);
    if (peer.makingOffer || peer.hasRemoteOffersInProgress()) {
      return false;
    }
    if (peer.connection.signalingState !== 'stable') {
      if (options.iceRestart === true) {
        this.#options.setPeerWarning(
          peerId,
          'peer-restart-deferred',
          `ICE restart for ${peerId} is waiting for stable signaling`,
        );
      }
      return false;
    }

    peer.makingOffer = true;
    const negotiationId = peer.startLocalNegotiation(() =>
      this.#options.createNegotiationId(peerId),
    );
    peer.remoteDescriptionSet = false;
    this.#options.setPeerConnectionStatus(peerId, 'negotiating');

    try {
      if (!peer.data.isAttached()) {
        peer.data.attach(
          peer.connection.createDataChannel(PEER_DATA_CHANNEL_LABEL, {
            ordered: true,
          }),
        );
      }
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
      void this.#options.updateVideoQuality(peer);
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
      this.drainRenegotiation(peer);
    }
  }

  /** 송신 트랙을 추가한 연결은 신호 상태가 안정되면 새 offer를 보낸다. */
  requestRenegotiation(peer: PeerConnectionLifecycle): void {
    if (!this.#options.isCurrentPeer(peer)) {
      return;
    }
    peer.pendingLocalRenegotiation = true;
    this.drainRenegotiation(peer);
  }

  drainRenegotiation(peer: PeerConnectionLifecycle): void {
    if (
      !this.#options.isCurrentPeer(peer) ||
      !peer.pendingLocalRenegotiation ||
      !this.#options.isRoomActive() ||
      !this.#options.transport.isOpen() ||
      peer.makingOffer ||
      peer.hasRemoteOffersInProgress() ||
      peer.connection.signalingState !== 'stable'
    ) {
      return;
    }

    peer.pendingLocalRenegotiation = false;
    void this.createOffer(peer.peerId)
      .then((published) => {
        if (!published && this.#options.isCurrentPeer(peer)) {
          peer.pendingLocalRenegotiation = true;
        }
      })
      .catch((error: unknown) => {
        if (this.#options.isCurrentPeer(peer)) {
          this.#options.onRenegotiationFailed(peer.peerId, error);
        }
      });
  }

  async handleOffer(
    peerId: string,
    description: OfferDescription,
    negotiationId: string,
  ): Promise<void> {
    const existing = this.#options.getPeer(peerId);
    if (existing !== undefined && !existing.canAcceptRemoteOffer(negotiationId)) {
      return;
    }
    if (existing?.connection.connectionState === 'failed' && existing.connectionAttempt > 0) {
      this.#options.failPeerConnectionTimeout(existing);
      return;
    }
    const peer =
      existing?.connection.connectionState === 'failed'
        ? this.#options.replacePeer(peerId, true)
        : this.#options.ensurePeer(peerId);
    peer.replaceNegotiationId(negotiationId);
    peer.beginRemoteOffer(negotiationId);
    try {
      peer.remoteDescriptionSet = false;
      this.#options.setPeerConnectionStatus(peerId, 'negotiating');
      await peer.connection.setRemoteDescription(description);
      if (!this.#isCurrentNegotiation(peer, negotiationId)) {
        return;
      }
      peer.remoteDescriptionSet = true;
      await this.#flushPendingCandidates(peer, negotiationId);
      if (!this.#isCurrentNegotiation(peer, negotiationId)) {
        return;
      }

      peer.resetLocalDescription();
      const answer = await peer.connection.createAnswer();
      if (!this.#isCurrentNegotiation(peer, negotiationId)) {
        return;
      }
      await peer.connection.setLocalDescription(answer);
      if (!this.#isCurrentNegotiation(peer, negotiationId)) {
        return;
      }
      void this.#options.updateVideoQuality(peer);
      const localDescription = peer.connection.localDescription ?? answer;
      peer.captureLocalIceUsernameFragments(localDescription.sdp);
      this.#publishLocalDescription(peer, {
        v: PROTOCOL_VERSION,
        type: 'rtc.answer',
        roomId: this.#options.roomId,
        to: peerId,
        payload: {
          negotiationId,
          description: {
            type: 'answer',
            ...(localDescription.sdp === undefined ? {} : { sdp: localDescription.sdp }),
          },
        },
      });
      if (peer.connection.connectionState === 'connected') {
        this.#options.finishPeerRecovery(peer);
      }
    } catch (error) {
      if (!this.#isCurrentNegotiation(peer, negotiationId)) {
        return;
      }
      throw error;
    } finally {
      peer.endRemoteOffer(negotiationId);
      this.drainRenegotiation(peer);
    }
  }

  async handleAnswer(
    peerId: string,
    description: AnswerDescription,
    negotiationId: string,
  ): Promise<void> {
    const peer = this.#options.getPeer(peerId);
    if (
      peer === undefined ||
      !peer.matchesNegotiation(negotiationId) ||
      !peer.localDescriptionPublished ||
      peer.connection.signalingState !== 'have-local-offer'
    ) {
      return;
    }
    try {
      await peer.connection.setRemoteDescription(description);
      if (!this.#isCurrentNegotiation(peer, negotiationId)) {
        return;
      }
      peer.remoteDescriptionSet = true;
      await this.#flushPendingCandidates(peer, negotiationId);
      if (!this.#isCurrentNegotiation(peer, negotiationId)) {
        return;
      }
      if (peer.connection.connectionState === 'connected') {
        this.#options.finishPeerRecovery(peer);
      }
      void this.#options.updateVideoQuality(peer);
      this.drainRenegotiation(peer);
    } catch (error) {
      if (!this.#isCurrentNegotiation(peer, negotiationId)) {
        return;
      }
      throw error;
    }
  }

  async handleIce(
    peerId: string,
    candidate: SerializedIceCandidate | null,
    negotiationId: string,
  ): Promise<void> {
    const peer = this.#options.ensurePeer(peerId);
    if (!peer.adoptOrMatchCandidateNegotiation(negotiationId)) {
      return;
    }
    if (peer.connection.connectionState === 'failed' || !peer.remoteDescriptionSet) {
      if (peer.queueRemoteCandidate(candidate)) {
        this.#options.setPeerWarning(
          peer.peerId,
          'ice-candidate-queue-overflow',
          `Oldest pending ICE candidate for ${peer.peerId} was discarded`,
        );
      }
      return;
    }

    await this.#addIceCandidate(peer, candidate, negotiationId);
  }

  handleLocalIceCandidate(peer: PeerConnectionLifecycle, candidate: RTCIceCandidate | null): void {
    if (!this.#options.isCurrentPeer(peer) || !this.#options.transport.isOpen()) {
      return;
    }
    const serializedCandidate =
      candidate === null ? null : (candidate.toJSON() as SerializedIceCandidate);
    if (!peer.localDescriptionPublished) {
      peer.queueLocalCandidate(serializedCandidate);
      return;
    }
    this.#sendLocalCandidate(peer, serializedCandidate);
  }

  async #flushPendingCandidates(
    peer: PeerConnectionLifecycle,
    negotiationId: string,
  ): Promise<void> {
    const { candidates } = peer.extractPendingRemoteCandidates();
    for (const candidate of candidates) {
      if (!this.#isCurrentNegotiation(peer, negotiationId)) {
        return;
      }
      await this.#addIceCandidate(peer, candidate, negotiationId);
    }
  }

  async #addIceCandidate(
    peer: PeerConnectionLifecycle,
    candidate: SerializedIceCandidate | null,
    negotiationId: string,
  ): Promise<void> {
    try {
      await peer.connection.addIceCandidate(candidate);
    } catch (error) {
      if (this.#isCurrentNegotiation(peer, negotiationId)) {
        this.#options.setPeerWarning(
          peer.peerId,
          'ice-candidate-rejected',
          `Ignored an ICE candidate for ${peer.peerId}: ${getErrorMessage(error)}`,
        );
      }
    }
  }

  // 호출 직전에 현재 협상인지 확인했다. sendRelay는 연결이 닫혀 있으면 예외를 던진다.
  #publishLocalDescription(peer: PeerConnectionLifecycle, message: RelayClientMessage): void {
    this.#options.transport.sendRelay(message);
    const candidates = peer.publishLocalDescription();
    for (const candidate of candidates) {
      this.#sendLocalCandidate(peer, candidate);
    }
  }

  #sendLocalCandidate(
    peer: PeerConnectionLifecycle,
    candidate: SerializedIceCandidate | null,
  ): void {
    const { negotiationId } = peer;
    if (
      negotiationId === null ||
      !peer.candidateMatchesCurrentLocalNegotiation(candidate) ||
      this.#options.isRoomReconnecting()
    ) {
      return;
    }
    this.#options.transport.sendRelay({
      v: PROTOCOL_VERSION,
      type: 'rtc.ice',
      roomId: this.#options.roomId,
      to: peer.peerId,
      payload: { negotiationId, candidate },
    });
  }

  #isCurrentNegotiation(peer: PeerConnectionLifecycle, negotiationId: string): boolean {
    return this.#options.isCurrentPeer(peer) && peer.negotiationId === negotiationId;
  }
}
