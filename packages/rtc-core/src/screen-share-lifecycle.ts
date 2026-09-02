import type { PeerConnectionLifecycle } from './peer-connection-lifecycle.js';

export type ScreenShareStartResult = 'started' | 'recovering' | 'cancelled' | 'failed';

export interface PeerMediaSenderUpdate {
  readonly peer: PeerConnectionLifecycle;
  readonly sender: RTCRtpSender;
  readonly previousTrack: MediaStreamTrack | null;
  readonly added: boolean;
}

interface ScreenShareLifecycleOptions {
  readonly isRoomActive: () => boolean;
  readonly isDisposed: () => boolean;
  readonly getMediaDevices: () => Partial<Pick<MediaDevices, 'getDisplayMedia'>> | undefined;
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

const SCREEN_SHARE_CONSTRAINTS: DisplayMediaStreamOptions = {
  video: {
    width: { ideal: 1280, max: 1280 },
    height: { ideal: 720, max: 720 },
    frameRate: { ideal: 15, max: 15 },
  },
  audio: false,
};

/** 화면 공유 트랙과 비동기 시작·중지 작업의 수명주기를 소유한다. */
export class ScreenShareLifecycle {
  readonly #options: ScreenShareLifecycleOptions;

  #cameraTracks: MediaStreamTrack[] = [];
  #pendingTrack: MediaStreamTrack | null = null;
  #activeTrack: MediaStreamTrack | null = null;
  #activeTrackEndedListener: EventListener | null = null;
  #createdLocalStream = false;
  #startPromise: Promise<ScreenShareStartResult> | null = null;
  #stopPromise: Promise<boolean> | null = null;
  #stopTrack: MediaStreamTrack | null = null;
  #stopGeneration = 0;
  #stopDisablesCamera = false;
  #operation = 0;

  constructor(options: ScreenShareLifecycleOptions) {
    this.#options = options;
  }

  isAvailable(): boolean {
    return this.#options.getMediaDevices()?.getDisplayMedia !== undefined;
  }

  isSharing(): boolean {
    return this.#activeTrack !== null && this.#activeTrack.readyState === 'live';
  }

  hasActiveTrack(): boolean {
    return this.#activeTrack !== null;
  }

  isTransitioning(): boolean {
    return this.#startPromise !== null || this.#stopPromise !== null;
  }

  isSharingOrStopping(): boolean {
    return this.#activeTrack !== null || this.#stopPromise !== null;
  }

  ownsVideoTrack(track: MediaStreamTrack): boolean {
    return track === this.#activeTrack || track === this.#pendingTrack;
  }

