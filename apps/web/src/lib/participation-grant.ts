export interface ParticipationGrantLease {
  readonly expiresAt: number;
  readonly refreshAfterSeconds: number;
}

export interface ParticipationGrantLeaseManagerOptions {
  readonly endpoint: string;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

interface ParticipationGrantLeaseState {
  readonly lease: ParticipationGrantLease;
  readonly refreshDueAtMs: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const MAXIMUM_REFRESH_AFTER_SECONDS = 60 * 60;

export class ParticipationGrantLeaseManager {
  readonly #endpoint: string;
  readonly #fetcher: typeof fetch;
  readonly #now: () => number;
  readonly #timeoutMs: number;

  #state: ParticipationGrantLeaseState | null = null;
  #refreshing: Promise<ParticipationGrantLease> | null = null;

  constructor(options: ParticipationGrantLeaseManagerOptions) {
    this.#endpoint = requireSameOriginPath(options.endpoint);
    this.#fetcher = options.fetcher ?? globalThis.fetch;
    this.#now = options.now ?? (() => globalThis.performance.now());
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
      const response = await this.#fetcher(this.#endpoint, {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        method: 'POST',
        signal: controller.signal,
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
