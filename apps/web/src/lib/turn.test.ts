import { describe, expect, it, vi } from 'vitest';

import { loadTurnCredentials, turnCredentialRefreshDelayMs } from './turn';

function response(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => body),
  } as unknown as Response;
}

describe('TURN credential loading', () => {
  it('uses the server-derived monotonic refresh deadline', () => {
    expect(turnCredentialRefreshDelayMs(4_300_000, 1_000_000)).toBe(3_300_000);
  });

  it('retries an overdue monotonic deadline without a tight loop', () => {
    expect(turnCredentialRefreshDelayMs(900_000, 1_000_000)).toBe(1_000);
  });

  it('maps a short-lived server response to an RTCIceServer', async () => {
    const fetcher = vi.fn(async () =>
      response(200, {
        urls: [
          'turn:round.example.com:3478?transport=udp',
          'turns:round.example.com:5349?transport=tcp',
        ],
        username: '7200:random-user',
        credential: 'signed-credential',
        expiresAt: 7_200,
        refreshAfterSeconds: 240,
      }),
    );

    await expect(
      loadTurnCredentials({
        fetcher: fetcher as typeof fetch,
        now: () => 1_000_000,
      }),
    ).resolves.toEqual({
      iceServer: {
        urls: [
          'turn:round.example.com:3478?transport=udp',
          'turns:round.example.com:5349?transport=tcp',
        ],
        username: '7200:random-user',
        credential: 'signed-credential',
      },
      expiresAt: 7_200,
      refreshDueAtMs: 1_240_000,
    });

    expect(fetcher).toHaveBeenCalledWith('/api/turn-credentials', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      method: 'POST',
      signal: expect.any(AbortSignal),
    });
  });

  it('posts to a room-scoped BATON endpoint without putting credentials in the URL', async () => {
    const endpoint = '/round/rooms/abcd-efgh-jkmp/turn-credentials';
    const fetcher = vi.fn(async () => response(204));

    await expect(
      loadTurnCredentials({
        endpoint,
        fetcher: fetcher as typeof fetch,
      }),
    ).resolves.toBeNull();

    expect(fetcher).toHaveBeenCalledWith(endpoint, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      method: 'POST',
      signal: expect.any(AbortSignal),
    });
    expect(endpoint).not.toMatch(/[?#]/);
    expect(endpoint).not.toMatch(/token|ticket|authorization/i);
  });

  it.each([204, 404])(
    'treats a disabled endpoint status %i as STUN-only local development',
    async (status) => {
      await expect(
        loadTurnCredentials({
          fetcher: vi.fn(async () => response(status)) as typeof fetch,
        }),
      ).resolves.toBeNull();
    },
  );

  it.each([
    {
      urls: ['https://not-a-turn-server.example.com'],
      username: 'user',
      credential: 'credential',
      expiresAt: 7_200,
      refreshAfterSeconds: 240,
    },
    {
      urls: ['turn:round.example.com:3478'],
      username: '',
      credential: 'credential',
      expiresAt: 7_200,
      refreshAfterSeconds: 240,
    },
    {
      urls: ['turn:round.example.com:3478'],
      username: 'user',
      credential: 'credential',
      expiresAt: 7_200,
      refreshAfterSeconds: 0,
    },
  ])('rejects an unsafe or stale response %#', async (payload) => {
    await expect(
      loadTurnCredentials({
        fetcher: vi.fn(async () => response(200, payload)) as typeof fetch,
        now: () => 1_000_000,
      }),
    ).rejects.toThrow();
  });

  it('does not compare the server expiry epoch with the browser wall clock', async () => {
    const now = vi.fn(() => 25_000);

    await expect(
      loadTurnCredentials({
        fetcher: vi.fn(async () =>
          response(200, {
            urls: ['turn:round.example.com:3478'],
            username: '1:short-lived',
            credential: 'credential',
            expiresAt: 1,
            refreshAfterSeconds: 1,
          }),
        ) as typeof fetch,
        now,
      }),
    ).resolves.toMatchObject({
      expiresAt: 1,
      refreshDueAtMs: 26_000,
    });
  });

  it('does not expose an unexpected response body in the HTTP error', async () => {
    await expect(
      loadTurnCredentials({
        fetcher: vi.fn(async () => response(500, { secret: 'do-not-log' })) as typeof fetch,
      }),
    ).rejects.toThrow('TURN credential request failed with status 500');
  });

  it('aborts a credential request that would otherwise wait forever', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          }),
      );

      const loading = loadTurnCredentials({
        fetcher: fetcher as typeof fetch,
        timeoutMs: 100,
      });
      const timedOut = expect(loading).rejects.toThrow('TURN credential request timed out');
      await vi.advanceTimersByTimeAsync(100);

      await timedOut;
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels an in-flight room refresh when the session becomes terminal', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        }),
    );

    const loading = loadTurnCredentials({
      fetcher: fetcher as typeof fetch,
      signal: controller.signal,
    });
    controller.abort();

    await expect(loading).rejects.toThrow('TURN credential request was cancelled');
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
