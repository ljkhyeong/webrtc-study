import type { SignalingTransport } from './signaling-transport.js';

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

interface SignalingRecoveryFailure {
  readonly message: string;
}

interface JoinWait {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  timeout: TimerHandle | null;
}

interface SignalingRecoveryLifecycleOptions {
  readonly transport: SignalingTransport;
  readonly serializedJoinMessage: string;
  readonly roomJoinTimeoutMs: number;
  readonly maxReconnectAttempts: number;
  readonly reconnectDelay: (attempt: number) => number;
  readonly isCancelled: () => boolean;
  readonly isRoomActive: () => boolean;
  readonly createJoinTimeoutError: () => unknown;
  readonly createJoinIncompleteError: () => unknown;
  readonly onReconnectAttemptFailed: (error: unknown) => SignalingRecoveryFailure;
  readonly onReconnectExhausted: (lastFailureMessage: string) => void;
  readonly onUnexpectedFailure: (error: unknown) => void;
}

/** 방 입장 확인과 제한된 시그널링 재연결 작업의 수명주기를 소유한다. */
export class SignalingRecoveryLifecycle {
  readonly #options: SignalingRecoveryLifecycleOptions;

  #joinWait: JoinWait | null = null;
  #reconnectDelayTimer: TimerHandle | null = null;
  #cancelReconnectDelay: (() => void) | null = null;
  #reconnectPromise: Promise<void> | null = null;

  constructor(options: SignalingRecoveryLifecycleOptions) {
    this.#options = options;
  }

  joinRoom(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let wait!: JoinWait;
      const finish = (settle: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        this.#clearJoinWait(wait);
        settle();
      };
      wait = {
        resolve: () => finish(resolve),
        reject: (error) => finish(() => reject(error)),
        timeout: null,
      };
      this.#joinWait = wait;
      wait.timeout = globalThis.setTimeout(() => {
        wait.reject(this.#options.createJoinTimeoutError());
      }, this.#options.roomJoinTimeoutMs);

      try {
        this.#options.transport.sendSerialized(this.#options.serializedJoinMessage);
      } catch (error) {
        wait.reject(error);
      }
    });
  }

  resolveJoin(): void {
    this.#joinWait?.resolve();
  }

  rejectJoin(error: unknown): boolean {
    const wait = this.#joinWait;
    if (wait === null) {
      return false;
    }
    wait.reject(error);
    return true;
  }

  startReconnect(initialFailure: SignalingRecoveryFailure): void {
    if (this.#reconnectPromise !== null) {
      return;
    }

    const reconnect = this.#performReconnect(initialFailure);
    this.#reconnectPromise = reconnect;
    void reconnect
      .catch((error: unknown) => {
        if (!this.#options.isCancelled()) {
          this.#options.onUnexpectedFailure(error);
        }
      })
      .finally(() => {
        if (this.#reconnectPromise === reconnect) {
          this.#reconnectPromise = null;
        }
      });
  }

  cancelReconnectWait(): void {
    this.#cancelReconnectDelay?.();
  }

  async #performReconnect(initialFailure: SignalingRecoveryFailure): Promise<void> {
    let lastFailureMessage = initialFailure.message;

    for (let attempt = 0; attempt < this.#options.maxReconnectAttempts; attempt += 1) {
      if (this.#options.isCancelled()) {
        return;
      }

      if (attempt > 0) {
        await this.#waitForReconnectDelay(this.#options.reconnectDelay(attempt));
        if (this.#options.isCancelled()) {
          return;
        }
      }

      try {
        await this.#options.transport.connect();
        if (this.#options.isCancelled()) {
          return;
        }

        const attemptSocket = this.#options.transport.socket;
        await this.joinRoom();
        if (
          attemptSocket !== null &&
          this.#options.transport.socket === attemptSocket &&
          attemptSocket.readyState === attemptSocket.OPEN &&
          this.#options.isRoomActive()
        ) {
          return;
        }
        throw this.#options.createJoinIncompleteError();
      } catch (error) {
        if (this.#options.isCancelled()) {
          return;
        }
        lastFailureMessage = this.#options.onReconnectAttemptFailed(error).message;
      }
    }

    this.#options.onReconnectExhausted(lastFailureMessage);
  }

  #waitForReconnectDelay(delayMs: number): Promise<void> {
    if (delayMs === 0) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const finish = () => {
        if (this.#reconnectDelayTimer !== null) {
          globalThis.clearTimeout(this.#reconnectDelayTimer);
          this.#reconnectDelayTimer = null;
        }
        this.#cancelReconnectDelay = null;
        resolve();
      };
      this.#cancelReconnectDelay = finish;
      this.#reconnectDelayTimer = globalThis.setTimeout(finish, delayMs);
    });
  }

  #clearJoinWait(wait: JoinWait): void {
    if (wait.timeout !== null) {
      globalThis.clearTimeout(wait.timeout);
      wait.timeout = null;
    }
    if (this.#joinWait === wait) {
      this.#joinWait = null;
    }
  }
}
