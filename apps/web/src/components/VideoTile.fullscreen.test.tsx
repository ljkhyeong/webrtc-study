// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VideoTile, type ParticipantView } from './VideoTile';

function remoteScreenShare(stream: MediaStream): ParticipantView {
  return {
    peerId: 'peer-1',
    displayName: '스터디원',
    role: 'participant',
    isLocal: false,
    audioEnabled: true,
    videoEnabled: true,
    videoSource: 'screen',
    connectionState: 'connected',
    stream,
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

describe('VideoTile fullscreen', () => {
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

  it('opens the rendered video with the Safari native fullscreen API', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const webkitEnterFullscreen = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(<VideoTile participant={remoteScreenShare({} as MediaStream)} />);
        await flushMicrotasks();
      });

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
        await flushMicrotasks();
      });

      expect(webkitEnterFullscreen).toHaveBeenCalledOnce();
      expect(container.querySelector('[role="alert"]')).toBeNull();
    } finally {
      await act(async () => {
        root.unmount();
        await flushMicrotasks();
      });
    }
  });
});
