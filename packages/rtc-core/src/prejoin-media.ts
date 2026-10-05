export type PrejoinMediaStatus = 'idle' | 'checking' | 'ready';

export type PrejoinMediaIssueCode =
  'permission-denied' | 'device-not-found' | 'device-busy' | 'media-unavailable' | 'track-ended';

export interface PrejoinMediaDevice {
  readonly deviceId: string;
  readonly label: string;
}

export interface PrejoinLocalMediaSnapshot {
  readonly audioAvailable: boolean;
  readonly audioEnabled: boolean;
  readonly videoAvailable: boolean;
  readonly videoEnabled: boolean;
}

export interface PrejoinMediaSnapshot {
  readonly status: PrejoinMediaStatus;
  readonly audioInputs: readonly PrejoinMediaDevice[];
  readonly videoInputs: readonly PrejoinMediaDevice[];
  readonly selectedAudioInputId: string | null;
  readonly selectedVideoInputId: string | null;
  readonly localMedia: PrejoinLocalMediaSnapshot;
  readonly audioIssue: PrejoinMediaIssueCode | null;
  readonly videoIssue: PrejoinMediaIssueCode | null;
}

export type PrejoinMediaListener = (snapshot: PrejoinMediaSnapshot) => void;

type PrejoinMediaDevices = Pick<
  MediaDevices,
  'addEventListener' | 'enumerateDevices' | 'getUserMedia'
>;

export interface PrejoinMediaOptions {
  readonly audioConstraints?: MediaTrackConstraints;
  readonly videoConstraints?: MediaTrackConstraints;
  readonly mediaDevices?: PrejoinMediaDevices;
  readonly mediaStreamFactory?: () => MediaStream;
}

type InputKind = 'audio' | 'video';
type PerKind<T> = Record<InputKind, T>;

const INPUT_KINDS: readonly InputKind[] = ['audio', 'video'];
const INPUT_LABELS: PerKind<string> = { audio: '마이크', video: '카메라' };

interface MediaRequest {
  readonly kind: InputKind;
  readonly deviceId: string | null;
}

function issueFor(error: unknown): PrejoinMediaIssueCode {
  switch ((error as { readonly name?: unknown } | null | undefined)?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'permission-denied';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'device-not-found';
    case 'AbortError':
    case 'NotReadableError':
    case 'TrackStartError':
      return 'device-busy';
    default:
      return 'media-unavailable';
  }
}

function missingTrackError(): DOMException {
  return new DOMException('The requested media track was not returned', 'NotFoundError');
}

