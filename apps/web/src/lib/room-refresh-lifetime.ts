export type RoomRefreshTimer = 'participation-grant' | 'turn';

/** 마운트되어 있고 종료되지 않은 방 세션 하나의 백그라운드 갱신 타이머를 소유한다. */
export class RoomRefreshLifetime {
  readonly #timers = new Map<RoomRefreshTimer, ReturnType<typeof globalThis.setTimeout>>();
  #active = true;

  isActive(): boolean {
    return this.#active;
  }

  schedule(timer: RoomRefreshTimer, callback: () => void, delayMs: number): void {
    if (!this.#active) {
      return;
    }
    this.#clear(timer);
    const handle = globalThis.setTimeout(() => {
      if (this.#timers.get(timer) !== handle) {
        return;
      }
      this.#timers.delete(timer);
      if (this.#active) {
        callback();
      }
    }, delayMs);
    this.#timers.set(timer, handle);
  }

  #clear(timer: RoomRefreshTimer): void {
    const handle = this.#timers.get(timer);
    if (handle === undefined) {
      return;
    }
    globalThis.clearTimeout(handle);
    this.#timers.delete(timer);
  }

  stop(): void {
    if (!this.#active) {
      return;
    }
    this.#active = false;
    for (const handle of this.#timers.values()) {
      globalThis.clearTimeout(handle);
    }
    this.#timers.clear();
  }
}
