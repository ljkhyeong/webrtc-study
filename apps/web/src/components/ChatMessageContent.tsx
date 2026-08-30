import { useState } from 'react';
import Linkify from 'linkify-react';
import type { Opts } from 'linkifyjs';

const LINK_OPTIONS: Opts = {
  validate: (value, type) => {
    const lower = value.toLowerCase();
    return type === 'url' && (lower.startsWith('https://') || lower.startsWith('http://'));
  },
  target: '_blank',
  rel: 'noopener noreferrer',
  attributes: { title: '새 탭에서 열기' },
};

export function ChatMessageContent({ text }: { text: string }) {
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'success' | 'error'>('idle');

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
      <Linkify as="p" options={LINK_OPTIONS}>
        {text}
      </Linkify>
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
}
