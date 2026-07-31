import { isValidRoomId } from './room';

export interface ParticipationGrantLease {
  readonly expiresAt: number;
  readonly refreshAfterSeconds: number;
}

export interface BatonRoundEntryContext {
  readonly version: 1;
  readonly teamId: string;
  readonly seasonId: string;
  readonly resourceId: string;
  readonly roomId: string;
}

export interface ParticipationGrantLeaseManagerOptions {
  readonly endpoint: string;
  readonly roomId: string;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
  readonly storage?: Pick<Storage, 'getItem' | 'removeItem'> | null;
  readonly timeoutMs?: number;
}

interface ParticipationGrantLeaseState {
  readonly lease: ParticipationGrantLease;
  readonly refreshDueAtMs: number;
}

interface BatonCsrfCredential {
  readonly headerName: string;
  readonly token: string;
}

const SESSION_ENDPOINT = '/api/v1/auth/session';
const ENTRY_STORAGE_PREFIX = 'baton-round-entry:v1:';
const ENTRY_FIELDS = ['resourceId', 'roomId', 'seasonId', 'teamId', 'version'] as const;
const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const DISALLOWED_CSRF_HEADER_NAMES = new Set([
  'accept',
  'authorization',
  'cache-control',
  'connection',
  'content-length',
  'content-type',
  'cookie',
  'host',
  'origin',
  'referer',
  'set-cookie',
]);
const DEFAULT_TIMEOUT_MS = 5_000;
const MAXIMUM_REFRESH_AFTER_SECONDS = 5 * 60;
const MAXIMUM_ENTRY_LENGTH = 2_048;
const MAXIMUM_CSRF_TOKEN_LENGTH = 4_096;

export class ParticipationGrantLeaseManager {
  readonly #endpoint: string;
  readonly #roomId: string;
  readonly #fetcher: typeof fetch;
  readonly #now: () => number;
  readonly #storage: Pick<Storage, 'getItem' | 'removeItem'> | null | undefined;
  readonly #timeoutMs: number;

  #state: ParticipationGrantLeaseState | null = null;
  #refreshing: Promise<ParticipationGrantLease> | null = null;

  constructor(options: ParticipationGrantLeaseManagerOptions) {
    this.#endpoint = requireSameOriginPath(options.endpoint);
    this.#roomId = requireRoomId(options.roomId);
    this.#fetcher = options.fetcher ?? globalThis.fetch;
    this.#now = options.now ?? (() => globalThis.performance.now());
    this.#storage = options.storage;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    if (typeof this.#fetcher !== 'function') {
      throw new Error('Participation grant refresh is unavailable in this browser');
    }
    if (!Number.isFinite(this.#timeoutMs) || this.#timeoutMs < 1) {
      throw new Error('Participation grant refresh timeout must be a positive number');
    }
  }

  ensureFresh(): Promise<ParticipationGrantLease> {
    const nowMs = this.#readNow();
    if (this.#state !== null && nowMs < this.#state.refreshDueAtMs) {
      return Promise.resolve(this.#state.lease);
    }
    if (this.#refreshing !== null) {
      return this.#refreshing;
    }

    const refreshing = this.#requestRefresh().finally(() => {
      if (this.#refreshing === refreshing) {
        this.#refreshing = null;
      }
    });
    this.#refreshing = refreshing;
    return refreshing;
  }

  refreshDelayMs(): number | null {
    if (this.#state === null) {
      return null;
    }
    return Math.max(0, this.#state.refreshDueAtMs - this.#readNow());
  }

  async #requestRefresh(): Promise<ParticipationGrantLease> {
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      const entryContext = readEntryContext(this.#roomId, this.#storage);
      const csrfCredential = await loadBatonCsrfCredential(this.#fetcher, controller.signal);
      const headers: Record<string, string> = {
        Accept: 'application/json',
        [csrfCredential.headerName]: csrfCredential.token,
      };
      const requestBody =
        entryContext === null
          ? undefined
          : JSON.stringify({
              teamId: entryContext.teamId,
              seasonId: entryContext.seasonId,
              resourceId: entryContext.resourceId,
            });
      if (requestBody !== undefined) {
        headers['Content-Type'] = 'application/json';
      }

      const response = await this.#fetcher(this.#endpoint, {
        cache: 'no-store',
        credentials: 'same-origin',
        headers,
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        ...(requestBody === undefined ? {} : { body: requestBody }),
      });
      if (!response.ok) {
        throw new Error(`Participation grant refresh failed with status ${response.status}`);
      }

      const lease = validateLease(await response.json());
      const receivedAtMs = this.#readNow();
      this.#state = {
        lease,
        refreshDueAtMs: receivedAtMs + lease.refreshAfterSeconds * 1_000,
      };
      return lease;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error('Participation grant refresh timed out', { cause: error });
      }
      throw error;
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }

  #readNow(): number {
    const nowMs = this.#now();
    if (!Number.isFinite(nowMs)) {
      throw new Error('Participation grant refresh clock must be finite');
    }
    return nowMs;
  }
}

