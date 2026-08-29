// @vitest-environment jsdom

import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { RoomSession, RoomSessionOptions, RoomSessionSnapshot } from '@round/rtc-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rtcCoreMock = vi.hoisted(() => ({
  RoomSession: vi.fn(),
}));

vi.mock('@round/rtc-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@round/rtc-core')>()),
  RoomSession: rtcCoreMock.RoomSession,
}));

import { App } from './App';

const ROOM_ID = 'abcd-efgh-jkmp';
const ROOM_PATH = `/room/${ROOM_ID}`;
const GRANT_ENDPOINT = `/round/rooms/${ROOM_ID}/participation-grant/refresh`;
const TURN_ENDPOINT = `/round/rooms/${ROOM_ID}/turn-credentials`;

function response(status: number, body?: unknown): Response {
  return {
    json: vi.fn(async () => body),
    ok: status >= 200 && status < 300,
    status,
  } as unknown as Response;
}

function authenticatedSession(): Response {
  return response(200, {
    authenticated: true,
    csrfHeaderName: 'X-CSRF-TOKEN',
    csrfToken: 'csrf-token',
  });
}

async function waitForState(assertion: () => void): Promise<void> {
  await act(async () => {
    await vi.waitFor(assertion);
  });
}

function buttonWithText(container: HTMLElement, text: string): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes(text),
    ) ?? null
  );
}

async function enterPrejoin(container: HTMLElement, displayName = '림'): Promise<void> {
  let input: HTMLInputElement | null = null;
  await waitForState(() => {
    input = container.querySelector<HTMLInputElement>('#display-name');
    expect(input).not.toBeNull();
  });
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    valueSetter?.call(input, displayName);
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    buttonWithText(container, '입장 준비')?.click();
  });
  await waitForState(() =>
    expect(container.textContent).toContain('입장 전에 장치를 확인해 주세요.'),
  );
}

function activeRoomSnapshot(): RoomSessionSnapshot {
  return {
    roomId: ROOM_ID,
    status: 'active',
    selfId: 'self',
    selfRole: 'participant',
    canModerateMedia: false,
    screenShareAvailable: false,
    screenSharing: false,
    participants: [],
    localMedia: {
      audioAvailable: false,
      audioEnabled: false,
      videoAvailable: false,
      videoEnabled: false,
      videoSource: 'camera',
    },
    messages: [],
    lastModerationNotice: null,
    warning: null,
    error: null,
  };
}

