// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useScreenWakeLock } from './use-screen-wake-lock';

class TestLock extends EventTarget {
  released = false;
  release = vi.fn(async () => {
    this.released = true;
    this.dispatchEvent(new Event('release'));
  });
}

describe('선택형 화면 켜짐 유지', () => {
  let root: Root;
  let control: ReturnType<typeof useScreenWakeLock>;
  let hidden: boolean;
  let request: ReturnType<typeof vi.fn>;
  function Page({ active = true }: { active?: boolean }) {
    control = useScreenWakeLock(active);
    return <output>{control.status}</output>;
  }
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    hidden = false;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    request = vi.fn();
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request } });
    root = createRoot(document.createElement('div'));
    act(() => root.render(<Page />));
  });
  afterEach(() => {
    act(() => root.unmount());
    Reflect.deleteProperty(navigator, 'wakeLock');
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('직접 켠 뒤에만 적용하고 탭 복귀 시 다시 요청하며 퇴장 때 해제한다', async () => {
    expect(request).not.toHaveBeenCalled();
    const first = new TestLock();
    const second = new TestLock();
    request.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    await act(async () => control.setEnabled(true));
    expect(control.status).toBe('active');
    expect(request).toHaveBeenCalledWith('screen');
    hidden = true;
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(first.release).toHaveBeenCalledOnce();
    expect(control.status).toBe('waiting');
    hidden = false;
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(control.status).toBe('active');
    expect(request).toHaveBeenCalledTimes(2);
    await act(async () => root.render(null));
    expect(second.release).toHaveBeenCalledOnce();
  });

  it('설정을 끈 뒤 도착한 승인을 해제하고 거절·시스템 해제를 적용 중으로 표시하지 않는다', async () => {
    let grant!: (lock: TestLock) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          grant = resolve;
        }),
    );
    await act(async () => control.setEnabled(true));
    expect(control.status).toBe('requesting');
    await act(async () => control.setEnabled(false));
    const late = new TestLock();
    await act(async () => grant(late));
    expect(late.release).toHaveBeenCalledOnce();
    expect(control.status).toBe('off');
    request.mockRejectedValueOnce(new DOMException('절전', 'NotAllowedError'));
    await act(async () => control.setEnabled(true));
    expect(control.status).toBe('error');
    await act(async () => control.setEnabled(false));
    const released = new TestLock();
    request.mockResolvedValueOnce(released);
    await act(async () => control.setEnabled(true));
    await act(async () => released.release());
    expect(control.status).toBe('released');
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('미지원 브라우저에서는 요청하지 않는다', async () => {
    Reflect.deleteProperty(navigator, 'wakeLock');
    act(() => root.render(<Page />));
    expect(control.supported).toBe(false);
    await act(async () => control.setEnabled(true));
    expect(request).not.toHaveBeenCalled();
    expect(control.status).toBe('off');
  });
});
