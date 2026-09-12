// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomRefreshCoordinator } from './room-refresh-coordinator';

describe('TURN 갱신 재시도', () => {
  let coordinator: RoomRefreshCoordinator;
  const updateRtcConfiguration = vi.fn();
  const onTurnWarning = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    coordinator = new RoomRefreshCoordinator({
      isCurrent: () => true,
      updateRtcConfiguration,
      onTurnWarning,
      onParticipationGrantWarning: vi.fn(),
    });
    coordinator.setTurnCredentialsUrl('/round/rooms/abcd-efgh-jkmp/turn-credentials');
  });

  afterEach(() => {
    coordinator.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([
    { status: 429, retryAfter: '120', delay: 120_000 },
    { status: 429, retryAfter: '1', delay: 30_000 },
    { status: 429, retryAfter: null, delay: 30_000 },
    { status: 429, retryAfter: 'invalid', delay: 30_000 },
    { status: 503, retryAfter: null, delay: 30_000 },
  ])(
    '$status 응답의 대기 시간 $retryAfter 뒤에 갱신한다',
    async ({ status, retryAfter, delay }) => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(null, {
            status,
            headers: retryAfter === null ? {} : { 'Retry-After': retryAfter },
          }),
        )
        .mockResolvedValueOnce(
          Response.json({
            urls: ['turn:turn.example.com:3478?transport=udp'],
            username: 'test-user',
            credential: 'test-credential',
            expiresAt: 7_200,
            refreshAfterSeconds: 240,
          }),
        );
      vi.stubGlobal('fetch', fetcher);
      coordinator.scheduleTurnRefresh(performance.now());

      await vi.advanceTimersByTimeAsync(1_000);
      expect(fetcher).toHaveBeenCalledOnce();
      expect(updateRtcConfiguration).not.toHaveBeenCalled();
      expect(onTurnWarning).toHaveBeenLastCalledWith(
        expect.stringContaining('갱신하지 못했습니다'),
      );
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(fetcher).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(updateRtcConfiguration).toHaveBeenCalledOnce();
      expect(onTurnWarning).toHaveBeenLastCalledWith('');
    },
  );

  it('서버가 지정한 대기 중에 퇴장하면 다시 요청하지 않는다', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(null, {
          status: 429,
          headers: { 'Retry-After': '120' },
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    coordinator.scheduleTurnRefresh(performance.now());
    await vi.advanceTimersByTimeAsync(1_000);
    coordinator.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(updateRtcConfiguration).not.toHaveBeenCalled();
  });
});
