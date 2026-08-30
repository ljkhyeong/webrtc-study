import { describe, expect, it, vi } from 'vitest';

import { PrejoinMedia } from '../src/index.js';
import { createHarness, joinSession, type Harness } from './room-session.test-support.js';

class FakeTrack {
  enabled = true;
  stopped = false;
  readyState: MediaStreamTrackState = 'live';
  readonly #endedListeners = new Set<EventListener>();

  constructor(
    readonly kind: 'audio' | 'video',
    readonly deviceId: string,
  ) {}

  getSettings(): MediaTrackSettings {
    return { deviceId: this.deviceId };
  }

  addEventListener(type: string, listener: EventListener): void {
    if (type === 'ended') {
      this.#endedListeners.add(listener);
    }
  }

  removeEventListener(type: string, listener: EventListener): void {
    if (type === 'ended') {
      this.#endedListeners.delete(listener);
    }
  }

  stop(): void {
    this.stopped = true;
    this.readyState = 'ended';
  }

  end(): void {
    if (this.readyState === 'ended') {
      return;
    }
    this.readyState = 'ended';
    for (const listener of [...this.#endedListeners]) {
      listener({ type: 'ended' } as Event);
    }
  }

  endedListenerCount(): number {
    return this.#endedListeners.size;
  }
}

class FakeMediaStream {
  readonly tracks: FakeTrack[];

  constructor(tracks: FakeTrack[] = []) {
    this.tracks = [...tracks];
  }

  getTracks(): MediaStreamTrack[] {
    return this.tracks as unknown as MediaStreamTrack[];
  }

  getAudioTracks(): MediaStreamTrack[] {
    return this.tracks.filter((track) => track.kind === 'audio') as unknown as MediaStreamTrack[];
  }

  getVideoTracks(): MediaStreamTrack[] {
    return this.tracks.filter((track) => track.kind === 'video') as unknown as MediaStreamTrack[];
  }

  addTrack(track: MediaStreamTrack): void {
    this.tracks.push(track as unknown as FakeTrack);
  }

