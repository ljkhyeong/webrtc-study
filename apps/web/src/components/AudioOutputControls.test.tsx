// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioOutputControls } from './AudioOutputControls';
import { startSpeakerTest } from '../lib/speaker-test';

vi.mock('../lib/speaker-test', () => ({ startSpeakerTest: vi.fn() }));

describe('스피커 선택과 확인음', () => {
  let container: HTMLDivElement;
  let root: Root;
  let setSinkId: ReturnType<typeof vi.fn>;
  const props = () => ({
    deviceId: '',
    devices: [{ deviceId: 'speaker-1', kind: 'audiooutput', label: '헤드셋' }] as MediaDeviceInfo[],
    onSelect: vi.fn(),
    onRefresh: vi.fn(),
  });
  const button = (name: string) =>
    [...container.querySelectorAll('button')].find((element) => element.textContent === name)!;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    setSinkId = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', {
      configurable: true,
      value: setSinkId,
    });
    container = document.createElement('div');
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    Reflect.deleteProperty(HTMLMediaElement.prototype, 'setSinkId');
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('출력 적용 버튼을 누른 뒤에만 선택하고 실패하면 기존 선택을 유지한다', async () => {
    const input = props();
    const getUserMedia = vi.fn();
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    act(() => root.render(<AudioOutputControls {...input} />));
    const select = container.querySelector('select')!;
    act(() => {
      select.value = 'speaker-1';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(setSinkId).not.toHaveBeenCalled();
    await act(async () => button('스피커 적용').click());
    expect(setSinkId).toHaveBeenCalledWith('speaker-1');
    expect(input.onSelect).toHaveBeenCalledWith('speaker-1');
    setSinkId.mockRejectedValueOnce(new DOMException('장치 없음', 'NotFoundError'));
    await act(async () => button('스피커 적용').click());
    expect(input.onSelect).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('기존 선택을 유지');
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('명시적 버튼으로 브라우저 선택창을 열고 새 출력 장치를 적용한다', async () => {
    const input = props();
    const selectAudioOutput = vi.fn().mockResolvedValue({ deviceId: 'new-speaker' });
    vi.stubGlobal('navigator', { mediaDevices: { selectAudioOutput } });
    act(() => root.render(<AudioOutputControls {...input} />));
    expect(selectAudioOutput).not.toHaveBeenCalled();
    await act(async () => button('다른 스피커 선택').click());
    expect(selectAudioOutput).toHaveBeenCalledWith({ deviceId: '' });
    expect(setSinkId).toHaveBeenCalledWith('new-speaker');
    expect(input.onSelect).toHaveBeenCalledWith('new-speaker');
  });

  it('미지원 브라우저에는 시스템 설정을 안내하고 확인음은 클릭한 동안만 재생한다', async () => {
    Reflect.deleteProperty(HTMLMediaElement.prototype, 'setSinkId');
    const stop = vi.fn();
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.mocked(startSpeakerTest).mockReturnValue({ stop, finished });
    act(() => root.render(<AudioOutputControls {...props()} />));
    expect(container.textContent).toContain('운영체제의 소리 설정');
    expect(container.querySelector('select')).toBeNull();
    expect(startSpeakerTest).not.toHaveBeenCalled();
    act(() => button('소리 확인').click());
    expect(startSpeakerTest).toHaveBeenCalledWith('');
    act(() => root.render(null));
    expect(stop).toHaveBeenCalledTimes(1);
    await act(async () => finish());
  });
});
