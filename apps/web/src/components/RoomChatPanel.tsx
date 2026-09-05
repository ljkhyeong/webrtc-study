import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import type { ChatDeliveryState, ChatMessage } from '@round/rtc-core';
import { CloseIcon, MessageIcon, SendIcon } from './Icons';
import { ChatMessageContent } from './ChatMessageContent';

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
  pending: ' · 전송 확인 중',
  sent: '',
  partial: ' · 일부 참가자 수신 확인 실패',
  failed: ' · 수신 확인 실패',
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
}: RoomChatPanelProps) {
  const [message, setMessage] = useState('');
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
    if (!open || !followingChatRef.current) {
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
  }, [open, messages]);

  useEffect(() => {
    if (!open) return;
    followingChatRef.current = true;
    setFollowingChat(true);
    setUnreadMessageCount(0);
    setUnseenDeliveryIssueCount(0);
    const list = messagesRef.current;
    if (list !== null) list.scrollTop = list.scrollHeight;
  }, [open]);

  const showLatestMessages = () => {
    followingChatRef.current = true;
    setFollowingChat(true);
    setUnreadMessageCount(0);
    setUnseenDeliveryIssueCount(0);
    const list = messagesRef.current;
    if (list !== null) list.scrollTop = list.scrollHeight;
  };

  const handleChatScroll = () => {
    const list = messagesRef.current;
    if (list === null || !open) return;
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
      showLatestMessages();
    }
  };

  return (
    <>
      <aside className="chat-panel" aria-hidden={!open} inert={!open}>
        <header className="chat-panel__header">
          <div>
            <span>ROOM CHAT</span>
            <strong>스터디 대화</strong>
          </div>
          <button type="button" aria-label="채팅 닫기" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>

        <div
          className="chat-messages"
          ref={messagesRef}
          onScroll={handleChatScroll}
          aria-live="polite"
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
              >
                <header>
                  <strong>{chatMessage.isLocal ? '나' : chatMessage.senderName}</strong>
                  <ChatMessageTime
                    sentAt={chatMessage.sentAt}
                    deliveryState={chatMessage.deliveryState}
                  />
                </header>
                <ChatMessageContent text={chatMessage.text} />
                {chatMessage.recipients?.some((recipient) => recipient.state !== 'acknowledged') ? (
                  <div className="chat-message__recipients">
                    {chatMessage.recipients.map((recipient) => (
                      <span key={recipient.peerId}>
                        {recipient.displayName} ·{' '}
                        {recipient.state === 'acknowledged'
                          ? '수신 확인'
                          : recipient.state === 'pending'
                            ? '확인 대기'
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
                    <small>재전송은 보낸 뒤 2분 동안 연결된 상대에게 가능합니다.</small>
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
              {unseenDeliveryIssueCount > 0 ? `전송 문제 ${unseenDeliveryIssueCount}건 · ` : ''}
              최신 대화로 이동
            </button>
          ) : null}
          <label className="sr-only" htmlFor="chat-message">
            메시지
          </label>
          <textarea
            id="chat-message"
            rows={1}
            maxLength={1000}
            placeholder="메시지 입력"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
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
        </form>
      </aside>

      {!open && unseenDeliveryIssueCount > 0 ? (
        <p className="sr-only" role="status" aria-live="polite">
          보낸 메시지 전송 문제 {unseenDeliveryIssueCount}건. 채팅을 확인하세요.
        </p>
      ) : null}
    </>
  );
}
