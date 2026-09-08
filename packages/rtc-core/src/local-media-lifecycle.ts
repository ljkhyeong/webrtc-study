import type {
  PeerConnectionLifecycle,
  PeerMediaSenderUpdate,
} from './peer-connection-lifecycle.js';

export interface LocalMediaLifecycleOptions {
  readonly isRoomActive: () => boolean;
  readonly isDisposed: () => boolean;
  readonly createMediaStream: () => MediaStream;
  readonly getLocalStream: () => MediaStream | null;
  readonly setLocalStream: (stream: MediaStream | null) => void;
  readonly getPeers: () => Iterable<PeerConnectionLifecycle>;
  readonly isCurrentPeer: (peer: PeerConnectionLifecycle) => boolean;
  readonly replacePeerTrack: (
    peer: PeerConnectionLifecycle,
    sender: RTCRtpSender,
    track: MediaStreamTrack | null,
  ) => Promise<boolean>;
  readonly rollbackSenderUpdates: (
    updates: readonly PeerMediaSenderUpdate[],
  ) => Promise<Map<PeerConnectionLifecycle, unknown>>;
  readonly recoverPeersAfterSenderFailure: (
    failures: ReadonlyMap<PeerConnectionLifecycle, unknown>,
    phase: string,
  ) => void;
  readonly requestLocalRenegotiation: (peer: PeerConnectionLifecycle) => void;
  readonly onStateChanged: () => void;
}
