export type PrejoinMediaStatus = 'idle' | 'checking' | 'ready';

export type PrejoinMediaIssueCode =
  'permission-denied' | 'device-not-found' | 'device-busy' | 'media-unavailable' | 'track-ended';

export interface PrejoinMediaIssue {
  readonly code: PrejoinMediaIssueCode;
}

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
  readonly audioIssue: PrejoinMediaIssue | null;
  readonly videoIssue: PrejoinMediaIssue | null;
}

export type PrejoinMediaListener = (snapshot: PrejoinMediaSnapshot) => void;

type PrejoinMediaDevices = Pick<
  MediaDevices,
  'addEventListener' | 'enumerateDevices' | 'getUserMedia' | 'removeEventListener'
>;

export interface PrejoinMediaOptions {
  readonly audioConstraints?: MediaTrackConstraints;
  readonly videoConstraints?: MediaTrackConstraints;
  readonly mediaDevices?: PrejoinMediaDevices;
  readonly mediaStreamFactory?: () => MediaStream;
}

type InputKind = 'audio' | 'video';

interface MediaRequest {
  readonly kind: InputKind;
  readonly deviceId: string | null;
}

function getErrorName(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'name' in error) {
    const name = (error as { readonly name?: unknown }).name;
    if (typeof name === 'string') {
      return name;
    }
  }
  return '';
}

