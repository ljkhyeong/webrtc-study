// @vitest-environment jsdom

import { act } from 'react';
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
    enter: (element: Element) => {
      fullscreenElement = element;
    },
    exitFullscreen,
  };
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
    document.body.replaceChildren();
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
    vi.spyOn(HTMLMediaElement.prototype, 'volume', 'get').mockReturnValue(1);
    vi.spyOn(HTMLMediaElement.prototype, 'volume', 'set').mockImplementation(() => {});
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
      await act(async () =>
        root.render(<VideoTile participant={participant} audioOutput={{ deviceId: 'missing' }} />),
      );
      expect(video.muted).toBe(false);
      expect(document.querySelector('[role="alert"]')).toBeNull();
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

  it('does not let an older fullscreen request close the newer request', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const firstRequest = deferredCompletion();
    const secondRequest = deferredCompletion();
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
      const requestFullscreen = vi
        .fn<() => Promise<void>>()
        .mockImplementationOnce(async function (this: HTMLVideoElement) {
          await firstRequest.promise;
          fullscreenDocument.enter(this);
        })
        .mockImplementationOnce(async function (this: HTMLVideoElement) {
          await secondRequest.promise;
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
      await act(async () => {
        secondRequest.resolve();
      });

      expect(requestFullscreen).toHaveBeenCalledTimes(2);
      expect(fullscreenDocument.exitFullscreen).not.toHaveBeenCalled();

      await act(async () => {
        firstRequest.resolve();
      });

      expect(fullscreenDocument.exitFullscreen).not.toHaveBeenCalled();
    } finally {
      act(() => {
        root.unmount();
      });
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
