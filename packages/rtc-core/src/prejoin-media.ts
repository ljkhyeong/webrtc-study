export type PrejoinMediaStatus = 'idle' | 'checking' | 'ready';

export type PrejoinMediaIssueCode =
  'permission-denied' | 'device-not-found' | 'device-busy' | 'media-unavailable';

export interface PrejoinMediaIssue {
  readonly code: PrejoinMediaIssueCode;
  readonly message: string;
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

export interface PrejoinMediaOptions {
  readonly audioConstraints?: MediaTrackConstraints;
  readonly videoConstraints?: MediaTrackConstraints;
  readonly mediaDevices?: Pick<MediaDevices, 'enumerateDevices' | 'getUserMedia'>;
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

function issueFor(kind: InputKind, error: unknown): PrejoinMediaIssue {
  const deviceName = kind === 'audio' ? '마이크' : '카메라';

  switch (getErrorName(error)) {
    case 'NotAllowedError':
    case 'SecurityError':
      return {
        code: 'permission-denied',
        message: `${deviceName} 권한이 거부되었습니다. 브라우저 설정에서 허용한 뒤 다시 시도해 주세요.`,
      };
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return {
        code: 'device-not-found',
        message: `사용할 수 있는 ${deviceName}를 찾지 못했습니다. 장치 연결 상태를 확인해 주세요.`,
      };
    case 'AbortError':
    case 'NotReadableError':
    case 'TrackStartError':
      return {
        code: 'device-busy',
        message: `${deviceName}를 다른 앱이 사용 중입니다. 다른 앱을 닫은 뒤 다시 시도해 주세요.`,
      };
    default:
      return {
        code: 'media-unavailable',
        message: `${deviceName}를 열지 못했습니다. 장치와 브라우저 설정을 확인한 뒤 다시 시도해 주세요.`,
      };
  }
}

function unavailableError(): Error {
  const error = new Error('Browser media APIs are unavailable');
  error.name = 'MediaUnavailableError';
  return error;
}

function missingTrackError(): Error {
  const error = new Error('The requested media track was not returned');
  error.name = 'NotFoundError';
  return error;
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
 * Owns camera and microphone tracks while the user is on pre-join.
 *
 * React callers should keep this object in a ref and store only getSnapshot()
 * results in state. `takeStream()` transfers track ownership to RoomSession.
 */
export class PrejoinMedia {
  readonly #audioConstraints: MediaTrackConstraints;
  readonly #videoConstraints: MediaTrackConstraints;
  readonly #mediaDevices: Pick<MediaDevices, 'enumerateDevices' | 'getUserMedia'> | undefined;
  readonly #mediaStreamFactory: () => MediaStream;
  readonly #listeners = new Set<PrejoinMediaListener>();
  readonly #trackEndedListeners = new Map<MediaStreamTrack, EventListener>();

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

  constructor(options: PrejoinMediaOptions = {}) {
    this.#audioConstraints = options.audioConstraints ?? {};
    this.#videoConstraints = options.videoConstraints ?? {};
    this.#mediaDevices =
      options.mediaDevices ??
      (typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined);
    this.#mediaStreamFactory = options.mediaStreamFactory ?? (() => new MediaStream());
    this.#snapshot = this.#buildSnapshot();
  }

  getSnapshot(): PrejoinMediaSnapshot {
    return this.#snapshot;
  }

  getStream(): MediaStream | null {
    return this.#stream;
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
    if (deviceId.length === 0 || deviceId === this.#selectedAudioInputId) {
      return Promise.resolve(this.#snapshot);
    }
    return this.#runRequests([{ kind: 'audio', deviceId }]);
  }

  selectVideoInput(deviceId: string): Promise<PrejoinMediaSnapshot> {
    if (deviceId.length === 0 || deviceId === this.#selectedVideoInputId) {
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
   * Transfers the current stream without stopping its tracks.
   * The controller becomes single-use and may safely be disposed afterward.
   */
  takeStream(): MediaStream | null {
    if (this.#status === 'checking') {
      throw new Error('Cannot transfer media while devices are being checked');
    }
    if (this.#disposed) {
      return null;
    }

    const stream = this.#stream;
    this.#detachAllTrackEndedListeners();
    this.#stream = null;
    this.#disposed = true;
    this.#listeners.clear();
    return stream !== null && stream.getTracks().length > 0 ? stream : null;
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }

    this.#disposed = true;
    this.#detachAllTrackEndedListeners();
    if (this.#stream !== null) {
      stopTracks(this.#stream);
      this.#stream = null;
    }
    this.#listeners.clear();
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

    await this.#refreshDevices();
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
        throw unavailableError();
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
      const issue = issueFor(request.kind, error);
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
    if (stream.getTracks().includes(track)) {
      stream.removeTrack(track);
    }
    const deviceName = kind === 'audio' ? '마이크' : '카메라';
    const issue: PrejoinMediaIssue = {
      code: 'media-unavailable',
      message: `${deviceName} 연결이 종료되었습니다. 장치 연결 상태를 확인한 뒤 다시 시도해 주세요.`,
    };
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

  async #refreshDevices(): Promise<void> {
    if (this.#mediaDevices === undefined) {
      this.#audioInputs = [];
      this.#videoInputs = [];
      return;
    }

    try {
      const devices = await this.#mediaDevices.enumerateDevices();
      if (this.#disposed) {
        return;
      }

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
    } catch {
      this.#audioInputs = [];
      this.#videoInputs = [];
    }
  }

  #normalizeSelection(
    selectedDeviceId: string | null,
    devices: readonly PrejoinMediaDevice[],
    track: MediaStreamTrack | undefined,
  ): string | null {
    if (
      selectedDeviceId !== null &&
      devices.some((device) => device.deviceId === selectedDeviceId)
    ) {
      return selectedDeviceId;
    }

    const activeDeviceId = track === undefined ? null : this.#trackDeviceId(track);
    if (activeDeviceId !== null && devices.some((device) => device.deviceId === activeDeviceId)) {
      return activeDeviceId;
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
        audioEnabled: audioTracks.length > 0 && audioTracks.some((track) => track.enabled),
        videoAvailable: videoTracks.length > 0,
        videoEnabled: videoTracks.length > 0 && videoTracks.some((track) => track.enabled),
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

export function createPrejoinMedia(options: PrejoinMediaOptions = {}): PrejoinMedia {
  return new PrejoinMedia(options);
}
