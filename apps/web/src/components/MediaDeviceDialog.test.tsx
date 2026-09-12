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
    audioTrack: null,
    audioEnabled: false,
    videoDeviceId: '',
    outputDeviceId: '',
    onSelectOutput: vi.fn(),
    screenSharing: false,
    videoQualityMode: 'standard' as const,
    onSelectVideoQuality: vi.fn(async () => true),
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

  it('꺼진 마이크와 종료된 통화에서는 입력 표시를 위해 장치를 요청하거나 분석하지 않는다', async () => {
    const AudioContext = vi.fn();
    vi.stubGlobal('AudioContext', AudioContext);
    const track = { stop: vi.fn() } as unknown as MediaStreamTrack;
    const input = props();
    await act(async () => root.render(<MediaDeviceDialog {...input} audioTrack={track} />));
    expect(container.textContent).toContain('마이크가 꺼져 있습니다.');
    await act(async () =>
      root.render(<MediaDeviceDialog {...input} audioTrack={track} audioEnabled active={false} />),
    );
    expect(container.textContent).toContain('마이크가 꺼져 있습니다.');
    expect(AudioContext).not.toHaveBeenCalled();
    expect(mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(track.stop).not.toHaveBeenCalled();
  });

  it('송신 설정은 적용 버튼으로만 바꾸고 실패를 성공으로 표시하지 않는다', async () => {
    const input = props();
    input.onSelectVideoQuality.mockResolvedValue(false);
    await act(async () => root.render(<MediaDeviceDialog {...input} />));
    const select = container.querySelector<HTMLSelectElement>('[aria-label="카메라 전송 품질"]')!;
    act(() => {
      select.value = 'data-saver';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(input.onSelectVideoQuality).not.toHaveBeenCalled();
    const apply = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === '품질 적용',
    )!;
    await act(async () => apply.click());
    expect(input.onSelectVideoQuality).toHaveBeenCalledWith('data-saver');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('일부 참가자');
    expect(mediaDevices.getUserMedia).not.toHaveBeenCalled();
    input.onSelectVideoQuality.mockResolvedValue(true);
    await act(async () => apply.click());
    expect(container.querySelector('[role="status"]')?.textContent).toContain('적용했습니다');
    expect(container.querySelector('[role="alert"]')).toBeNull();
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

  it('목록 조회 실패를 새로고침으로 복구하고 선택 중인 장치·품질을 유지한다', async () => {
    const input = props();
    await act(async () => root.render(<MediaDeviceDialog {...input} />));
    const microphone = container.querySelector('select')!;
    const quality = container.querySelector<HTMLSelectElement>('[aria-label="카메라 전송 품질"]')!;
    const refresh = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === '장치 목록 새로고침',
    )!;
    act(() => {
      microphone.value = 'mic-2';
      microphone.dispatchEvent(new Event('change', { bubbles: true }));
      quality.value = 'data-saver';
      quality.dispatchEvent(new Event('change', { bubbles: true }));
    });
    mediaDevices.enumerateDevices.mockRejectedValueOnce(new Error('목록 조회 실패'));
    await act(async () => refresh.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('장치 목록 새로고침');
    expect(microphone.value).toBe('mic-2');

    let finish!: (devices: Partial<MediaDeviceInfo>[]) => void;
    mediaDevices.enumerateDevices.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    act(() => refresh.click());
    expect(refresh.disabled).toBe(true);
    expect(refresh.textContent).toBe('목록 확인 중');
    act(() => refresh.click());
    expect(mediaDevices.enumerateDevices).toHaveBeenCalledTimes(3);
    await act(async () =>
      finish([
        { deviceId: 'mic-1', kind: 'audioinput', label: '내장 마이크' },
        { deviceId: 'mic-2', kind: 'audioinput', label: '외장 마이크' },
        { deviceId: 'mic-3', kind: 'audioinput', label: '새 마이크' },
      ]),
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(refresh.disabled).toBe(false);
    expect(microphone.textContent).toContain('새 마이크');
    expect(microphone.value).toBe('mic-2');
    expect(quality.value).toBe('data-saver');
    expect(input.onSelect).not.toHaveBeenCalled();
    expect(input.onSelectVideoQuality).not.toHaveBeenCalled();
    expect(input.onClose).not.toHaveBeenCalled();
    expect(mediaDevices.getUserMedia).not.toHaveBeenCalled();
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

  it.each(['audio', 'video'] as const)(
    '%s 실제 장치 변경을 표시하되 적용 전 선택과 실패 후 재시도 값은 유지한다',
    async (kind) => {
      const input = props();
      let deviceId = `${kind}-1`;
      const render = () =>
        root.render(
          <MediaDeviceDialog
            {...input}
            {...(kind === 'audio' ? { audioDeviceId: deviceId } : { videoDeviceId: deviceId })}
          />,
        );
      mediaDevices.enumerateDevices.mockResolvedValue(
        [1, 2, 3].map((index) => ({
          deviceId: `${kind}-${index}`,
          kind: kind === 'audio' ? 'audioinput' : 'videoinput',
          label: `장치 ${index}`,
        })),
      );
      await act(async () => render());
      const row = container.querySelectorAll('.media-device-dialog__input')[
        kind === 'audio' ? 0 : 1
      ]!;
      const select = row.querySelector('select')!;
      const apply = row.querySelector('button')!;
      deviceId = `${kind}-2`;
      await act(async () => render());
      expect(select.value).toBe(deviceId);
      expect(input.onSelect).not.toHaveBeenCalled();
      expect(mediaDevices.getUserMedia).not.toHaveBeenCalled();

      act(() => {
        select.value = `${kind}-3`;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      deviceId = `${kind}-1`;
      await act(async () => render());
      expect(select.value).toBe(`${kind}-3`);
      input.onSelect.mockResolvedValueOnce(false);
      await act(async () => apply.click());
      expect(select.value).toBe(`${kind}-3`);
      input.onSelect.mockImplementationOnce(async () => {
        deviceId = `${kind}-3`;
        render();
        return true;
      });
      await act(async () => apply.click());
      expect(input.onSelect).toHaveBeenLastCalledWith(kind, `${kind}-3`);
      expect(select.value).toBe(deviceId);

      deviceId = `${kind}-2`;
      await act(async () => render());
      expect(select.value).toBe(deviceId);
    },
  );

  it('공유 종료로 복원된 카메라와 외부에서 완료된 품질 변경을 표시한다', async () => {
    const input = props();
    await act(async () => root.render(<MediaDeviceDialog {...input} screenSharing />));
    const camera = container.querySelectorAll<HTMLSelectElement>('select')[1]!;
    const quality = container.querySelector<HTMLSelectElement>('[aria-label="카메라 전송 품질"]')!;
    await act(async () =>
      root.render(
        <MediaDeviceDialog
          {...input}
          videoDeviceId="restored-camera"
          videoQualityMode="data-saver"
        />,
      ),
    );
    expect(camera.value).toBe('restored-camera');
    expect(camera.disabled).toBe(false);
    expect(quality.value).toBe('data-saver');
    act(() => {
      quality.value = 'standard';
      quality.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () =>
      root.render(
        <MediaDeviceDialog
          {...input}
          videoDeviceId="restored-camera"
          videoQualityMode="data-saver"
        />,
      ),
    );
    expect(quality.value).toBe('standard');
    expect(input.onSelectVideoQuality).not.toHaveBeenCalled();
    expect(input.onSelect).not.toHaveBeenCalled();
    expect(mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it.each([
    { phase: 'starting' as const, message: '화면 공유 준비 중', sharingAfter: true },
    { phase: 'stopping' as const, message: '화면 공유 중지 중', sharingAfter: false },
  ])('$phase 동안 입력 교체를 막고 완료 후 기존 선택을 유지한다', async (state) => {
    const input = props();
    const onSelectScreenShareQuality = vi.fn(() => true);
    const render = (screenSharePending: 'starting' | 'stopping' | null, screenSharing = false) =>
      root.render(
        <MediaDeviceDialog
          {...input}
          screenSharing={screenSharing}
          screenSharePending={screenSharePending}
          onSelectScreenShareQuality={onSelectScreenShareQuality}
        />,
      );
    await act(async () => render(null));
    const microphone = container.querySelector<HTMLSelectElement>('select')!;
    act(() => {
      microphone.value = 'mic-2';
      microphone.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => render(state.phase));
    const inputs = container.querySelectorAll<HTMLSelectElement>(
      '.media-device-dialog__input select:not([aria-label])',
    );
    const applyButtons = [...container.querySelectorAll<HTMLButtonElement>('button')].filter(
      (button) => ['마이크 적용', '카메라 적용'].includes(button.textContent ?? ''),
    );
    const shareQuality = container.querySelector<HTMLSelectElement>(
      '.screen-quality-setting select',
    )!;
    expect(inputs).toHaveLength(2);
    for (const select of inputs) expect(select.disabled).toBe(true);
    for (const button of applyButtons) {
      expect(button.disabled).toBe(true);
      act(() => button.click());
    }
    expect(shareQuality.disabled).toBe(true);
    expect(container.textContent).toContain(state.message);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(input.onSelect).not.toHaveBeenCalled();
    expect(onSelectScreenShareQuality).not.toHaveBeenCalled();
    expect(mediaDevices.getUserMedia).not.toHaveBeenCalled();
    const close = container.querySelector<HTMLButtonElement>('[aria-label="장치 설정 닫기"]')!;
    expect(close.disabled).toBe(false);

    await act(async () => render(null, state.sharingAfter));
    expect(microphone.value).toBe('mic-2');
    expect(microphone.disabled).toBe(false);
    expect(applyButtons[0]!.disabled).toBe(false);
    expect(applyButtons[1]!.disabled).toBe(state.sharingAfter);
    expect(shareQuality.disabled).toBe(state.sharingAfter);
    expect(container.textContent).not.toContain(state.message);
    await act(async () => applyButtons[0]!.click());
    expect(input.onSelect).toHaveBeenCalledExactlyOnceWith('audio', 'mic-2');
    expect(container.textContent).toContain('마이크를 변경했습니다.');
  });
});
