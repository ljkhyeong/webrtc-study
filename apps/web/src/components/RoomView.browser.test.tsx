// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomView } from './RoomView';

function roomViewProps(): Parameters<typeof RoomView>[0] {
  return {
    roomId: 'abcd-efgh-jkmp',
    status: 'active',
    statusLabel: '통화 연결됨',
    participants: [],
    messages: [],
    audioAvailable: false,
    audioEnabled: false,
    videoAvailable: false,
    videoEnabled: false,
    screenShareAvailable: false,
    screenSharing: false,
    canModerateMedia: false,
    onToggleAudio: vi.fn(),
    onToggleVideo: vi.fn(),
    onToggleScreenShare: vi.fn(),
    onDisableParticipantAudio: vi.fn(),
    onDisableParticipantVideo: vi.fn(),
    onSendMessage: vi.fn(() => true),
    onSelectDevices: vi.fn(),
    onReconnect: vi.fn(),
    onLeave: vi.fn(),
  };
}

describe('RoomView 브라우저 동작', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      value: true,
    });
    Element.prototype.scrollIntoView = vi.fn();
    window.history.replaceState({}, '', '/room/abcd-efgh-jkmp?source=invite#chat');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('초대 링크 복사 실패 시 정규 주소를 직접 복사할 수 있게 표시한다', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new DOMException('거부됨')) },
    });
    act(() => root.render(<RoomView {...roomViewProps()} />));

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.room-code')?.click();
    });

    const recovery = container.querySelector<HTMLElement>('.room-copy-recovery');
    const manualCopy = container.querySelector<HTMLInputElement>(
      'input[aria-label="초대 링크 수동 복사"]',
    );
    expect(recovery?.getAttribute('role')).toBe('alert');
    expect(manualCopy?.value).toBe(`${window.location.origin}/room/abcd-efgh-jkmp`);
  });

  it('채팅 패널을 닫으면 하단 채팅 버튼으로 포커스를 복원한다', async () => {
    act(() => root.render(<RoomView {...roomViewProps()} />));
    const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="채팅 열기"]');
    expect(toggle).not.toBeNull();

    await act(async () => toggle?.click());
    const close = container.querySelector<HTMLButtonElement>('button[aria-label="채팅 닫기"]');
    close?.focus();
    expect(document.activeElement).toBe(close);

    await act(async () => close?.click());
    expect(document.activeElement).toBe(toggle);
  });
});
