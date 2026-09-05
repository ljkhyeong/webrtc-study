// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkSignalingCompatibility, useClientRelease } from './client-release';

describe('입장 전 호환성과 새 배포 확인', () => {
  let root: Root;
  let container: HTMLDivElement;
  let release: ReturnType<typeof useClientRelease>;
  function Status() {
    release = useClientRelease();
    return <output>{release.status}</output>;
  }
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('기존 방 경로를 HTTP로 조회하고 필수 기능이 없는 서버는 입장을 거부한다', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ protocolVersion: 3, capabilities: ['peer.reconnect', 'room.study'] }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ protocolVersion: 3, capabilities: [] })),
      );
    vi.stubGlobal('fetch', fetcher);
    await checkSignalingCompatibility('wss://round.test/round/rooms/abcd-efgh-jkmp/signal');
    expect(fetcher).toHaveBeenCalledWith(
      'https://round.test/round/rooms/abcd-efgh-jkmp/signal?compatibility=1',
      expect.objectContaining({ cache: 'no-store', credentials: 'same-origin' }),
    );
    await expect(checkSignalingCompatibility('ws://localhost/signal')).rejects.toThrow(
      '버전이 맞지',
    );
  });

  it('새 배포를 감지하고 일시적인 조회 실패에도 갱신 안내를 유지하며 요청을 합친다', async () => {
    const fetcher = vi
      .fn()
      .mockImplementation(
        async () => new Response(JSON.stringify({ buildId: import.meta.env.ROUND_WEB_BUILD_ID })),
      );
    vi.stubGlobal('fetch', fetcher);
    await act(async () => root.render(<Status />));
    expect(container.textContent).toBe('current');
    fetcher.mockImplementation(async () => new Response(JSON.stringify({ buildId: 'new-build' })));
    await act(async () => {
      const first = release.check();
      const second = release.check();
      expect(first).toBe(second);
      await first;
    });
    expect(container.textContent).toBe('update');
    fetcher.mockRejectedValue(new Error('연결 끊김'));
    await act(async () => {
      await release.check();
    });
    expect(container.textContent).toBe('update');
  });

  it('화면을 닫거나 StrictMode가 다시 시작하면 이전 요청을 취소하고 늦은 결과를 버린다', async () => {
    const signals: AbortSignal[] = [];
    const resolve: ((response: Response) => void)[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_url, options) => {
        signals.push(options.signal);
        return new Promise<Response>((done) => resolve.push(done));
      }),
    );
    await act(async () =>
      root.render(
        <StrictMode>
          <Status />
        </StrictMode>,
      ),
    );
    expect(signals[0]!.aborted).toBe(true);
    await act(async () =>
      resolve[1]!(new Response(JSON.stringify({ buildId: import.meta.env.ROUND_WEB_BUILD_ID }))),
    );
    await act(async () => resolve[0]!(new Response(JSON.stringify({ buildId: 'old-result' }))));
    expect(container.textContent).toBe('current');
    let pending!: Promise<string>;
    act(() => {
      pending = release.check();
    });
    act(() => root.render(null));
    expect(signals.at(-1)!.aborted).toBe(true);
    await act(async () => {
      resolve.at(-1)!(new Response('{}'));
      await pending;
    });
  });
});
