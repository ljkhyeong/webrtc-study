// @vitest-environment jsdom

import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  RoomSession,
  RoomSessionListener,
  RoomSessionOptions,
  RoomSessionSnapshot,
} from '@round/rtc-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ParticipationGrantLeaseManager } from './lib/participation-grant';
import { RoomRefreshLifetime, type RoomRefreshTimer } from './lib/room-refresh-lifetime';

const rtcCoreMock = vi.hoisted(() => ({
  createRoomSession: vi.fn(),
}));

vi.mock('@round/rtc-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@round/rtc-core')>()),
  createRoomSession: rtcCoreMock.createRoomSession,
}));

vi.mock('./components/RoomView', () => ({
  RoomView: ({ status }: { readonly status: string }) => (
    <output data-testid="room-status">{status}</output>
  ),
}));

import { ActiveRoom } from './App';

const ROOM_ID = 'abcd-efgh-jkmp';
const GRANT_ENDPOINT = `/round/rooms/${ROOM_ID}/participation-grant/refresh`;
const TURN_ENDPOINT = `/round/rooms/${ROOM_ID}/turn-credentials`;

function roomSnapshot(
  status: RoomSessionSnapshot['status'],
  error: RoomSessionSnapshot['error'] = null,
): RoomSessionSnapshot {
  return {
    roomId: ROOM_ID,
    status,
    selfId: status === 'active' ? 'self' : null,
    selfRole: status === 'active' ? 'participant' : null,
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
    error,
  };
}

function jsonResponse(payload: unknown): Response {
  return {
    json: async () => payload,
    ok: true,
    status: 200,
  } as Response;
}

function pendingUntilAborted(signal: AbortSignal): Promise<Response> {
  return new Promise((_, reject) => {
    const rejectAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) {
      rejectAbort();
      return;
    }
    signal.addEventListener('abort', rejectAbort, { once: true });
  });
}

async function flushMicrotasks(rounds = 12): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
  }
}

