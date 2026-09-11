import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { ChatDeliveryState, ChatMessage } from '@round/rtc-core';
import { CloseIcon, MessageIcon, SendIcon } from './Icons';
import { ChatMessageContent } from './ChatMessageContent';
import { findChatSearchMatches, normalizeChatSearch } from '../lib/chat-search';

const MAX_COMPOSER_LENGTH = 1000;
const messageKey = (item: ChatMessage) => JSON.stringify([item.senderId, item.id]);

interface ChatMessageIdentity {
  readonly id: string;
  readonly senderId: string;
}

export interface ChatNotificationSummary {
  readonly unreadMessageCount: number;
  readonly unseenDeliveryIssueCount: number;
}

interface RoomChatPanelProps {
  readonly open: boolean;
  readonly messages: readonly ChatMessage[];
  readonly onRetryMessage?: ((messageId: string, peerId: string) => void) | undefined;
  readonly onSendMessage: (text: string) => boolean;
  readonly onClose: () => void;
  readonly onNotificationChange: (summary: ChatNotificationSummary) => void;
  readonly onDraftChange?: (hasDraft: boolean) => void;
}

interface ChatEnterState {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly isComposing: boolean;
  readonly compositionActive: boolean;
  readonly keyCode: number;
}

export function shouldSubmitChatOnEnter(state: ChatEnterState): boolean {
  return (
    state.key === 'Enter' &&
    !state.shiftKey &&
    !state.isComposing &&
    !state.compositionActive &&
    state.keyCode !== 229
  );
}

