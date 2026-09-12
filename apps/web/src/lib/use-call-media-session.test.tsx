// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCallMediaSession } from './use-call-media-session';

describe('작은 창 통화 제어', () => {
  let root: Root;
  const handlers = new Map<string, ((details: { isActivating?: boolean }) => void) | null>();
  const session = {
    setActionHandler: vi.fn(
      (action: string, handler: ((details: { isActivating?: boolean }) => void) | null) => {
        handlers.set(action, handler);
      },
    ),
    setMicrophoneActive: vi.fn(),
    setCameraActive: vi.fn(),
  };
  const defaults = {
    active: true,
    audioAvailable: true,
    audioEnabled: true,
    cameraAvailable: true,
    cameraEnabled: true,
    onToggleAudio: vi.fn(),
    onToggleVideo: vi.fn(),
  };
  function Page(props: Partial<typeof defaults>) {
    useCallMediaSession({ ...defaults, ...props });
    return null;
  }
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.clearAllMocks();
    handlers.clear();
    Object.defineProperty(navigator, 'mediaSession', { configurable: true, value: session });
    root = createRoot(document.createElement('div'));
  });
  afterEach(() => {
    act(() => root.unmount());
    Reflect.deleteProperty(navigator, 'mediaSession');
    vi.unstubAllGlobals();
  });

  it('기존 제어를 호출하고 최신 상태·브라우저의 명시적 켜기 요청을 반영한다', () => {
    act(() => root.render(<Page />));
    const microphone = handlers.get('togglemicrophone')!;
    act(() => microphone({}));
    expect(defaults.onToggleAudio).toHaveBeenCalledOnce();
    const latestToggle = vi.fn();
    act(() => root.render(<Page audioEnabled={false} onToggleAudio={latestToggle} />));
    expect(session.setMicrophoneActive).toHaveBeenLastCalledWith(false);
    act(() => microphone({ isActivating: false }));
    expect(latestToggle).not.toHaveBeenCalled();
    act(() => microphone({ isActivating: true }));
    expect(latestToggle).toHaveBeenCalledOnce();
    expect(handlers.get('togglemicrophone')).toBe(microphone);
    act(() => handlers.get('togglecamera')!({}));
    expect(defaults.onToggleVideo).toHaveBeenCalledOnce();
  });

  it('화면 공유·장치 없음·재연결 동안 제어를 해제하고 퇴장 뒤 이전 액션을 무시한다', () => {
    act(() => root.render(<Page />));
    const camera = handlers.get('togglecamera')!;
    act(() => root.render(<Page cameraAvailable={false} />));
    expect(handlers.get('togglecamera')).toBeNull();
    expect(session.setCameraActive).toHaveBeenLastCalledWith(false);
    act(() => camera({}));
    expect(defaults.onToggleVideo).not.toHaveBeenCalled();
    act(() => root.render(<Page active={false} />));
    expect(handlers.get('togglemicrophone')).toBeNull();
    act(() => root.render(<Page audioAvailable={false} />));
    expect(handlers.get('togglemicrophone')).toBeNull();
    const restoredCamera = handlers.get('togglecamera')!;
    act(() => root.render(null));
    act(() => restoredCamera({}));
    expect(defaults.onToggleVideo).not.toHaveBeenCalled();
    expect(handlers.get('togglecamera')).toBeNull();
  });

  it('일부 액션·상태 API가 미지원이거나 비동기로 거부돼도 통화 화면을 유지한다', async () => {
    session.setActionHandler.mockImplementationOnce(() => {
      throw new DOMException('미지원', 'NotSupportedError');
    });
    session.setMicrophoneActive.mockRejectedValueOnce(new Error('거부'));
    session.setCameraActive.mockImplementationOnce(() => {
      throw new Error('미지원');
    });
    await act(async () => root.render(<Page />));
    expect(handlers.get('togglecamera')).toBeTypeOf('function');
    act(() => root.render(null));
    Reflect.deleteProperty(navigator, 'mediaSession');
    expect(() => act(() => root.render(<Page />))).not.toThrow();
  });
});
