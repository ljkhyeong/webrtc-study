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