const messageTime = new Intl.DateTimeFormat('ko-KR', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const chatDeliveryLabels: Record<ChatDeliveryState, string> = {
  pending: ' · 수신 확인 중',
  sent: '',
  partial: ' · 일부 수신 미확인',
  failed: ' · 수신 미확인',
  received: '',
};

function ChatMessageTime({
  sentAt,
  deliveryState,
}: {
  readonly sentAt: number;
  readonly deliveryState: ChatMessage['deliveryState'];
}) {
  const date = new Date(sentAt);
  return (
    <time dateTime={date.toISOString()}>
      {messageTime.format(date)}
      {chatDeliveryLabels[deliveryState]}
    </time>
  );
}

export function countNewRemoteMessages(
  messages: readonly ChatMessage[],
  previousLastMessage: ChatMessageIdentity | null,
) {
  const previousIndex =
    previousLastMessage === null
      ? -1
      : messages.findIndex(
          (item) =>
            item.id === previousLastMessage.id && item.senderId === previousLastMessage.senderId,
        );
  const unseen = previousIndex >= 0 ? messages.slice(previousIndex + 1) : messages;
  return unseen.filter((item) => !item.isLocal).length;
}

function isLocalDeliveryIssue(deliveryState: ChatDeliveryState | undefined) {
  return deliveryState === 'partial' || deliveryState === 'failed';
}

function collectLocalDeliveryStates(messages: readonly ChatMessage[]) {
  const deliveryStates = new Map<string, ChatDeliveryState>();
  for (const item of messages) {
    if (item.isLocal) {
      deliveryStates.set(item.id, item.deliveryState);
    }
  }
  return deliveryStates;
}

export function countNewLocalDeliveryIssues(
  messages: readonly ChatMessage[],
  previousDeliveryStates: ReadonlyMap<string, ChatDeliveryState>,
) {
  return messages.filter(
    (item) =>
      item.isLocal &&
      isLocalDeliveryIssue(item.deliveryState) &&
      !isLocalDeliveryIssue(previousDeliveryStates.get(item.id)),
  ).length;
}

function chatMessageIdentity(message: ChatMessage | undefined): ChatMessageIdentity | null {
  return message === undefined ? null : { id: message.id, senderId: message.senderId };
}

export function RoomChatPanel({
  open,
  messages,
  onSendMessage,
  onRetryMessage,
  onClose,
  onNotificationChange,
  onDraftChange,
}: RoomChatPanelProps) {
  const [message, setMessage] = useState('');
  const [pasteNotice, setPasteNotice] = useState('');
  const composerRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const input = composerRef.current;
    if (!open || !input) return;
    const resize = () => {
      input.style.height = 'auto';
      input.style.height = `${input.scrollHeight + input.offsetHeight - input.clientHeight}px`;
    };
    resize();
    if (typeof ResizeObserver === 'undefined') return;
    let previousWidth = input.clientWidth;
    let resizeFrame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (input.clientWidth === previousWidth) return;
      previousWidth = input.clientWidth;
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = null;
        resize();
      });
    });
    observer.observe(input);
    return () => {
      observer.disconnect();
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
    };
  }, [message, open]);
  const hasDraft = Boolean(message.trim());
  useLayoutEffect(() => {
    onDraftChange?.(hasDraft);
  }, [hasDraft, onDraftChange]);
  const [search, setSearch] = useState('');
  const [selectedMatch, setSelectedMatch] = useState<string | null>(null);
  const query = normalizeChatSearch(search.trim());
  const searchMatches = useMemo(
    () =>
      new Map(
        messages.flatMap((item) => {
          return query && normalizeChatSearch(item.text).includes(query)
            ? [[messageKey(item), item] as const]
            : [];
        }),
      ),
    [messages, query],
  );
  const matchKeys = [...searchMatches.keys()];
  const matchIndex = Math.max(0, matchKeys.indexOf(selectedMatch ?? ''));
  const currentMatchKey = matchKeys[matchIndex] ?? null;
  const currentMatch = searchMatches.get(currentMatchKey ?? '');
  const currentHighlights = useMemo(
    () => (currentMatch ? findChatSearchMatches(currentMatch.text, query) : undefined),
    [currentMatch, query],
  );
  const messageElements = useRef(new Map<string, HTMLElement>());
  const moveMatch = (direction: number) => {
    if (!matchKeys.length) return;
    setSelectedMatch(matchKeys[(matchIndex + direction + matchKeys.length) % matchKeys.length]!);
  };
  const [unreadMessageCount, setUnreadMessageCount] = useState(0);
  const [unseenDeliveryIssueCount, setUnseenDeliveryIssueCount] = useState(0);
  const [followingChat, setFollowingChat] = useState(true);
  const previousLastMessage = useRef<ChatMessageIdentity | null>(
    chatMessageIdentity(messages.at(-1)),
  );
  const previousLocalDeliveryStates = useRef(collectLocalDeliveryStates(messages));
  const hasObservedMessages = useRef(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const followingChatRef = useRef(true);
  const chatCompositionActive = useRef(false);
  const searchCompositionActive = useRef(false);

  useLayoutEffect(() => {
    if (!open || !query || !currentMatchKey) return;
    const list = messagesRef.current;
    const target = messageElements.current.get(currentMatchKey);
    if (list && target) {
      followingChatRef.current = false;
      setFollowingChat(false);
      list.scrollTop +=
        target.getBoundingClientRect().top -
        list.getBoundingClientRect().top -
        (list.clientHeight - target.clientHeight) / 2;
    }
  }, [open, query, currentMatchKey]);

  useEffect(() => {
    onNotificationChange({ unreadMessageCount, unseenDeliveryIssueCount });
  }, [onNotificationChange, unreadMessageCount, unseenDeliveryIssueCount]);

  // 자동 스크롤 이벤트보다 먼저 새 메시지 높이에 맞춰 스크롤 위치를 갱신한다.
  useLayoutEffect(() => {
    const currentLocalDeliveryStates = collectLocalDeliveryStates(messages);
    if (!hasObservedMessages.current) {
      hasObservedMessages.current = true;
      previousLastMessage.current = chatMessageIdentity(messages.at(-1));
      previousLocalDeliveryStates.current = currentLocalDeliveryStates;
      return;
    }
    if (!open || query || !followingChatRef.current) {
      setUnreadMessageCount(
        (count) => count + countNewRemoteMessages(messages, previousLastMessage.current),
      );
      setUnseenDeliveryIssueCount(
        (count) =>
          count + countNewLocalDeliveryIssues(messages, previousLocalDeliveryStates.current),
      );
    } else if (
      messages.at(-1)?.id !== previousLastMessage.current?.id ||
      messages.at(-1)?.senderId !== previousLastMessage.current?.senderId
    ) {
      const list = messagesRef.current;
      if (list !== null) list.scrollTop = list.scrollHeight;
    }
    previousLastMessage.current = chatMessageIdentity(messages.at(-1));
    previousLocalDeliveryStates.current = currentLocalDeliveryStates;
  }, [open, messages, query]);

  useEffect(() => {
    if (!open || query) return;
    followingChatRef.current = true;
    setFollowingChat(true);
    setUnreadMessageCount(0);
    setUnseenDeliveryIssueCount(0);
    const list = messagesRef.current;
    if (list !== null) list.scrollTop = list.scrollHeight;
  }, [open, query]);

  const showLatestMessages = () => {
    setSearch('');
    setSelectedMatch(null);
    followingChatRef.current = true;
    setFollowingChat(true);
    setUnreadMessageCount(0);
    setUnseenDeliveryIssueCount(0);
    const list = messagesRef.current;
    if (list !== null) list.scrollTop = list.scrollHeight;
  };

  const closeSearch = () => {
    showLatestMessages();
    composerRef.current?.focus();
  };

  const handleChatScroll = () => {
    const list = messagesRef.current;
    if (list === null || !open || query) return;
    const following = list.scrollHeight - list.scrollTop - list.clientHeight <= 32;
    followingChatRef.current = following;
    setFollowingChat(following);
    if (following) {
      setUnreadMessageCount(0);
      setUnseenDeliveryIssueCount(0);
    }
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!message.trim()) return;
    if (onSendMessage(message)) {
      setMessage('');
      setPasteNotice('');
      showLatestMessages();
      composerRef.current?.focus();
    }
  };

  return (
    <>
      <aside className="chat-panel" aria-hidden={!open} inert={!open}>
        <header className="chat-panel__header">
          <strong>스터디 대화</strong>
          <button type="button" aria-label="채팅 닫기" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>

        <section className="chat-search" aria-label="채팅 검색">
          <label className="sr-only" htmlFor="chat-search">
            대화 검색
          </label>
          <input
            id="chat-search"
            type="search"
            placeholder="이 방의 대화 검색"
            value={search}
            maxLength={1000}
            onChange={(event) => {
              setSearch(event.target.value);
              setSelectedMatch(null);
            }}
            onCompositionStart={() => {
              searchCompositionActive.current = true;
            }}
            onCompositionEnd={() => {
              searchCompositionActive.current = false;
            }}
            onKeyDown={(event) => {
              if (
                searchCompositionActive.current ||
                event.nativeEvent.isComposing ||
                event.keyCode === 229
              )
                return;
              if (event.key !== 'Enter' && event.key !== 'Escape') return;
              event.preventDefault();
              if (event.key === 'Escape') closeSearch();
              else moveMatch(event.shiftKey ? -1 : 1);
            }}
          />
          {query ? (
            <div className="chat-search__navigation">
              <span role="status">
                {matchKeys.length ? `${matchIndex + 1} / ${matchKeys.length}` : '검색 결과 없음'}
              </span>
              <button
                type="button"
                disabled={!matchKeys.length}
                onClick={() => moveMatch(-1)}
                aria-label="이전 검색 결과"
              >
                이전
              </button>
              <button
                type="button"
                disabled={!matchKeys.length}
                onClick={() => moveMatch(1)}
                aria-label="다음 검색 결과"
              >
                다음
              </button>
              <button type="button" onClick={closeSearch}>
                검색 닫기
              </button>
            </div>
          ) : null}
        </section>

        <div
          className="chat-messages"
          ref={messagesRef}
          onScroll={handleChatScroll}
          aria-live={query ? 'off' : 'polite'}
        >
          {messages.length === 0 ? (
            <div className="chat-empty">
              <MessageIcon />
              <strong>아직 대화가 없습니다.</strong>
              <span>메시지는 이 방에 있는 동안만 표시됩니다.</span>
            </div>
          ) : (
            messages.map((chatMessage) => (
              <article
                key={`${chatMessage.senderId}:${chatMessage.id}`}
                className={`chat-message${chatMessage.isLocal ? ' chat-message--mine' : ''}`}
                data-delivery-state={chatMessage.deliveryState}
                data-search-match={searchMatches.has(messageKey(chatMessage)) || undefined}
                data-search-current={currentMatchKey === messageKey(chatMessage) || undefined}
                ref={(element) => {
                  const key = messageKey(chatMessage);
                  if (element) messageElements.current.set(key, element);
                  else messageElements.current.delete(key);
                }}
              >
                <header>
                  <strong>{chatMessage.isLocal ? '나' : chatMessage.senderName}</strong>
                  <ChatMessageTime
                    sentAt={chatMessage.sentAt}
                    deliveryState={chatMessage.deliveryState}
                  />
                </header>
                <ChatMessageContent
                  text={chatMessage.text}
                  matches={
                    currentMatchKey === messageKey(chatMessage) ? currentHighlights : undefined
                  }
                />
                {chatMessage.recipients?.some((recipient) => recipient.state !== 'acknowledged') ? (
                  <div className="chat-message__recipients">
                    {chatMessage.recipients.map((recipient) => (
                      <span key={recipient.peerId}>
                        {recipient.displayName} ·{' '}
                        {recipient.state === 'acknowledged'
                          ? '수신 확인'
                          : recipient.state === 'pending'
                            ? '수신 확인 중'
                            : '수신 미확인'}
                        {recipient.canRetry && onRetryMessage ? (
                          <button
                            type="button"
                            onClick={() => onRetryMessage(chatMessage.id, recipient.peerId)}
                          >
                            {recipient.displayName}에게 재전송
                          </button>
                        ) : null}
                      </span>
                    ))}
                    <small>전송 후 2분 이내, 연결된 상대에게만 재전송할 수 있습니다.</small>
                  </div>
                ) : null}
              </article>
            ))
          )}
        </div>

        <form className="chat-composer" onSubmit={handleSubmit}>
          {!followingChat ? (
            <button className="chat-latest" type="button" onClick={showLatestMessages}>
              {unreadMessageCount > 0 ? `새 메시지 ${unreadMessageCount}개 · ` : ''}
              {unseenDeliveryIssueCount > 0
                ? `수신 미확인 메시지 ${unseenDeliveryIssueCount}개 · `
                : ''}
              최신 대화로 이동
            </button>
          ) : null}
          <label className="sr-only" htmlFor="chat-message">
            메시지
          </label>
          <textarea
            ref={composerRef}
            id="chat-message"
            rows={1}
            maxLength={MAX_COMPOSER_LENGTH}
            aria-describedby="chat-composer-help chat-composer-count chat-composer-notice"
            placeholder="메시지 입력"
            value={message}
            onChange={(event) => {
              setMessage(event.target.value);
              setPasteNotice('');
            }}
            onPaste={(event) => {
              const input = event.currentTarget;
              const pasted = event.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n');
              const nextLength =
                input.value.length - (input.selectionEnd - input.selectionStart) + pasted.length;
              if (nextLength > MAX_COMPOSER_LENGTH) {
                event.preventDefault();
                setPasteNotice(
                  '1,000자를 초과해 붙여넣지 않았습니다. 내용을 줄여 다시 시도해 주세요.',
                );
              } else setPasteNotice('');
            }}
            onCompositionStart={() => {
              chatCompositionActive.current = true;
            }}
            onCompositionEnd={() => {
              chatCompositionActive.current = false;
            }}
            onKeyDown={(event) => {
              if (
                !shouldSubmitChatOnEnter({
                  key: event.key,
                  shiftKey: event.shiftKey,
                  isComposing: event.nativeEvent.isComposing,
                  compositionActive: chatCompositionActive.current,
                  keyCode: event.keyCode,
                })
              ) {
                return;
              }
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }}
          />
          <button type="submit" aria-label="메시지 보내기" disabled={!message.trim()}>
            <SendIcon />
          </button>
          <div className="chat-composer__help">
            <span id="chat-composer-help">Enter 전송 · Shift+Enter 줄바꿈</span>
            <span
              id="chat-composer-count"
              title="최대 1,000자이며 이모지 등 일부 문자는 2자 이상으로 계산됩니다."
            >
              {message.length.toLocaleString('ko-KR')} / 1,000자
            </span>
          </div>
          <p id="chat-composer-notice" className="chat-composer__notice" role="status">
            {pasteNotice ||
              (message.length >= MAX_COMPOSER_LENGTH ? '입력 한도 1,000자에 도달했습니다.' : '')}
          </p>
        </form>
      </aside>

      {!open && unseenDeliveryIssueCount > 0 ? (
        <p className="sr-only" role="status" aria-live="polite">
          수신 미확인 메시지 {unseenDeliveryIssueCount}개. 채팅을 확인하세요.
        </p>
      ) : null}
    </>
  );
}
