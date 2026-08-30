// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
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

  it.each(['audio', 'video'] as const)(
    '%s 장치 선택값을 권한 확인이 끝난 뒤에도 유지한다',
    async (kind) => {
      const getUserMedia = vi.fn(async () => {
        throw new DOMException('테스트 장치가 연결되지 않았습니다.', 'NotFoundError');
      });
      vi.stubGlobal('navigator', {
        mediaDevices: {
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          enumerateDevices: vi.fn(async () => [
            { kind: 'audioinput', deviceId: 'audio-replacement', label: '마이크' },
            { kind: 'videoinput', deviceId: 'video-replacement', label: '카메라' },
          ]),
          getUserMedia,
        },
      });
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      const authorize = vi.fn(async () => true);
      const container = document.createElement('div');
      document.body.append(container);
      const root = createRoot(container);

      try {
        await act(async () => {
          root.render(
            <PrejoinScreen
              displayName="림"
              roomId="abcd-efgh-jkmp"
              showHostCapabilityInput={false}
              authorizeBeforeEntryAction={authorize}
              onBack={vi.fn()}
              onJoin={vi.fn()}
            />,
          );
        });
        await act(async () => {
          [...container.querySelectorAll('button')]
            .find((button) => button.textContent?.includes('장치 확인'))!
            .click();
        });
        getUserMedia.mockClear();

        let approve!: (authorized: boolean) => void;
        authorize.mockReturnValueOnce(new Promise<boolean>((resolve) => (approve = resolve)));
        const select = container.querySelectorAll('select')[kind === 'audio' ? 0 : 1]!;
        await act(async () => {
          select.value = `${kind}-replacement`;
          select.dispatchEvent(new Event('change', { bubbles: true }));
        });
        expect(getUserMedia).not.toHaveBeenCalled();

        await act(async () => approve(true));
        expect(getUserMedia).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            [kind]: expect.objectContaining({ deviceId: { exact: `${kind}-replacement` } }),
          }),
        );
      } finally {
        await act(async () => root.unmount());
        container.remove();
        vi.unstubAllGlobals();
      }
    },
  );
});
