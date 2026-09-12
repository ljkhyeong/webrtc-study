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

type RelayClientMessage = Extract<ClientMessage, { to: string }>;
type PeerNegotiationStatus = RTCPeerConnectionState | 'negotiating';
type PeerNegotiationWarningCode =
  'peer-restart-deferred' | 'ice-candidate-queue-overflow' | 'ice-candidate-rejected';

interface PeerNegotiationLifecycleOptions {
  readonly roomId: string;
  readonly transport: SignalingTransport;
  readonly maxPendingRemoteCandidates: number;
  readonly createNegotiationId: (peerId: string) => string;
  readonly getPeer: (peerId: string) => PeerConnectionLifecycle | undefined;
  readonly ensurePeer: (peerId: string) => PeerConnectionLifecycle;
  readonly replacePeer: (
    peerId: string,
    preservePendingCandidates: boolean,
    connectionAttempt: number,
  ) => PeerConnectionLifecycle;
  readonly isCurrentPeer: (peer: PeerConnectionLifecycle) => boolean;
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
  readonly onNegotiationSettled: (peer: PeerConnectionLifecycle) => void;
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
    peer.resetLocalDescription();
    if (options.iceRestart === true) {
      peer.clearPendingRemoteCandidates();
    }
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
      this.#options.onNegotiationSettled(peer);
    }
  }

  async handleOffer(
    peerId: string,
    description: OfferDescription,
    negotiationId?: string,
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
        ? this.#options.replacePeer(peerId, true, existing.connectionAttempt + 1)
        : this.#options.ensurePeer(peerId);
    peer.replaceNegotiationId(negotiationId ?? null);
    const acceptedNegotiationId = peer.negotiationId;
    peer.beginRemoteOffer(acceptedNegotiationId);
    try {
      peer.remoteDescriptionSet = false;
      this.#options.setPeerConnectionStatus(peerId, 'negotiating');
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
      void this.#options.updateVideoQuality(peer);
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
        this.#options.finishPeerRecovery(peer);
      }
    } catch (error) {
      if (!this.#isCurrentNegotiation(peer, acceptedNegotiationId)) {
        return;
      }
      throw error;
    } finally {
      peer.endRemoteOffer(acceptedNegotiationId);
      this.#options.onNegotiationSettled(peer);
    }
  }

  async handleAnswer(
    peerId: string,
    description: AnswerDescription,
    negotiationId?: string,
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
        this.#options.finishPeerRecovery(peer);
      }
      void this.#options.updateVideoQuality(peer);
      this.#options.onNegotiationSettled(peer);
    } catch (error) {
      if (!this.#isCurrentNegotiation(peer, acceptedNegotiationId)) {
        return;
      }
      throw error;
    }
  }

  async handleIce(
    peerId: string,
    candidate: SerializedIceCandidate | null,
    negotiationId?: string,
  ): Promise<void> {
    const peer = this.#options.ensurePeer(peerId);
    if (!peer.adoptOrMatchCandidateNegotiation(negotiationId)) {
      return;
    }
    const acceptedNegotiationId = peer.negotiationId;
    if (peer.connection.connectionState === 'failed' || !peer.remoteDescriptionSet) {
      if (peer.queueRemoteCandidate(candidate, this.#options.maxPendingRemoteCandidates)) {
        this.#options.setPeerWarning(
          peer.peerId,
          'ice-candidate-queue-overflow',
          `Oldest pending ICE candidate for ${peer.peerId} was discarded`,
        );
      }
      return;
    }

    await this.#addIceCandidate(peer, candidate, acceptedNegotiationId);
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
    negotiationId: string | null,
  ): Promise<void> {
    const candidates = peer.takePendingRemoteCandidates();
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
    negotiationId: string | null,
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

  #publishLocalDescription(peer: PeerConnectionLifecycle, message: RelayClientMessage): void {
    if (!this.#options.isCurrentPeer(peer)) {
      return;
    }
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
    if (
      !this.#options.isCurrentPeer(peer) ||
      !peer.candidateMatchesCurrentLocalNegotiation(candidate) ||
      !this.#options.transport.isOpen() ||
      this.#options.isRoomReconnecting()
    ) {
      return;
    }
    this.#options.transport.sendRelay({
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

  #isCurrentNegotiation(peer: PeerConnectionLifecycle, negotiationId: string | null): boolean {
    return this.#options.isCurrentPeer(peer) && peer.negotiationId === negotiationId;
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
