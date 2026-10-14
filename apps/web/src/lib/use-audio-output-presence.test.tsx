// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAudioOutputPresence } from './use-audio-output-presence';

describe('선택한 스피커 연결 상태', () => {
  let root: Root;
  let warning: string;
  let outputs: string[];
  const onReconnected = vi.fn();
  const mediaDevices = Object.assign(new EventTarget(), {
    enumerateDevices: vi.fn(async () =>
      outputs.map((deviceId) => ({ deviceId, kind: 'audiooutput' }) as MediaDeviceInfo),
    ),
  });
  function Page({ deviceId }: { deviceId: string }) {
    warning = useAudioOutputPresence(deviceId, onReconnected);
    return null;
  }
  const deviceChange = () =>
    act(async () => {
      mediaDevices.dispatchEvent(new Event('devicechange'));
    });

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('navigator', { mediaDevices });
    outputs = ['headset'];
    onReconnected.mockClear();
    mediaDevices.enumerateDevices.mockClear();
    root = createRoot(document.createElement('div'));
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  it('분리되면 안내하고 같은 장치가 다시 연결될 때만 한 번 다시 적용을 알린다', async () => {
    await act(async () => root.render(<Page deviceId="headset" />));
    expect(warning).toBe('');
    expect(onReconnected).not.toHaveBeenCalled();

    outputs = ['speaker'];
    await deviceChange();
    expect(warning).toContain('선택한 스피커가 연결되어 있지 않습니다.');
    expect(onReconnected).not.toHaveBeenCalled();

    outputs = ['speaker', 'headset'];
    await deviceChange();
    expect(warning).toBe('');
    expect(onReconnected).toHaveBeenCalledOnce();

    await deviceChange();
    expect(onReconnected).toHaveBeenCalledOnce();
  });

  it('시스템 기본 출력은 장치 목록을 조회하지 않는다', async () => {
    await act(async () => root.render(<Page deviceId="" />));
    await deviceChange();
    expect(mediaDevices.enumerateDevices).not.toHaveBeenCalled();
    expect(warning).toBe('');
  });
});