  removeTrack(track: MediaStreamTrack): void {
    const index = this.tracks.indexOf(track as unknown as FakeTrack);
    if (index >= 0) {
      this.tracks.splice(index, 1);
    }
  }
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

function device(kind: MediaDeviceKind, deviceId: string, label: string): MediaDeviceInfo {
  return {
    deviceId,
    groupId: 'group',
    kind,
    label,
    toJSON: () => ({}),
  };
}

function mediaDeviceEventTarget(): Pick<MediaDevices, 'addEventListener' | 'removeEventListener'> {
  return {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}

describe('PrejoinMedia', () => {
  it.each(['audio', 'video'] as const)(
    '입장 전에 끄고 분리한 %s 장치를 방에서 다시 선택해도 꺼진 상태를 유지한다',
    async (kind) => {
      const audio = new FakeTrack('audio', 'mic');
      const video = new FakeTrack('video', 'camera');
      const controller = new PrejoinMedia({
        mediaDevices: {
          ...mediaDeviceEventTarget(),
          getUserMedia: async (constraints = {}) =>
            new FakeMediaStream([
              constraints.audio !== false ? audio : video,
            ]) as unknown as MediaStream,
          enumerateDevices: async () => [],
        },
        mediaStreamFactory: () => new FakeMediaStream() as unknown as MediaStream,
      });
      let harness: Harness | undefined;
      try {
        await controller.checkDevices();
        if (kind === 'audio') controller.toggleAudio();
        else controller.toggleVideo();
        (kind === 'audio' ? audio : video).end();
        const replacement = new FakeTrack(kind, 'replacement');
        harness = createHarness({
          initialInputEnabled: controller.getInputEnabled(),
          preparedMediaStream: controller.takeStream(),
          getUserMedia: async () => new FakeMediaStream([replacement]) as unknown as MediaStream,
        });
        await joinSession(harness);
        expect(await harness.session.selectInputDevice(kind, 'replacement')).toBe(true);
        expect(replacement.enabled).toBe(false);
        expect(kind === 'audio' ? video.stopped : audio.stopped).toBe(false);
      } finally {
        controller.dispose();
        await harness?.session.leave();
      }
    },
  );

  it.each(['audio', 'video'] as const)(
    '%s 트랙이 없으면 같은 장치와 목록에서 자동 선택한 대체 장치를 다시 요청한다',
    async (kind) => {
      let track = new FakeTrack(kind, 'first');
      let devices = [device(kind === 'audio' ? 'audioinput' : 'videoinput', 'first', '기존 장치')];
      const mediaDevices = Object.assign(new EventTarget(), {
        enumerateDevices: async () => devices,
        getUserMedia: vi.fn(async (constraints: MediaStreamConstraints = {}) => {
          if ((constraints.audio === false ? 'video' : 'audio') !== kind) {
            throw namedError('NotFoundError');
          }
          return new FakeMediaStream([track]) as unknown as MediaStream;
        }),
      });
      const controller = new PrejoinMedia({
        mediaDevices,
        mediaStreamFactory: () => new FakeMediaStream() as unknown as MediaStream,
      });
      const select = (id: string) =>
        kind === 'audio' ? controller.selectAudioInput(id) : controller.selectVideoInput(id);
      try {
        await controller.checkDevices();
        track.end();
        track = new FakeTrack(kind, 'first');
        await select('first');
        expect(controller.getStream()?.getTracks()).toEqual([track]);

        track.end();
        devices = [device(kind === 'audio' ? 'audioinput' : 'videoinput', 'next', '대체 장치')];
        mediaDevices.dispatchEvent(new Event('devicechange'));
        await flushMicrotasks();
        const snapshot = controller.getSnapshot();
        expect(
          kind === 'audio' ? snapshot.selectedAudioInputId : snapshot.selectedVideoInputId,
        ).toBe('next');
        track = new FakeTrack(kind, 'next');
        await select('next');
        expect(controller.getStream()?.getTracks()).toEqual([track]);
        const calls = mediaDevices.getUserMedia.mock.calls.length;
        await select('next');
        expect(mediaDevices.getUserMedia).toHaveBeenCalledTimes(calls);
      } finally {
        controller.dispose();
      }
    },
  );

  it('waits for an explicit check and keeps audio when video is busy', async () => {
    const audioTrack = new FakeTrack('audio', 'mic-default');
    const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
      if (constraints.audio !== false) {
        return new FakeMediaStream([audioTrack]) as unknown as MediaStream;
      }
      throw namedError('NotReadableError');
    });
    const controller = new PrejoinMedia({
      mediaDevices: {
        ...mediaDeviceEventTarget(),
        getUserMedia,
        enumerateDevices: vi.fn(async () => [
          device('audioinput', 'mic-default', '내장 마이크'),
          device('videoinput', 'camera-default', '내장 카메라'),
        ]),
      },
      mediaStreamFactory: () => new FakeMediaStream() as unknown as MediaStream,
    });

    expect(getUserMedia).not.toHaveBeenCalled();

    const snapshot = await controller.checkDevices();

    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(getUserMedia.mock.calls[0]?.[0]).toMatchObject({ audio: {}, video: false });
    expect(getUserMedia.mock.calls[1]?.[0]).toMatchObject({ audio: false, video: {} });
    expect(snapshot.localMedia).toEqual({
      audioAvailable: true,
      audioEnabled: true,
      videoAvailable: false,
      videoEnabled: false,
    });
    expect(snapshot.videoIssue).toEqual({ code: 'device-busy' });
    expect(controller.getStream()?.getAudioTracks()).toEqual([audioTrack]);
  });

  it('distinguishes permission denial from a missing device', async () => {
    const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
      if (constraints.audio !== false) {
        throw namedError('NotAllowedError');
      }
      throw namedError('NotFoundError');
    });
    const controller = new PrejoinMedia({
      mediaDevices: {
        ...mediaDeviceEventTarget(),
        getUserMedia,
        enumerateDevices: vi.fn(async () => []),
      },
      mediaStreamFactory: () => new FakeMediaStream() as unknown as MediaStream,
    });

    const snapshot = await controller.checkDevices();

    expect(snapshot.audioIssue).toEqual({ code: 'permission-denied' });
    expect(snapshot.videoIssue).toEqual({ code: 'device-not-found' });
    expect(controller.getStream()).toBeNull();
  });