describe('BATON room entry boundary', () => {
  let container: HTMLDivElement;
  let root: Root | null;
  let getUserMedia: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = null;
    rtcCoreMock.RoomSession.mockReset();
    rtcCoreMock.RoomSession.mockImplementation(function (options: RoomSessionOptions) {
      const snapshot = activeRoomSnapshot();
      return {
        disableParticipantMedia: vi.fn(),
        getLocalStream: () => null,
        getRemoteStream: () => null,
        getSnapshot: () => snapshot,
        join: vi.fn(async () => {
          await options.beforeSignalingConnect?.();
        }),
        leave: vi.fn(async () => {}),
        sendChatMessage: vi.fn(),
        startScreenShare: vi.fn(),
        stopScreenShare: vi.fn(),
        subscribe: vi.fn(() => () => {}),
        toggleAudio: vi.fn(),
        toggleVideo: vi.fn(),
        updateRtcConfiguration: vi.fn(),
      } as unknown as RoomSession;
    });
    window.history.replaceState(null, '', ROOM_PATH);
    const localEntries = new Map<string, string>([['round:display-name', '림']]);
    const sessionEntries = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => localEntries.get(key) ?? null),
      removeItem: vi.fn((key: string) => localEntries.delete(key)),
      setItem: vi.fn((key: string, value: string) => localEntries.set(key, value)),
    });
    vi.stubGlobal('sessionStorage', {
      getItem: vi.fn((key: string) => sessionEntries.get(key) ?? null),
      removeItem: vi.fn((key: string) => sessionEntries.delete(key)),
      setItem: vi.fn((key: string, value: string) => sessionEntries.set(key, value)),
    });
    getUserMedia = vi.fn(async () => {
      throw new DOMException('No fake device', 'NotFoundError');
    });
    vi.stubGlobal('navigator', {
      mediaDevices: {
        addEventListener: vi.fn(),
        enumerateDevices: vi.fn(async () => []),
        getUserMedia,
        removeEventListener: vi.fn(),
      },
    });
    vi.stubEnv('VITE_ROUND_AUTH_MODE', 'baton');
    vi.stubEnv('VITE_SIGNALING_URL', '');
    vi.stubEnv('VITE_TURN_CREDENTIALS_URL', '');
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      value: true,
    });
  });

  afterEach(async () => {
    if (root !== null) {
      await act(async () => {
        root?.unmount();
      });
    }
    container.remove();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('completes session and room authorization before rendering prejoin or requesting media', async () => {
    let resolveGrant!: (value: Response) => void;
    const grantResponse = new Promise<Response>((resolve) => {
      resolveGrant = resolve;
    });
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      if (input === '/api/v1/auth/session') {
        return Promise.resolve(authenticatedSession());
      }
      if (input === GRANT_ENDPOINT) {
        return grantResponse;
      }
      if (input === TURN_ENDPOINT) {
        return Promise.resolve(
          response(200, {
            urls: ['turns:turn.example.test:5349'],
            username: 'round-user',
            credential: 'round-credential',
            expiresAt: 1_800_000_000,
            refreshAfterSeconds: 480,
          }),
        );
      }
      return Promise.reject(new Error(`Unexpected request: ${String(input)}`));
    });
    vi.stubGlobal('fetch', fetcher);

    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
    });

    await waitForState(() =>
      expect(container.textContent).toContain('스터디 참여 권한을 확인하고 있습니다.'),
    );
    expect(container.textContent).not.toContain('입장 전에 장치를 확인해 주세요.');
    expect(buttonWithText(container, '장치 확인')).toBeNull();
    expect(getUserMedia).not.toHaveBeenCalled();

    await act(async () => {
      resolveGrant(
        response(200, {
          expiresAt: 1_800_000_000,
          refreshAfterSeconds: 240,
        }),
      );
    });

    await waitForState(() =>
      expect(container.querySelector<HTMLInputElement>('#display-name')?.value).toBe(''),
    );
    await enterPrejoin(container);
    expect(localStorage.setItem).not.toHaveBeenCalled();

    expect(container.textContent).toContain('입장 전에 장치를 확인해 주세요.');
    expect(getUserMedia).not.toHaveBeenCalled();

    await act(async () => {
      buttonWithText(container, '장치 확인')?.click();
    });

    await waitForState(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    expect(fetcher.mock.invocationCallOrder[1]).toBeLessThan(
      getUserMedia.mock.invocationCallOrder[0]!,
    );

    await act(async () => {
      buttonWithText(container, '미디어 없이 입장')?.click();
    });

    await waitForState(() => expect(rtcCoreMock.RoomSession).toHaveBeenCalledOnce());
    expect(fetcher.mock.calls.filter(([input]) => input === TURN_ENDPOINT)).toHaveLength(1);
    expect(container.textContent).not.toContain('TURN 서버 정보를 받지 못했습니다.');
    expect(container.textContent).not.toContain('스터디 참여 권한을 확인하지 못했습니다.');
    expect(fetcher.mock.calls.filter(([input]) => input === GRANT_ENDPOINT)).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([input]) => input === '/api/v1/auth/session')).toHaveLength(
      1,
    );
  });

  it('keeps the boundary-owned lease manager alive through the StrictMode active-room handoff', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (input === '/api/v1/auth/session') {
        return authenticatedSession();
      }
      if (input === GRANT_ENDPOINT) {
        return response(200, {
          expiresAt: 1_800_000_000,
          refreshAfterSeconds: 240,
        });
      }
      if (input === TURN_ENDPOINT) {
        return response(200, {
          urls: ['turns:turn.example.test:5349'],
          username: 'round-user',
          credential: 'round-credential',
          expiresAt: 1_800_000_000,
          refreshAfterSeconds: 480,
        });
      }
      return Promise.reject(new Error(`Unexpected request: ${String(input)}`));
    });
    vi.stubGlobal('fetch', fetcher);

    await act(async () => {
      root = createRoot(container);
      root.render(
        <StrictMode>
          <App />
        </StrictMode>,
      );
    });
    await enterPrejoin(container);
    expect(container.textContent).toContain('입장 전에 장치를 확인해 주세요.');
    await act(async () => {
      const joinButton = buttonWithText(container, '미디어 없이 입장');
      expect(joinButton).not.toBeNull();
      joinButton?.click();
    });

    await waitForState(() => expect(rtcCoreMock.RoomSession).toHaveBeenCalledOnce());
    const session = rtcCoreMock.RoomSession.mock.results[0]?.value as RoomSession;
    await waitForState(() => expect(session.join).toHaveBeenCalled());
  });

  it('rechecks an expired entry lease before requesting camera or microphone access', async () => {
    let nowMs = 0;
    let grantRequests = 0;
    vi.stubGlobal('performance', { now: () => nowMs });
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (input === '/api/v1/auth/session') {
        return authenticatedSession();
      }
      if (input === GRANT_ENDPOINT) {
        grantRequests += 1;
        return grantRequests === 1
          ? response(200, {
              expiresAt: 1_800_000_000,
              refreshAfterSeconds: 1,
            })
          : response(403, { internal: 'revoked membership' });
      }
      return Promise.reject(new Error(`Unexpected request: ${String(input)}`));
    });
    vi.stubGlobal('fetch', fetcher);

    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
    });
    await enterPrejoin(container);

    nowMs = 1_001;
    await act(async () => {
      buttonWithText(container, '장치 확인')?.click();
    });

    await waitForState(() => {
      expect(grantRequests).toBe(2);
      expect(container.textContent).toContain('이 스터디룸에 참여할 수 없습니다.');
    });
    expect(container.textContent).not.toContain('revoked membership');
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('stops active-room retries and returns to login when a scheduled refresh loses its session', async () => {
    vi.useFakeTimers();
    let grantRequests = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (input === '/api/v1/auth/session') {
        return authenticatedSession();
      }
      if (input === GRANT_ENDPOINT) {
        grantRequests += 1;
        return grantRequests === 1
          ? response(200, {
              expiresAt: 1_800_000_000,
              refreshAfterSeconds: 1,
            })
          : response(401, { internal: 'expired provider detail' });
      }
      if (input === TURN_ENDPOINT) {
        return response(200, {
          urls: ['turns:turn.example.test:5349'],
          username: 'round-user',
          credential: 'round-credential',
          expiresAt: 1_800_000_000,
          refreshAfterSeconds: 480,
        });
      }
      return Promise.reject(new Error(`Unexpected request: ${String(input)}`));
    });
    vi.stubGlobal('fetch', fetcher);

    try {
      await act(async () => {
        root = createRoot(container);
        root.render(<App />);
      });
      await enterPrejoin(container);
      await act(async () => {
        buttonWithText(container, '미디어 없이 입장')?.click();
      });

      await waitForState(() => {
        expect(rtcCoreMock.RoomSession).toHaveBeenCalledOnce();
        expect(grantRequests).toBe(1);
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });

      await waitForState(() => {
        expect(grantRequests).toBe(2);
        expect(container.textContent).toContain('BATON 로그인이 필요합니다.');
      });
      expect(container.textContent).not.toContain('expired provider detail');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(grantRequests).toBe(2);
    } finally {
      if (root !== null) {
        await act(async () => {
          root?.unmount();
          root = null;
        });
      }
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('offers a canonical full-document login return on 401 without exposing credentials', async () => {
    const fetcher = vi.fn(async () => response(200, { authenticated: false }));
    vi.stubGlobal('fetch', fetcher);

    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
    });

    await waitForState(() => expect(container.textContent).toContain('BATON 로그인이 필요합니다.'));
    const loginLink = container.querySelector<HTMLAnchorElement>('a[href^="/login?"]');
    expect(loginLink?.getAttribute('href')).toBe(
      `/login?returnTo=${encodeURIComponent(ROOM_PATH)}`,
    );
    expect(container.textContent).toContain('BATON 로그인이 필요합니다.');
    expect(container.textContent).not.toContain('csrf-token');
    expect(container.textContent).not.toContain('participation grant');
    expect(buttonWithText(container, '장치 확인')).toBeNull();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('returns a forbidden participant to BATON without creating a login loop', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (input === '/api/v1/auth/session') {
        return authenticatedSession();
      }
      return response(403, { internal: 'membership detail' });
    });
    vi.stubGlobal('fetch', fetcher);

    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
    });

    await waitForState(() =>
      expect(container.textContent).toContain('이 스터디룸에 참여할 수 없습니다.'),
    );
    expect(container.textContent).not.toContain('membership detail');
    expect(container.querySelector('a[href^="/login?"]')).toBeNull();
    expect(container.querySelector('a[href="/"]')).not.toBeNull();
    expect(buttonWithText(container, '장치 확인')).toBeNull();
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('treats a missing authoritative room as terminal before prejoin', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (input === '/api/v1/auth/session') {
        return authenticatedSession();
      }
      return response(404, { internal: 'room mapping detail' });
    });
    vi.stubGlobal('fetch', fetcher);

    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
    });

    await waitForState(() =>
      expect(container.textContent).toContain('이 스터디룸을 더 이상 찾을 수 없습니다.'),
    );
    expect(container.textContent).not.toContain('room mapping detail');
    expect(buttonWithText(container, '장치 확인')).toBeNull();
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('does not expose standalone create or join controls at the BATON asset root', async () => {
    window.history.replaceState(null, '', '/round-ui/');
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);

    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
    });

    await waitForState(() =>
      expect(container.textContent).toContain('BATON에서 스터디룸을 열어 주세요.'),
    );
    expect(container.textContent).not.toContain('새 스터디룸 만들기');
    expect(container.textContent).not.toContain('초대 코드로 참가');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