  start(): Promise<ScreenShareStartResult> {
    if (this.#stopPromise !== null) {
      return Promise.resolve('cancelled');
    }
    if (this.#startPromise !== null) {
      return this.#startPromise;
    }
    if (this.#activeTrack !== null) {
      return Promise.resolve('cancelled');
    }
    const operation = ++this.#operation;
    const startPromise = this.#performStart(operation).finally(() => {
      if (this.#startPromise === startPromise) {
        this.#startPromise = null;
      }
    });
    this.#startPromise = startPromise;
    return startPromise;
  }

  stop(disableCamera: boolean): Promise<boolean> {
    if (this.#options.isDisposed()) {
      return Promise.resolve(false);
    }
    if (this.#stopPromise !== null) {
      if (disableCamera && !this.#stopDisablesCamera) {
        this.#stopDisablesCamera = true;
        this.disableCameraTracks();
      }
      return this.#stopPromise;
    }

    const screenTrack = this.#activeTrack;
    if (screenTrack === null) {
      this.cancelPendingStart(disableCamera);
      return Promise.resolve(false);
    }

    const generation = ++this.#operation;
    this.#stopTrack = screenTrack;
    this.#stopGeneration = generation;
    this.#stopDisablesCamera = disableCamera;
    if (disableCamera) {
      this.disableCameraTracks();
    }
    this.#detachActiveTrackEndedListener();
    screenTrack.stop();

    let resolveStop!: (result: boolean) => void;
    let rejectStop!: (reason: unknown) => void;
    const stopPromise = new Promise<boolean>((resolve, reject) => {
      resolveStop = resolve;
      rejectStop = reject;
    });
    const finishStop = () => {
      if (this.#stopPromise === stopPromise) {
        this.#stopPromise = null;
        this.#stopTrack = null;
        this.#stopGeneration = 0;
        this.#stopDisablesCamera = false;
      }
    };
    this.#stopPromise = stopPromise;
    void this.#performStop(screenTrack, generation).then(
      (result) => {
        finishStop();
        resolveStop(result);
      },
      (error: unknown) => {
        finishStop();
        rejectStop(error);
      },
    );
    return stopPromise;
  }

  cancelPendingStart(disableCamera: boolean): boolean {
    if (this.#startPromise === null || this.#activeTrack !== null) {
      return false;
    }
    ++this.#operation;
    if (disableCamera) {
      this.disableCameraTracks();
    }
    this.#pendingTrack?.stop();
    return true;
  }

  disableCameraTracks(): void {
    const cameraTracks = new Set([
      ...this.#cameraTracks,
      ...(this.#options.getLocalStream()?.getVideoTracks() ?? []),
    ]);
    for (const track of cameraTracks) {
      if (track !== this.#activeTrack && track !== this.#pendingTrack) {
        track.enabled = false;
      }
    }
  }

  removeRetainedCameraTrack(track: MediaStreamTrack): void {
    const index = this.#cameraTracks.indexOf(track);
    if (index >= 0) {
      this.#cameraTracks.splice(index, 1);
    }
  }

  takeOwnedTracks(): readonly MediaStreamTrack[] {
    ++this.#operation;
    this.#detachActiveTrackEndedListener();
    const tracks = [
      ...this.#cameraTracks,
      ...(this.#pendingTrack === null ? [] : [this.#pendingTrack]),
      ...(this.#activeTrack === null ? [] : [this.#activeTrack]),
    ];
    this.#cameraTracks = [];
    this.#pendingTrack = null;
    this.#activeTrack = null;
    this.#createdLocalStream = false;
    this.#stopTrack = null;
    this.#stopGeneration = 0;
    this.#stopDisablesCamera = false;
    return tracks;
  }

  async #performStart(operation: number): Promise<ScreenShareStartResult> {
    const mediaDevices = this.#options.getMediaDevices();
    if (mediaDevices?.getDisplayMedia === undefined) {
      return 'failed';
    }

    let displayStream: MediaStream;
    try {
      displayStream = await mediaDevices.getDisplayMedia(SCREEN_SHARE_CONSTRAINTS);
    } catch (error) {
      return isDisplayMediaCancellation(error) ? 'cancelled' : 'failed';
    }

    const screenTrack = displayStream.getVideoTracks().find((track) => track.readyState === 'live');
    for (const track of displayStream.getTracks()) {
      if (track !== screenTrack) {
        track.stop();
      }
    }
    if (screenTrack !== undefined) {
      preferDetailedScreenContent(screenTrack);
      this.#pendingTrack = screenTrack;
    }
    if (screenTrack === undefined) {
      return 'failed';
    }
    if (!this.#ownsStart(operation, screenTrack)) {
      screenTrack.stop();
      if (this.#pendingTrack === screenTrack) {
        this.#pendingTrack = null;
      }
      return 'cancelled';
    }

    let localStream = this.#options.getLocalStream();
    const createdLocalStream = localStream === null;
    if (localStream === null) {
      try {
        localStream = this.#options.createMediaStream();
      } catch {
        screenTrack.stop();
        if (this.#pendingTrack === screenTrack) {
          this.#pendingTrack = null;
        }
        return 'failed';
      }
    }

    const cameraTracks = [...localStream.getVideoTracks()];
    const primaryCameraTrack = cameraTracks.find((track) => track.readyState === 'live') ?? null;
    const senderUpdates: PeerMediaSenderUpdate[] = [];
    const senderFailures = new Map<PeerConnectionLifecycle, unknown>();

    for (const peer of this.#options.getPeers()) {
      if (!this.#options.isCurrentPeer(peer)) {
        continue;
      }
      try {
        if (peer.videoSender === null) {
          const sender = peer.connection.addTrack(screenTrack, localStream);
          peer.videoSender = sender;
          senderUpdates.push({
            peer,
            sender,
            previousTrack: null,
            added: true,
          });
          continue;
        }

        const sender = peer.videoSender;
        const previousTrack = sender.track ?? primaryCameraTrack;
        if (await this.#options.replacePeerTrack(peer, sender, screenTrack)) {
          senderUpdates.push({ peer, sender, previousTrack, added: false });
        }
        if (!this.#ownsStart(operation, screenTrack)) {
          break;
        }
      } catch (error) {
        senderFailures.set(peer, error);
        if (!this.#ownsStart(operation, screenTrack)) {
          break;
        }
      }
    }

    if (!this.#ownsStart(operation, screenTrack)) {
      screenTrack.stop();
      const rollbackFailures = await this.#options.rollbackSenderUpdates(senderUpdates);
      for (const [peer, error] of rollbackFailures) {
        senderFailures.set(peer, error);
      }
      if (this.#pendingTrack === screenTrack) {
        this.#pendingTrack = null;
      }
      this.#options.recoverPeersAfterSenderFailure(senderFailures, 'starting screen share');
      return 'cancelled';
    }

    for (const cameraTrack of cameraTracks) {
      localStream.removeTrack(cameraTrack);
    }
    localStream.addTrack(screenTrack);
    this.#options.setLocalStream(localStream);
    this.#cameraTracks = cameraTracks;
    this.#pendingTrack = null;
    this.#activeTrack = screenTrack;
    this.#createdLocalStream = createdLocalStream;
    const endedListener: EventListener = () => {
      void this.stop(false);
    };
    this.#activeTrackEndedListener = endedListener;
    screenTrack.addEventListener('ended', endedListener);

    this.#options.onStateChanged();

    for (const update of senderUpdates) {
      if (!update.added || !this.#options.isCurrentPeer(update.peer)) {
        continue;
      }
      this.#options.requestLocalRenegotiation(update.peer);
    }
    this.#options.recoverPeersAfterSenderFailure(senderFailures, 'starting screen share');

    if (screenTrack.readyState === 'ended') {
      await this.stop(false);
      return 'cancelled';
    }
    return senderFailures.size === 0 ? 'started' : 'recovering';
  }

  async #performStop(screenTrack: MediaStreamTrack, generation: number): Promise<boolean> {
    const cameraTracks = [...this.#cameraTracks];
    const primaryCameraTrack = cameraTracks.find((track) => track.readyState === 'live') ?? null;
    const senderFailures = new Map<PeerConnectionLifecycle, unknown>();

    const localStream = this.#options.getLocalStream();
    localStream?.removeTrack(screenTrack);
    for (const cameraTrack of cameraTracks) {
      if (cameraTrack.readyState === 'live' && localStream !== null) {
        localStream.addTrack(cameraTrack);
      }
    }
    if (this.#createdLocalStream && localStream !== null && localStream.getTracks().length === 0) {
      this.#options.setLocalStream(null);
    }
    if (this.#stopDisablesCamera) {
      this.disableCameraTracks();
    }
    this.#options.onStateChanged();

    for (const peer of [...this.#options.getPeers()]) {
      if (!this.#ownsStop(screenTrack, generation)) {
        return false;
      }
      if (!this.#options.isCurrentPeer(peer) || peer.videoSender === null) {
        continue;
      }
      try {
        await this.#options.replacePeerTrack(peer, peer.videoSender, primaryCameraTrack);
      } catch (error) {
        senderFailures.set(peer, error);
      }
      if (!this.#ownsStop(screenTrack, generation)) {
        return false;
      }
    }

    if (!this.#ownsStop(screenTrack, generation)) {
      return false;
    }
    if (this.#stopDisablesCamera) {
      this.disableCameraTracks();
    }
    this.#activeTrack = null;
    this.#cameraTracks = [];
    this.#createdLocalStream = false;

    this.#options.recoverPeersAfterSenderFailure(
      senderFailures,
      'restoring camera after screen share',
    );
    return senderFailures.size === 0;
  }

  #ownsStart(operation: number, screenTrack: MediaStreamTrack): boolean {
    return (
      this.#options.isRoomActive() &&
      this.#operation === operation &&
      this.#pendingTrack === screenTrack &&
      screenTrack.readyState === 'live' &&
      this.#activeTrack === null &&
      this.#stopPromise === null
    );
  }

  #ownsStop(screenTrack: MediaStreamTrack, generation: number): boolean {
    return (
      !this.#options.isDisposed() &&
      this.#operation === generation &&
      this.#stopGeneration === generation &&
      this.#stopTrack === screenTrack &&
      this.#activeTrack === screenTrack
    );
  }

  #detachActiveTrackEndedListener(): void {
    if (this.#activeTrack !== null && this.#activeTrackEndedListener !== null) {
      this.#activeTrack.removeEventListener('ended', this.#activeTrackEndedListener);
    }
    this.#activeTrackEndedListener = null;
  }
}

function isDisplayMediaCancellation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('name' in error)) {
    return false;
  }
  return error.name === 'NotAllowedError' || error.name === 'AbortError';
}

function preferDetailedScreenContent(track: MediaStreamTrack): void {
  if (!('contentHint' in track)) {
    return;
  }
  try {
    track.contentHint = 'detail';
  } catch {
    // 일부 엔진은 contentHint를 노출하지만 표준화된 모든 값을 허용하지는 않는다.
  }
}
