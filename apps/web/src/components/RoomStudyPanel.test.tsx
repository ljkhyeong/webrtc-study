// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomStudyPanel } from './RoomStudyPanel';
import { createTimerChime } from '../lib/timer-chime';
vi.mock('../lib/timer-chime', () => ({ createTimerChime: vi.fn() }));

describe('타이머 종료 안내', () => {
  let root: Root;
  let container: HTMLDivElement;
  let now = 0;
  const onSync = vi.fn();
  const state = {
    revision: 1,
    topic: '',
    mode: 'focus' as const,
    durationSeconds: 60,
    remainingMs: 2000,
    running: true,
    sampledAt: 0,
  };
  const render = (changes = {}) =>
    act(() =>
      root.render(
        <RoomStudyPanel
          state={{ ...state, ...changes }}
          active
          canControl={false}
          pending={false}
          notice={null}
          onCommand={() => true}
          onSync={onSync}
        />,
      ),
    );
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    now = 0;
    onSync.mockClear();
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    document.title = 'ROUND';
    container = document.createElement('div');
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('종료를 한 번 알리고 시간 보정·이미 끝난 타이머 조회에는 다시 알리지 않는다', () => {
    render({ remainingMs: 0, running: false });
    expect(container.querySelector('.room-study-completion')).toBeNull();
    render();
    now = 2000;
    act(() => vi.advanceTimersByTime(2000));
    expect(container.querySelector('.room-study-completion')).toBeNull();
    expect(onSync).toHaveBeenCalledOnce();
    render({ remainingMs: 0, running: false, sampledAt: now });
    expect(container.querySelector('.room-study-completion')?.textContent).toContain(
      '집중 시간이 끝났습니다',
    );
    expect(document.title).toContain('집중 시간이 끝났습니다');
    act(() => container.querySelector<HTMLButtonElement>('.room-study-completion button')!.click());
    render({ remainingMs: 2000, sampledAt: 2000 });
    now = 4000;
    act(() => vi.advanceTimersByTime(2000));
    render({ remainingMs: 0, running: false, sampledAt: now });
    expect(container.querySelector('.room-study-completion')).toBeNull();
    expect(document.title).toBe('ROUND');
    expect(createTimerChime).not.toHaveBeenCalled();
  });

  it('사용자가 켠 알림음만 재생하고 퇴장할 때 오디오 자원을 닫는다', async () => {
    const chime = { ready: Promise.resolve(), play: vi.fn(() => true), close: vi.fn() };
    vi.mocked(createTimerChime).mockReturnValue(chime);
    render();
    await act(async () =>
      container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
    );
    now = 2000;
    act(() => vi.advanceTimersByTime(2000));
    render({ running: false, remainingMs: 0, sampledAt: now });
    expect(chime.play).toHaveBeenCalledOnce();
    act(() => root.render(null));
    expect(chime.close).toHaveBeenCalledOnce();
    expect(document.title).toBe('ROUND');
  });
});
