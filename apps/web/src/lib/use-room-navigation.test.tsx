// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRoomNavigation } from './use-room-navigation';

describe('방을 유지하는 브라우저 이동', () => {
  let root: Root;
  let container: HTMLDivElement;
  let navigation: ReturnType<typeof useRoomNavigation>;
  function Page() {
    navigation = useRoomNavigation();
    return <output>{navigation.pathname}</output>;
  }
  const waitForPath = async (path: string) => {
    await act(async () => {
      await vi.waitFor(() => expect(window.location.pathname).toBe(path));
    });
  };
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    window.history.replaceState({ previousState: '보존' }, '', '/');
    container = document.createElement('div');
    root = createRoot(container);
    act(() => root.render(<Page />));
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  it('뒤로가기 확인 중 경로를 유지하고 취소 뒤 다시 승인하면 한 번 이동한다', async () => {
    act(() => navigation.navigate('/room/first'));
    act(() => navigation.navigate('/room/current'));
    let decide!: (accepted: boolean) => void;
    const guard = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          decide = resolve;
        }),
    );
    navigation.registerLeaveGuard(guard);
    window.history.back();
    await act(async () => {
      await vi.waitFor(() => expect(guard).toHaveBeenCalledOnce());
    });
    await waitForPath('/room/current');
    expect(container.textContent).toBe('/room/current');
    // 확인 중 추가 이동도 같은 확인 결과를 기다린다.
    window.history.go(-2);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    await waitForPath('/room/current');
    expect(guard).toHaveBeenCalledOnce();
    await act(async () => decide(false));
    expect(container.textContent).toBe('/room/current');
    window.history.back();
    await act(async () => {
      await vi.waitFor(() => expect(guard).toHaveBeenCalledTimes(2));
    });
    await act(async () => decide(true));
    await waitForPath('/room/first');
    expect(container.textContent).toBe('/room/first');
    expect(guard).toHaveBeenCalledTimes(2);
    navigation.registerLeaveGuard(null);
    window.history.forward();
    await waitForPath('/room/current');
    expect(container.textContent).toBe('/room/current');
    expect(window.history.state.previousState).toBe('보존');
  });

  it('보호할 내용이 없는 이동과 직접 초대의 첫 화면을 그대로 처리한다', async () => {
    act(() => navigation.navigate('/room/invite', true));
    expect(container.textContent).toBe('/room/invite');
    act(() => navigation.navigate('/'));
    navigation.registerLeaveGuard(() => true);
    window.history.back();
    await waitForPath('/room/invite');
    expect(container.textContent).toBe('/room/invite');
  });
});
