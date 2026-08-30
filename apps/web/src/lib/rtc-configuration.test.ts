import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadRtcConfiguration } from './rtc-configuration';
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
      'TURN 서버 정보를 받지 못했습니다.',
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
