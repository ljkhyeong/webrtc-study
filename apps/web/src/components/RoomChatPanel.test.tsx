// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@round/rtc-core';
import { RoomChatPanel } from './RoomChatPanel';

describe('방 안의 채팅 입력과 검색', () => {
  let root: Root;
  let container: HTMLDivElement;
  const notifications = vi.fn();
  const sendMessage = vi.fn(() => true);
  const message = (senderId: string, id: string, text: string): ChatMessage => ({
    senderId,
    id,
    text,
    senderName: senderId,
    sentAt: 1000,
    isLocal: false,
    deliveryState: 'received',
  });
  const first = message('a', 'same', '자료 https://example.com/GUIDE');
  const second = message('b', 'same', '다음 guide 설명');
  const render = (messages: ChatMessage[]) =>
    act(() =>
      root.render(
        <RoomChatPanel
          open
          messages={messages}
          onSendMessage={sendMessage}
          onClose={() => {}}
          onNotificationChange={notifications}
        />,
      ),
    );
  const search = (text: string) =>
    act(() => {
      const input = container.querySelector<HTMLInputElement>('#chat-search')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    notifications.mockClear();
    sendMessage.mockClear();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('입력 길이와 한도를 표시하고 전송 후 입력과 안내를 비운다', () => {
    render([]);
    const input = container.querySelector<HTMLTextAreaElement>('#chat-message')!;
    const text = `${'가'.repeat(998)}😀`;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        input,
        text,
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.querySelector('#chat-composer-count')?.textContent).toBe('1,000 / 1,000자');
    expect(container.querySelector('#chat-composer-notice')?.textContent).toContain('입력 한도');
    act(() => input.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(sendMessage).toHaveBeenCalledWith(text);
    expect(input.value).toBe('');
    expect(container.querySelector('#chat-composer-count')?.textContent).toBe('0 / 1,000자');
    expect(container.querySelector('#chat-composer-notice')?.textContent).toBe('');
  });

  it('한도 초과 붙여넣기는 초안·선택을 유지하고 선택 영역 교체와 줄바꿈 길이를 반영한다', () => {
    render([]);
    const input = container.querySelector<HTMLTextAreaElement>('#chat-message')!;
    const text = '가'.repeat(998);
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        input,
        text,
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    input.setSelectionRange(997, 998);
    const paste = (value: string) => {
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: { getData: () => value } });
      act(() => input.dispatchEvent(event));
      return event;
    };
    expect(paste('😀😀').defaultPrevented).toBe(true);
    expect(input.value).toBe(text);
    expect([input.selectionStart, input.selectionEnd]).toEqual([997, 998]);
    expect(container.querySelector('#chat-composer-notice')?.textContent).toContain(
      '붙여넣지 않았',
    );
    expect(paste('가\r\n나').defaultPrevented).toBe(false);
    expect(container.querySelector('#chat-composer-notice')?.textContent).toBe('');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('원문·링크를 유지하며 검색 결과를 순환하고 새 메시지에도 선택 위치를 유지한다', () => {
    render([first, second]);
    search('guide');
    expect(container.querySelectorAll('[data-search-match]')).toHaveLength(2);
    expect(container.querySelector('[data-search-current]')?.textContent).toContain('GUIDE');
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="다음 검색 결과"]')!.click());
    expect(container.querySelector('[data-search-current]')?.textContent).toContain('다음 guide');
    const list = container.querySelector<HTMLElement>('.chat-messages')!;
    list.scrollTop = 80;
    render([first, second, message('c', 'new', '새 guide')]);
    expect(list.scrollTop).toBe(80);
    expect(container.querySelector('[data-search-current]')?.textContent).toContain('다음 guide');
    expect(notifications).toHaveBeenLastCalledWith({
      unreadMessageCount: 1,
      unseenDeliveryIssueCount: 0,
    });
    expect(container.querySelector('a')?.href).toBe('https://example.com/GUIDE');
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="이전 검색 결과"]')!.click());
    expect(container.querySelector('[data-search-current]')?.textContent).toContain('GUIDE');
  });

  it('메시지가 보관 한도 밖으로 사라지면 결과를 갱신하고 검색 종료 시 최신 대화로 돌아간다', () => {
    render([first, second]);
    search('guide');
    render([second]);
    expect(container.querySelector('[data-search-current]')?.textContent).toContain('다음 guide');
    search('없는 내용');
    expect(container.textContent).toContain('검색 결과 없음');
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="다음 검색 결과"]')!.disabled,
    ).toBe(true);
    act(() =>
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === '검색 닫기')!
        .click(),
    );
    expect(container.querySelector<HTMLInputElement>('#chat-search')!.value).toBe('');
    expect(container.querySelector('[data-search-current]')).toBeNull();
  });
});
