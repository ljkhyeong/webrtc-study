// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { RoomSession, RoomSessionOptions, RoomSessionSnapshot } from '@round/rtc-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rtcCoreMock = vi.hoisted(() => ({
  createRoomSession: vi.fn(),
}));

vi.mock('@round/rtc-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@round/rtc-core')>()),
  createRoomSession: rtcCoreMock.createRoomSession,
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
    accountId: '11111111-1111-4111-8111-111111111111',
    csrfHeaderName: 'X-CSRF-TOKEN',
    csrfToken: 'csrf-token',
  });
}

async function flushMicrotasks(rounds = 16): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
  }
}

function buttonWithText(container: HTMLElement, text: string): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes(text),
    ) ?? null
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
    rtcCoreMock.createRoomSession.mockReset();
    rtcCoreMock.createRoomSession.mockImplementation((options: RoomSessionOptions) => {
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
        await flushMicrotasks();
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
      await flushMicrotasks();
    });

    expect(container.textContent).toContain('스터디 참여 권한을 확인하고 있습니다.');
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
      await flushMicrotasks();
    });

    const prepareButton = buttonWithText(container, '입장 준비');
    expect(prepareButton).not.toBeNull();
    await act(async () => {
      prepareButton?.click();
      await flushMicrotasks();
    });

    expect(container.textContent).toContain('입장 전에 장치를 확인해 주세요.');
    expect(getUserMedia).not.toHaveBeenCalled();

    await act(async () => {
      buttonWithText(container, '장치 확인')?.click();
      await flushMicrotasks(24);
    });

    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.invocationCallOrder[1]).toBeLessThan(
      getUserMedia.mock.invocationCallOrder[0]!,
    );

    await act(async () => {
      buttonWithText(container, '미디어 없이 입장')?.click();
      await flushMicrotasks(32);
    });

    expect(rtcCoreMock.createRoomSession).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls.filter(([input]) => input === GRANT_ENDPOINT)).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([input]) => input === '/api/v1/auth/session')).toHaveLength(
      1,
    );
  });

  it('offers a canonical full-document login return on 401 without exposing credentials', async () => {
    const fetcher = vi.fn(async () => response(200, { authenticated: false }));
    vi.stubGlobal('fetch', fetcher);

    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
      await flushMicrotasks();
    });

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
      await flushMicrotasks();
    });

    expect(container.textContent).toContain('이 스터디룸에 참여할 수 없습니다.');
    expect(container.textContent).not.toContain('membership detail');
    expect(container.querySelector('a[href^="/login?"]')).toBeNull();
    expect(container.querySelector('a[href="/"]')).not.toBeNull();
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
      await flushMicrotasks();
    });

    expect(container.textContent).toContain('BATON에서 스터디룸을 열어 주세요.');
    expect(container.textContent).not.toContain('새 스터디룸 만들기');
    expect(container.textContent).not.toContain('초대 코드로 참가');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
