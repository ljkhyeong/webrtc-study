import { hasOnlyKeys, isJsonObject } from './json-validation';

interface TurnCredentials {
  readonly iceServer: RTCIceServer;
  readonly refreshDueAtMs: number;
}

interface LoadTurnCredentialsOptions {
  readonly endpoint?: string;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

interface TurnCredentialsPayload {
  readonly urls: string[];
  readonly username: string;
  readonly credential: string;
  readonly expiresAt: number;
  readonly refreshAfterSeconds: number;
}

const DEFAULT_ENDPOINT = '/api/turn-credentials';
const DEFAULT_TIMEOUT_MS = 5_000;
const MAXIMUM_REFRESH_AFTER_SECONDS = 7 * 24 * 60 * 60;
const MAX_TURN_URLS = 8;

export class TurnCredentialRateLimitError extends Error {
  constructor(readonly retryAfterMs: number) {
    super('통화 중계 요청이 많습니다. 잠시 후 다시 시도해 주세요.');
    this.name = 'TurnCredentialRateLimitError';
  }
}

export function turnCredentialRefreshDelayMs(
  refreshDueAtMs: number,
  nowMs = globalThis.performance.now(),
): number {
  return Math.max(1_000, refreshDueAtMs - nowMs);
}

export async function loadTurnCredentials(
  options: LoadTurnCredentialsOptions = {},
): Promise<TurnCredentials | null> {
  const fetcher = options.fetcher ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal =
    options.signal === undefined ? timeoutSignal : AbortSignal.any([options.signal, timeoutSignal]);

  try {
    const response = await fetcher(options.endpoint ?? DEFAULT_ENDPOINT, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      method: 'POST',
      redirect: 'error',
      signal,
    });

    if (response.status === 204 || response.status === 404) {
      return null;
    }
    if (response.status === 429) {
      // ROUND는 Retry-After를 초 단위로 반환한다. 브라우저 타이머의 최대 지연을 넘기지 않는다.
      const value = response.headers.get('Retry-After') ?? '';
      const seconds = /^\d+$/.test(value) ? Number(value) : 0;
      const retryAfterMs = Number.isFinite(seconds) ? Math.min(seconds * 1_000, 2_147_483_647) : 0;
      throw new TurnCredentialRateLimitError(retryAfterMs);
    }
    if (!response.ok) {
      throw new Error(`TURN credential request failed with status ${response.status}`);
    }

    const payload = validatePayload(await response.json());
    const receivedAtMs = (options.now ?? (() => globalThis.performance.now()))();
    return {
      iceServer: {
        urls: payload.urls,
        username: payload.username,
        credential: payload.credential,
      },
      refreshDueAtMs: receivedAtMs + payload.refreshAfterSeconds * 1_000,
    };
  } catch (error) {
    if (
      error instanceof DOMException &&
      (error.name === 'AbortError' || error.name === 'TimeoutError')
    ) {
      if (options.signal?.aborted) {
        throw new Error('TURN credential request was cancelled', { cause: error });
      }
      throw new Error('TURN credential request timed out', { cause: error });
    }
    throw error;
  }
}

function validatePayload(input: unknown): TurnCredentialsPayload {
  if (
    !isJsonObject(input) ||
    !hasOnlyKeys(input, ['urls', 'username', 'credential', 'expiresAt', 'refreshAfterSeconds'])
  ) {
    throw new Error('TURN credential response must contain only credential lease metadata');
  }

  const urls = input.urls;
  const username = input.username;
  const credential = input.credential;
  const expiresAt = input.expiresAt;
  const refreshAfterSeconds = input.refreshAfterSeconds;

  if (
    !Array.isArray(urls) ||
    urls.length === 0 ||
    urls.length > MAX_TURN_URLS ||
    !urls.every(
      (url) =>
        typeof url === 'string' && url.length > 0 && url.length <= 2_048 && /^turns?:/i.test(url),
    )
  ) {
    throw new Error('TURN credential response contains invalid URLs');
  }
  if (typeof username !== 'string' || username.length === 0 || username.length > 512) {
    throw new Error('TURN credential response contains an invalid username');
  }
  if (typeof credential !== 'string' || credential.length === 0 || credential.length > 512) {
    throw new Error('TURN credential response contains an invalid credential');
  }
  if (!Number.isSafeInteger(expiresAt) || (expiresAt as number) < 1) {
    throw new Error('TURN credential response contains an invalid expiry');
  }
  if (
    !Number.isSafeInteger(refreshAfterSeconds) ||
    (refreshAfterSeconds as number) < 1 ||
    (refreshAfterSeconds as number) > MAXIMUM_REFRESH_AFTER_SECONDS
  ) {
    throw new Error('TURN credential response contains an invalid refresh interval');
  }

  return {
    urls,
    username,
    credential,
    expiresAt: expiresAt as number,
    refreshAfterSeconds: refreshAfterSeconds as number,
  };
}