function issueFor(error: unknown): PrejoinMediaIssue {
  switch (getErrorName(error)) {
    case 'NotAllowedError':
    case 'SecurityError':
      return { code: 'permission-denied' };
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return { code: 'device-not-found' };
    case 'AbortError':
    case 'NotReadableError':
    case 'TrackStartError':
      return { code: 'device-busy' };
    default:
      return { code: 'media-unavailable' };
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
  readonly #audioConstraints: MediaTrackConstraints;
  readonly #videoConstraints: MediaTrackConstraints;
  readonly #mediaDevices: PrejoinMediaDevices | undefined;
  readonly #mediaStreamFactory: () => MediaStream;
  readonly #listeners = new Set<PrejoinMediaListener>();
  readonly #trackEndedListeners = new Map<MediaStreamTrack, EventListener>();
  readonly #deviceRefreshWaiters: {
    readonly generation: number;
    readonly resolve: () => void;
  }[] = [];

  #stream: MediaStream | null = null;
  #status: PrejoinMediaStatus = 'idle';
  #audioInputs: PrejoinMediaDevice[] = [];
  #videoInputs: PrejoinMediaDevice[] = [];
  #selectedAudioInputId: string | null = null;
  #selectedVideoInputId: string | null = null;
  #audioIssue: PrejoinMediaIssue | null = null;
  #videoIssue: PrejoinMediaIssue | null = null;
  #desiredAudioEnabled = true;
  #desiredVideoEnabled = true;
  #snapshot: PrejoinMediaSnapshot;
  #disposed = false;
  #deviceChangeListener: EventListener | null = null;
  #deviceRefreshRequestedGeneration = 0;
  #deviceRefreshCompletedGeneration = 0;
  #deviceRefreshPromise: Promise<void> | null = null;
  #deviceRefreshShouldEmit = false;

  constructor(options: PrejoinMediaOptions = {}) {
    this.#audioConstraints = options.audioConstraints ?? {};
    this.#videoConstraints = options.videoConstraints ?? {};
    this.#mediaDevices =
      options.mediaDevices ??
      (typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined);
    this.#mediaStreamFactory = options.mediaStreamFactory ?? (() => new MediaStream());
    this.#snapshot = this.#buildSnapshot();
    this.#attachDeviceChangeListener();
  }

  getSnapshot(): PrejoinMediaSnapshot {
    return this.#snapshot;
  }

  getStream(): MediaStream | null {
    return this.#stream;
  }

  getInputEnabled(): Readonly<Record<'audio' | 'video', boolean>> {
    return { audio: this.#desiredAudioEnabled, video: this.#desiredVideoEnabled };
  }

  subscribe(listener: PrejoinMediaListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  checkDevices(): Promise<PrejoinMediaSnapshot> {
    return this.#runRequests([
      { kind: 'audio', deviceId: this.#selectedAudioInputId },
      { kind: 'video', deviceId: this.#selectedVideoInputId },
    ]);
  }

  retryUnavailable(): Promise<PrejoinMediaSnapshot> {
    const requests: MediaRequest[] = [];
    if (this.#liveTracks(this.#audioTracks()).length === 0 || this.#audioIssue !== null) {
      requests.push({ kind: 'audio', deviceId: this.#selectedAudioInputId });
    }
    if (this.#liveTracks(this.#videoTracks()).length === 0 || this.#videoIssue !== null) {
      requests.push({ kind: 'video', deviceId: this.#selectedVideoInputId });
    }

    return this.#runRequests(
      requests.length > 0
        ? requests
        : [
            { kind: 'audio', deviceId: this.#selectedAudioInputId },
            { kind: 'video', deviceId: this.#selectedVideoInputId },
          ],
    );
  }

  selectAudioInput(deviceId: string): Promise<PrejoinMediaSnapshot> {
    if (
      deviceId.length === 0 ||
      this.#liveTracks(this.#audioTracks()).some((track) => this.#trackDeviceId(track) === deviceId)
    ) {
      return Promise.resolve(this.#snapshot);
    }
    return this.#runRequests([{ kind: 'audio', deviceId }]);
  }

  selectVideoInput(deviceId: string): Promise<PrejoinMediaSnapshot> {
    if (
      deviceId.length === 0 ||
      this.#liveTracks(this.#videoTracks()).some((track) => this.#trackDeviceId(track) === deviceId)
    ) {
      return Promise.resolve(this.#snapshot);
    }
    return this.#runRequests([{ kind: 'video', deviceId }]);
  }

  toggleAudio(): boolean {
    return this.#toggleTracks('audio', this.#liveTracks(this.#audioTracks()));
  }

  toggleVideo(): boolean {
    return this.#toggleTracks('video', this.#liveTracks(this.#videoTracks()));
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
    this.#disposed = true;
    this.#detachAllTrackEndedListeners();
    this.#detachDeviceChangeListener();
    this.#stream = null;
    this.#listeners.clear();
    this.#resolveDeviceRefreshWaiters(true);
    return stream !== null && stream.getTracks().length > 0 ? stream : null;
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }

    this.#disposed = true;
    this.#detachAllTrackEndedListeners();
    this.#detachDeviceChangeListener();
    if (this.#stream !== null) {
      stopTracks(this.#stream);
      this.#stream = null;
    }
    this.#listeners.clear();
    this.#resolveDeviceRefreshWaiters(true);
    this.#snapshot = this.#buildSnapshot();
  }

  async #runRequests(requests: readonly MediaRequest[]): Promise<PrejoinMediaSnapshot> {
    if (this.#disposed || this.#status === 'checking') {
      return this.#snapshot;
    }

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

  async #acquire(request: MediaRequest): Promise<void> {
    let acquiredStream: MediaStream | null = null;
    try {
      if (this.#mediaDevices === undefined) {
        throw new Error('Browser media APIs are unavailable');
      }

      const constraints =
        request.kind === 'audio'
          ? {
              audio: withSelectedDevice(this.#audioConstraints, request.deviceId),
              video: false,
            }
          : {
              audio: false,
              video: withSelectedDevice(this.#videoConstraints, request.deviceId),
            };
      acquiredStream = await this.#mediaDevices.getUserMedia(constraints);

      if (this.#disposed) {
        stopTracks(acquiredStream);
        return;
      }

      const requestedTracks =
        request.kind === 'audio'
          ? acquiredStream.getAudioTracks()
          : acquiredStream.getVideoTracks();
      const track = requestedTracks[0];
      if (track === undefined || hasEnded(track)) {
        stopTracks(acquiredStream);
        acquiredStream = null;
        throw missingTrackError();
      }

      for (const extraTrack of acquiredStream.getTracks()) {
        if (extraTrack !== track) {
          extraTrack.stop();
        }
      }

      this.#replaceTrack(request.kind, track);
      if (hasEnded(track)) {
        throw missingTrackError();
      }
      const actualDeviceId = this.#trackDeviceId(track) ?? request.deviceId;
      if (request.kind === 'audio') {
        this.#selectedAudioInputId = actualDeviceId;
        this.#audioIssue = null;
      } else {
        this.#selectedVideoInputId = actualDeviceId;
        this.#videoIssue = null;
      }
    } catch (error) {
      if (acquiredStream !== null) {
        stopTracks(acquiredStream);
      }
      const issue = issueFor(error);
      if (request.kind === 'audio') {
        this.#audioIssue = issue;
      } else {
        this.#videoIssue = issue;
      }
    }
  }

  #replaceTrack(kind: InputKind, track: MediaStreamTrack): void {
    const previousTracks = kind === 'audio' ? this.#audioTracks() : this.#videoTracks();
    track.enabled = kind === 'audio' ? this.#desiredAudioEnabled : this.#desiredVideoEnabled;

    if (this.#stream === null) {
      this.#stream = this.#mediaStreamFactory();
    }

    for (const previousTrack of previousTracks) {
      this.#detachTrackEndedListener(previousTrack);
      this.#stream.removeTrack(previousTrack);
      previousTrack.stop();
    }
    this.#stream.addTrack(track);
    this.#attachTrackEndedListener(kind, track);
  }

  #attachTrackEndedListener(kind: InputKind, track: MediaStreamTrack): void {
    this.#detachTrackEndedListener(track);
    const listener: EventListener = () => {
      this.#handleTrackEnded(kind, track);
    };
    this.#trackEndedListeners.set(track, listener);
    track.addEventListener('ended', listener);
    if (hasEnded(track)) {
      this.#handleTrackEnded(kind, track);
    }
  }

  #handleTrackEnded(kind: InputKind, track: MediaStreamTrack): void {
    const stream = this.#stream;
    if (this.#disposed || stream === null || !this.#trackEndedListeners.has(track)) {
      this.#detachTrackEndedListener(track);
      return;
    }

    this.#detachTrackEndedListener(track);
    stream.removeTrack(track);
    const issue: PrejoinMediaIssue = { code: 'track-ended' };
    if (kind === 'audio') {
      this.#audioIssue = issue;
    } else {
      this.#videoIssue = issue;
    }
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

  #detachAllTrackEndedListeners(): void {
    for (const track of [...this.#trackEndedListeners.keys()]) {
      this.#detachTrackEndedListener(track);
    }
  }

  #attachDeviceChangeListener(): void {
    const mediaDevices = this.#mediaDevices;
    if (mediaDevices === undefined) {
      return;
    }

    const listener: EventListener = () => {
      void this.#requestDeviceRefresh(true);
    };
    this.#deviceChangeListener = listener;
    mediaDevices.addEventListener('devicechange', listener);
  }

  #detachDeviceChangeListener(): void {
    const listener = this.#deviceChangeListener;
    const mediaDevices = this.#mediaDevices;
    this.#deviceChangeListener = null;
    if (listener !== null && mediaDevices !== undefined) {
      mediaDevices.removeEventListener('devicechange', listener);
    }
  }

  #requestDeviceRefresh(emitSnapshot: boolean): Promise<void> {
    if (this.#disposed) {
      return Promise.resolve();
    }

    const generation = this.#deviceRefreshRequestedGeneration + 1;
    this.#deviceRefreshRequestedGeneration = generation;
    this.#deviceRefreshShouldEmit ||= emitSnapshot;
    const completion = new Promise<void>((resolve) => {
      this.#deviceRefreshWaiters.push({ generation, resolve });
    });
    this.#startDeviceRefresh();
    return completion;
  }

  #startDeviceRefresh(): void {
    if (this.#disposed || this.#deviceRefreshPromise !== null) {
      return;
    }

    const operation = this.#drainDeviceRefreshes();
    this.#deviceRefreshPromise = operation;
    const settle = () => {
      if (this.#deviceRefreshPromise === operation) {
        this.#deviceRefreshPromise = null;
      }
      if (this.#disposed) {
        this.#resolveDeviceRefreshWaiters(true);
        return;
      }
      this.#resolveDeviceRefreshWaiters(false);
      if (this.#deviceRefreshCompletedGeneration < this.#deviceRefreshRequestedGeneration) {
        this.#startDeviceRefresh();
      }
    };
    void operation.then(settle, settle);
  }

  async #drainDeviceRefreshes(): Promise<void> {
    while (
      !this.#disposed &&
      this.#deviceRefreshCompletedGeneration < this.#deviceRefreshRequestedGeneration
    ) {
      const generation = this.#deviceRefreshRequestedGeneration;
      const devices = await this.#enumerateDevices();
      if (this.#disposed) {
        return;
      }
      if (generation !== this.#deviceRefreshRequestedGeneration) {
        continue;
      }

      if (devices !== null) this.#applyDevices(devices);
      this.#deviceRefreshCompletedGeneration = generation;
      if (this.#deviceRefreshShouldEmit) {
        this.#deviceRefreshShouldEmit = false;
        this.#emit();
      }
      this.#resolveDeviceRefreshWaiters(false);
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
    this.#audioInputs = devices
      .filter((device) => device.kind === 'audioinput')
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || `마이크 ${index + 1}`,
      }));
    this.#videoInputs = devices
      .filter((device) => device.kind === 'videoinput')
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || `카메라 ${index + 1}`,
      }));

    this.#selectedAudioInputId = this.#normalizeSelection(
      this.#selectedAudioInputId,
      this.#audioInputs,
      this.#audioTracks()[0],
    );
    this.#selectedVideoInputId = this.#normalizeSelection(
      this.#selectedVideoInputId,
      this.#videoInputs,
      this.#videoTracks()[0],
    );
  }

  #resolveDeviceRefreshWaiters(force: boolean): void {
    for (let index = this.#deviceRefreshWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.#deviceRefreshWaiters[index]!;
      if (force || waiter.generation <= this.#deviceRefreshCompletedGeneration) {
        this.#deviceRefreshWaiters.splice(index, 1);
        waiter.resolve();
      }
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
    try {
      const deviceId = track.getSettings().deviceId;
      return typeof deviceId === 'string' && deviceId.length > 0 ? deviceId : null;
    } catch {
      return null;
    }
  }

  #toggleTracks(kind: InputKind, tracks: readonly MediaStreamTrack[]): boolean {
    if (this.#disposed || tracks.length === 0) {
      return false;
    }

    const enabled = !tracks.some((track) => track.enabled);
    if (kind === 'audio') {
      this.#desiredAudioEnabled = enabled;
    } else {
      this.#desiredVideoEnabled = enabled;
    }
    for (const track of tracks) {
      track.enabled = enabled;
    }
    this.#emit();
    return enabled;
  }

  #audioTracks(): MediaStreamTrack[] {
    return this.#stream?.getAudioTracks() ?? [];
  }

  #videoTracks(): MediaStreamTrack[] {
    return this.#stream?.getVideoTracks() ?? [];
  }

  #liveTracks(tracks: readonly MediaStreamTrack[]): MediaStreamTrack[] {
    return tracks.filter((track) => track.readyState === 'live');
  }

  #buildSnapshot(): PrejoinMediaSnapshot {
    const audioTracks = this.#liveTracks(this.#audioTracks());
    const videoTracks = this.#liveTracks(this.#videoTracks());
    return {
      status: this.#status,
      audioInputs: this.#audioInputs.map((device) => ({ ...device })),
      videoInputs: this.#videoInputs.map((device) => ({ ...device })),
      selectedAudioInputId: this.#selectedAudioInputId,
      selectedVideoInputId: this.#selectedVideoInputId,
      localMedia: {
        audioAvailable: audioTracks.length > 0,
        audioEnabled: audioTracks.some((track) => track.enabled),
        videoAvailable: videoTracks.length > 0,
        videoEnabled: videoTracks.some((track) => track.enabled),
      },
      audioIssue: this.#audioIssue === null ? null : { ...this.#audioIssue },
      videoIssue: this.#videoIssue === null ? null : { ...this.#videoIssue },
    };
  }

  #emit(): void {
    this.#snapshot = this.#buildSnapshot();
    for (const listener of [...this.#listeners]) {
      listener(this.#snapshot);
    }
  }
}
