import type { SignalingTransport } from './signaling-transport.js';

interface SignalingRecoveryFailure {
  readonly message: string;
  /** 다시 시도해도 결과가 같은 실패다. 남은 시도 없이 재연결을 끝낸다. */
  readonly final?: boolean;
}

interface JoinWait {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

interface SignalingRecoveryLifecycleOptions {
  readonly transport: SignalingTransport;
  readonly serializedJoinMessage: string;
  readonly roomJoinTimeoutMs: number;
  readonly maxReconnectAttempts: number;
  /** 첫 재연결 시도부터 새 시도를 시작할 수 있는 시간이다. */
  readonly reconnectWindowMs: number;
  readonly reconnectDelay: (attempt: number) => number;
  readonly now: () => number;
  readonly isCancelled: () => boolean;
  readonly isRoomActive: () => boolean;
  readonly createJoinTimeoutError: () => unknown;
  readonly createJoinIncompleteError: () => unknown;
  readonly onReconnectAttemptFailed: (error: unknown) => SignalingRecoveryFailure;
  readonly onReconnectExhausted: (lastFailureMessage: string, lastError: unknown) => void;
  readonly onUnexpectedFailure: (error: unknown) => void;
}

/** 방 입장 확인과 시간·횟수가 제한된 시그널링 재연결을 관리한다. */
export class SignalingRecoveryLifecycle {
  readonly #options: SignalingRecoveryLifecycleOptions;

  #joinWait: JoinWait | null = null;
  #cancelReconnectDelay: (() => void) | null = null;
  #reconnectPromise: Promise<void> | null = null;

  constructor(options: SignalingRecoveryLifecycleOptions) {
    this.#options = options;
  }

  joinRoom(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Promise 완료와 타이머 해제는 여러 번 불러도 결과가 같다.
      const finish = (settle: () => void) => {
        globalThis.clearTimeout(timeout);
        if (this.#joinWait === wait) this.#joinWait = null;
        settle();
      };
      const wait: JoinWait = {
        resolve: () => finish(resolve),
        reject: (error) => finish(() => reject(error)),
      };
      this.#joinWait = wait;
      const timeout = globalThis.setTimeout(() => {
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

  cancelReconnectWait(): boolean {
    const cancel = this.#cancelReconnectDelay;
    if (cancel === null) {
      return false;
    }
    cancel();
    return true;
  }

  async #performReconnect(initialFailure: SignalingRecoveryFailure): Promise<void> {
    const startedAt = this.#options.now();
    let lastFailureMessage = initialFailure.message;
    let lastError: unknown = null;

    for (let attempt = 0; attempt < this.#options.maxReconnectAttempts; attempt += 1) {
      if (this.#options.isCancelled()) {
        return;
      }

      if (attempt > 0) {
        const delayMs = this.#options.reconnectDelay(attempt);
        // 다음 시도가 시간 예산 밖에서 시작되면 기다리지 않고 바로 끝낸다.
        if (this.#options.now() - startedAt + delayMs >= this.#options.reconnectWindowMs) {
          break;
        }
        await this.#waitForReconnectDelay(delayMs);
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
        const failure = this.#options.onReconnectAttemptFailed(error);
        lastFailureMessage = failure.message;
        lastError = error;
        if (failure.final === true) {
          break;
        }
      }
    }

    this.#options.onReconnectExhausted(lastFailureMessage, lastError);
  }

  #waitForReconnectDelay(delayMs: number): Promise<void> {
    if (delayMs === 0) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const finish = () => {
        globalThis.clearTimeout(timer);
        this.#cancelReconnectDelay = null;
        resolve();
      };
      this.#cancelReconnectDelay = finish;
      const timer = globalThis.setTimeout(finish, delayMs);
    });
  }
}
