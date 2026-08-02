import { describe, expect, it, vi } from 'vitest';
import { enterVideoFullscreen, exitVideoFullscreen } from './fullscreen';

describe('video fullscreen compatibility', () => {
  it('prefers the standard fullscreen API', async () => {
    const requestFullscreen = vi.fn(async () => {});
    const webkitEnterFullscreen = vi.fn();
    const video = {
      requestFullscreen,
      webkitEnterFullscreen,
    } as unknown as HTMLVideoElement;

    await expect(enterVideoFullscreen(video)).resolves.toBe(true);
    expect(requestFullscreen).toHaveBeenCalledOnce();
    expect(webkitEnterFullscreen).not.toHaveBeenCalled();
  });

  it('falls back to Safari native video fullscreen', async () => {
    const webkitEnterFullscreen = vi.fn();
    const video = {
      webkitSupportsFullscreen: true,
      webkitEnterFullscreen,
    } as unknown as HTMLVideoElement;

    await expect(enterVideoFullscreen(video)).resolves.toBe(true);
    expect(webkitEnterFullscreen).toHaveBeenCalledOnce();
  });

  it('reports unsupported or rejected fullscreen without throwing', async () => {
    const unsupported = {} as HTMLVideoElement;
    const rejected = {
      requestFullscreen: vi.fn(async () => {
        throw new DOMException('denied', 'NotAllowedError');
      }),
    } as unknown as HTMLVideoElement;

    await expect(enterVideoFullscreen(unsupported)).resolves.toBe(false);
    await expect(enterVideoFullscreen(rejected)).resolves.toBe(false);
  });

  it('exits standard fullscreen only when the target video owns it', async () => {
    const exitFullscreen = vi.fn(async () => {});
    const video = {} as HTMLVideoElement;
    const documentRef = {
      fullscreenElement: video,
      exitFullscreen,
    } as unknown as Document;

    await expect(exitVideoFullscreen(video, documentRef)).resolves.toBe(true);
    expect(exitFullscreen).toHaveBeenCalledOnce();
  });
});
