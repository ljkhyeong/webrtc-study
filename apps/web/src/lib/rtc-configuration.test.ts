import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadRtcConfiguration, type TurnCredentialReuse } from './rtc-configuration';
import { loadTurnCredentials } from './turn';

vi.mock('./turn', () => ({
  loadTurnCredentials: vi.fn(),
}));

const mockedLoadTurnCredentials = vi.mocked(loadTurnCredentials);

function useHostname(hostname: string): void {
  vi.stubGlobal('window', { location: { hostname } });
}

describe('RTC configuration loading', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_STUN_URLS', '');
    vi.stubEnv('VITE_ICE_TRANSPORT_POLICY', 'all');
    useHostname('localhost');
    mockedLoadTurnCredentials.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('trims STUN URLs and merges TURN credentials with relay policy', async () => {
    vi.stubEnv('VITE_STUN_URLS', ' stun:one.example:3478, ,stun:two.example:3478 ');
    vi.stubEnv('VITE_ICE_TRANSPORT_POLICY', 'relay');
    useHostname('round.example.com');
    const signal = new AbortController().signal;
    const turnServer: RTCIceServer = {
      urls: ['turn:round.example.com:3478'],
      username: 'user',
      credential: 'credential',
    };
    mockedLoadTurnCredentials.mockResolvedValue({
      iceServer: turnServer,
      refreshDueAtMs: 241_000,
    });

    await expect(loadRtcConfiguration('/api/turn', signal)).resolves.toEqual({
      configuration: {
        iceServers: [{ urls: ['stun:one.example:3478', 'stun:two.example:3478'] }, turnServer],
        iceCandidatePoolSize: 1,
        iceTransportPolicy: 'relay',
      },
      turnRefreshDueAtMs: 241_000,
    });
    expect(mockedLoadTurnCredentials).toHaveBeenCalledWith({
      endpoint: '/api/turn',
      signal,
    });
  });

  it('보관소를 넘긴 입장만 아직 갱신 전인 직전 TURN 자격 증명을 다시 쓴다', async () => {
    vi.useFakeTimers();
    try {
      const turnServer: RTCIceServer = {
        urls: ['turn:round.example.com:3478'],
        username: 'user',
        credential: 'credential',
      };
      mockedLoadTurnCredentials.mockImplementation(async () => ({
        iceServer: turnServer,
        refreshDueAtMs: performance.now() + 240_000,
      }));
      const url = '/round/rooms/reuse-test/turn-credentials';
      const reuse: TurnCredentialReuse = { last: null };

      await loadRtcConfiguration(url, undefined, { reuse });
      await loadRtcConfiguration(url, undefined, { reuse });
      expect(mockedLoadTurnCredentials).toHaveBeenCalledOnce();

      // 통화 중 갱신은 보관소 없이 항상 새로 받는다.
      await loadRtcConfiguration(url);
      expect(mockedLoadTurnCredentials).toHaveBeenCalledTimes(2);

      // 방이 바뀌면 이전 방의 자격 증명은 다시 쓰지 않고, 갱신 시점이 지나도 새로 받는다.
      await loadRtcConfiguration('/round/rooms/other-room/turn-credentials', undefined, { reuse });
      expect(mockedLoadTurnCredentials).toHaveBeenCalledTimes(3);
      await loadRtcConfiguration(url, undefined, { reuse });
      expect(mockedLoadTurnCredentials).toHaveBeenCalledTimes(4);
      vi.advanceTimersByTime(240_000);
      await loadRtcConfiguration(url, undefined, { reuse });
      expect(mockedLoadTurnCredentials).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows localhost with all policy when TURN is unavailable', async () => {
    mockedLoadTurnCredentials.mockResolvedValue(null);

    await expect(loadRtcConfiguration('/api/turn')).resolves.toEqual({
      configuration: {
        iceServers: [],
        iceCandidatePoolSize: 1,
        iceTransportPolicy: 'all',
      },
      turnRefreshDueAtMs: null,
    });
  });

  it.each([
    { hostname: 'localhost', policy: 'relay' },
    { hostname: 'round.example.com', policy: 'all' },
  ])('rejects missing TURN for $hostname with $policy policy', async ({ hostname, policy }) => {
    vi.stubEnv('VITE_ICE_TRANSPORT_POLICY', policy);
    useHostname(hostname);
    mockedLoadTurnCredentials.mockResolvedValue(null);

    await expect(loadRtcConfiguration('/api/turn')).rejects.toThrow(
      '통화 중계 정보를 받지 못했습니다.',
    );
  });

  it('rejects an unsupported ICE transport policy', async () => {
    vi.stubEnv('VITE_ICE_TRANSPORT_POLICY', 'invalid');
    mockedLoadTurnCredentials.mockResolvedValue(null);

    await expect(loadRtcConfiguration('/api/turn')).rejects.toThrow(
      'ICE 전송 정책 설정이 올바르지 않습니다.',
    );
    expect(mockedLoadTurnCredentials).not.toHaveBeenCalled();
  });
});
