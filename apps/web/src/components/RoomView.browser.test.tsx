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
    onCollectConnectionDiagnostics: vi.fn(async () => ({
      status: 'active' as const,
      connections: [],
    })),
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

  it('이전 대화를 읽을 때 위치를 유지하고 최신 대화로 이동한 뒤에만 새 메시지를 따라간다', () => {
    const props = roomViewProps();
    const message = {
      id: 'first',
      senderId: 'peer',
      senderName: '참가자',
      text: '첫 메시지',
      sentAt: 1,
      isLocal: false,
      deliveryState: 'received' as const,
    };
    act(() => root.render(<RoomView {...props} messages={[message]} />));
    const list = container.querySelector<HTMLDivElement>('.chat-messages')!;
    let height = 1000;
    Object.defineProperties(list, {
      scrollHeight: { get: () => height },
      clientHeight: { value: 200 },
    });
    act(() =>
      container.querySelector<HTMLButtonElement>('button[aria-label="채팅 열기"]')!.click(),
    );
    expect(list.scrollTop).toBe(1000);

    act(() => {
      list.scrollTop = 100;
      list.dispatchEvent(new Event('scroll'));
    });
    const messages = [message, { ...message, id: 'second' }];
    height = 1200;
    act(() => root.render(<RoomView {...props} messages={messages} />));
    expect(list.scrollTop).toBe(100);
    expect(container.querySelector('.chat-latest')?.textContent).toContain('새 메시지 1개');

    act(() => root.render(<RoomView {...props} messages={[...messages]} />));
    expect(list.scrollTop).toBe(100);
    expect(container.querySelector('.chat-latest')?.textContent).toContain('새 메시지 1개');

    act(() => container.querySelector<HTMLButtonElement>('.chat-latest')!.click());
    expect(list.scrollTop).toBe(1200);
    expect(container.querySelector('.chat-latest')).toBeNull();

    height = 1400;
    act(() =>
      root.render(<RoomView {...props} messages={[...messages, { ...message, id: 'third' }]} />),
    );
    expect(list.scrollTop).toBe(1400);
  });

  it('수신 확인 상태만 바뀌면 채팅 스크롤을 움직이지 않는다', () => {
    const props = roomViewProps();
    const message = {
      id: 'local',
      senderId: 'me',
      senderName: '나',
      text: '보낸 메시지',
      sentAt: 1,
      isLocal: true,
      deliveryState: 'pending' as const,
    };
    act(() => root.render(<RoomView {...props} messages={[message]} />));
    act(() =>
      container.querySelector<HTMLButtonElement>('button[aria-label="채팅 열기"]')!.click(),
    );
    const list = container.querySelector<HTMLDivElement>('.chat-messages')!;
    const setScrollTop = vi.fn();
    Object.defineProperty(list, 'scrollTop', { set: setScrollTop });
    act(() =>
      root.render(<RoomView {...props} messages={[{ ...message, deliveryState: 'sent' }]} />),
    );
    expect(setScrollTop).not.toHaveBeenCalled();
  });

  it('개인정보가 없는 연결 진단을 요청 시 수집하고 복사한다', async () => {
    const onCollectConnectionDiagnostics = vi.fn(async () => ({
      status: 'active' as const,
      connections: [
        {
          connectionNumber: 1,
          connectionState: 'connected' as const,
          localCandidateType: 'relay' as const,
          remoteCandidateType: 'srflx' as const,
          roundTripTimeMs: 34,
          packetLossPercent: 2,
          jitterMs: 18,
        },
      ],
    }));
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    act(() =>
      root.render(<RoomView {...roomViewProps()} {...{ onCollectConnectionDiagnostics }} />),
    );
    const details = container.querySelector<HTMLDetailsElement>('.connection-diagnostics');

    await act(async () => {
      if (details !== null) {
        details.open = true;
        details.dispatchEvent(new Event('toggle', { bubbles: true }));
      }
    });

    expect(onCollectConnectionDiagnostics).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('TURN 중계');
    expect(container.textContent).toContain('34ms');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.connection-diagnostics__copy')?.click();
    });

    expect(writeText).toHaveBeenCalledWith(expect.not.stringContaining('peerId'));
    expect(writeText).toHaveBeenCalledWith(expect.not.stringContaining('roomId'));
  });
});