describe('ActiveRoom mounted lifecycle', () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = null;
    rtcCoreMock.createRoomSession.mockReset();
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

  it('keeps the latest grant guard through StrictMode and stops BATON work on a 4002 snapshot', async () => {
    let monotonicNow = 0;
    vi.spyOn(globalThis.performance, 'now').mockImplementation(() => monotonicNow);

    const scheduledCallbacks = new Map<RoomRefreshLifetime, Map<RoomRefreshTimer, () => void>>();
    vi.spyOn(RoomRefreshLifetime.prototype, 'schedule').mockImplementation(function (
      this: RoomRefreshLifetime,
      timer: RoomRefreshTimer,
      callback: () => void,
    ) {
      const callbacks = scheduledCallbacks.get(this) ?? new Map();
      callbacks.set(timer, callback);
      scheduledCallbacks.set(this, callbacks);
    });
    const stopSpy = vi.spyOn(RoomRefreshLifetime.prototype, 'stop');
    const ensureFreshSpy = vi.spyOn(ParticipationGrantLeaseManager.prototype, 'ensureFresh');
    const closeSpy = vi.spyOn(ParticipationGrantLeaseManager.prototype, 'close');

    let holdGrantRefresh = false;
    let holdTurnRefresh = false;
    const pendingSignals: {
      grant: AbortSignal | null;
      turn: AbortSignal | null;
    } = {
      grant: null,
      turn: null,
    };
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const endpoint =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (endpoint === '/api/v1/auth/session') {
        return Promise.resolve(
          jsonResponse({
            authenticated: true,
            accountId: '00000000-0000-4000-8000-000000000001',
            csrfHeaderName: 'X-CSRF-TOKEN',
            csrfToken: 'csrf-token',
          }),
        );
      }
      if (endpoint === GRANT_ENDPOINT) {
        if (holdGrantRefresh) {
          pendingSignals.grant = init?.signal ?? null;
          if (pendingSignals.grant === null) {
            throw new Error('Expected participation-grant refresh to be abortable');
          }
          return pendingUntilAborted(pendingSignals.grant);
        }
        return Promise.resolve(
          jsonResponse({
            expiresAt: 4_000_000_000,
            refreshAfterSeconds: 1,
          }),
        );
      }
      if (endpoint === TURN_ENDPOINT) {
        if (holdTurnRefresh) {
          pendingSignals.turn = init?.signal ?? null;
          if (pendingSignals.turn === null) {
            throw new Error('Expected TURN refresh to be abortable');
          }
          return pendingUntilAborted(pendingSignals.turn);
        }
        return Promise.resolve(
          jsonResponse({
            urls: ['turns:turn.example.test:5349'],
            username: 'round-user',
            credential: 'round-credential',
            expiresAt: 4_000_000_000,
            refreshAfterSeconds: 480,
          }),
        );
      }
      return Promise.reject(new Error(`Unexpected request: ${endpoint}`));
    });
    vi.stubGlobal('fetch', fetcher);

    let currentSnapshot = roomSnapshot('active');
    const listeners = new Set<RoomSessionListener>();
    const sessionState: { options: RoomSessionOptions | null } = { options: null };
    let joinPromise: Promise<void> | null = null;
    const session = {
      getSnapshot: () => currentSnapshot,
      getLocalStream: () => null,
      getRemoteStream: () => null,
      join: vi.fn(() => {
        joinPromise ??= Promise.resolve(sessionState.options?.beforeSignalingConnect?.()).then(
          () => undefined,
        );
        return joinPromise;
      }),
      leave: vi.fn(async () => {}),
      subscribe: vi.fn((listener: RoomSessionListener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
      updateRtcConfiguration: vi.fn(),
    } as unknown as RoomSession;
    rtcCoreMock.createRoomSession.mockImplementation((options: RoomSessionOptions) => {
      sessionState.options = options;
      return session;
    });

    await act(async () => {
      root = createRoot(container);
      root.render(
        <StrictMode>
          <ActiveRoom
            displayName="Rim"
            roomId={ROOM_ID}
            releasePreparedMediaStream={vi.fn()}
            takePreparedMediaStream={() => null}
            onReconnect={vi.fn()}
            onLeave={vi.fn()}
          />
        </StrictMode>,
      );
      await flushMicrotasks(24);
    });

    expect(rtcCoreMock.createRoomSession).toHaveBeenCalledTimes(1);
    const mountedSessionOptions = sessionState.options;
    if (mountedSessionOptions === null) {
      throw new Error('Expected StrictMode handoff to create one room session');
    }
    expect(mountedSessionOptions.beforeSignalingConnect).toBeTypeOf('function');
    expect(container.querySelector('[data-testid="room-status"]')?.textContent).toBe('active');

    const activeManager = ensureFreshSpy.mock.instances.at(-1);
    expect(activeManager).toBeInstanceOf(ParticipationGrantLeaseManager);
    const ensureFreshCallsBeforeHandoffCheck = ensureFreshSpy.mock.calls.length;
    monotonicNow = 500;
    await act(async () => {
      await mountedSessionOptions.beforeSignalingConnect?.();
      await flushMicrotasks();
    });

    expect(ensureFreshSpy).toHaveBeenCalledTimes(ensureFreshCallsBeforeHandoffCheck + 1);
    expect(ensureFreshSpy.mock.instances.at(-1)).toBe(activeManager);

    const activeSchedule = [...scheduledCallbacks.entries()].find(
      ([lifetime, callbacks]) =>
        lifetime.isActive() && callbacks.has('participation-grant') && callbacks.has('turn'),
    );
    expect(activeSchedule).toBeDefined();
    const [activeLifetime, activeCallbacks] = activeSchedule!;

    holdTurnRefresh = true;
    await act(async () => {
      activeCallbacks.get('turn')?.();
      await flushMicrotasks();
    });
    const turnRefreshSignal = pendingSignals.turn;
    if (turnRefreshSignal === null) {
      throw new Error('Expected a TURN refresh request to remain in flight');
    }
    expect(turnRefreshSignal.aborted).toBe(false);

    monotonicNow = 2_000;
    holdGrantRefresh = true;
    await act(async () => {
      activeCallbacks.get('participation-grant')?.();
      await flushMicrotasks();
    });
    const grantRefreshSignal = pendingSignals.grant;
    if (grantRefreshSignal === null) {
      throw new Error('Expected a participation-grant refresh request to remain in flight');
    }
    expect(grantRefreshSignal.aborted).toBe(false);

    const stopCallsBeforeTerminalSnapshot = stopSpy.mock.calls.length;
    const closeCallsBeforeTerminalSnapshot = closeSpy.mock.calls.length;
    // RoomSession translates signaling close code 4002 into this terminal snapshot.
    currentSnapshot = roomSnapshot('error', {
      code: 'connection-superseded',
      message: 'Participation session superseded',
    });

    await act(async () => {
      for (const listener of listeners) {
        listener(currentSnapshot);
      }
      await flushMicrotasks(24);
    });

    expect(container.querySelector('[data-testid="room-status"]')?.textContent).toBe('error');
    expect(stopSpy).toHaveBeenCalledTimes(stopCallsBeforeTerminalSnapshot + 1);
    expect(closeSpy).toHaveBeenCalledTimes(closeCallsBeforeTerminalSnapshot + 1);
    expect(activeLifetime.isActive()).toBe(false);
    expect(grantRefreshSignal.aborted).toBe(true);
    expect(turnRefreshSignal.aborted).toBe(true);
  });
});