  it('switches devices, preserves the pre-join toggle, and transfers ownership once', async () => {
    const tracks: FakeTrack[] = [];
    const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
      if (constraints.audio !== false) {
        const selected =
          typeof constraints.audio === 'object' &&
          typeof constraints.audio.deviceId === 'object' &&
          'exact' in constraints.audio.deviceId
            ? String(constraints.audio.deviceId.exact)
            : 'mic-default';
        const track = new FakeTrack('audio', selected);
        tracks.push(track);
        return new FakeMediaStream([track]) as unknown as MediaStream;
      }

      const track = new FakeTrack('video', 'camera-default');
      tracks.push(track);
      return new FakeMediaStream([track]) as unknown as MediaStream;
    });
    const controller = new PrejoinMedia({
      mediaDevices: {
        ...mediaDeviceEventTarget(),
        getUserMedia,
        enumerateDevices: vi.fn(async () => [
          device('audioinput', 'mic-default', '내장 마이크'),
          device('audioinput', 'mic-usb', 'USB 마이크'),
          device('videoinput', 'camera-default', '내장 카메라'),
        ]),
      },
      mediaStreamFactory: () => new FakeMediaStream() as unknown as MediaStream,
    });

    await controller.checkDevices();
    expect(controller.toggleAudio()).toBe(false);
    const previousAudioTrack = tracks[0];

    const switched = await controller.selectAudioInput('mic-usb');

    expect(previousAudioTrack?.stopped).toBe(true);
    expect(switched.selectedAudioInputId).toBe('mic-usb');
    expect(switched.localMedia.audioEnabled).toBe(false);
    const transferred = controller.takeStream();
    controller.dispose();

