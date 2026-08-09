export interface TurnCredentials {
  readonly iceServer: RTCIceServer;
  readonly expiresAt: number;
  readonly refreshDueAtMs: number;
}

export interface LoadTurnCredentialsOptions {
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
  if (typeof fetcher !== 'function') {
    throw new Error('TURN credential fetch is unavailable in this browser');
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    throw new Error('TURN credential timeout must be a positive number');
  }

  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  if (options.signal?.aborted) {
    controller.abort();
  } else {
    options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  }
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);

  try {
    if (controller.signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    const response = await fetcher(options.endpoint ?? DEFAULT_ENDPOINT, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      method: 'POST',
      signal: controller.signal,
    });
    if (controller.signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    if (response.status === 204 || response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`TURN credential request failed with status ${response.status}`);
    }

    const payload = validatePayload(await response.json());
    const receivedAtMs = (options.now ?? (() => globalThis.performance.now()))();
    if (!Number.isFinite(receivedAtMs)) {
      throw new Error('TURN credential refresh clock must be finite');
    }
    return {
      iceServer: {
        urls: payload.urls,
        username: payload.username,
        credential: payload.credential,
      },
      expiresAt: payload.expiresAt,
      refreshDueAtMs: receivedAtMs + payload.refreshAfterSeconds * 1_000,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      if (options.signal?.aborted) {
        throw new Error('TURN credential request was cancelled', { cause: error });
      }
      throw new Error('TURN credential request timed out', { cause: error });
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abortFromCaller);
  }
}

function validatePayload(input: unknown): TurnCredentialsPayload {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ['urls', 'username', 'credential', 'expiresAt', 'refreshAfterSeconds'])
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
  if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt < 1) {
    throw new Error('TURN credential response contains an invalid expiry');
  }
  if (
    typeof refreshAfterSeconds !== 'number' ||
    !Number.isSafeInteger(refreshAfterSeconds) ||
    refreshAfterSeconds < 1 ||
    refreshAfterSeconds > MAXIMUM_REFRESH_AFTER_SECONDS
  ) {
    throw new Error('TURN credential response contains an invalid refresh interval');
  }

  return {
    urls: [...urls],
    username,
    credential,
    expiresAt,
    refreshAfterSeconds,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
