import { describe, expect, it, vi } from 'vitest';

import { createPrejoinMedia } from '../src/index.js';

class FakeTrack {
  enabled = true;
  stopped = false;

  constructor(
    readonly kind: 'audio' | 'video',
    readonly deviceId: string,
  ) {}

  getSettings(): MediaTrackSettings {
    return { deviceId: this.deviceId };
  }

  stop(): void {
    this.stopped = true;
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

describe('PrejoinMedia', () => {
  it('waits for an explicit check and keeps audio when video is busy', async () => {
    const audioTrack = new FakeTrack('audio', 'mic-default');
    const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
      if (constraints.audio !== false) {
        return new FakeMediaStream([audioTrack]) as unknown as MediaStream;
      }
      throw namedError('NotReadableError');
    });
    const controller = createPrejoinMedia({
      mediaDevices: {
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
    expect(snapshot.videoIssue).toEqual({
      code: 'device-busy',
      message: '카메라를 다른 앱이 사용 중입니다. 다른 앱을 닫은 뒤 다시 시도해 주세요.',
    });
    expect(controller.getStream()?.getAudioTracks()).toEqual([audioTrack]);
  });

  it('distinguishes permission denial from a missing device in Korean', async () => {
    const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
      if (constraints.audio !== false) {
        throw namedError('NotAllowedError');
      }
      throw namedError('NotFoundError');
    });
    const controller = createPrejoinMedia({
      mediaDevices: {
        getUserMedia,
        enumerateDevices: vi.fn(async () => []),
      },
      mediaStreamFactory: () => new FakeMediaStream() as unknown as MediaStream,
    });

    const snapshot = await controller.checkDevices();

    expect(snapshot.audioIssue).toEqual({
      code: 'permission-denied',
      message: '마이크 권한이 거부되었습니다. 브라우저 설정에서 허용한 뒤 다시 시도해 주세요.',
    });
    expect(snapshot.videoIssue).toEqual({
      code: 'device-not-found',
      message: '사용할 수 있는 카메라를 찾지 못했습니다. 장치 연결 상태를 확인해 주세요.',
    });
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
    const controller = createPrejoinMedia({
      mediaDevices: {
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
});
