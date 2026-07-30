import { describe, expect, it, vi } from 'vitest';

import { ParticipationGrantLeaseManager } from './participation-grant';

function response(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => body),
  } as unknown as Response;
}

describe('BATON participation grant lease manager', () => {
  it('refreshes the HttpOnly grant through an exact same-origin POST', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      response(200, {
        expiresAt: 1_780_000_000,
        refreshAfterSeconds: 240,
      }),
    );
    const manager = new ParticipationGrantLeaseManager({
      endpoint: '/round/rooms/abcd-efgh-jkmp/participation-grant/refresh',
      fetcher: fetcher as typeof fetch,
      now: () => 10_000,
    });

    await expect(manager.ensureFresh()).resolves.toEqual({
      expiresAt: 1_780_000_000,
      refreshAfterSeconds: 240,
    });
    expect(fetcher).toHaveBeenCalledWith(
      '/round/rooms/abcd-efgh-jkmp/participation-grant/refresh',
      {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        method: 'POST',
        signal: expect.any(AbortSignal),
      },
    );
    expect(fetcher.mock.calls[0]?.[0]).not.toMatch(/[?#]/);
  });

  it('shares one refresh and uses the server-provided relative deadline', async () => {
    let nowMs = 1_000;
    let resolveFirst: ((value: Response) => void) | undefined;
    const fetcher = vi
      .fn<() => Promise<Response>>()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue(
        response(200, {
          expiresAt: 1_780_000_300,
          refreshAfterSeconds: 240,
        }),
      );
    const manager = new ParticipationGrantLeaseManager({
      endpoint: '/round/rooms/abcd-efgh-jkmp/participation-grant/refresh',
      fetcher: fetcher as typeof fetch,
      now: () => nowMs,
    });

    const first = manager.ensureFresh();
    const concurrent = manager.ensureFresh();
    expect(fetcher).toHaveBeenCalledTimes(1);
    resolveFirst?.(
      response(200, {
        expiresAt: 1_780_000_000,
        refreshAfterSeconds: 240,
      }),
    );
    await expect(Promise.all([first, concurrent])).resolves.toHaveLength(2);

    nowMs += 239_999;
    await manager.ensureFresh();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(manager.refreshDelayMs()).toBe(1);

    nowMs += 1;
    await manager.ensureFresh();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      body: {
        expiresAt: 1_780_000_000,
        refreshAfterSeconds: 240,
        token: 'must-not-reach-javascript',
      },
      label: 'unexpected token material',
    },
    {
      body: {
        expiresAt: 1_780_000_000,
        refreshAfterSeconds: 0,
      },
      label: 'non-positive refresh delay',
    },
    {
      body: {
        expiresAt: 'later',
        refreshAfterSeconds: 240,
      },
      label: 'non-numeric expiry',
    },
  ])('rejects $label in the response', async ({ body }) => {
    const manager = new ParticipationGrantLeaseManager({
      endpoint: '/round/rooms/abcd-efgh-jkmp/participation-grant/refresh',
      fetcher: vi.fn(async () => response(200, body)) as typeof fetch,
    });

    await expect(manager.ensureFresh()).rejects.toThrow();
  });

  it.each([
    'https://baton.example/round/rooms/abcd-efgh-jkmp/participation-grant/refresh',
    '//baton.example/round/rooms/abcd-efgh-jkmp/participation-grant/refresh',
    '/round/rooms/abcd-efgh-jkmp/participation-grant/refresh?token=secret',
  ])('rejects a non-same-origin or decorated endpoint %s', (endpoint) => {
    expect(() => new ParticipationGrantLeaseManager({ endpoint })).toThrow('same-origin path');
  });

  it('reports only an HTTP status when refresh fails', async () => {
    const manager = new ParticipationGrantLeaseManager({
      endpoint: '/round/rooms/abcd-efgh-jkmp/participation-grant/refresh',
      fetcher: vi.fn(async () => response(403, { secret: 'do-not-log' })) as typeof fetch,
    });

    await expect(manager.ensureFresh()).rejects.toThrow(
      'Participation grant refresh failed with status 403',
    );
  });

  it('aborts a refresh request that exceeds its deadline', async () => {
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
      const manager = new ParticipationGrantLeaseManager({
        endpoint: '/round/rooms/abcd-efgh-jkmp/participation-grant/refresh',
        fetcher: fetcher as typeof fetch,
        timeoutMs: 100,
      });

      const refreshing = expect(manager.ensureFresh()).rejects.toThrow(
        'Participation grant refresh timed out',
      );
      await vi.advanceTimersByTimeAsync(100);

      await refreshing;
    } finally {
      vi.useRealTimers();
    }
  });
});
