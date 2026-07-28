import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { App, roomWarningMessage } from './App';

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
});
