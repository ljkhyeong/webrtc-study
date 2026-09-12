// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTimerNotifications } from './use-timer-notifications';

class TestNotification {
  static permission: NotificationPermission = 'default';
  static requestPermission = vi.fn(async (): Promise<NotificationPermission> => {
    TestNotification.permission = 'granted';
    return 'granted';
  });
  static instances: TestNotification[] = [];
  close = vi.fn();
  onclick: (() => void) | null = null;
  constructor(
    readonly title: string,
    readonly options: NotificationOptions,
  ) {
    TestNotification.instances.push(this);
  }
}

describe('선택형 데스크톱 타이머 알림', () => {
  let root: Root;
  let control: ReturnType<typeof useTimerNotifications>;
  let focused = false;
  function Page() {
    control = useTimerNotifications();
    return null;
  }
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('Notification', TestNotification);
    TestNotification.instances = [];
    TestNotification.permission = 'default';
    TestNotification.requestPermission.mockClear();
    focused = false;
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
    root = createRoot(document.createElement('div'));
    act(() =>
      root.render(
        <StrictMode>
          <Page />
        </StrictMode>,
      ),
    );
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('직접 켠 뒤 다른 창 사용 중에만 알리고 복귀·해제·퇴장 시 닫는다', async () => {
    act(() => control.notify('집중 종료'));
    expect(TestNotification.requestPermission).not.toHaveBeenCalled();
    expect(TestNotification.instances).toHaveLength(0);
    await act(async () => control.toggle());
    expect(control.enabled).toBe(true);
    expect(TestNotification.requestPermission).toHaveBeenCalledOnce();
    focused = true;
    act(() => control.notify('집중 종료'));
    expect(TestNotification.instances).toHaveLength(0);
    focused = false;
    act(() => control.notify('집중 종료'));
    expect(TestNotification.instances[0]?.options.body).toBe('집중 종료');
    focused = true;
    act(() => window.dispatchEvent(new Event('focus')));
    expect(TestNotification.instances[0]?.close).toHaveBeenCalledOnce();
    focused = false;
    act(() => control.notify('휴식 종료'));
    await act(async () => control.toggle());
    expect(TestNotification.instances[1]?.close).toHaveBeenCalledOnce();
    await act(async () => control.toggle());
    act(() => control.notify('집중 종료'));
    act(() => root.render(null));
    expect(TestNotification.instances[2]?.close).toHaveBeenCalledOnce();
  });

  it('차단된 권한을 반복 요청하지 않고 권한 취소와 미지원도 안내한다', async () => {
    TestNotification.permission = 'denied';
    await act(async () => control.toggle());
    expect(control.enabled).toBe(false);
    expect(control.notice).toContain('사이트 설정');
    expect(TestNotification.requestPermission).not.toHaveBeenCalled();
    TestNotification.permission = 'granted';
    await act(async () => control.toggle());
    TestNotification.permission = 'denied';
    act(() => control.notify('집중 종료'));
    expect(control.enabled).toBe(false);
    TestNotification.permission = 'granted';
    await act(async () => control.toggle());
    vi.stubGlobal(
      'Notification',
      class extends TestNotification {
        constructor(title: string, options: NotificationOptions) {
          super(title, options);
          throw new TypeError('ServiceWorkerRegistration.showNotification 필요');
        }
      },
    );
    act(() => control.notify('집중 종료'));
    expect(control.enabled).toBe(false);
    expect(control.notice).toContain('표시하지 못했습니다');
  });

  it('퇴장 뒤 도착한 권한 응답을 무시하고 API가 없으면 선택을 숨긴다', async () => {
    let grant!: (value: NotificationPermission) => void;
    TestNotification.requestPermission.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          grant = resolve;
        }),
    );
    let request!: Promise<void>;
    act(() => {
      request = control.toggle();
    });
    expect(control.pending).toBe(true);
    act(() => root.render(null));
    await act(async () => {
      grant('granted');
      await request;
    });
    expect(TestNotification.instances).toHaveLength(0);
    vi.stubGlobal('Notification', undefined);
    act(() => root.render(<Page />));
    expect(control.supported).toBe(false);
  });
});
