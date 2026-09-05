// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useRoomShortcuts } from './use-room-shortcuts';

it('통화 단축키가 입력·한글 조합·반복 키·닫힌 연결을 건드리지 않고 해제된다', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const onAudio = vi.fn(),
    onVideo = vi.fn(),
    onHand = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  function Controls({ active = true }: { active?: boolean }) {
    useRoomShortcuts({
      active,
      audioAvailable: true,
      videoAvailable: false,
      onAudio,
      onVideo,
      onHand,
    });
    return <input />;
  }
  const key = (code: string, target: EventTarget = document, overrides = {}) =>
    target.dispatchEvent(
      new KeyboardEvent('keydown', {
        code,
        altKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
        ...overrides,
      }),
    );
  try {
    act(() => root.render(<Controls />));
    key('KeyM');
    key('KeyC');
    key('KeyH');
    expect(onAudio).toHaveBeenCalledOnce();
    expect(onVideo).not.toHaveBeenCalled();
    expect(onHand).toHaveBeenCalledOnce();
    key('KeyM', container.querySelector('input')!);
    key('KeyM', document, { repeat: true });
    key('KeyM', document, { isComposing: true });
    document.dispatchEvent(new CompositionEvent('compositionstart'));
    key('KeyM');
    document.dispatchEvent(new CompositionEvent('compositionend'));
    const dialog = document.createElement('dialog');
    dialog.open = true;
    container.append(dialog);
    key('KeyM');
    dialog.remove();
    act(() => root.render(<Controls active={false} />));
    key('KeyM');
    act(() => root.unmount());
    key('KeyH');
    expect(onAudio).toHaveBeenCalledOnce();
    expect(onHand).toHaveBeenCalledOnce();
  } finally {
    container.remove();
    vi.unstubAllGlobals();
  }
});
