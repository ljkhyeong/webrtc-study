// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatMessageContent } from './ChatMessageContent';
import { findChatSearchMatches, normalizeChatSearch } from '../lib/chat-search';

describe('채팅 링크와 복사', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  it('HTTP와 HTTPS만 새 탭 링크로 표시하고 HTML과 다른 주소는 일반 텍스트로 유지한다', () => {
    const text =
      '자료 https://example.com/guide?a=1&b=2, HTTP://example.org/path.\n<script>alert(1)</script> javascript:alert(1) data:text/html,<b> ftp://example.com/a mailto:study@example.com example.com';
    act(() =>
      root.render(
        <ChatMessageContent text={text} matches={findChatSearchMatches(text, '<script>')} />,
      ),
    );
    const links = [...container.querySelectorAll('a')];
    expect(links.map((link) => link.href)).toEqual([
      'https://example.com/guide?a=1&b=2',
      'http://example.org/path',
    ]);
    for (const link of links) {
      expect(link.target).toBe('_blank');
      expect(link.rel).toBe('noopener noreferrer');
    }
    expect(container.querySelector('script, b')).toBeNull();
    expect(container.querySelector('mark')?.textContent).toBe('<script>');
    expect(container.querySelector('p')?.textContent).toBe(text);
  });

  it('검색어가 일반 문구와 링크에 걸쳐 있어도 주소·줄바꿈·복사 원문을 유지한다', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const text = '함께 볼 자료\nhttps://example.com/문서?q=스터디';
    const query = '자료\nhttps://example.com/문서';
    act(() =>
      root.render(
        <ChatMessageContent
          text={text}
          matches={findChatSearchMatches(text, normalizeChatSearch(query))}
        />,
      ),
    );
    expect([...container.querySelectorAll('mark')].map((mark) => mark.textContent).join('')).toBe(
      query,
    );
    expect(container.querySelector('a')?.getAttribute('href')).toBe(
      'https://example.com/문서?q=스터디',
    );
    expect(container.querySelector('p')?.textContent).toBe(text);
    expect(writeText).not.toHaveBeenCalled();
    await act(async () => container.querySelector('button')!.click());
    expect(writeText).toHaveBeenCalledWith(text);
    expect(container.querySelector('[role="status"]')?.textContent).toBe('메시지를 복사했습니다.');
  });

  it('클립보드 권한이 없으면 원문을 남겨 직접 복사하도록 안내한다', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new DOMException('권한 거부')) },
    });
    act(() => root.render(<ChatMessageContent text="직접 복사할 메시지" />));
    await act(async () => container.querySelector('button')!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('직접 선택해 복사');
    expect(container.querySelector('p')?.textContent).toBe('직접 복사할 메시지');
    expect(container.querySelector('button')?.disabled).toBe(false);
  });
});