    expect(transferred?.getTracks()).toHaveLength(2);
    expect(transferred?.getTracks().every((track) => track.readyState !== 'ended')).toBe(true);
    expect(controller.takeStream()).toBeNull();
    expect((transferred?.getAudioTracks()[0] as unknown as FakeTrack).stopped).toBe(false);
  });

  it('marks an ended preview track unavailable and reacquires only that device', async () => {
    const firstAudio = new FakeTrack('audio', 'mic-default');
    const replacementAudio = new FakeTrack('audio', 'mic-default');
    const video = new FakeTrack('video', 'camera-default');
    let audioRequests = 0;
    const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
      if (constraints.audio !== false) {
        audioRequests += 1;
        return new FakeMediaStream([
          audioRequests === 1 ? firstAudio : replacementAudio,
        ]) as unknown as MediaStream;
      }
      return new FakeMediaStream([video]) as unknown as MediaStream;
    });
    const controller = new PrejoinMedia({
      mediaDevices: {
        ...mediaDeviceEventTarget(),
        getUserMedia,
        enumerateDevices: vi.fn(async () => [
          device('audioinput', 'mic-default', '내장 마이크'),
          device('videoinput', 'camera-default', '내장 카메라'),
        ]),
      },
      mediaStreamFactory: () => new FakeMediaStream() as unknown as MediaStream,
    });

    await controller.checkDevices();
    expect(controller.toggleAudio()).toBe(false);
    firstAudio.end();

    expect(controller.getSnapshot()).toMatchObject({
      localMedia: {
        audioAvailable: false,
        audioEnabled: false,
        videoAvailable: true,
        videoEnabled: true,
      },
      audioIssue: {
        code: 'track-ended',
      },
    });
    expect(controller.getStream()?.getAudioTracks()).toEqual([]);

    const retried = await controller.retryUnavailable();

    expect(getUserMedia).toHaveBeenCalledTimes(3);
    expect(retried.localMedia).toEqual({
      audioAvailable: true,
      audioEnabled: false,
      videoAvailable: true,
      videoEnabled: true,
    });
    expect(retried.audioIssue).toBeNull();
    expect(controller.getStream()?.getAudioTracks()).toEqual([replacementAudio]);
    expect(replacementAudio.enabled).toBe(false);
  });

  it('releases preview ended listeners when stream ownership transfers', async () => {
    const audioTrack = new FakeTrack('audio', 'mic-default');
    const controller = new PrejoinMedia({
      mediaDevices: {
        ...mediaDeviceEventTarget(),
        getUserMedia: vi.fn(async (constraints: MediaStreamConstraints) => {
          if (constraints.audio !== false) {
            return new FakeMediaStream([audioTrack]) as unknown as MediaStream;
          }
          throw namedError('NotFoundError');
        }),
        enumerateDevices: vi.fn(async () => [device('audioinput', 'mic-default', '내장 마이크')]),
      },
      mediaStreamFactory: () => new FakeMediaStream() as unknown as MediaStream,
    });

    await controller.checkDevices();
    expect(audioTrack.endedListenerCount()).toBe(1);

    const transferred = controller.takeStream();

    expect(transferred?.getAudioTracks()).toEqual([audioTrack]);
    expect(audioTrack.endedListenerCount()).toBe(0);
    audioTrack.end();
    expect(controller.getSnapshot().localMedia.audioAvailable).toBe(true);
  });

  it('coalesces device changes, publishes only the newest list, and detaches on dispose', async () => {
    const audioTrack = new FakeTrack('audio', 'mic-default');
    const videoTrack = new FakeTrack('video', 'camera-default');
    const staleEnumeration = deferred<MediaDeviceInfo[]>();
    const deviceChangeListeners = new Set<EventListener>();
    const enumerateDevices = vi
      .fn<() => Promise<MediaDeviceInfo[]>>()
      .mockResolvedValueOnce([
        device('audioinput', 'mic-default', '내장 마이크'),
        device('videoinput', 'camera-default', '내장 카메라'),
      ])
      .mockImplementationOnce(() => staleEnumeration.promise)
      .mockResolvedValueOnce([
        device('audioinput', 'mic-usb', 'USB 마이크'),
        device('videoinput', 'camera-usb', 'USB 카메라'),
      ]);
    const addEventListener = vi.fn((type: string, listener: EventListener) => {
      if (type === 'devicechange') {
        deviceChangeListeners.add(listener);
      }
    });
    const removeEventListener = vi.fn((type: string, listener: EventListener) => {
      if (type === 'devicechange') {
        deviceChangeListeners.delete(listener);
      }
    });
    const mediaDevices = {
      addEventListener,
      enumerateDevices,
      getUserMedia: vi.fn(async (constraints: MediaStreamConstraints) =>
        constraints.audio === false
          ? (new FakeMediaStream([videoTrack]) as unknown as MediaStream)
          : (new FakeMediaStream([audioTrack]) as unknown as MediaStream),
      ),
      removeEventListener,
    } as unknown as MediaDevices;
    const controller = new PrejoinMedia({
      mediaDevices,
      mediaStreamFactory: () => new FakeMediaStream() as unknown as MediaStream,
    });

    await controller.checkDevices();
    expect(addEventListener).toHaveBeenCalledWith('devicechange', expect.any(Function));
    expect(deviceChangeListeners.size).toBe(1);

    const publishedAudioInputs: string[][] = [];
    controller.subscribe((snapshot) => {
      publishedAudioInputs.push(snapshot.audioInputs.map((input) => input.deviceId));
    });
    const emitDeviceChange = () => {
      for (const listener of [...deviceChangeListeners]) {
        listener({ type: 'devicechange' } as Event);
      }
    };

    emitDeviceChange();
    await flushMicrotasks();
    expect(enumerateDevices).toHaveBeenCalledTimes(2);
    emitDeviceChange();
    await flushMicrotasks();
    expect(enumerateDevices).toHaveBeenCalledTimes(2);

    staleEnumeration.resolve([device('audioinput', 'mic-stale', '이전 마이크')]);
    await vi.waitFor(() => {
      expect(enumerateDevices).toHaveBeenCalledTimes(3);
      expect(controller.getSnapshot().audioInputs).toEqual([
        { deviceId: 'mic-usb', label: 'USB 마이크' },
      ]);
    });
    expect(publishedAudioInputs).not.toContainEqual(['mic-stale']);
    expect(publishedAudioInputs.at(-1)).toEqual(['mic-usb']);

    controller.dispose();
    expect(removeEventListener).toHaveBeenCalledWith('devicechange', expect.any(Function));
    expect(deviceChangeListeners.size).toBe(0);
    const enumerationCountAfterDispose = enumerateDevices.mock.calls.length;
    emitDeviceChange();
    await flushMicrotasks();
    expect(enumerateDevices).toHaveBeenCalledTimes(enumerationCountAfterDispose);
  });
});
