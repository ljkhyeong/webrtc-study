// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { startBrowserMonitoring } from './browser-monitoring';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('브라우저 오류 수집', () => {
  it('수집 URL이 없으면 오류 수집을 시작하지 않는다', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await startBrowserMonitoring('')).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('SDK 전송에서 오류 원문·사용자·방 주소를 제거하고 정적 파일 위치만 남긴다', async () => {
    vi.useFakeTimers();
    vi.stubEnv('BASE_URL', '/round-ui/');
    vi.stubEnv('ROUND_WEB_BUILD_ID', 'test-build');
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetch);
    const faro = await startBrowserMonitoring('https://collector.example.invalid/collect/test');
    expect(faro).toBeDefined();
    try {
      faro!.api.setUser({ id: 'private-user', username: 'private-name' });
      faro!.api.pushError(new TypeError('private-message'), {
        context: { grant: 'private-token' },
        stackFrames: [
          {
            filename: `${location.origin}/round-ui/assets/index-12345678.js?token=private-token`,
            function: 'private-function',
            lineno: 12,
            colno: 34,
          },
          { filename: `${location.origin}/room/private-room`, function: 'private-function' },
          { filename: 'https://other.invalid/private-source.js', function: 'private-function' },
          { filename: 'http://%', function: 'private-function' },
        ],
      });
      faro!.api.pushLog(['private-log']);
      faro!.api.pushEvent('private-event');
      await vi.advanceTimersByTimeAsync(1_000);

      expect(fetch).toHaveBeenCalledOnce();
      const body = String(fetch.mock.calls[0]![1]!.body);
      expect(body).not.toContain('private-');
      expect(JSON.parse(body)).toEqual({
        meta: {
          app: { name: 'round', version: 'test-build' },
          session: { id: expect.any(String) },
        },
        exceptions: [
          {
            type: 'TypeError',
            value: 'TypeError',
            timestamp: expect.any(String),
            stacktrace: {
              frames: [
                {
                  filename: `${location.origin}/round-ui/assets/index-12345678.js`,
                  function: '',
                  lineno: 12,
                  colno: 34,
                },
              ],
            },
          },
        ],
      });
    } finally {
      faro?.pause();
      if (faro) {
        faro.instrumentations.remove(...faro.instrumentations.instrumentations);
        faro.transports.remove(...faro.transports.transports);
      }
    }
  });
});
