import { describe, expect, it, vi } from 'vitest';

import { RoomRefreshLifetime } from './room-refresh-lifetime';

describe('RoomRefreshLifetime', () => {
  it('clears both refresh timers and refuses rescheduling after a terminal session', async () => {
    vi.useFakeTimers();
    try {
      const lifetime = new RoomRefreshLifetime();
      const refreshParticipationGrant = vi.fn();
      const refreshTurn = vi.fn();

      lifetime.schedule('participation-grant', refreshParticipationGrant, 1_000);
      lifetime.schedule('turn', refreshTurn, 2_000);
      lifetime.stop();
      lifetime.schedule('participation-grant', refreshParticipationGrant, 1);
      lifetime.schedule('turn', refreshTurn, 1);

      await vi.advanceTimersByTimeAsync(5_000);

      expect(lifetime.isActive()).toBe(false);
      expect(refreshParticipationGrant).not.toHaveBeenCalled();
      expect(refreshTurn).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets an in-flight continuation observe termination before scheduling more work', async () => {
    const lifetime = new RoomRefreshLifetime();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const continuation = vi.fn();
    const inFlight = (async () => {
      await gate;
      if (lifetime.isActive()) {
        continuation();
      }
    })();

    lifetime.stop();
    release();
    await inFlight;

    expect(continuation).not.toHaveBeenCalled();
  });
});
