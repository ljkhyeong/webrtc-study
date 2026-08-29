import { describe, expect, it, vi } from 'vitest';

import {
  ParticipationGrantAccessError,
  ParticipationGrantLeaseManager,
} from './participation-grant';

const ROOM_ID = 'abcd-efgh-jkmp';
const ENDPOINT = `/round/rooms/${ROOM_ID}/participation-grant/refresh`;
const SESSION_ENDPOINT = '/api/v1/auth/session';

function response(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => body),
  } as unknown as Response;
}

function sessionResponse(overrides: Record<string, unknown> = {}): Response {
  return response(200, {
    authenticated: true,
    csrfHeaderName: 'X-CSRF-TOKEN',
    csrfToken: 'csrf-token',
    ...overrides,
  });
}

function authenticatedFetcher(
  refresh: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> | Response,
) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (input === SESSION_ENDPOINT) {
      return sessionResponse();
    }
    return refresh(input, init);
  });
}

function refreshCallCount(fetcher: ReturnType<typeof vi.fn>): number {
  return fetcher.mock.calls.filter(([input]) => input === ENDPOINT).length;
}

describe('BATON participation grant lease manager', () => {
  it('loads a dynamic CSRF credential before the exact same-origin refresh POST', async () => {
    const fetcher = authenticatedFetcher(async () =>
      response(200, {
        expiresAt: 1_780_000_000,
        refreshAfterSeconds: 240,
      }),
    );
    const manager = new ParticipationGrantLeaseManager({
      endpoint: ENDPOINT,
      fetcher: fetcher as typeof fetch,
      now: () => 10_000,
      roomId: ROOM_ID,
      storage: null,
    });

    await expect(manager.ensureFresh()).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenNthCalledWith(1, SESSION_ENDPOINT, {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      method: 'GET',
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
    expect(fetcher).toHaveBeenNthCalledWith(2, ENDPOINT, {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'X-CSRF-TOKEN': 'csrf-token',
      },
      method: 'POST',
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
    expect(fetcher.mock.calls[1]?.[0]).not.toMatch(/[?#]/);
  });

  it('binds default and explicitly injected browser fetch receivers', async () => {
    const receiverSensitiveFetcher = vi.fn(function (this: unknown, input: RequestInfo | URL) {
      if (this !== undefined && this !== globalThis) {
        throw new TypeError('Illegal invocation');
      }
      if (input === SESSION_ENDPOINT) {
        return Promise.resolve(sessionResponse());
      }
      return Promise.resolve(
        response(200, {
          expiresAt: 1_780_000_000,
          refreshAfterSeconds: 240,
        }),
      );
    });
    vi.stubGlobal('fetch', receiverSensitiveFetcher);

    try {
      const defaultManager = new ParticipationGrantLeaseManager({
        endpoint: ENDPOINT,
        roomId: ROOM_ID,
        storage: null,
      });
      const injectedManager = new ParticipationGrantLeaseManager({
        endpoint: ENDPOINT,
        roomId: ROOM_ID,
        storage: null,
        fetcher: globalThis.fetch,
      });

      for (const manager of [defaultManager, injectedManager]) {
        await expect(manager.ensureFresh()).resolves.toBeUndefined();
      }
      expect(receiverSensitiveFetcher).toHaveBeenCalledTimes(4);
      expect(receiverSensitiveFetcher.mock.contexts).toEqual([
        globalThis,
        globalThis,
        globalThis,
        globalThis,
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('sends a validated BATON entry locator without treating it as a credential', async () => {
    const getItem = vi.fn(() =>
      JSON.stringify({
        version: 1,
        teamId: '22222222-2222-4222-8222-222222222222',
        seasonId: '33333333-3333-4333-8333-333333333333',
        resourceId: '44444444-4444-4444-8444-444444444444',
        roomId: ROOM_ID,
      }),
    );
    const fetcher = authenticatedFetcher(async () =>
      response(200, {
        expiresAt: 1_780_000_000,
        refreshAfterSeconds: 240,
      }),
    );
    const manager = new ParticipationGrantLeaseManager({
      endpoint: ENDPOINT,
      fetcher: fetcher as typeof fetch,
      roomId: ROOM_ID,
      storage: {
        getItem,
        removeItem: vi.fn(),
      },
    });

    await manager.ensureFresh();

    expect(getItem).toHaveBeenCalledWith(`baton-round-entry:v1:${ROOM_ID}`);
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      ENDPOINT,
      expect.objectContaining({
        body: JSON.stringify({
          teamId: '22222222-2222-4222-8222-222222222222',
          seasonId: '33333333-3333-4333-8333-333333333333',
          resourceId: '44444444-4444-4444-8444-444444444444',
        }),
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-CSRF-TOKEN': 'csrf-token',
        },
      }),
    );
  });

  it('shares one refresh and uses the server-provided relative deadline', async () => {
    let nowMs = 1_000;
    let resolveFirst: ((value: Response) => void) | undefined;
    const refresh = vi
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
    const fetcher = authenticatedFetcher(() => refresh());
    const manager = new ParticipationGrantLeaseManager({
      endpoint: ENDPOINT,
      fetcher: fetcher as typeof fetch,
      now: () => nowMs,
      roomId: ROOM_ID,
      storage: null,
    });

    const first = manager.ensureFresh();
    const concurrent = manager.ensureFresh();
    await vi.waitFor(() => expect(refreshCallCount(fetcher)).toBe(1));
    resolveFirst?.(
      response(200, {
        expiresAt: 1_780_000_000,
        refreshAfterSeconds: 240,
      }),
    );
    await expect(Promise.all([first, concurrent])).resolves.toHaveLength(2);

    nowMs += 239_999;
    await manager.ensureFresh();
    expect(refreshCallCount(fetcher)).toBe(1);
    expect(manager.refreshDelayMs()).toBe(1);

    nowMs += 1;
    await manager.ensureFresh();
    expect(refreshCallCount(fetcher)).toBe(2);
  });

  it('cancels an in-flight lookup before it can consume protected refresh quota', async () => {
    let resolveSession!: (value: Response) => void;
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      if (input === SESSION_ENDPOINT) {
        return new Promise<Response>((resolve) => {
          resolveSession = resolve;
        });
      }
      return Promise.resolve(
        response(200, {
          expiresAt: 1_780_000_000,
          refreshAfterSeconds: 240,
        }),
      );
    });
    const manager = new ParticipationGrantLeaseManager({
      endpoint: ENDPOINT,
      fetcher: fetcher as typeof fetch,
      roomId: ROOM_ID,
      storage: null,
    });

    const refreshing = manager.ensureFresh();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    manager.close();
    resolveSession(sessionResponse());

    await expect(refreshing).rejects.toThrow('cancelled');
    expect(refreshCallCount(fetcher)).toBe(0);
    await expect(manager.ensureFresh()).rejects.toThrow('closed');
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
    const fetcher = authenticatedFetcher(async () => response(200, body));
    const manager = new ParticipationGrantLeaseManager({
      endpoint: ENDPOINT,
      fetcher: fetcher as typeof fetch,
      roomId: ROOM_ID,
      storage: null,
    });

    await expect(manager.ensureFresh()).rejects.toThrow();
  });

  it.each([
    'https://baton.example/round/rooms/abcd-efgh-jkmp/participation-grant/refresh',
    '//baton.example/round/rooms/abcd-efgh-jkmp/participation-grant/refresh',
    '/round\\rooms/abcd-efgh-jkmp/participation-grant/refresh',
    '/round/rooms/abcd-efgh-jkmp/participation-grant/refresh?token=secret',
  ])('rejects a non-same-origin or decorated endpoint %s', (endpoint) => {
    expect(
      () =>
        new ParticipationGrantLeaseManager({
          endpoint,
          roomId: ROOM_ID,
        }),
    ).toThrow('same-origin path');
  });

  it.each([
    { failure: 'unauthenticated', status: 401 },
    { failure: 'forbidden', status: 403 },
    { failure: 'not-found', status: 404 },
  ] as const)(
    'classifies a $status refresh without reading or exposing its body',
    async ({ failure, status }) => {
      const body = { secret: 'do-not-log' };
      const failedResponse = response(status, body);
      const fetcher = authenticatedFetcher(async () => failedResponse);
      const manager = new ParticipationGrantLeaseManager({
        endpoint: ENDPOINT,
        fetcher: fetcher as typeof fetch,
        roomId: ROOM_ID,
        storage: null,
      });

      const accessFailure = await manager.ensureFresh().catch((error: unknown) => error);

      expect(accessFailure).toBeInstanceOf(ParticipationGrantAccessError);
      expect((accessFailure as ParticipationGrantAccessError).failure).toBe(failure);
      expect((accessFailure as Error).message).not.toContain('secret');
      expect(failedResponse.json).not.toHaveBeenCalled();
    },
  );

  it.each([
    { failure: 'unauthenticated', response: response(401) },
    { failure: 'forbidden', response: response(403) },
    { failure: 'unauthenticated', response: response(200, { authenticated: false }) },
  ] as const)('classifies a session access failure as $failure', async ({ failure, response }) => {
    const fetcher = vi.fn(async () => response);
    const manager = new ParticipationGrantLeaseManager({
      endpoint: ENDPOINT,
      fetcher: fetcher as typeof fetch,
      roomId: ROOM_ID,
      storage: null,
    });

    const accessFailure = await manager.ensureFresh().catch((error: unknown) => error);

    expect(accessFailure).toBeInstanceOf(ParticipationGrantAccessError);
    expect((accessFailure as ParticipationGrantAccessError).failure).toBe(failure);
    expect(refreshCallCount(fetcher)).toBe(0);
  });

  it('reports only an HTTP status for a non-access refresh failure', async () => {
    const fetcher = authenticatedFetcher(async () => response(429, { secret: 'do-not-log' }));
    const manager = new ParticipationGrantLeaseManager({
      endpoint: ENDPOINT,
      fetcher: fetcher as typeof fetch,
      roomId: ROOM_ID,
      storage: null,
    });

    await expect(manager.ensureFresh()).rejects.toThrow(
      'Participation grant refresh failed with status 429',
    );
  });

  it('aborts a refresh request that exceeds its deadline', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = authenticatedFetcher(
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
        endpoint: ENDPOINT,
        fetcher: fetcher as typeof fetch,
        roomId: ROOM_ID,
        storage: null,
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

  it('rejects and removes a corrupt entry locator before any protected request', async () => {
    const removeItem = vi.fn();
    const fetcher = authenticatedFetcher(async () =>
      response(200, {
        expiresAt: 1_780_000_000,
        refreshAfterSeconds: 240,
      }),
    );
    const manager = new ParticipationGrantLeaseManager({
      endpoint: ENDPOINT,
      fetcher: fetcher as typeof fetch,
      roomId: ROOM_ID,
      storage: {
        getItem: () => JSON.stringify({ version: 1, roomId: 'other-room' }),
        removeItem,
      },
    });

    await expect(manager.ensureFresh()).rejects.toThrow('entry context is invalid');
    expect(removeItem).toHaveBeenCalledWith(`baton-round-entry:v1:${ROOM_ID}`);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects an unsafe server-provided CSRF header name', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (input === SESSION_ENDPOINT) {
        return sessionResponse({ csrfHeaderName: 'Authorization' });
      }
      return response(200, {
        expiresAt: 1_780_000_000,
        refreshAfterSeconds: 240,
      });
    });
    const manager = new ParticipationGrantLeaseManager({
      endpoint: ENDPOINT,
      fetcher: fetcher as typeof fetch,
      roomId: ROOM_ID,
      storage: null,
    });

    await expect(manager.ensureFresh()).rejects.toThrow('CSRF header is invalid');
    expect(refreshCallCount(fetcher)).toBe(0);
  });
});
