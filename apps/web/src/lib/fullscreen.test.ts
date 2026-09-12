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

  it('continues to a prefixed API when the standard request is rejected', async () => {
    const requestFullscreen = vi.fn(async () => {
      throw new DOMException('denied', 'NotAllowedError');
    });
    const webkitRequestFullscreen = vi.fn(async () => {});
    const webkitEnterFullscreen = vi.fn();
    const video = {
      requestFullscreen,
      webkitRequestFullscreen,
      webkitEnterFullscreen,
    } as unknown as HTMLVideoElement;

    await expect(enterVideoFullscreen(video)).resolves.toBe(true);
    expect(requestFullscreen).toHaveBeenCalledOnce();
    expect(webkitRequestFullscreen).toHaveBeenCalledOnce();
    expect(webkitEnterFullscreen).not.toHaveBeenCalled();
  });

  it('continues to Safari native video fullscreen when both request APIs are rejected', async () => {
    const requestFullscreen = vi.fn(async () => {
      throw new DOMException('denied', 'NotAllowedError');
    });
    const webkitRequestFullscreen = vi.fn(async () => {
      throw new DOMException('denied', 'NotAllowedError');
    });
    const webkitEnterFullscreen = vi.fn();
    const video = {
      requestFullscreen,
      webkitRequestFullscreen,
      webkitSupportsFullscreen: true,
      webkitEnterFullscreen,
    } as unknown as HTMLVideoElement;

    await expect(enterVideoFullscreen(video)).resolves.toBe(true);
    expect(requestFullscreen).toHaveBeenCalledOnce();
    expect(webkitRequestFullscreen).toHaveBeenCalledOnce();
    expect(webkitEnterFullscreen).toHaveBeenCalledOnce();
  });

  it('reports unsupported or fully rejected fullscreen without throwing', async () => {
    const unsupported = {} as HTMLVideoElement;
    const requestFullscreen = vi.fn(async () => {
      throw new DOMException('denied', 'NotAllowedError');
    });
    const webkitRequestFullscreen = vi.fn(async () => {
      throw new DOMException('denied', 'NotAllowedError');
    });
    const webkitEnterFullscreen = vi.fn(() => {
      throw new DOMException('denied', 'NotAllowedError');
    });
    const rejected = {
      requestFullscreen,
      webkitRequestFullscreen,
      webkitEnterFullscreen,
    } as unknown as HTMLVideoElement;

    await expect(enterVideoFullscreen(unsupported)).resolves.toBe(false);
    await expect(enterVideoFullscreen(rejected)).resolves.toBe(false);
    expect(requestFullscreen).toHaveBeenCalledOnce();
    expect(webkitRequestFullscreen).toHaveBeenCalledOnce();
    expect(webkitEnterFullscreen).toHaveBeenCalledOnce();
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

  it.each(['video', 'container'])(
    '표준 종료가 거부되면 현재 %s 전체 화면을 호환 API로 닫는다',
    async (owner) => {
      const exitFullscreen = vi.fn(async () => {
        throw new DOMException('denied', 'NotAllowedError');
      });
      const webkitExitFullscreen = vi.fn(async () => {});
      const video = {} as HTMLVideoElement;
      const container = {} as HTMLElement;
      const fullscreenElement = owner === 'video' ? video : container;
      const documentRef = {
        fullscreenElement,
        exitFullscreen,
        webkitFullscreenElement: fullscreenElement,
        webkitExitFullscreen,
      } as unknown as Document;

      await expect(exitVideoFullscreen(video, documentRef, container)).resolves.toBe(true);
      expect(exitFullscreen).toHaveBeenCalledOnce();
      expect(webkitExitFullscreen).toHaveBeenCalledOnce();
    },
  );

  it('다른 참가자의 전체 화면은 닫지 않는다', async () => {
    const exitFullscreen = vi.fn();
    const webkitExitFullscreen = vi.fn();
    const other = {} as HTMLElement;
    const documentRef = {
      fullscreenElement: other,
      webkitFullscreenElement: other,
      exitFullscreen,
      webkitExitFullscreen,
    } as unknown as Document;

    await expect(
      exitVideoFullscreen({} as HTMLVideoElement, documentRef, {} as HTMLElement),
    ).resolves.toBe(false);
    expect(exitFullscreen).not.toHaveBeenCalled();
    expect(webkitExitFullscreen).not.toHaveBeenCalled();
  });
});
