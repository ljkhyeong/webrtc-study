import { renderToStaticMarkup } from 'react-dom/server';
import { SIGNALING_ERROR_CODES } from '@round/protocol';
import { ChatSendError } from '@round/rtc-core';
import { describe, expect, it, vi } from 'vitest';
import { App, navigateToOwningHome } from './App';
import {
  buildRoomSystemNotices,
  chatErrorMessage,
  resolveActiveRoomTerminalState,
  roomErrorMessage,
  roomStatusLabel,
  roomWarningMessage,
  screenShareStartNotice,
} from './lib/room-presentation';

describe('App pre-join boundary', () => {
  it('returns BATON-owned rooms with a document navigation', () => {
    const navigate = vi.fn();
    const navigateDocument = vi.fn();

    navigateToOwningHome('baton', navigate, navigateDocument);

    expect(navigateDocument).toHaveBeenCalledOnce();
    expect(navigateDocument).toHaveBeenCalledWith('/');
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each([undefined, 'standalone'] as const)(
    'keeps %s rooms on the standalone client-side landing route',
    (authMode) => {
      const navigate = vi.fn();
      const navigateDocument = vi.fn();

      navigateToOwningHome(authMode, navigate, navigateDocument);

      expect(navigate).toHaveBeenCalledOnce();
      expect(navigate).toHaveBeenCalledWith('/');
      expect(navigateDocument).not.toHaveBeenCalled();
    },
  );

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

      expect(markup).toContain('내 이름');
      expect(markup).not.toContain('같이 공부할');
      expect(markup).not.toContain('ROUND 기능 미리보기');
      expect(markup).toContain('입장 준비');
      expect(markup).not.toContain('직접 연결됨');
      expect(getUserMedia).not.toHaveBeenCalled();
      expect(webSocket).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('fails closed before prejoin or media access for an unsupported authentication mode', () => {
    const getUserMedia = vi.fn();
    const webSocket = vi.fn();
    vi.stubEnv('VITE_ROUND_AUTH_MODE', 'unsupported');
    vi.stubGlobal('window', {
      location: {
        host: 'localhost:5173',
        pathname: '/room/abcd-efgh-jkmp',
        protocol: 'http:',
      },
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

      expect(markup).toContain('서비스 설정 오류로 입장할 수 없습니다.');
      expect(markup).not.toContain('입장 준비');
      expect(markup).not.toContain('장치 확인');
      expect(getUserMedia).not.toHaveBeenCalled();
      expect(webSocket).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
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

  it('describes a full room without hard-coding deployment capacity', () => {
    const message = roomErrorMessage({
      code: 'ROOM_FULL',
      message: 'This room is limited to 4 participants.',
    });

    expect(message).toBe('이 스터디룸은 최대 인원에 도달했습니다.');
    expect(message).not.toContain('4');
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
        role: 'host',
        isLocal: true,
        handRaised: false,
        audioEnabled: true,
        videoEnabled: true,
        videoSource: 'camera',
        connectionState: 'connected',
      },
      {
        peerId: 'peer-a',
        displayName: 'Ara',
        role: 'participant',
        isLocal: false,
        handRaised: false,
        audioEnabled: false,
        videoEnabled: false,
        videoSource: 'camera',
        connectionState: 'failed',
      },
    ]);

    expect(status).toBe('일부 참가자 연결 실패');
    for (const warning of [timeoutWarning, negotiationWarning]) {
      expect(warning).toContain('일부 참가자');
      expect(warning).toContain('다른 참가자와의 통화는 유지');
      expect(warning).toContain('해당 참가자의 다시 연결 버튼');
    }
    expect(timeoutWarning).not.toContain('raw peer timeout');
    expect(negotiationWarning).not.toContain('internal-peer-id');
  });

  it('does not discard a later TURN warning', () => {
    const warning = roomWarningMessage({
      code: 'rtc-configuration-update-failed',
      message: 'later warning',
    });

    expect(warning).toContain('통화 연결 정보');
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

  it('describes screen-share sender recovery without exposing internal details', () => {
    const warning = roomWarningMessage({
      code: 'screen-share-sender-recovery',
      message: 'internal recovery detail',
    });

    expect(warning).toContain('자동으로 복구');
    expect(warning).toContain('통화는 유지');
    expect(warning).not.toContain('internal recovery detail');
  });

  it('gives a neutral retry action for picker cancellation and an error for capture failure', () => {
    expect(screenShareStartNotice('started')).toBeUndefined();
    expect(screenShareStartNotice('recovering')).toBeUndefined();
    expect(screenShareStartNotice('cancelled')).toEqual({
      tone: 'warning',
      message: '화면 공유가 시작되지 않았습니다. 다시 시도하려면 화면 공유 버튼을 눌러 주세요.',
    });
    expect(screenShareStartNotice('failed')).toEqual({
      tone: 'error',
      message:
        '화면 공유를 시작하지 못했습니다. 공유할 화면을 선택하고 브라우저 권한을 확인해 주세요.',
    });
  });

  it('keeps independent session, action, participation-grant, and TURN notices', () => {
    expect(
      buildRoomSystemNotices({
        status: 'active',
        sessionError: '세션 오류',
        actionWarning: '작업 안내',
        actionError: '작업 오류',
        participationGrantRefreshWarning: '참여권 경고',
        turnRefreshWarning: 'TURN 경고',
      }),
    ).toEqual([
      { id: 'session-error', tone: 'error', message: '세션 오류' },
      { id: 'action-warning', tone: 'warning', message: '작업 안내' },
      { id: 'action-error', tone: 'error', message: '작업 오류' },
      {
        id: 'participation-grant-refresh',
        tone: 'warning',
        message: '참여권 경고',
      },
      { id: 'turn-refresh', tone: 'warning', message: 'TURN 경고' },
    ]);
  });

  it('keeps startup failures out of non-active system notices', () => {
    expect(
      buildRoomSystemNotices({
        status: 'idle',
        actionError: 'raw startup failure',
        participationGrantRefreshWarning: 'stale participation warning',
        turnRefreshWarning: 'stale TURN warning',
      }),
    ).toEqual([]);
  });

  it('turns a pre-session startup failure into a safe terminal overlay state', () => {
    const terminal = resolveActiveRoomTerminalState({
      snapshotStatus: undefined,
      sessionError: undefined,
      startupError: 'turn-configuration',
    });

    expect(terminal.status).toBe('error');
    expect(terminal.terminalErrorMessage).toContain('통화 연결 정보');
    expect(terminal.terminalErrorMessage).not.toContain('credential request failed');
  });

  it('shows a terminal join error once without the raw exception detail', () => {
    const sessionError = roomErrorMessage({
      code: 'join-failed',
      message: 'WebSocket rejected internal-peer-id with secret diagnostic',
    });
    const terminal = resolveActiveRoomTerminalState({
      snapshotStatus: 'error',
      sessionError,
      startupError: null,
    });

    expect(terminal.terminalErrorMessage).toContain('입장을 완료하지 못했습니다');
    expect(terminal.terminalErrorMessage).not.toContain('WebSocket rejected');
    expect(terminal.terminalErrorMessage).not.toContain('internal-peer-id');
    expect(
      buildRoomSystemNotices({
        status: terminal.status,
        sessionError,
        actionError: 'duplicate raw action error',
      }),
    ).toEqual([]);
  });

  it('never exposes an unexpected chat exception or peer id', () => {
    const message = chatErrorMessage(
      new Error('RTCDataChannel failed for internal-peer-id with secret diagnostic'),
    );

    expect(message).toContain('메시지를 보내지 못했습니다');
    expect(message).not.toContain('RTCDataChannel');
    expect(message).not.toContain('internal-peer-id');
    expect(message).not.toContain('secret diagnostic');
  });

  it('maps typed chat delivery failures without inspecting internal error text', () => {
    expect(chatErrorMessage(new ChatSendError('peer-unavailable', 'arbitrary detail'))).toContain(
      '연결 가능한 참가자',
    );
    expect(chatErrorMessage(new ChatSendError('queue-full', 'arbitrary detail'))).toContain(
      '전송 대기 중인 메시지',
    );
  });

  it('localizes a superseded BATON session without exposing the close reason', () => {
    const message = roomErrorMessage({
      code: 'connection-superseded',
      message: 'Participation session superseded internal-peer-id',
    });

    expect(message).toContain('새 접속으로 대체');
    expect(message).not.toContain('Participation session superseded');
    expect(message).not.toContain('internal-peer-id');
  });

  it('explains an ended local media track with an explicit recovery action', () => {
    const warning = roomWarningMessage({
      code: 'local-media-ended',
      message: 'Local microphone track ended unexpectedly',
    });

    expect(warning).toContain('연결이 종료');
    expect(warning).toContain('장치를 다시 선택');
    expect(warning).toContain('통화를 유지한 채');
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
