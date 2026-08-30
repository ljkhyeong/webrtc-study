// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaDeviceDialog } from './MediaDeviceDialog';

describe('통화 장치 설정', () => {
  let root: Root;
  let container: HTMLDivElement;
  let mediaDevices: EventTarget & {
    enumerateDevices: ReturnType<typeof vi.fn>;
    getUserMedia: ReturnType<typeof vi.fn>;
  };
  const props = () => ({
    audioDeviceId: 'mic-1',
    videoDeviceId: '',
    outputDeviceId: '',
    onSelectOutput: vi.fn(),
    screenSharing: false,
    active: true,
    onSelect: vi.fn(async () => true),
    onClose: vi.fn(),
  });

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    HTMLDialogElement.prototype.showModal = vi.fn();
    HTMLDialogElement.prototype.close = vi.fn();
    mediaDevices = Object.assign(new EventTarget(), {
      enumerateDevices: vi.fn(async () => [
        { deviceId: 'mic-1', kind: 'audioinput', label: '내장 마이크' },
        { deviceId: 'mic-2', kind: 'audioinput', label: '외장 마이크' },
      ]),
      getUserMedia: vi.fn(),
    });
    vi.stubGlobal('navigator', { mediaDevices });
    container = document.createElement('div');
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
    Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('설정을 열거나 목록을 변경할 때는 장치를 요청하지 않고 적용 버튼으로만 교체한다', async () => {
    const input = props();
    await act(async () => root.render(<MediaDeviceDialog {...input} />));
    expect(mediaDevices.getUserMedia).not.toHaveBeenCalled();
    const microphone = container.querySelector('select')!;
    act(() => {
      microphone.value = 'mic-2';
      microphone.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(input.onSelect).not.toHaveBeenCalled();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('.media-device-dialog__input button')!.click(),
    );
    expect(input.onSelect).toHaveBeenCalledWith('audio', 'mic-2');
    expect(container.textContent).toContain('마이크를 변경했습니다.');
    await act(async () => mediaDevices.dispatchEvent(new Event('devicechange')));
    expect(mediaDevices.enumerateDevices).toHaveBeenCalledTimes(3);
  });

  it('교체 실패를 안내하고 화면 공유 중에는 카메라 적용을 막는다', async () => {
    const input = props();
    input.onSelect.mockResolvedValue(false);
    await act(async () => root.render(<MediaDeviceDialog {...input} screenSharing />));
    const buttons = container.querySelectorAll<HTMLButtonElement>(
      '.media-device-dialog__input button',
    );
    expect(buttons[1]!.disabled).toBe(true);
    await act(async () => buttons[0]!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      '기존 통화는 유지됩니다.',
    );
    expect(input.onClose).not.toHaveBeenCalled();
  });
});
