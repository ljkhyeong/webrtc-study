import type { LocalMediaLifecycleOptions } from './local-media-lifecycle.js';
import type { PeerMediaSenderUpdate } from './peer-connection-lifecycle.js';

type InputKind = 'audio' | 'video';

interface LocalInputLifecycleOptions extends LocalMediaLifecycleOptions {
  readonly canSelectInput: (kind: InputKind) => boolean;
  readonly isVideoToggleBlocked: () => boolean;
  readonly getMediaDevices: () => Pick<MediaDevices, 'getUserMedia'> | undefined;
  readonly getInputConstraints: (kind: InputKind) => boolean | MediaTrackConstraints | undefined;
  readonly onInputTrackEnded: (track: MediaStreamTrack) => void;
}

/** 마이크·카메라 트랙과 통화 중 입력 장치 교체 상태를 관리한다. */
export class LocalInputLifecycle {
  readonly #options: LocalInputLifecycleOptions;
  readonly #trackEndedListeners = new Map<MediaStreamTrack, EventListener>();
  readonly #lastEnabled = { audio: true, video: true };
  readonly #endedKinds = new Set<InputKind>();

  #change: {
    kind: InputKind;
    enabled: boolean;
    track: MediaStreamTrack | null;
  } | null = null;

  constructor(
    options: LocalInputLifecycleOptions,
    initialEnabled?: Readonly<Record<InputKind, boolean>>,
  ) {
    this.#options = options;
    Object.assign(this.#lastEnabled, initialEnabled);
  }

  isChanging(): boolean {
    return this.#change !== null;
  }

  hasEndedInput(): boolean {
    return this.#endedKinds.size > 0;
  }

  liveTracks(kind: InputKind): MediaStreamTrack[] {
    const stream = this.#options.getLocalStream();
    const tracks = kind === 'audio' ? stream?.getAudioTracks() : stream?.getVideoTracks();
    return (tracks ?? []).filter((track) => track.readyState === 'live');
  }

  adoptStream(stream: MediaStream | null): void {
    this.#detachAllTrackEndedListeners();
    if (stream !== null) {
      this.#normalizeVideoTracks(stream);
    }
    this.#options.setLocalStream(stream);
    this.#attachTrackEndedListeners(stream?.getTracks() ?? []);
  }

  setDesiredEnabled(kind: InputKind, enabled: boolean): void {
    this.#lastEnabled[kind] = enabled;
    if (this.#change?.kind === kind) {
      this.#change.enabled = enabled;
    }
  }

  disableTracks(kind: InputKind): void {
    for (const track of this.liveTracks(kind)) {
      track.enabled = false;
    }
  }

  toggle(kind: InputKind): boolean {
    if (kind === 'video' && this.#options.isVideoToggleBlocked()) {
      return false;
    }
    const tracks = this.liveTracks(kind);
    if (tracks.length === 0) {
      return false;
    }

    const enabled = !tracks.some((track) => track.enabled);
    this.setDesiredEnabled(kind, enabled);
    for (const track of tracks) {
      track.enabled = enabled;
    }
    this.#options.onStateChanged();
    return enabled;
  }

  async select(kind: InputKind, deviceId: string): Promise<boolean> {
    if (
      !this.#options.isRoomActive() ||
      this.#change !== null ||
      !this.#options.canSelectInput(kind)
    ) {
      return false;
    }

    const currentTracks = this.liveTracks(kind);
    const operation = {
      kind,
      enabled:
        currentTracks.length > 0
          ? currentTracks.some((track) => track.enabled)
          : this.#lastEnabled[kind],
      track: null as MediaStreamTrack | null,
    };
    this.#change = operation;
    const updates: PeerMediaSenderUpdate[] = [];
    let committed = false;
    try {
      const devices = this.#options.getMediaDevices();
      if (devices === undefined) {
        return false;
      }
      const defaults = this.#options.getInputConstraints(kind);
      const constraints = {
        ...(typeof defaults === 'object' ? defaults : {}),
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      };
      const acquired = await devices.getUserMedia({
        audio: false,
        video: false,
        [kind]: constraints,
      });
      const next = acquired
        .getTracks()
        .find((track) => track.kind === kind && track.readyState === 'live');
      for (const track of acquired.getTracks()) {
        if (track !== next) {
          track.stop();
        }
      }
      operation.track = next ?? null;
      if (next === undefined || this.#options.isDisposed()) {
        return false;
      }

      // 모든 송신자 교체가 끝나기 전에는 새 장치의 소리·영상을 보내지 않는다.
      next.enabled = false;
      const stream = this.#options.getLocalStream() ?? this.#options.createMediaStream();
      for (const peer of this.#options.getPeers()) {
        if (!this.#options.isCurrentPeer(peer)) {
          continue;
        }
        const sender = kind === 'video' ? peer.videoSender : peer.audioSender;
        if (sender === null) {
          const added = peer.connection.addTrack(next, stream);
          if (kind === 'video') {
            peer.videoSender = added;
          } else {
            peer.audioSender = added;
          }
          updates.push({ peer, sender: added, previousTrack: null, added: true });
        } else {
          const previousTrack = sender.track;
          if (await this.#options.replacePeerTrack(peer, sender, next)) {
            updates.push({ peer, sender, previousTrack, added: false });
          }
        }
        if (this.#options.isDisposed() || next.readyState === 'ended') {
          return false;
        }
      }

      for (const previous of stream.getTracks().filter((track) => track.kind === kind)) {
        this.#detachTrackEndedListener(previous);
        stream.removeTrack(previous);
        previous.stop();
      }
      stream.addTrack(next);
      this.#options.setLocalStream(stream);
      next.enabled = operation.enabled;
      committed = true;
      this.#endedKinds.delete(kind);
      this.#attachTrackEndedListeners([next]);
      this.#options.onStateChanged();
      for (const update of updates) {
        if (update.added && this.#options.isCurrentPeer(update.peer)) {
          this.#options.requestLocalRenegotiation(update.peer);
        }
      }
      return true;
    } catch {
      return false;
    } finally {
      if (!committed) {
        operation.track?.stop();
        const failures = await this.#options.rollbackSenderUpdates(updates);
        this.#options.recoverPeersAfterSenderFailure(failures, '장치 교체 취소');
      }
      if (this.#change === operation) {
        this.#change = null;
      }
    }
  }

  takeOwnedTracks(): readonly MediaStreamTrack[] {
    const tracks = new Set(this.#options.getLocalStream()?.getTracks() ?? []);
    const changingTrack = this.#change?.track;
    if (changingTrack) {
      tracks.add(changingTrack);
    }
    this.#change = null;
    this.#detachAllTrackEndedListeners();
    this.#options.setLocalStream(null);
    this.#endedKinds.clear();
    return [...tracks];
  }

  #normalizeVideoTracks(stream: MediaStream): void {
    const videoTracks = stream.getVideoTracks();
    const selectedTrack =
      videoTracks.find((track) => track.readyState === 'live') ?? videoTracks[0] ?? null;
    for (const track of videoTracks) {
      if (track !== selectedTrack) {
        stream.removeTrack(track);
        track.stop();
      }
    }
  }

  #attachTrackEndedListeners(tracks: readonly MediaStreamTrack[]): void {
    for (const track of [...tracks]) {
      if (this.#trackEndedListeners.has(track)) {
        continue;
      }
      const kind = track.kind === 'audio' ? 'audio' : 'video';
      this.#lastEnabled[kind] = track.enabled;
      const listener: EventListener = () => {
        this.#handleTrackEnded(track);
      };
      this.#trackEndedListeners.set(track, listener);
      track.addEventListener('ended', listener);
      if (track.readyState === 'ended') {
        this.#handleTrackEnded(track);
      }
    }
  }

  #handleTrackEnded(track: MediaStreamTrack): void {
    const stream = this.#options.getLocalStream();
    if (this.#options.isDisposed() || stream === null || !this.#trackEndedListeners.has(track)) {
      this.#detachTrackEndedListener(track);
      return;
    }

    this.#detachTrackEndedListener(track);
    this.#endedKinds.add(track.kind === 'audio' ? 'audio' : 'video');
    this.#options.onInputTrackEnded(track);
    stream.removeTrack(track);
    this.#options.onStateChanged();
  }

  #detachTrackEndedListener(track: MediaStreamTrack): void {
    const listener = this.#trackEndedListeners.get(track);
    if (listener === undefined) {
      return;
    }
    track.removeEventListener('ended', listener);
    this.#trackEndedListeners.delete(track);
  }

  #detachAllTrackEndedListeners(): void {
    for (const track of [...this.#trackEndedListeners.keys()]) {
      this.#detachTrackEndedListener(track);
    }
  }
}