function requireRoomId(roomId: string): string {
  if (!isValidRoomId(roomId)) {
    throw new Error('Participation grant room id must be canonical');
  }
  return roomId;
}

function readEntryContext(
  roomId: string,
  configuredStorage: Pick<Storage, 'getItem' | 'removeItem'> | null | undefined,
): BatonRoundEntryContext | null {
  const storage = configuredStorage === undefined ? browserSessionStorage() : configuredStorage;
  if (storage === null) {
    return null;
  }

  const key = `${ENTRY_STORAGE_PREFIX}${roomId}`;
  let serialized: string | null;
  try {
    serialized = storage.getItem(key);
  } catch {
    return null;
  }
  if (serialized === null) {
    return null;
  }

  try {
    if (serialized.length < 1 || serialized.length > MAXIMUM_ENTRY_LENGTH) {
      throw new Error('invalid entry size');
    }
    const parsed: unknown = JSON.parse(serialized);
    if (!isValidEntryContext(parsed, roomId)) {
      throw new Error('invalid entry fields');
    }
    return parsed;
  } catch (error) {
    try {
      storage.removeItem(key);
    } catch {
      // The invalid locator remains rejected even when browser privacy settings block cleanup.
    }
    throw new Error('BATON ROUND entry context is invalid', { cause: error });
  }
}

function browserSessionStorage(): Pick<Storage, 'getItem' | 'removeItem'> | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function isValidEntryContext(input: unknown, roomId: string): input is BatonRoundEntryContext {
  if (!isRecord(input)) {
    return false;
  }
  const fields = Object.keys(input).sort();
  return (
    fields.length === ENTRY_FIELDS.length &&
    fields.every((field, index) => field === ENTRY_FIELDS[index]) &&
    input.version === 1 &&
    typeof input.teamId === 'string' &&
    CANONICAL_UUID_PATTERN.test(input.teamId) &&
    typeof input.seasonId === 'string' &&
    CANONICAL_UUID_PATTERN.test(input.seasonId) &&
    typeof input.resourceId === 'string' &&
    CANONICAL_UUID_PATTERN.test(input.resourceId) &&
    input.roomId === roomId
  );
}

async function loadBatonCsrfCredential(
  fetcher: typeof fetch,
  signal: AbortSignal,
): Promise<BatonCsrfCredential> {
  const response = await fetcher(SESSION_ENDPOINT, {
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    method: 'GET',
    redirect: 'error',
    signal,
  });
  if (!response.ok) {
    throw new Error(`BATON session lookup failed with status ${response.status}`);
  }

  const input: unknown = await response.json();
  if (!isRecord(input) || input.authenticated !== true) {
    throw new Error('BATON session is not authenticated');
  }
  if (typeof input.accountId !== 'string' || !CANONICAL_UUID_PATTERN.test(input.accountId)) {
    throw new Error('BATON session account is invalid');
  }
  if (typeof input.csrfHeaderName !== 'string' || !isSafeCsrfHeaderName(input.csrfHeaderName)) {
    throw new Error('BATON session CSRF header is invalid');
  }
  if (
    typeof input.csrfToken !== 'string' ||
    input.csrfToken.length < 1 ||
    input.csrfToken.length > MAXIMUM_CSRF_TOKEN_LENGTH
  ) {
    throw new Error('BATON session CSRF token is invalid');
  }
  return {
    headerName: input.csrfHeaderName,
    token: input.csrfToken,
  };
}

function isSafeCsrfHeaderName(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    value.length <= 128 &&
    HTTP_HEADER_NAME_PATTERN.test(value) &&
    !DISALLOWED_CSRF_HEADER_NAMES.has(normalized) &&
    !normalized.startsWith('proxy-') &&
    !normalized.startsWith('sec-') &&
    !normalized.startsWith('x-forwarded-')
  );
}

function validateLease(input: unknown): ParticipationGrantLease {
  if (!isRecord(input) || !hasExactKeys(input, ['expiresAt', 'refreshAfterSeconds'])) {
    throw new Error('Participation grant refresh response must contain only lease metadata');
  }

  const expiresAt = input.expiresAt;
  const refreshAfterSeconds = input.refreshAfterSeconds;
  if (!Number.isSafeInteger(expiresAt) || (expiresAt as number) < 1) {
    throw new Error('Participation grant refresh response contains an invalid expiry');
  }
  if (
    !Number.isSafeInteger(refreshAfterSeconds) ||
    (refreshAfterSeconds as number) < 1 ||
    (refreshAfterSeconds as number) > MAXIMUM_REFRESH_AFTER_SECONDS
  ) {
    throw new Error('Participation grant refresh response contains an invalid refresh delay');
  }

  return {
    expiresAt: expiresAt as number,
    refreshAfterSeconds: refreshAfterSeconds as number,
  };
}

function requireSameOriginPath(endpoint: string): string {
  const normalized = endpoint.trim();
  if (
    !normalized.startsWith('/') ||
    normalized.startsWith('//') ||
    normalized.includes('?') ||
    normalized.includes('#')
  ) {
    throw new Error('Participation grant refresh endpoint must be a same-origin path');
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
