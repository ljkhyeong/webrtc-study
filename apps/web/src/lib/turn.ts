export interface TurnCredentials {
  readonly iceServer: RTCIceServer;
  readonly expiresAt: number;
}

export interface LoadTurnCredentialsOptions {
  readonly endpoint?: string;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

interface TurnCredentialsPayload {
  readonly urls: string[];
  readonly username: string;
  readonly credential: string;
  readonly expiresAt: number;
}

const DEFAULT_ENDPOINT = '/api/turn-credentials';
const DEFAULT_TIMEOUT_MS = 5_000;
const MINIMUM_REMAINING_LIFETIME_SECONDS = 60;
const MAXIMUM_REFRESH_SKEW_MS = 5 * 60 * 1_000;
const MINIMUM_REFRESH_SKEW_MS = 30 * 1_000;
const MAX_TURN_URLS = 8;

export function turnCredentialRefreshDelayMs(expiresAt: number, nowMs = Date.now()): number {
  const remainingMs = Math.max(0, expiresAt * 1_000 - nowMs);
  const refreshSkewMs = Math.min(
    MAXIMUM_REFRESH_SKEW_MS,
    Math.max(MINIMUM_REFRESH_SKEW_MS, Math.floor(remainingMs / 5)),
  );

  return Math.max(1_000, remainingMs - refreshSkewMs);
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
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetcher(options.endpoint ?? DEFAULT_ENDPOINT, {
      headers: { Accept: 'application/json' },
      method: 'POST',
      signal: controller.signal,
    });

    if (response.status === 204 || response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`TURN credential request failed with status ${response.status}`);
    }

    const payload = validatePayload(await response.json(), (options.now ?? Date.now)());
    return {
      iceServer: {
        urls: payload.urls,
        username: payload.username,
        credential: payload.credential,
      },
      expiresAt: payload.expiresAt,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('TURN credential request timed out', { cause: error });
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

function validatePayload(input: unknown, nowMs: number): TurnCredentialsPayload {
  if (!isRecord(input)) {
    throw new Error('TURN credential response must be an object');
  }

  const urls = input.urls;
  const username = input.username;
  const credential = input.credential;
  const expiresAt = input.expiresAt;

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
  if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt)) {
    throw new Error('TURN credential response contains an invalid expiry');
  }

  const minimumExpiry = Math.floor(nowMs / 1_000) + MINIMUM_REMAINING_LIFETIME_SECONDS;
  if (expiresAt < minimumExpiry) {
    throw new Error('TURN credential expires too soon');
  }

  return {
    urls: [...urls],
    username,
    credential,
    expiresAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
