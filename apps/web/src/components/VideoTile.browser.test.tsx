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

describe('VideoTile browser behavior', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      value: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
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
