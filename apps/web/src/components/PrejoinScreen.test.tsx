import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PrejoinScreen } from './PrejoinScreen';

describe('PrejoinScreen', () => {
  it('requires a separate device-check action and offers a media-less join', () => {
    const getUserMedia = vi.fn();
    const webSocket = vi.fn();
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia,
        enumerateDevices: vi.fn(),
      },
    });
    vi.stubGlobal('WebSocket', webSocket);

    try {
      const markup = renderToStaticMarkup(
        <PrejoinScreen
          displayName="림"
          roomId="abcd-efgh-jkmp"
          showHostCapabilityInput
          onBack={vi.fn()}
          onJoin={vi.fn()}
        />,
      );

      expect(markup).toContain('장치 확인');
      expect(markup).toContain('미디어 없이 입장');
      expect(markup).toContain('방장 키 (선택)');
      expect(markup).toContain('type="password"');
      expect(markup).toContain('minLength="32"');
      expect(markup).toContain('32자 이상의 무작위 키만 사용');
      expect(markup).toContain('이 버튼을 누르기 전에는 카메라와 마이크 권한을 요청하지 않습니다.');
      expect(markup).not.toContain('서버에 연결 중');
      expect(getUserMedia).not.toHaveBeenCalled();
      expect(webSocket).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not render the standalone host key field for BATON entry', () => {
    const markup = renderToStaticMarkup(
      <PrejoinScreen
        displayName="림"
        roomId="abcd-efgh-jkmp"
        showHostCapabilityInput={false}
        onBack={vi.fn()}
        onJoin={vi.fn()}
      />,
    );

    expect(markup).not.toContain('방장 키 (선택)');
    expect(markup).not.toContain('type="password"');
  });
});
