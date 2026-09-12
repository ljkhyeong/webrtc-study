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
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    notifications.mockClear();
    sendMessage.mockClear();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(['다른 탭', '다른 창'])(
    '%s에서 작업 중 받은 대화는 위치와 새 메시지 수를 유지한다',
    (away) => {
      render([first]);
      const list = container.querySelector<HTMLDivElement>('.chat-messages')!;
      let height = 1000;
      Object.defineProperties(list, {
        scrollHeight: { get: () => height },
        clientHeight: { get: () => 300 },
      });
      list.scrollTop = 700;
      vi.mocked(document.hasFocus).mockReturnValue(false);
      vi.spyOn(document, 'hidden', 'get').mockReturnValue(away === '다른 탭');
      height = 1200;
      render([first, second]);
      expect(list.scrollTop).toBe(700);
      expect(notifications).toHaveBeenLastCalledWith({
        unreadMessageCount: 1,
        unseenDeliveryIssueCount: 0,
      });
      expect(container.querySelector('.chat-latest')?.textContent).toContain('새 메시지 1개');

      const local: ChatMessage = {
        ...message('me', 'mine', '내 메시지'),
        isLocal: true,
        deliveryState: 'pending',
      };
      render([first, second, local]);
      const failed: ChatMessage = { ...local, deliveryState: 'failed' };
      render([first, second, failed]);
      // 백그라운드의 스크롤 이벤트가 읽음 표시를 지우지 않아야 한다.
      act(() => {
        list.scrollTop = 900;
        list.dispatchEvent(new Event('scroll'));
      });
      expect(notifications).toHaveBeenLastCalledWith({
        unreadMessageCount: 1,
        unseenDeliveryIssueCount: 1,
      });

      vi.mocked(document.hasFocus).mockReturnValue(true);
      vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
      render([first, second, failed]);
      expect(container.querySelector('.chat-latest')?.textContent).toContain('새 메시지 1개');
      act(() => container.querySelector<HTMLButtonElement>('.chat-latest')!.click());
      expect(list.scrollTop).toBe(1200);
      expect(container.querySelector('.chat-latest')).toBeNull();
      expect(notifications).toHaveBeenLastCalledWith({
        unreadMessageCount: 0,
        unseenDeliveryIssueCount: 0,
      });
      height = 1400;
      render([first, second, failed, message('b', 'next', '새 자료')]);
      expect(list.scrollTop).toBe(1400);
      expect(container.querySelector('.chat-latest')).toBeNull();
    },
  );

  it('현재 대화를 이름·날짜·수신 상태와 함께 복사하고 검색·초안은 유지한다', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    render([]);
    const copy = () => container.querySelector<HTMLButtonElement>('.chat-panel__copy')!;
    expect(copy().disabled).toBe(true);
    const messages: ChatMessage[] = [
      {
        ...message('가온', 'same', '첫 설명\nhttps://example.com/문서'),
        sentAt: new Date(2026, 8, 12, 14, 30).getTime(),
      },
      {
        ...message('나래', 'same', '다음 자료'),
        sentAt: new Date(2026, 8, 12, 14, 31).getTime(),
        isLocal: true,
        deliveryState: 'partial',
      },
      {
        ...message('나래', 'missing', '확인이 필요한 내용'),
        sentAt: new Date(2026, 8, 12, 14, 32).getTime(),
        isLocal: true,
        deliveryState: 'failed',
      },
    ];
    render(messages);
    search('설명');
    const input = container.querySelector<HTMLTextAreaElement>('#chat-message')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        input,
        '전송 전 초안',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(writeText).not.toHaveBeenCalled();
    await act(async () => copy().click());
    expect(writeText).toHaveBeenCalledExactlyOnceWith(
      '[26. 9. 12. 14:30] 가온\n첫 설명\nhttps://example.com/문서\n\n' +
        '[26. 9. 12. 14:31] 나래 · 일부 수신 미확인\n다음 자료\n\n' +
        '[26. 9. 12. 14:32] 나래 · 수신 미확인\n확인이 필요한 내용',
    );
    expect(container.querySelector('.chat-panel__copy-notice')?.textContent).toBe(
      '메시지 3개를 복사했습니다.',
    );
    expect(input.value).toBe('전송 전 초안');
    expect(container.querySelector<HTMLInputElement>('#chat-search')?.value).toBe('설명');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('복사 중 중복 실행을 막고 거부 뒤 새 대화로 다시 복사할 수 있다', async () => {
    let reject!: (error: Error) => void;
    const writeText = vi.fn().mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    render([first]);
    const copy = () => container.querySelector<HTMLButtonElement>('.chat-panel__copy')!;
    act(() => copy().click());
    expect(copy().disabled).toBe(true);
    act(() => copy().click());
    expect(writeText).toHaveBeenCalledOnce();
    await act(async () => reject(new DOMException('거부', 'NotAllowedError')));
    expect(copy().disabled).toBe(false);
    expect(
      container.querySelector('.chat-panel__copy-notice[role="alert"]')?.textContent,
    ).toContain('직접 선택');
    render([first, second]);
    writeText.mockResolvedValueOnce(undefined);
    await act(async () => copy().click());
    expect(writeText.mock.calls[1]?.[0]).toContain(second.text);
    expect(container.querySelector('.chat-panel__copy-notice')?.textContent).toBe(
      '메시지 2개를 복사했습니다.',
    );
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
    const send = container.querySelector<HTMLButtonElement>('[aria-label="메시지 보내기"]')!;
    act(() => {
      send.focus();
      send.click();
    });
    expect(sendMessage).toHaveBeenCalledWith(text);
    expect(input.value).toBe('');
    expect(document.activeElement).toBe(input);
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
    expect([...container.querySelectorAll('mark')].map((mark) => mark.textContent)).toEqual([
      'GUIDE',
    ]);
    expect(container.querySelector('a mark')?.textContent).toBe('GUIDE');
    expect(container.querySelector('[data-search-current]')?.textContent).toContain('GUIDE');
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="다음 검색 결과"]')!.click());
    expect(container.querySelector('[data-search-current]')?.textContent).toContain('다음 guide');
    expect([...container.querySelectorAll('mark')].map((mark) => mark.textContent)).toEqual([
      'guide',
    ]);
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
    expect(container.querySelectorAll('mark')).toHaveLength(0);
    expect(document.activeElement).toBe(container.querySelector('#chat-message'));
  });

  it('한글 조합 중에는 결과를 이동하거나 닫지 않고 Escape로 검색을 마친다', () => {
    render([first, second]);
    search('guide');
    const input = container.querySelector<HTMLInputElement>('#chat-search')!;
    act(() => {
      input.focus();
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(input.value).toBe('guide');
    expect(container.querySelector('[data-search-current]')?.textContent).toContain('GUIDE');
    act(() => {
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(container.querySelector('[data-search-current]')?.textContent).toContain('다음 guide');
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(input.value).toBe('');
    expect(container.querySelectorAll('mark')).toHaveLength(0);
    expect(document.activeElement).toBe(container.querySelector('#chat-message'));
  });

  it('조합형 한글의 검색어를 원문 그대로 강조한다', () => {
    const decomposed = '가이드'.normalize('NFD');
    const text = `😀 ${decomposed}를 확인하세요.`;
    render([message('a', 'nfd', text)]);
    search('가이드');
    expect(container.querySelectorAll('[data-search-match]')).toHaveLength(1);
    expect(container.querySelector('mark')?.textContent).toBe(decomposed);
    expect(container.querySelector('.chat-message p')?.textContent).toBe(text);
  });
});
