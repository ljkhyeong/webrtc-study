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
  const onCommand = vi.fn(() => true);
  const state = {
    revision: 1,
    topic: '',
    mode: 'focus' as const,
    durationSeconds: 60,
    remainingMs: 2000,
    running: true,
    sampledAt: 0,
  };
  const render = (changes = {}, canControl = false) =>
    act(() =>
      root.render(
        <RoomStudyPanel
          state={{ ...state, ...changes }}
          active
          canControl={canControl}
          hostPresent
          pending={false}
          notice={null}
          onCommand={onCommand}
          onSync={onSync}
        />,
      ),
    );
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    now = 0;
    onSync.mockClear();
    onCommand.mockClear();
    HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function () {
      this.open = false;
    };
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    document.title = 'ROUND';
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
    Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
  });

  it('종료를 한 번 알리고 시간 보정·이미 끝난 타이머 조회에는 다시 알리지 않는다', () => {
    render({ remainingMs: 0, running: false });
    expect(container.querySelector('.room-study-completion')).toBeNull();
    expect(container.querySelector('.room-study summary')?.textContent).toContain('완료');
    render();
    now = 2000;
    act(() => vi.advanceTimersByTime(2000));
    expect(container.querySelector('.room-study-completion')).toBeNull();
    expect(container.querySelector('.room-study summary')?.textContent).toContain('종료 확인 중');
    expect(container.querySelector('.room-study summary')?.textContent).not.toContain('완료');
    expect(onSync).toHaveBeenCalledOnce();
    render({ remainingMs: 0, running: false, sampledAt: now });
    expect(container.querySelector('.room-study summary')?.textContent).toContain('완료');
    expect(container.querySelector('.room-study summary')?.textContent).not.toContain(
      '종료 확인 중',
    );
    expect(container.querySelector('.room-study-completion')?.textContent).toContain(
      '집중 시간이 끝났습니다',
    );
    expect(document.title).toContain('집중 시간이 끝났습니다');
    act(() => container.querySelector<HTMLButtonElement>('.room-study-completion button')!.click());
    render({ remainingMs: 2000, sampledAt: 2000 });
    expect(container.querySelector('.room-study summary')?.textContent).toContain('진행 중');
    now = 4000;
    act(() => vi.advanceTimersByTime(2000));
    render({ remainingMs: 0, running: false, sampledAt: now });
    expect(container.querySelector('.room-study-completion')).toBeNull();
    expect(document.title).toBe('ROUND');
    expect(createTimerChime).not.toHaveBeenCalled();
  });

  it('방장은 종료 안내에서 다음 휴식·집중을 바로 시작하고 일반 참가자는 확인만 한다', () => {
    const button = (text: string) =>
      [...container.querySelectorAll('.room-study-completion button')].find(
        (element) => element.textContent === text,
      ) as HTMLButtonElement | undefined;
    const finish = (changes: object, canControl: boolean) => {
      render({ ...changes, running: true, remainingMs: 2000, sampledAt: now }, canControl);
      now += 2000;
      act(() => vi.advanceTimersByTime(2000));
      render({ ...changes, running: false, remainingMs: 0, sampledAt: now }, canControl);
    };

    finish({}, false);
    expect(container.querySelector('.room-study-completion')).not.toBeNull();
    expect(button('휴식 5분 시작')).toBeUndefined();
    act(() => button('확인')!.click());

    finish({ revision: 2 }, true);
    onCommand.mockReturnValueOnce(false);
    act(() => button('휴식 5분 시작')!.click());
    expect(container.querySelector('.room-study-completion [role="alert"]')?.textContent).toContain(
      '타이머나 주제를 변경하지 못했습니다',
    );
    act(() => button('휴식 5분 시작')!.click());
    expect(onCommand).toHaveBeenLastCalledWith({
      action: 'start',
      mode: 'break',
      durationSeconds: 300,
    });
    expect(container.querySelector('.room-study-completion')).toBeNull();

    finish({ revision: 3, mode: 'break', durationSeconds: 300 }, true);
    act(() => button('집중 1분 시작')!.click());
    expect(onCommand).toHaveBeenLastCalledWith({
      action: 'start',
      mode: 'focus',
      durationSeconds: 60,
    });
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

  it('서버가 확정한 종료만 한 번 데스크톱에 알리고 이미 끝난 타이머는 알리지 않는다', async () => {
    const shown = vi.fn();
    const close = vi.fn();
    vi.stubGlobal(
      'Notification',
      class {
        static permission = 'granted';
        close = close;
        constructor(title: string, options: NotificationOptions) {
          shown(title, options);
        }
      },
    );
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    render({ remainingMs: 0, running: false });
    const toggle = () =>
      container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!.click();
    await act(async () => toggle());
    expect(shown).not.toHaveBeenCalled();
    render();
    now = 2000;
    act(() => vi.advanceTimersByTime(2000));
    expect(shown).not.toHaveBeenCalled();
    expect(onSync).toHaveBeenCalledOnce();
    render({ running: false, remainingMs: 0, sampledAt: now });
    expect(shown).toHaveBeenCalledWith('ROUND 타이머', { body: '집중 시간이 끝났습니다' });
    render({ running: false, remainingMs: 0, sampledAt: now });
    expect(shown).toHaveBeenCalledOnce();
    render({ revision: 2, remainingMs: 60_000, sampledAt: now });
    expect(close).toHaveBeenCalledOnce();
  });

  it('진행 중 교체·초기화를 확인하고 취소하면 명령을 보내지 않으며 승인한 개정으로 한 번 변경한다', () => {
    const button = (text: string) =>
      [...container.querySelectorAll('button')].find((el) => el.textContent === text)!;
    render({ remainingMs: 40_000 }, true);
    act(() => button('초기화').click());
    expect(onCommand).not.toHaveBeenCalled();
    expect(container.querySelector('dialog')?.textContent).toContain('0분 40초');
    now = 1000;
    act(() => vi.advanceTimersByTime(1000));
    expect(container.querySelector('dialog')?.textContent).toContain('0분 39초');
    act(() => button('기존 타이머 유지').click());
    expect(onCommand).not.toHaveBeenCalled();
    act(() => button('새 타이머 시작').click());
    const confirm = button('타이머 변경');
    act(() => {
      confirm.click();
      confirm.click();
    });
    expect(onCommand).toHaveBeenCalledOnce();
    expect(onCommand).toHaveBeenCalledWith(
      { action: 'start', mode: 'focus', durationSeconds: 1500 },
      1,
    );
    expect(container.querySelector('dialog')).toBeNull();
  });

  it('설정 창은 Esc와 바깥 누르기로 닫고 변경 확인을 취소하면 누른 버튼으로 초점을 돌려준다', () => {
    render({ remainingMs: 40_000 }, true);
    const panel = container.querySelector<HTMLDetailsElement>('.room-study')!;
    const summary = panel.querySelector('summary')!;
    const topic = panel.querySelector<HTMLInputElement>('input[placeholder="예: 3장 코드 리뷰"]')!;
    const escape = (target: Element, isComposing = false) =>
      act(() => {
        target.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', isComposing, bubbles: true }),
        );
      });
    const pointerDown = (target: EventTarget) =>
      act(() => {
        target.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      });

    panel.open = true;
    topic.focus();
    escape(topic, true);
    expect(panel.open).toBe(true);
    escape(topic);
    expect(panel.open).toBe(false);
    expect(document.activeElement).toBe(summary);

    panel.open = true;
    pointerDown(topic);
    expect(panel.open).toBe(true);
    pointerDown(document.body);
    expect(panel.open).toBe(false);

    panel.open = true;
    const reset = [...panel.querySelectorAll('button')].find((el) => el.textContent === '초기화')!;
    reset.focus();
    act(() => reset.click());
    const dialog = container.querySelector('dialog')!;
    pointerDown(dialog);
    expect(panel.open).toBe(true);
    const keep = [...dialog.querySelectorAll('button')].find(
      (el) => el.textContent === '기존 타이머 유지',
    )!;
    keep.focus();
    act(() => keep.click());
    expect(container.querySelector('dialog')).toBeNull();
    expect(document.activeElement).toBe(reset);
    expect(onCommand).not.toHaveBeenCalled();
  });

  it('일시정지한 진행 시간도 보호하고 확인 중 다른 변경이 오면 취소하며 첫 시작은 바로 적용한다', () => {
    const reset = () =>
      [...container.querySelectorAll('button')].find((el) => el.textContent === '초기화')!;
    render({ running: false, remainingMs: 30_000 }, true);
    act(() => reset().click());
    expect(container.querySelector('dialog')).not.toBeNull();
    render({ revision: 2, running: false, remainingMs: 30_000 }, true);
    expect(container.querySelector('dialog')).toBeNull();
    expect(container.textContent).toContain('최신 시간을 확인');
    expect(onCommand).not.toHaveBeenCalled();
    render({ revision: 3, running: false, remainingMs: 60_000 }, true);
    act(() => reset().click());
    expect(container.querySelector('dialog')).toBeNull();
    expect(onCommand).toHaveBeenCalledWith({ action: 'reset' }, undefined);
  });
});
