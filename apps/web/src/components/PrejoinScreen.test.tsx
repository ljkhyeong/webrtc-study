// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PrejoinScreen } from './PrejoinScreen';

describe('PrejoinScreen', () => {
  it('호환성을 확인한 뒤에만 입장하고 실패 안내와 재시도를 제공한다', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const beforeJoin = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error('서버 버전을 확인하지 못했습니다.'))
      .mockResolvedValueOnce(true);
    const onJoin = vi.fn();
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <PrejoinScreen
            initialDisplayName="림"
            backLabel="BATON으로 돌아가기"
            roomId="abcd-efgh-jkmp"
            showHostCapabilityInput={false}
            beforeJoin={beforeJoin}
            onBack={() => {}}
            onJoin={onJoin}
          />,
        ),
      );
      const join = [...container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('미디어 없이 입장'),
      )!;
      await act(async () => join.click());
      expect(onJoin).not.toHaveBeenCalled();
      await act(async () => join.click());
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        '서버 버전을 확인하지 못했습니다',
      );
      expect(onJoin).not.toHaveBeenCalled();
      await act(async () => join.click());
      expect(onJoin).toHaveBeenCalledOnce();
    } finally {
      act(() => root.unmount());
      vi.unstubAllGlobals();
    }
  });

  it('호환성 조회 중 뒤로 가면 늦은 응답으로 방에 입장하지 않는다', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    let resolve!: (allowed: boolean) => void;
    const beforeJoin = () =>
      new Promise<boolean>((done) => {
        resolve = done;
      });
    const onJoin = vi.fn();
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <PrejoinScreen
            initialDisplayName="림"
            backLabel="BATON으로 돌아가기"
            roomId="abcd-efgh-jkmp"
            showHostCapabilityInput={false}
            beforeJoin={beforeJoin}
            onBack={() => {}}
            onJoin={onJoin}
          />,
        ),
      );
      await act(async () =>
        [...container.querySelectorAll('button')]
          .find((button) => button.textContent?.includes('미디어 없이 입장'))!
          .click(),
      );
      act(() =>
        [...container.querySelectorAll('button')]
          .find((button) => button.textContent?.includes('BATON으로 돌아가기'))!
          .click(),
      );
      await act(async () => resolve(true));
      expect(onJoin).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      vi.unstubAllGlobals();
    }
  });

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
          initialDisplayName="림"
          backLabel="BATON으로 돌아가기"
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
      expect(markup).toContain('카메라와 마이크는 ‘장치 확인’을 눌러야 켜집니다.');
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
        initialDisplayName="림"
        backLabel="BATON으로 돌아가기"
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
              initialDisplayName="림"
              backLabel="BATON으로 돌아가기"
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
