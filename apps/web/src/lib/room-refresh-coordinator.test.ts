// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ParticipationGrantLeaseManager } from './participation-grant';
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

describe('참여권 갱신 뒤 시그널링 연결 연장', () => {
  const ROOM_ID = 'abcd-efgh-jkmp';
  const GRANT_ENDPOINT = `/round/rooms/${ROOM_ID}/participation-grant/refresh`;
  const LEASE_URL = `https://baton.example/round/rooms/${ROOM_ID}/signal?lease=peer-1`;
  let nowMs: number;
  let peerId: string | null;
  let grantFetcher: ReturnType<typeof vi.fn>;
  let coordinator: RoomRefreshCoordinator;

  beforeEach(() => {
    vi.useFakeTimers();
    nowMs = 0;
    peerId = 'peer-1';
    grantFetcher = vi.fn(async (input: RequestInfo | URL) =>
      input === '/api/v1/auth/session'
        ? Response.json({
            authenticated: true,
            csrfHeaderName: 'X-CSRF-TOKEN',
            csrfToken: 'csrf-token',
          })
        : Response.json({ expiresAt: 1_780_000_000, refreshAfterSeconds: 240 }),
    );
    coordinator = new RoomRefreshCoordinator({
      participationGrantLeaseManager: new ParticipationGrantLeaseManager({
        endpoint: GRANT_ENDPOINT,
        roomId: ROOM_ID,
        fetcher: grantFetcher as typeof fetch,
        now: () => nowMs,
        storage: null,
      }),
      isCurrent: () => true,
      updateRtcConfiguration: vi.fn(),
      onTurnWarning: vi.fn(),
      onParticipationGrantWarning: vi.fn(),
      currentSignalingPeerId: () => peerId,
    });
    coordinator.setSignalingUrl(`wss://baton.example/round/rooms/${ROOM_ID}/signal`);
  });

  afterEach(() => {
    coordinator.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const grantRefreshCount = () =>
    grantFetcher.mock.calls.filter(([input]) => input === GRANT_ENDPOINT).length;

  it('새 참여권을 받았을 때만 현재 연결의 만료 연장을 요청한다', async () => {
    const leaseFetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', leaseFetch);

    await coordinator.ensureFreshParticipationGrant();
    await vi.advanceTimersByTimeAsync(0);
    expect(leaseFetch).toHaveBeenCalledOnce();
    expect(leaseFetch).toHaveBeenCalledWith(LEASE_URL, {
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });

    // 아직 갱신할 때가 아니면 새 참여권이 없으므로 다시 요청하지 않는다.
    await coordinator.ensureFreshParticipationGrant();
    await vi.advanceTimersByTimeAsync(0);
    expect(leaseFetch).toHaveBeenCalledOnce();

    nowMs = 240_000;
    await vi.advanceTimersByTimeAsync(240_000);
    expect(grantRefreshCount()).toBe(2);
    expect(leaseFetch).toHaveBeenCalledTimes(2);
  });

  it('일시적인 실패만 10초 간격으로 두 번까지 다시 요청한다', async () => {
    const leaseFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue(new Response(null, { status: 429 }));
    vi.stubGlobal('fetch', leaseFetch);

    await coordinator.ensureFreshParticipationGrant();
    await vi.advanceTimersByTimeAsync(0);
    expect(leaseFetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(leaseFetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(leaseFetch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(leaseFetch).toHaveBeenCalledTimes(3);
  });

  it('연장할 수 없는 연결은 다시 요청하지 않고 만료 뒤 재연결에 맡긴다', async () => {
    const leaseFetch = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', leaseFetch);

    await coordinator.ensureFreshParticipationGrant();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(leaseFetch).toHaveBeenCalledOnce();
  });

  it('입장 전·재연결 중에 받은 참여권과 퇴장 뒤 재시도로는 요청하지 않는다', async () => {
    const leaseFetch = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', leaseFetch);

    peerId = null;
    await coordinator.ensureFreshParticipationGrant();
    await vi.advanceTimersByTimeAsync(0);
    expect(grantRefreshCount()).toBe(1);
    expect(leaseFetch).not.toHaveBeenCalled();

    // 새 연결은 갱신한 참여권으로 만들었으므로 같은 참여권으로 다시 연장하지 않는다.
    peerId = 'peer-1';
    await coordinator.ensureFreshParticipationGrant();
    await vi.advanceTimersByTimeAsync(0);
    expect(leaseFetch).not.toHaveBeenCalled();

    nowMs = 240_000;
    await vi.advanceTimersByTimeAsync(240_000);
    expect(leaseFetch).toHaveBeenCalledOnce();
    coordinator.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(leaseFetch).toHaveBeenCalledOnce();
  });
});
