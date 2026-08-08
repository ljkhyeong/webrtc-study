// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VideoTile, type ParticipantView } from './VideoTile';

function remoteParticipant(stream: MediaStream): ParticipantView {
  return {
    peerId: 'peer-1',
    displayName: '스터디원',
    role: 'participant',
    isLocal: false,
    audioEnabled: true,
    videoEnabled: true,
    videoSource: 'camera',
    connectionState: 'connected',
    stream,
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
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

describe('VideoTile autoplay recovery', () => {
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
    const play = vi
      .spyOn(HTMLMediaElement.prototype, 'play')
      .mockRejectedValueOnce(new DOMException('Autoplay blocked', 'NotAllowedError'))
      .mockResolvedValueOnce(undefined);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(<VideoTile participant={remoteParticipant({} as MediaStream)} />);
        await flushMicrotasks();
      });

      const recoveryButton = container.querySelector<HTMLButtonElement>(
        'button[aria-label="스터디원의 소리와 영상 재생"]',
      );
      expect(play).toHaveBeenCalledTimes(1);
      expect(recoveryButton).not.toBeNull();

      await act(async () => {
        recoveryButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flushMicrotasks();
      });

      expect(play).toHaveBeenCalledTimes(2);
      expect(
        container.querySelector('button[aria-label="스터디원의 소리와 영상 재생"]'),
      ).toBeNull();
    } finally {
      await act(async () => {
        root.unmount();
        await flushMicrotasks();
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
      await act(async () => {
        root.render(<VideoTile participant={remoteParticipant({} as MediaStream)} />);
        await flushMicrotasks();
      });
      await act(async () => {
        root.render(<VideoTile participant={remoteParticipant({} as MediaStream)} />);
        await flushMicrotasks();
      });
      await act(async () => {
        firstPlayback.reject(new DOMException('Old source aborted', 'AbortError'));
        await flushMicrotasks();
      });

      expect(play).toHaveBeenCalledTimes(2);
      expect(
        container.querySelector('button[aria-label="스터디원의 소리와 영상 재생"]'),
      ).toBeNull();
    } finally {
      await act(async () => {
        root.unmount();
        await flushMicrotasks();
      });
    }
  });
});
