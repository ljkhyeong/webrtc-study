import { memo, useMemo, useState, type ReactNode } from 'react';
import { find, type Opts } from 'linkifyjs';
import type { ChatSearchMatch } from '../lib/chat-search';

const LINK_OPTIONS: Opts = {
  validate: (value, type) => {
    const lower = value.toLowerCase();
    return type === 'url' && (lower.startsWith('https://') || lower.startsWith('http://'));
  },
};

export const ChatMessageContent = memo(function ChatMessageContent({
  text,
  matches = [],
}: {
  text: string;
  matches?: readonly ChatSearchMatch[] | undefined;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'success' | 'error'>('idle');
  const links = useMemo(() => find(text, LINK_OPTIONS), [text]);
  const highlight = (start: number, end: number): ReactNode[] => {
    const parts: ReactNode[] = [];
    let cursor = start;
    for (const match of matches) {
      const from = Math.max(cursor, match.start);
      const to = Math.min(end, match.end);
      if (from >= to) continue;
      parts.push(
        text.slice(cursor, from),
        <mark key={`match-${from}`}>{text.slice(from, to)}</mark>,
      );
      cursor = to;
    }
    parts.push(text.slice(cursor, end));
    return parts;
  };
  const content: ReactNode[] = [];
  let cursor = 0;
  for (const link of links) {
    content.push(
      ...highlight(cursor, link.start),
      <a
        key={`link-${link.start}`}
        href={link.href}
        target="_blank"
        rel="noopener noreferrer"
        title="새 탭에서 열기"
      >
        {highlight(link.start, link.end)}
      </a>,
    );
    cursor = link.end;
  }
  content.push(...highlight(cursor, text.length));

  async function copy() {
    setCopyState('copying');
    try {
      await navigator.clipboard.writeText(text);
      setCopyState('success');
    } catch {
      setCopyState('error');
    }
  }

  return (
    <>
      <p>{content}</p>
      <div className="chat-message__actions">
        <button
          type="button"
          aria-label="메시지 복사"
          disabled={copyState === 'copying'}
          onClick={() => void copy()}
        >
          {copyState === 'success' ? '복사됨' : copyState === 'copying' ? '복사 중' : '복사'}
        </button>
        {copyState === 'success' ? (
          <span className="sr-only" role="status">
            메시지를 복사했습니다.
          </span>
        ) : null}
        {copyState === 'error' ? (
          <span role="alert">복사하지 못했습니다. 메시지를 직접 선택해 복사해 주세요.</span>
        ) : null}
      </div>
    </>
  );
});
