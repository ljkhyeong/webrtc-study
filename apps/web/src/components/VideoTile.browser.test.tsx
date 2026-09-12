// @vitest-environment jsdom

import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VideoTile, type ParticipantView } from './VideoTile';

function remoteParticipant(
  stream: MediaStream,
  videoSource: ParticipantView['videoSource'] = 'camera',
): ParticipantView {
  return {
    peerId: 'peer-1',
    displayName: '스터디원',
    role: 'participant',
    isLocal: false,
    handRaised: false,
    audioEnabled: true,
    videoEnabled: true,
    videoSource,
    connectionState: 'connected',
    stream,
  };
}

function deferredPlayback(): {
  readonly promise: Promise<void>;
  readonly reject: (error: unknown) => void;
} {
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((_, rejectPromise) => {
    reject = rejectPromise;
  });
  return { promise, reject };
}

function deferredCompletion(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function installFullscreenDocument() {
  let fullscreenElement: Element | null = null;
  const exitFullscreen = vi.fn(async () => {
    fullscreenElement = null;
  });
  Object.defineProperties(document, {
    fullscreenElement: { configurable: true, get: () => fullscreenElement },
    exitFullscreen: { configurable: true, value: exitFullscreen },
  });
  return {
    enter: (element: Element | null) => {
      fullscreenElement = element;
    },
    exitFullscreen,
  };
}

function installPictureInPicture() {
  let owner: HTMLVideoElement | null = null;
  const enter = (video: HTMLVideoElement) => {
    const previous = owner;
    owner = video;
    previous?.dispatchEvent(new Event('leavepictureinpicture'));
    video.dispatchEvent(new Event('enterpictureinpicture'));
  };
  const exit = vi.fn(async () => {
    const previous = owner;
    owner = null;
    previous?.dispatchEvent(new Event('leavepictureinpicture'));
  });
  const request = vi.fn(async function (this: HTMLVideoElement) {
    enter(this);
    return {} as PictureInPictureWindow;
  });
  Object.defineProperties(document, {
    pictureInPictureEnabled: { configurable: true, value: true },
    pictureInPictureElement: { configurable: true, get: () => owner },
    exitPictureInPicture: { configurable: true, value: exit },
  });
  Object.defineProperty(HTMLVideoElement.prototype, 'requestPictureInPicture', {
    configurable: true,
    value: request,
  });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(4);
  vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(640);
  return { enter, exit, request };
}

describe('VideoTile browser behavior', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      value: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(HTMLMediaElement.prototype, 'setSinkId');
    Reflect.deleteProperty(HTMLMediaElement.prototype, 'sinkId');
    Reflect.deleteProperty(document, 'fullscreenElement');
    Reflect.deleteProperty(document, 'exitFullscreen');
    Reflect.deleteProperty(document, 'pictureInPictureEnabled');
    Reflect.deleteProperty(document, 'pictureInPictureElement');
    Reflect.deleteProperty(document, 'exitPictureInPicture');
    Reflect.deleteProperty(HTMLVideoElement.prototype, 'requestPictureInPicture');
    document.body.replaceChildren();
  });

  it('작은 창의 버튼과 브라우저 자체 종료를 반영하고 공유 종료 시 창만 닫는다', async () => {
    const pip = installPictureInPicture();
    const root = createRoot(document.body);
    const participant = remoteParticipant({} as MediaStream, 'screen');
    const button = () => document.querySelector<HTMLButtonElement>('[aria-label*="작은 창"]')!;
    try {
      await act(async () =>
        root.render(
          <StrictMode>
            <VideoTile participant={participant} />
          </StrictMode>,
        ),
      );
      const video = document.querySelector('video')!;
      await act(async () => button().click());
      expect(document.pictureInPictureElement).toBe(video);
      expect(button().textContent).toBe('작은 창 닫기');
      await act(async () => button().click());
      expect(document.pictureInPictureElement).toBeNull();
      await act(async () => button().click());
      await act(async () => pip.exit());
      expect(button().getAttribute('aria-pressed')).toBe('false');
      await act(async () => button().click());
      await act(async () =>
        root.render(
          <StrictMode>
            <VideoTile participant={{ ...participant, videoSource: 'camera' }} />
          </StrictMode>,
        ),
      );
      expect(document.pictureInPictureElement).toBeNull();
      expect(button()).toBeNull();
      expect(document.querySelector('video')).toBe(video);
      expect(video.srcObject).toBe(participant.stream);
      expect(video.muted).toBe(false);
    } finally {
      act(() => root.unmount());
    }
  });

  it('작은 창 요청 중 중복 실행을 막고 공유 종료 뒤 늦게 열린 창을 닫는다', async () => {
    const pip = installPictureInPicture();
    const pending = deferredCompletion();
    pip.request.mockImplementationOnce(async function (this: HTMLVideoElement) {
      await pending.promise;
      pip.enter(this);
      return {} as PictureInPictureWindow;
    });
    const root = createRoot(document.body);
    const participant = remoteParticipant({} as MediaStream, 'screen');
    try {
      await act(async () => root.render(<VideoTile participant={participant} />));
      const button = document.querySelector<HTMLButtonElement>('[aria-label*="작은 창"]')!;
      act(() => {
        button.click();
        button.click();
      });
      expect(pip.request).toHaveBeenCalledOnce();
      expect(button.disabled).toBe(true);
      await act(async () =>
        root.render(<VideoTile participant={{ ...participant, videoSource: 'camera' }} />),
      );
      await act(async () => pending.resolve());
      expect(pip.exit).toHaveBeenCalledOnce();
      expect(document.pictureInPictureElement).toBeNull();
      expect(document.querySelector('video')!.srcObject).toBe(participant.stream);
    } finally {
      act(() => root.unmount());
    }
  });

  it.each([false, true])('타일을 제거할 때 자기 작은 창만 닫는다: 다른 창=%s', async (other) => {
    const pip = installPictureInPicture();
    const root = createRoot(document.body);
    await act(async () =>
      root.render(<VideoTile participant={remoteParticipant({} as MediaStream, 'screen')} />),
    );
    const owner = other ? document.createElement('video') : document.querySelector('video')!;
    act(() => pip.enter(owner));
    await act(async () => root.unmount());
    expect(document.pictureInPictureElement).toBe(other ? owner : null);
    expect(pip.exit).toHaveBeenCalledTimes(other ? 0 : 1);
  });

  it('작은 창 열기·닫기 실패를 안내하고 재시도할 수 있다', async () => {
    const pip = installPictureInPicture();
    pip.request.mockRejectedValueOnce(new DOMException('blocked', 'NotAllowedError'));
    const root = createRoot(document.body);
    const button = () => document.querySelector<HTMLButtonElement>('[aria-label*="작은 창"]')!;
    try {
      await act(async () =>
        root.render(<VideoTile participant={remoteParticipant({} as MediaStream, 'screen')} />),
      );
      await act(async () => button().click());
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        '작은 창을 열지 못했습니다.',
      );
      expect(button().disabled).toBe(false);
      await act(async () => button().click());
      expect(document.querySelector('[role="alert"]')).toBeNull();
      pip.exit.mockRejectedValueOnce(new Error('blocked'));
      await act(async () => button().click());
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        '작은 창을 닫지 못했습니다.',
      );
      expect(button().textContent).toBe('작은 창 닫기');
      await act(async () => button().click());
      expect(document.pictureInPictureElement).toBeNull();
      expect(document.querySelector('[role="alert"]')).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it('작은 창 미지원이면 버튼을 숨기고 지원 시 영상이 준비될 때까지 기다린다', async () => {
    installPictureInPicture();
    Object.defineProperty(document, 'pictureInPictureEnabled', {
      configurable: true,
      value: false,
    });
    const width = vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(0);
    const root = createRoot(document.body);
    const participant = remoteParticipant({} as MediaStream, 'screen');
    const button = () => document.querySelector<HTMLButtonElement>('[aria-label*="작은 창"]');
    try {
      await act(async () => root.render(<VideoTile participant={participant} />));
      expect(button()).toBeNull();
      Object.defineProperty(document, 'pictureInPictureEnabled', {
        configurable: true,
        value: true,
      });
      await act(async () =>
        root.render(<VideoTile participant={{ ...participant, stream: {} as MediaStream }} />),
      );
      expect(button()?.disabled).toBe(true);
      width.mockReturnValue(640);
      act(() => document.querySelector('video')!.dispatchEvent(new Event('resize')));
      expect(button()?.disabled).toBe(false);
    } finally {
      act(() => root.unmount());
    }
  });

  it('참가자 재연결 요청 실패를 안내하고 다음 요청이 성공하면 해제한다', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const onRetryPeer = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const root = createRoot(document.body);
    const participant = {
      ...remoteParticipant({} as MediaStream),
      connectionState: 'failed' as const,
    };

    try {
      await act(async () => root.render(<VideoTile {...{ participant, onRetryPeer }} />));
      const retry = document.querySelector<HTMLButtonElement>(
        'button[aria-label="스터디원 다시 연결"]',
      )!;

      act(() => retry.click());
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        '재연결 요청을 보내지 못했습니다.',
      );
      await act(async () =>
        root.render(
          <VideoTile
            participant={{ ...participant, connectionState: 'connecting' }}
            onRetryPeer={onRetryPeer}
          />,
        ),
      );
      await act(async () => root.render(<VideoTile {...{ participant, onRetryPeer }} />));
      expect(document.querySelector('[role="alert"]')).toBeNull();
      act(() =>
        document
          .querySelector<HTMLButtonElement>('button[aria-label="스터디원 다시 연결"]')!
          .click(),
      );
      expect(onRetryPeer).toHaveBeenCalledTimes(2);
      expect(onRetryPeer).toHaveBeenLastCalledWith('peer-1');
    } finally {
      act(() => root.unmount());
    }
  });

  it('전체 화면 닫기 버튼과 브라우저 자체 종료 뒤에 버튼 상태를 복원한다', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const fullscreen = installFullscreenDocument();
    const root = createRoot(document.body);
    try {
      await act(async () =>
        root.render(<VideoTile participant={remoteParticipant({} as MediaStream, 'screen')} />),
      );
      const tile = document.querySelector('article')!;
      Object.defineProperty(tile, 'requestFullscreen', {
        configurable: true,
        value: async () => {
          fullscreen.enter(tile);
          document.dispatchEvent(new Event('fullscreenchange'));
        },
      });
      const button = () => document.querySelector<HTMLButtonElement>('[aria-label*="전체 화면"]')!;
      await act(async () => button().click());
      expect(button().textContent).toContain('전체 화면 닫기');
      await act(async () => button().click());
      expect(document.fullscreenElement).toBeNull();
      expect(button().textContent).not.toContain('닫기');
      await act(async () => button().click());
      await act(async () => {
        await document.exitFullscreen();
        document.dispatchEvent(new Event('fullscreenchange'));
      });
      expect(button().textContent).not.toContain('닫기');
    } finally {
      act(() => root.unmount());
    }
  });

  it('개인 음량과 음소거를 스트림·스피커 교체 뒤에도 유지하고 상대 마이크를 바꾸지 않는다', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const root = createRoot(document.body);
    const participant = remoteParticipant({} as MediaStream);
    try {
      await act(async () => root.render(<VideoTile participant={participant} />));
      const video = document.querySelector('video')!;
      const slider = document.querySelector<HTMLInputElement>('input[type="range"]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          slider,
          '35',
        );
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        slider.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(video.volume).toBe(0.35);
      const button = document.querySelector<HTMLButtonElement>('.video-tile__local-mute')!;
      await act(async () => button.click());
      expect(video.muted).toBe(true);
      expect(button.getAttribute('aria-pressed')).toBe('true');
      await act(async () =>
        root.render(
          <VideoTile
            participant={{ ...participant, stream: {} as MediaStream, videoEnabled: false }}
            audioOutput={{ deviceId: '' }}
          />,
        ),
      );
      expect(document.querySelector('video')).toBe(video);
      expect(video.muted).toBe(true);
      expect(participant.audioEnabled).toBe(true);
      expect(video.volume).toBe(0.35);
      await act(async () => button.click());
      expect(video.muted).toBe(false);
      expect(video.volume).toBe(0.35);
    } finally {
      act(() => root.unmount());
    }
  });

  it('음량 변경을 무시하는 브라우저에서는 조절 막대 대신 기기 음량을 안내한다', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const volume = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume')!;
    Object.defineProperty(HTMLMediaElement.prototype, 'volume', {
      ...volume,
      get: () => 1,
      set: () => {},
    });
    const root = createRoot(document.body);
    try {
      await act(async () =>
        root.render(<VideoTile participant={remoteParticipant({} as MediaStream)} />),
      );
      expect(document.querySelector<HTMLInputElement>('input[type="range"]')!.disabled).toBe(true);
      expect(document.body.textContent).toContain('기기 음량이나 소리 끄기');
      await act(async () =>
        document.querySelector<HTMLButtonElement>('.video-tile__local-mute')!.click(),
      );
      expect(document.querySelector('video')!.muted).toBe(true);
    } finally {
      act(() => root.unmount());
      Object.defineProperty(HTMLMediaElement.prototype, 'volume', volume);
    }
  });

  it('내 영상을 숨겨도 영상 요소와 송신 상태를 유지하고 장치 교체 뒤 다시 보여 준다', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const participant = { ...remoteParticipant({} as MediaStream), isLocal: true };
    const root = createRoot(document.body);
    try {
      await act(async () => root.render(<VideoTile participant={participant} />));
      const video = document.querySelector('video')!;
      const button = document.querySelector<HTMLButtonElement>('.video-tile__local-mute')!;
      await act(async () => button.click());
      expect(document.querySelector('video')).toBe(video);
      expect(video.getAttribute('aria-hidden')).toBe('true');
      expect(video.srcObject).toBe(participant.stream);
      expect(participant.videoEnabled).toBe(true);
      expect(play).toHaveBeenCalledOnce();
      const stream = {} as MediaStream;
      await act(async () => root.render(<VideoTile participant={{ ...participant, stream }} />));
      expect(video.srcObject).toBe(stream);
      expect(video.getAttribute('aria-hidden')).toBe('true');
      await act(async () => button.click());
      expect(video.getAttribute('aria-hidden')).toBe('false');
      expect(video.muted).toBe(true);
    } finally {
      act(() => root.unmount());
    }
  });

  it('공유 화면의 확대·이동 범위를 제한하고 공유 종료와 스트림 교체 때 초기화한다', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const participant = remoteParticipant({} as MediaStream, 'screen');
    const root = createRoot(document.body);
    try {
      await act(async () => root.render(<VideoTile participant={participant} />));
      const video = document.querySelector('video')!;
      const viewport = document.querySelector<HTMLElement>('.video-tile__viewport')!;
      const key = (key: string) =>
        act(() => viewport.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));
      for (let index = 0; index < 10; index += 1) key('+');
      expect(video.style.width).toBe('400%');
      for (let index = 0; index < 15; index += 1) key('ArrowRight');
      expect(video.style.left).toBe('-300%');
      expect(video.muted).toBe(false);
      expect(play).toHaveBeenCalledOnce();
      key('0');
      expect(video.style.width).toBe('100%');
      Object.defineProperties(viewport, {
        clientWidth: { configurable: true, value: 200 },
        clientHeight: { configurable: true, value: 400 },
      });
      Object.defineProperties(video, {
        videoWidth: { configurable: true, value: 1600 },
        videoHeight: { configurable: true, value: 900 },
      });
      act(() => video.dispatchEvent(new Event('loadedmetadata')));
      key('+');
      for (let index = 0; index < 15; index += 1) key('ArrowDown');
      // 세로 타일보다 낮은 영상은 세로로 끌어 검은 여백 뒤로 숨길 수 없다.
      expect(video.style.top).toBe('-25%');
      await act(async () =>
        root.render(<VideoTile participant={{ ...participant, stream: {} as MediaStream }} />),
      );
      expect(video.style.width).toBe('100%');
      key('+');
      await act(async () =>
        root.render(<VideoTile participant={{ ...participant, videoSource: 'camera' }} />),
      );
      expect(document.querySelector('video')).toBe(video);
      expect(video.style.width).toBe('');
      expect(document.querySelector('[aria-label="공유 화면 확대"]')).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it('전체 화면에 확대 도구를 함께 열고 공유가 끝나면 닫는다', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const fullscreen = installFullscreenDocument();
    const root = createRoot(document.body);
    const participant = remoteParticipant({} as MediaStream, 'screen');
    try {
      await act(async () => root.render(<VideoTile participant={participant} />));
      const tile = document.querySelector('article')!;
      const request = vi.fn(async () => fullscreen.enter(tile));
      Object.defineProperty(tile, 'requestFullscreen', { configurable: true, value: request });
      await act(async () =>
        document.querySelector<HTMLButtonElement>('[aria-label$="전체 화면으로 보기"]')!.click(),
      );
      expect(request).toHaveBeenCalledOnce();
      expect(document.fullscreenElement).toBe(tile);
      expect(tile.querySelector('[aria-label="공유 화면 확대"]')).not.toBeNull();
      await act(async () =>
        root.render(<VideoTile participant={{ ...participant, videoSource: 'camera' }} />),
      );
      expect(fullscreen.exitFullscreen).toHaveBeenCalledOnce();
    } finally {
      act(() => root.unmount());
    }
  });

  it('개인 음소거 해제로 스피커 적용 실패를 우회하지 않는다', async () => {
    const setSinkId = vi.fn().mockRejectedValue(new DOMException('장치 없음', 'NotFoundError'));
    Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', {
      configurable: true,
      value: setSinkId,
    });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const root = createRoot(document.body);
    try {
      await act(async () =>
        root.render(
          <VideoTile
            participant={remoteParticipant({} as MediaStream)}
            audioOutput={{ deviceId: 'missing' }}
          />,
        ),
      );
      const button = document.querySelector<HTMLButtonElement>('.video-tile__local-mute')!;
      await act(async () => button.click());
      await act(async () => button.click());
      expect(document.querySelector('video')!.muted).toBe(true);
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('선택한 스피커');
    } finally {
      act(() => root.unmount());
    }
  });

  it('기본 스피커를 그대로 쓰면 출력 선택 API를 호출하지 않는다', async () => {
    const setSinkId = vi.fn().mockRejectedValue(new DOMException('권한 없음', 'NotAllowedError'));
    Object.defineProperties(HTMLMediaElement.prototype, {
      sinkId: { configurable: true, value: '' },
      setSinkId: { configurable: true, value: setSinkId },
    });
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const root = createRoot(document.body);
    try {
      await act(async () =>
        root.render(<VideoTile participant={remoteParticipant({} as MediaStream)} />),
      );
      expect(setSinkId).not.toHaveBeenCalled();
      expect(play).toHaveBeenCalledTimes(1);
      expect(document.querySelector('video')?.muted).toBe(false);
    } finally {
      act(() => root.unmount());
    }
  });

  it('출력 장치 변경을 순서대로 적용하고 적용 실패 시 음소거와 안내를 유지한다', async () => {
    const firstChange = deferredCompletion();
    const setSinkId = vi.fn().mockReturnValueOnce(firstChange.promise).mockResolvedValue(undefined);
    Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', {
      configurable: true,
      value: setSinkId,
    });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const root = createRoot(document.body);
    const participant = remoteParticipant({} as MediaStream);
    try {
      await act(async () =>
        root.render(<VideoTile participant={participant} audioOutput={{ deviceId: 'old' }} />),
      );
      const video = document.querySelector('video')!;
      expect(video.muted).toBe(true);
      act(() => video.dispatchEvent(new Event('pause')));
      expect(document.querySelector('button[aria-label="스터디원의 소리와 영상 재생"]')).toBeNull();
      await act(async () =>
        root.render(<VideoTile participant={participant} audioOutput={{ deviceId: 'new' }} />),
      );
      expect(setSinkId).toHaveBeenCalledTimes(1);
      await act(async () => firstChange.resolve());
      expect(setSinkId.mock.calls.map(([id]) => id)).toEqual(['old', 'new']);
      expect(video.muted).toBe(false);
      expect(document.querySelector('video')).toBe(video);
      expect(video.srcObject).toBe(participant.stream);
      setSinkId.mockRejectedValueOnce(new DOMException('장치 없음', 'NotFoundError'));
      await act(async () =>
        root.render(<VideoTile participant={participant} audioOutput={{ deviceId: 'missing' }} />),
      );
      expect(video.muted).toBe(true);
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('선택한 스피커');
      act(() => video.dispatchEvent(new Event('pause')));
      expect(document.querySelector('button[aria-label="스터디원의 소리와 영상 재생"]')).toBeNull();
      await act(async () =>
        root.render(<VideoTile participant={participant} audioOutput={{ deviceId: 'missing' }} />),
      );
      expect(video.muted).toBe(false);
      expect(document.querySelector('[role="alert"]')).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it.each([false, true])(
    '일시정지 후 같은 영상과 음량으로 재생하고 내 쪽 음소거를 유지한다 (음소거: %s)',
    async (muted) => {
      const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
      const paused = vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockReturnValue(false);
      const participant = remoteParticipant({} as MediaStream);
      const root = createRoot(document.body);
      try {
        await act(async () => root.render(<VideoTile participant={participant} />));
        const video = document.querySelector('video')!;
        if (muted) {
          await act(async () =>
            document.querySelector<HTMLButtonElement>('.video-tile__local-mute')!.click(),
          );
        }
        const slider = document.querySelector<HTMLInputElement>('input[type="range"]')!;
        await act(async () => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
            slider,
            '35',
          );
          slider.dispatchEvent(new Event('input', { bubbles: true }));
          slider.dispatchEvent(new Event('change', { bubbles: true }));
        });
        expect(video.volume).toBe(0.35);
        const previousCalls = play.mock.calls.length;
        paused.mockReturnValue(true);
        act(() => video.dispatchEvent(new Event('pause')));
        const resume = document.querySelector<HTMLButtonElement>(
          'button[aria-label="스터디원의 소리와 영상 재생"]',
        );
        expect(resume).not.toBeNull();
        expect(play).toHaveBeenCalledTimes(previousCalls);
        play.mockImplementationOnce(async () => {
          paused.mockReturnValue(false);
          video.dispatchEvent(new Event('playing'));
        });
        await act(async () => resume!.click());
        expect(play).toHaveBeenCalledTimes(previousCalls + 1);
        expect(
          document.querySelector('button[aria-label="스터디원의 소리와 영상 재생"]'),
        ).toBeNull();
        expect(document.querySelector('video')).toBe(video);
        expect(video.srcObject).toBe(participant.stream);
        expect(video.muted).toBe(muted);
        expect(video.volume).toBe(0.35);
      } finally {
        act(() => root.unmount());
      }
    },
  );

  it('브라우저에서 재생을 재개하면 안내를 지우고 늦은 재생 이벤트는 현재 상태로 판단한다', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const paused = vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockReturnValue(false);
    const root = createRoot(document.body);
    const recovery = () =>
      document.querySelector('button[aria-label="스터디원의 소리와 영상 재생"]');
    try {
      await act(async () =>
        root.render(<VideoTile participant={remoteParticipant({} as MediaStream)} />),
      );
      const video = document.querySelector('video')!;
      paused.mockReturnValue(true);
      act(() => video.dispatchEvent(new Event('pause')));
      expect(recovery()).not.toBeNull();
      paused.mockReturnValue(false);
      act(() => video.dispatchEvent(new Event('playing')));
      expect(recovery()).toBeNull();
      act(() => video.dispatchEvent(new Event('pause')));
      expect(recovery()).toBeNull();
      paused.mockReturnValue(true);
      act(() => video.dispatchEvent(new Event('pause')));
      act(() => video.dispatchEvent(new Event('playing')));
      expect(recovery()).not.toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it('offers a user gesture after autoplay is rejected and clears it after playback succeeds', async () => {
    const autoplay = deferredPlayback();
    const play = vi
      .spyOn(HTMLMediaElement.prototype, 'play')
      .mockImplementationOnce(() => autoplay.promise)
      .mockResolvedValueOnce(undefined);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      act(() => {
        root.render(<VideoTile participant={remoteParticipant({} as MediaStream)} />);
      });
      await act(async () => {
        autoplay.reject(new DOMException('Autoplay blocked', 'NotAllowedError'));
      });

      const recoveryButton = container.querySelector<HTMLButtonElement>(
        'button[aria-label="스터디원의 소리와 영상 재생"]',
      );
      expect(play).toHaveBeenCalledTimes(1);
      expect(recoveryButton).not.toBeNull();

      await act(async () => {
        recoveryButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(play).toHaveBeenCalledTimes(2);
      expect(
        container.querySelector('button[aria-label="스터디원의 소리와 영상 재생"]'),
      ).toBeNull();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('ignores a late autoplay rejection from a replaced stream', async () => {
    const firstPlayback = deferredPlayback();
    const play = vi
      .spyOn(HTMLMediaElement.prototype, 'play')
      .mockImplementationOnce(() => firstPlayback.promise)
      .mockResolvedValueOnce(undefined);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      act(() => {
        root.render(<VideoTile participant={remoteParticipant({} as MediaStream)} />);
      });
      expect(play).toHaveBeenCalledTimes(1);
      act(() => {
        root.render(<VideoTile participant={remoteParticipant({} as MediaStream)} />);
      });
      expect(play).toHaveBeenCalledTimes(2);
      await act(async () => {
        firstPlayback.reject(new DOMException('Old source aborted', 'AbortError'));
      });

      expect(play).toHaveBeenCalledTimes(2);
      expect(
        container.querySelector('button[aria-label="스터디원의 소리와 영상 재생"]'),
      ).toBeNull();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('전체 화면을 열고 닫는 동안 중복 요청을 막고 완료 후 버튼을 복원한다', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const firstRequest = deferredCompletion();
    const closeRequest = deferredCompletion();
    const fullscreenDocument = installFullscreenDocument();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const stream = {} as MediaStream;

    try {
      act(() => {
        root.render(<VideoTile participant={remoteParticipant(stream, 'screen')} />);
      });
      const video = container.querySelector<HTMLVideoElement>('video');
      const fullscreenButton = container.querySelector<HTMLButtonElement>(
        'button[aria-label="스터디원의 화면 공유 전체 화면으로 보기"]',
      );
      expect(video).not.toBeNull();
      expect(fullscreenButton).not.toBeNull();
      const requestFullscreen = vi.fn(async function (this: HTMLVideoElement) {
        await firstRequest.promise;
        fullscreenDocument.enter(this);
      });
      Object.defineProperty(video, 'requestFullscreen', {
        configurable: true,
        value: requestFullscreen,
      });

      act(() => {
        fullscreenButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        fullscreenButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(requestFullscreen).toHaveBeenCalledOnce();
      expect(fullscreenButton?.disabled).toBe(true);
      expect(fullscreenButton?.textContent).toContain('전환 중');
      await act(async () => {
        firstRequest.resolve();
      });

      expect(fullscreenButton?.disabled).toBe(false);
      expect(fullscreenButton?.textContent).toContain('전체 화면 닫기');
      expect(fullscreenDocument.exitFullscreen).not.toHaveBeenCalled();

      fullscreenDocument.exitFullscreen.mockImplementationOnce(async () => {
        await closeRequest.promise;
        fullscreenDocument.enter(null);
      });
      act(() => {
        fullscreenButton?.click();
        fullscreenButton?.click();
      });
      expect(fullscreenDocument.exitFullscreen).toHaveBeenCalledOnce();
      expect(fullscreenButton?.disabled).toBe(true);
      await act(async () => {
        closeRequest.resolve();
      });

      expect(document.fullscreenElement).toBeNull();
      expect(fullscreenButton?.disabled).toBe(false);
      expect(fullscreenButton?.textContent).toBe('전체 화면');
      expect(video?.srcObject).toBe(stream);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('전체 화면 전환이 실패해도 버튼을 복원해 다시 시도할 수 있다', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const fullscreen = installFullscreenDocument();
    const root = createRoot(document.body);
    try {
      await act(async () =>
        root.render(<VideoTile participant={remoteParticipant({} as MediaStream, 'screen')} />),
      );
      const video = document.querySelector('video')!;
      const requestFullscreen = vi
        .fn(async () => fullscreen.enter(video))
        .mockRejectedValueOnce(new Error('denied'));
      Object.defineProperty(video, 'requestFullscreen', { value: requestFullscreen });
      const button = document.querySelector<HTMLButtonElement>('[aria-label*="전체 화면"]')!;

      await act(async () => button.click());
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        '전체 화면으로 열지 못했습니다.',
      );
      expect(button.disabled).toBe(false);
      await act(async () => button.click());
      expect(requestFullscreen).toHaveBeenCalledTimes(2);
      expect(document.fullscreenElement).toBe(video);
      expect(button.disabled).toBe(false);
      expect(document.querySelector('[role="alert"]')).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it('exits a delayed fullscreen entry after the screen share ends', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const request = deferredCompletion();
    const fullscreenDocument = installFullscreenDocument();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const stream = {} as MediaStream;

    try {
      act(() => {
        root.render(<VideoTile participant={remoteParticipant(stream, 'screen')} />);
      });
      const video = container.querySelector<HTMLVideoElement>('video');
      const fullscreenButton = container.querySelector<HTMLButtonElement>(
        'button[aria-label="스터디원의 화면 공유 전체 화면으로 보기"]',
      );
      expect(video).not.toBeNull();
      expect(fullscreenButton).not.toBeNull();
      const requestFullscreen = vi.fn(async function (this: HTMLVideoElement) {
        await request.promise;
        fullscreenDocument.enter(this);
      });
      Object.defineProperty(video, 'requestFullscreen', {
        configurable: true,
        value: requestFullscreen,
      });

      act(() => {
        fullscreenButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        root.render(<VideoTile participant={remoteParticipant(stream, 'camera')} />);
      });
      expect(fullscreenDocument.exitFullscreen).not.toHaveBeenCalled();

      await act(async () => {
        request.resolve();
      });

      expect(requestFullscreen).toHaveBeenCalledOnce();
      expect(fullscreenDocument.exitFullscreen).toHaveBeenCalledOnce();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('opens the rendered video with the Safari native fullscreen API', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const webkitEnterFullscreen = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      act(() => {
        root.render(<VideoTile participant={remoteParticipant({} as MediaStream, 'screen')} />);
      });
      expect(play).toHaveBeenCalledOnce();

      const video = container.querySelector<HTMLVideoElement>('video');
      const fullscreenButton = container.querySelector<HTMLButtonElement>(
        'button[aria-label="스터디원의 화면 공유 전체 화면으로 보기"]',
      );
      expect(video).not.toBeNull();
      expect(fullscreenButton).not.toBeNull();
      Object.defineProperties(video, {
        webkitSupportsFullscreen: { configurable: true, value: true },
        webkitEnterFullscreen: { configurable: true, value: webkitEnterFullscreen },
      });

      await act(async () => {
        fullscreenButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(webkitEnterFullscreen).toHaveBeenCalledOnce();
      expect(container.querySelector('[role="alert"]')).toBeNull();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });
});
