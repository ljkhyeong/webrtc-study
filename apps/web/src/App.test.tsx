import { renderToStaticMarkup } from 'react-dom/server';
import { SIGNALING_ERROR_CODES } from '@round/protocol';
import { describe, expect, it, vi } from 'vitest';
import { App, roomErrorMessage, roomStatusLabel, roomWarningMessage } from './App';

describe('App pre-join boundary', () => {
  it('opens a direct invite link without requesting media or creating a WebSocket', () => {
    const getUserMedia = vi.fn();
    const webSocket = vi.fn();
    vi.stubGlobal('window', {
      location: {
        host: 'localhost:5173',
        pathname: '/room/abcd-efgh-jkmp',
        protocol: 'http:',
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      history: {
        pushState: vi.fn(),
        replaceState: vi.fn(),
      },
    });
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => '림'),
      setItem: vi.fn(),
    });
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia,
        enumerateDevices: vi.fn(),
      },
    });
    vi.stubGlobal('WebSocket', webSocket);

    try {
      const markup = renderToStaticMarkup(<App />);

      expect(markup).toContain('초대받은 스터디룸');
      expect(markup).toContain('입장 준비');
      expect(markup).not.toContain('직접 연결됨');
      expect(getUserMedia).not.toHaveBeenCalled();
      expect(webSocket).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('describes signaling reconnect without claiming remote calls are preserved', () => {
    const warning = roomWarningMessage({
      code: 'signaling-reconnecting',
      message: 'socket closed',
    });

    expect(warning).toContain('카메라와 마이크는 유지');
    expect(warning).toContain('참가자 연결은 다시 설정');
    expect(warning).not.toContain('현재 통화 정보는 유지');
  });

  it('describes an exhausted peer connection as a partial actionable failure', () => {
    const timeoutWarning = roomWarningMessage({
      code: 'peer-connection-timeout',
      message: 'raw peer timeout',
    });
    const negotiationWarning = roomWarningMessage({
      code: 'peer-negotiation-failed',
      message: 'Connection to internal-peer-id failed',
    });
    const status = roomStatusLabel('active', [
      {
        peerId: 'self',
        displayName: 'Jin',
        isLocal: true,
        audioEnabled: true,
        videoEnabled: true,
        connectionState: 'connected',
      },
      {
        peerId: 'peer-a',
        displayName: 'Ara',
        isLocal: false,
        audioEnabled: false,
        videoEnabled: false,
        connectionState: 'failed',
      },
    ]);

    expect(status).toBe('일부 참가자 연결 실패');
    for (const warning of [timeoutWarning, negotiationWarning]) {
      expect(warning).toContain('일부 참가자');
      expect(warning).toContain('현재 연결은 유지');
      expect(warning).toContain('방에 다시 입장');
    }
    expect(timeoutWarning).not.toContain('raw peer timeout');
    expect(negotiationWarning).not.toContain('internal-peer-id');
  });

  it('does not discard a later TURN warning', () => {
    const warning = roomWarningMessage({
      code: 'rtc-configuration-update-failed',
      message: 'later warning',
    });

    expect(warning).toContain('TURN');
    expect(warning).not.toContain('later warning');
  });

  it('describes DataChannel rate limiting without exposing an internal peer id', () => {
    const warning = roomWarningMessage({
      code: 'data-channel-rate-limit',
      message: 'Ignored excessive DataChannel messages from internal-peer-id',
    });

    expect(warning).toContain('너무 많은 데이터');
    expect(warning).toContain('통화는 유지');
    expect(warning).not.toContain('internal-peer-id');
  });

  it('explains an ended local media track with an explicit recovery action', () => {
    const warning = roomWarningMessage({
      code: 'local-media-ended',
      message: 'Local microphone track ended unexpectedly',
    });

    expect(warning).toContain('연결이 종료');
    expect(warning).toContain('통화는 유지');
    expect(warning).toContain('다시 입장');
    expect(warning).not.toContain('Local microphone');
  });

  it.each(SIGNALING_ERROR_CODES)('localizes %s without exposing raw signaling details', (code) => {
    const issue = {
      code,
      message: 'raw server detail with internal-peer-id',
    };

    for (const message of [roomErrorMessage(issue), roomWarningMessage(issue)]) {
      expect(message).toMatch(/[가-힣]/);
      expect(message).not.toContain('raw server detail');
      expect(message).not.toContain('internal-peer-id');
    }
  });

  it('explains that a non-terminal INTERNAL_ERROR warning preserves the call', () => {
    expect(roomWarningMessage({ code: 'INTERNAL_ERROR', message: 'raw detail' })).toContain(
      '현재 통화는 유지',
    );
  });
});