function withSelectedDevice(
  constraints: MediaTrackConstraints,
  deviceId: string | null,
): MediaTrackConstraints {
  if (deviceId === null) {
    return constraints;
  }
  return {
    ...constraints,
    deviceId: { exact: deviceId },
  };
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

function hasEnded(track: MediaStreamTrack): boolean {
  return track.readyState === 'ended';
}

/**
 * 사용자가 입장 준비 화면에 있는 동안 카메라와 마이크 트랙을 관리한다.
 *
 * React 호출자는 이 객체를 ref에 보관하고 `getSnapshot()` 결과만 상태에 저장해야 한다.
 * `takeStream()`은 트랙 관리를 `RoomSession`에 넘긴다.
 */
export class PrejoinMedia {
  readonly #constraints: PerKind<MediaTrackConstraints>;
  readonly #mediaDevices: PrejoinMediaDevices | undefined;
  readonly #mediaStreamFactory: () => MediaStream;
  readonly #listeners = new Set<PrejoinMediaListener>();
  readonly #trackEndedListeners = new Map<MediaStreamTrack, EventListener>();
  // 폐기하면 장치 변경 리스너를 떼고 진행 중인 목록 조회를 기다리지 않는다.
  readonly #lifetime = new AbortController();
  readonly #disposal = new Promise<null>((resolve) => {
    this.#lifetime.signal.addEventListener('abort', () => resolve(null), { once: true });
  });
  readonly #desiredEnabled: PerKind<boolean> = { audio: true, video: true };

  #stream: MediaStream | null = null;
  #status: PrejoinMediaStatus = 'idle';
  // 목록은 조회할 때마다 새 배열로 바꾸고 고치지 않으므로 스냅샷이 그대로 공유한다.
  #inputs: PerKind<readonly PrejoinMediaDevice[]> = { audio: [], video: [] };
  #selected: PerKind<string | null> = { audio: null, video: null };
  #issues: PerKind<PrejoinMediaIssueCode | null> = { audio: null, video: null };
  #snapshot: PrejoinMediaSnapshot;
  #deviceRefresh: Promise<void> | null = null;
  #deviceRefreshStale = false;
  #deviceRefreshShouldEmit = false;

  constructor(options: PrejoinMediaOptions = {}) {
    this.#constraints = {
      audio: options.audioConstraints ?? {},
      video: options.videoConstraints ?? {},
    };
    this.#mediaDevices =
      options.mediaDevices ??
      (typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined);
    this.#mediaStreamFactory = options.mediaStreamFactory ?? (() => new MediaStream());
    this.#snapshot = this.#buildSnapshot();
    this.#mediaDevices?.addEventListener(
      'devicechange',
      () => void this.#requestDeviceRefresh(true),
      { signal: this.#lifetime.signal },
    );
  }

  get #disposed(): boolean {
    return this.#lifetime.signal.aborted;
  }

  getSnapshot(): PrejoinMediaSnapshot {
    return this.#snapshot;
  }

  getStream(): MediaStream | null {
    return this.#stream;
  }

  getInputEnabled(): Readonly<PerKind<boolean>> {
    return { ...this.#desiredEnabled };
  }

  subscribe(listener: PrejoinMediaListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  checkDevices(): Promise<PrejoinMediaSnapshot> {
    return this.#runRequests(INPUT_KINDS);
  }

  retryUnavailable(): Promise<PrejoinMediaSnapshot> {
    const kinds = INPUT_KINDS.filter(
      (kind) => this.#liveTracks(kind).length === 0 || this.#issues[kind] !== null,
    );
    return this.#runRequests(kinds.length > 0 ? kinds : INPUT_KINDS);
  }

  selectInput(kind: InputKind, deviceId: string): Promise<PrejoinMediaSnapshot> {
    if (
      deviceId.length === 0 ||
      this.#liveTracks(kind).some((track) => this.#trackDeviceId(track) === deviceId)
    ) {
      return Promise.resolve(this.#snapshot);
    }
    return this.#runRequests([kind], deviceId);
  }

  toggle(kind: InputKind): boolean {
    const tracks = this.#liveTracks(kind);
    if (this.#disposed || tracks.length === 0) {
      return false;
    }
    const enabled = !tracks.some((track) => track.enabled);
    this.#desiredEnabled[kind] = enabled;
    for (const track of tracks) {
      track.enabled = enabled;
    }
    this.#emit();
    return enabled;
  }

  /**
   * 트랙을 중지하지 않고 현재 스트림을 이전한다.
   * 이전 후 컨트롤러는 다시 사용할 수 없으며 안전하게 폐기할 수 있다.
   */
  takeStream(): MediaStream | null {
    if (this.#status === 'checking') {
      throw new Error('Cannot transfer media while devices are being checked');
    }
    if (this.#disposed) {
      return null;
    }

    const stream = this.#stream;
    this.#stream = null;
    this.#shutdown();
    return stream !== null && stream.getTracks().length > 0 ? stream : null;
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }

    this.#shutdown();
    if (this.#stream !== null) {
      stopTracks(this.#stream);
      this.#stream = null;
    }
    this.#snapshot = this.#buildSnapshot();
  }

  #shutdown(): void {
    this.#lifetime.abort();
    for (const track of [...this.#trackEndedListeners.keys()]) {
      this.#detachTrackEndedListener(track);
    }
    this.#listeners.clear();
  }

  // 선택한 장치가 없으면 요청 시점의 선택값을 쓴다.
  async #runRequests(
    kinds: readonly InputKind[],
    deviceId?: string,
  ): Promise<PrejoinMediaSnapshot> {
    if (this.#disposed || this.#status === 'checking') {
      return this.#snapshot;
    }

    const requests = kinds.map((kind) => ({ kind, deviceId: deviceId ?? this.#selected[kind] }));
    this.#status = 'checking';
    this.#emit();

    for (const request of requests) {
      await this.#acquire(request);
      if (this.#disposed) {
        return this.#snapshot;
      }
    }

    await this.#requestDeviceRefresh(false);
    if (!this.#disposed) {
      this.#status = 'ready';
      this.#emit();
    }
    return this.#snapshot;
  }

  async #acquire({ kind, deviceId }: MediaRequest): Promise<void> {
    let acquiredStream: MediaStream | null = null;
    try {
      if (this.#mediaDevices === undefined) {
        throw new Error('Browser media APIs are unavailable');
      }

      acquiredStream = await this.#mediaDevices.getUserMedia({
        audio: false,
        video: false,
        [kind]: withSelectedDevice(this.#constraints[kind], deviceId),
      });

      if (this.#disposed) {
        stopTracks(acquiredStream);
        return;
      }

      const track = (
        kind === 'audio' ? acquiredStream.getAudioTracks() : acquiredStream.getVideoTracks()
      )[0];
      if (track === undefined || hasEnded(track)) {
        throw missingTrackError();
      }

      for (const extraTrack of acquiredStream.getTracks()) {
        if (extraTrack !== track) {
          extraTrack.stop();
        }
      }

      this.#replaceTrack(kind, track);
      this.#selected[kind] = this.#trackDeviceId(track) ?? deviceId;
      this.#issues[kind] = null;
    } catch (error) {
      if (acquiredStream !== null) {
        stopTracks(acquiredStream);
      }
      this.#issues[kind] = issueFor(error);
    }
  }

  // 새 트랙은 바로 앞에서 live임을 확인했고 그 뒤로는 동기 처리만 한다.
  #replaceTrack(kind: InputKind, track: MediaStreamTrack): void {
    const previousTracks = this.#tracks(kind);
    track.enabled = this.#desiredEnabled[kind];
    this.#stream ??= this.#mediaStreamFactory();

    for (const previousTrack of previousTracks) {
      this.#detachTrackEndedListener(previousTrack);
      this.#stream.removeTrack(previousTrack);
      previousTrack.stop();
    }
    this.#stream.addTrack(track);
    const listener: EventListener = () => {
      this.#handleTrackEnded(kind, track);
    };
    this.#trackEndedListeners.set(track, listener);
    track.addEventListener('ended', listener);
  }

  #handleTrackEnded(kind: InputKind, track: MediaStreamTrack): void {
    if (!this.#trackEndedListeners.has(track)) {
      return;
    }
    this.#detachTrackEndedListener(track);
    this.#stream?.removeTrack(track);
    this.#issues[kind] = 'track-ended';
    this.#emit();
  }

  #detachTrackEndedListener(track: MediaStreamTrack): void {
    const listener = this.#trackEndedListeners.get(track);
    if (listener === undefined) {
      return;
    }
    track.removeEventListener('ended', listener);
    this.#trackEndedListeners.delete(track);
  }

  /** 조회 중에 다시 요청되면 그 결과는 버리고 최신 목록을 다시 조회한다. */
  #requestDeviceRefresh(emitSnapshot: boolean): Promise<void> {
    if (this.#disposed) {
      return Promise.resolve();
    }
    this.#deviceRefreshStale = true;
    this.#deviceRefreshShouldEmit ||= emitSnapshot;
    this.#deviceRefresh ??= this.#refreshDevices();
    return this.#deviceRefresh;
  }

  async #refreshDevices(): Promise<void> {
    try {
      while (this.#deviceRefreshStale && !this.#disposed) {
        this.#deviceRefreshStale = false;
        const devices = await Promise.race([this.#enumerateDevices(), this.#disposal]);
        if (this.#deviceRefreshStale || this.#disposed) {
          continue;
        }
        if (devices !== null) this.#applyDevices(devices);
        if (this.#deviceRefreshShouldEmit) {
          this.#deviceRefreshShouldEmit = false;
          this.#emit();
        }
      }
    } finally {
      this.#deviceRefresh = null;
    }
  }

  async #enumerateDevices(): Promise<readonly MediaDeviceInfo[] | null> {
    if (this.#mediaDevices === undefined) {
      return null;
    }

    try {
      return await this.#mediaDevices.enumerateDevices();
    } catch {
      return null;
    }
  }

  #applyDevices(devices: readonly MediaDeviceInfo[]): void {
    for (const kind of INPUT_KINDS) {
      this.#inputs[kind] = devices
        .filter((device) => device.kind === `${kind}input`)
        .map((device, index) => ({
          deviceId: device.deviceId,
          label: device.label || `${INPUT_LABELS[kind]} ${index + 1}`,
        }));
      this.#selected[kind] = this.#normalizeSelection(
        this.#selected[kind],
        this.#inputs[kind],
        this.#tracks(kind)[0],
      );
    }
  }

  #normalizeSelection(
    selectedDeviceId: string | null,
    devices: readonly PrejoinMediaDevice[],
    track: MediaStreamTrack | undefined,
  ): string | null {
    if (track !== undefined && !hasEnded(track)) {
      return this.#trackDeviceId(track) ?? selectedDeviceId;
    }
    if (
      selectedDeviceId !== null &&
      devices.some((device) => device.deviceId === selectedDeviceId)
    ) {
      return selectedDeviceId;
    }

    return devices[0]?.deviceId ?? selectedDeviceId;
  }

  #trackDeviceId(track: MediaStreamTrack): string | null {
    return track.getSettings().deviceId || null;
  }

  #tracks(kind: InputKind): MediaStreamTrack[] {
    return (
      (kind === 'audio' ? this.#stream?.getAudioTracks() : this.#stream?.getVideoTracks()) ?? []
    );
  }

  #liveTracks(kind: InputKind): MediaStreamTrack[] {
    return this.#tracks(kind).filter((track) => track.readyState === 'live');
  }

  #buildSnapshot(): PrejoinMediaSnapshot {
    const audioTracks = this.#liveTracks('audio');
    const videoTracks = this.#liveTracks('video');
    return {
      status: this.#status,
      audioInputs: this.#inputs.audio,
      videoInputs: this.#inputs.video,
      selectedAudioInputId: this.#selected.audio,
      selectedVideoInputId: this.#selected.video,
      localMedia: {
        audioAvailable: audioTracks.length > 0,
        audioEnabled: audioTracks.some((track) => track.enabled),
        videoAvailable: videoTracks.length > 0,
        videoEnabled: videoTracks.some((track) => track.enabled),
      },
      audioIssue: this.#issues.audio,
      videoIssue: this.#issues.video,
    };
  }

  #emit(): void {
    this.#snapshot = this.#buildSnapshot();
    for (const listener of [...this.#listeners]) {
      listener(this.#snapshot);
    }
  }
}
