import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ChatDeliveryState, ChatMessage } from '@round/rtc-core';
import {
  CameraIcon,
  CameraOffIcon,
  CheckIcon,
  CloseIcon,
  CopyIcon,
  MessageIcon,
  MicIcon,
  MicOffIcon,
  PhoneOffIcon,
  ScreenShareIcon,
  SendIcon,
  UsersIcon,
} from './Icons';
import { type ParticipantView, VideoTile } from './VideoTile';
import { canonicalRoomUrl } from '../lib/room';

export type ChatMessageView = ChatMessage;

interface ChatMessageIdentity {
  readonly id: string;
  readonly senderId: string;
}

interface RoomViewProps {
  roomId: string;
  status: string;
  statusLabel: string;
  participants: ParticipantView[];
  messages: ChatMessageView[];
  audioAvailable: boolean;
  audioEnabled: boolean;
  videoAvailable: boolean;
  videoEnabled: boolean;
  screenShareAvailable: boolean;
  screenSharing: boolean;
  canModerateMedia: boolean;
  moderationNotice?: string | undefined;
  peerRecoveryMessage?: string | undefined;
  mediaWarning?: string | undefined;
  mediaRecoveryAvailable?: boolean | undefined;
  errorMessage?: string | undefined;
  onToggleAudio: () => void;
  onToggleVideo: () => void;
  onToggleScreenShare: () => void;
  onDisableParticipantAudio: (peerId: string) => void;
  onDisableParticipantVideo: (peerId: string) => void;
  onSendMessage: (text: string) => boolean;
  onSelectDevices: () => void;
  onReconnect: () => void;
  onLeave: () => void;
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
  sentAt: number;
  deliveryState: ChatMessageView['deliveryState'];
}) {
  const deliveryLabel = chatDeliveryLabels[deliveryState];
  const date = new Date(sentAt);
  if (!Number.isFinite(sentAt) || Number.isNaN(date.getTime())) {
    return <time>{`시간 미상${deliveryLabel}`}</time>;
  }

  try {
    return (
      <time dateTime={date.toISOString()}>
        {messageTime.format(date)}
        {deliveryLabel}
      </time>
    );
  } catch {
    return <time>{`시간 미상${deliveryLabel}`}</time>;
  }
}

export function countNewRemoteMessages(
  messages: ChatMessageView[],
  previousLastMessage: ChatMessageIdentity | null,
) {
  if (messages.length === 0) {
    return 0;
  }
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

function collectLocalDeliveryStates(messages: ChatMessageView[]) {
  const deliveryStates = new Map<string, ChatDeliveryState>();
  for (const item of messages) {
    if (item.isLocal) {
      deliveryStates.set(item.id, item.deliveryState);
    }
  }
  return deliveryStates;
}

export function countNewLocalDeliveryIssues(
  messages: ChatMessageView[],
  previousDeliveryStates: ReadonlyMap<string, ChatDeliveryState>,
) {
  return messages.filter(
    (item) =>
      item.isLocal &&
      isLocalDeliveryIssue(item.deliveryState) &&
      !isLocalDeliveryIssue(previousDeliveryStates.get(item.id)),
  ).length;
}

async function copyInviteLink(roomId: string) {
  const inviteUrl = canonicalRoomUrl(roomId, window.location.href);
  if (navigator.clipboard) {
    await navigator.clipboard.writeText(inviteUrl);
    return;
  }

  const textArea = document.createElement('textarea');
  textArea.value = inviteUrl;
  textArea.style.position = 'fixed';
  textArea.style.opacity = '0';
  document.body.append(textArea);
  textArea.select();
  document.execCommand('copy');
  textArea.remove();
}

function chatMessageIdentity(message: ChatMessageView | undefined): ChatMessageIdentity | null {
  return message === undefined ? null : { id: message.id, senderId: message.senderId };
}

export function RoomView({
  roomId,
  status,
  statusLabel,
  participants,
  messages,
  audioAvailable,
  audioEnabled,
  videoAvailable,
  videoEnabled,
  screenShareAvailable,
  screenSharing,
  canModerateMedia,
  moderationNotice,
  peerRecoveryMessage,
  mediaWarning,
  mediaRecoveryAvailable = false,
  errorMessage,
  onToggleAudio,
  onToggleVideo,
  onToggleScreenShare,
  onDisableParticipantAudio,
  onDisableParticipantVideo,
  onSendMessage,
  onSelectDevices,
  onReconnect,
  onLeave,
}: RoomViewProps) {
  const [chatOpen, setChatOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [copied, setCopied] = useState(false);
  const [unreadMessageCount, setUnreadMessageCount] = useState(0);
  const [unseenDeliveryIssueCount, setUnseenDeliveryIssueCount] = useState(0);
  const previousLastMessage = useRef<ChatMessageIdentity | null>(
    chatMessageIdentity(messages.at(-1)),
  );
  const previousLocalDeliveryStates = useRef(collectLocalDeliveryStates(messages));
  const hasObservedMessages = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatCompositionActive = useRef(false);

  useEffect(() => {
    const currentLocalDeliveryStates = collectLocalDeliveryStates(messages);
    if (!hasObservedMessages.current) {
      hasObservedMessages.current = true;
      previousLastMessage.current = chatMessageIdentity(messages.at(-1));
      previousLocalDeliveryStates.current = currentLocalDeliveryStates;
      return;
    }
    if (!chatOpen) {
      const newRemoteMessages = countNewRemoteMessages(messages, previousLastMessage.current);
      const newDeliveryIssues = countNewLocalDeliveryIssues(
        messages,
        previousLocalDeliveryStates.current,
      );
      setUnreadMessageCount((count) => count + newRemoteMessages);
      setUnseenDeliveryIssueCount((count) => count + newDeliveryIssues);
    }
    previousLastMessage.current = chatMessageIdentity(messages.at(-1));
    previousLocalDeliveryStates.current = currentLocalDeliveryStates;
  }, [chatOpen, messages]);

  useEffect(() => {
    if (!chatOpen) {
      return;
    }

    setUnreadMessageCount(0);
    setUnseenDeliveryIssueCount(0);
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [chatOpen, messages]);

  const handleCopy = async () => {
    try {
      await copyInviteLink(roomId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const text = message.trim();
    if (!text) {
      return;
    }

    if (onSendMessage(text)) {
      setMessage('');
    }
  };

  const toggleChat = () => {
    setChatOpen((open) => !open);
  };

  const isActive = status === 'active';
  const terminalConnectionError = !isActive && Boolean(errorMessage);
  const partialPeerFailure = isActive && Boolean(peerRecoveryMessage);
  const gridSize = Math.min(Math.max(participants.length, 1), 6);
  const chatNotificationCount = unreadMessageCount + unseenDeliveryIssueCount;
  const chatButtonLabel = chatOpen
    ? '채팅 닫기'
    : `채팅 열기${unreadMessageCount > 0 ? `, 새 메시지 ${unreadMessageCount}개` : ''}${
        unseenDeliveryIssueCount > 0 ? `, 보낸 메시지 전송 문제 ${unseenDeliveryIssueCount}건` : ''
      }`;

  return (
    <div className={`room-shell${chatOpen ? ' room-shell--chat-open' : ''}`}>
      <header className="room-header">
        <div className="room-header__brand">
          <span className="wordmark">
            ROUND
            <span>study room</span>
          </span>
          <span className="room-header__rule" />
          <button className="room-code" type="button" onClick={handleCopy}>
            <span>ROOM</span>
            <strong>{roomId}</strong>
            {copied ? <CheckIcon /> : <CopyIcon />}
          </button>
        </div>

        <div className="room-header__status">
          <span
            className={`connection-state connection-state--${
              partialPeerFailure ? 'partial-failure' : status
            }`}
          >
            <i />
            {statusLabel}
          </span>
          <span className="participant-count" aria-label={`참가자 ${participants.length}명`}>
            <UsersIcon />
            {participants.length}
          </span>
        </div>
      </header>

      <main className="room-workspace">
        <section className={`video-stage video-stage--${gridSize}`} aria-label="스터디 참가자 영상">
          {participants.map((participant) => (
            <VideoTile
              key={participant.peerId}
              participant={participant}
              canModerateMedia={canModerateMedia}
              onDisableAudio={onDisableParticipantAudio}
              onDisableVideo={onDisableParticipantVideo}
            />
          ))}

          {participants.length === 1 && isActive ? (
            <div className="waiting-note">
              <span>링크를 공유하면 이 자리에 스터디원이 나타납니다.</span>
              <button type="button" onClick={handleCopy}>
                {copied ? '링크 복사됨' : '초대 링크 복사'}
              </button>
            </div>
          ) : null}

          {!isActive ? (
            <div
              className={`connecting-layer${
                terminalConnectionError ? ' connecting-layer--error' : ''
              }`}
              role={terminalConnectionError ? 'alert' : 'status'}
              aria-live={terminalConnectionError ? 'assertive' : 'polite'}
            >
              {terminalConnectionError ? <CloseIcon /> : <span className="connecting-ring" />}
              <strong>{terminalConnectionError ? '연결하지 못했습니다' : statusLabel}</strong>
              <p>
                {terminalConnectionError
                  ? errorMessage
                  : '브라우저 사이에 안전한 연결을 준비하고 있습니다.'}
              </p>
              {terminalConnectionError ? (
                <div className="connecting-layer__actions">
                  <button type="button" onClick={onReconnect}>
                    다시 연결
                  </button>
                  <button type="button" onClick={onLeave}>
                    나가기
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          {peerRecoveryMessage ||
          moderationNotice ||
          mediaWarning ||
          (errorMessage && !terminalConnectionError) ? (
            <div className="room-notice-stack">
              {peerRecoveryMessage ? (
                <div className="room-notice room-notice--warning" role="alert">
                  <span>{peerRecoveryMessage}</span>
                  <div className="connecting-layer__actions">
                    <button type="button" onClick={onReconnect}>
                      방 다시 입장
                    </button>
                    <button type="button" onClick={onLeave}>
                      나가기
                    </button>
                  </div>
                </div>
              ) : null}
              {mediaWarning ? (
                <div
                  className={`room-notice room-notice--warning${
                    mediaRecoveryAvailable ? ' room-notice--recoverable' : ''
                  }`}
                  role="status"
                >
                  <span>{mediaWarning}</span>
                  {mediaRecoveryAvailable ? (
                    <button type="button" onClick={onSelectDevices}>
                      장치 다시 선택
                    </button>
                  ) : null}
                </div>
              ) : null}
              {moderationNotice ? (
                <p className="room-notice room-notice--moderation" role="status">
                  {moderationNotice}
                </p>
              ) : null}
              {errorMessage && !terminalConnectionError ? (
                <p className="room-notice room-notice--error" role="alert">
                  {errorMessage}
                </p>
              ) : null}
            </div>
          ) : null}
        </section>

        <aside className="chat-panel" aria-hidden={!chatOpen} inert={!chatOpen}>
          <header className="chat-panel__header">
            <div>
              <span>ROOM CHAT</span>
              <strong>스터디 대화</strong>
            </div>
            <button type="button" aria-label="채팅 닫기" onClick={toggleChat}>
              <CloseIcon />
            </button>
          </header>

          <div className="chat-messages" aria-live="polite">
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
                  <p>{chatMessage.text}</p>
                </article>
              ))
            )}
            <div ref={messagesEndRef} />
          </div>

          <form className="chat-composer" onSubmit={handleSubmit}>
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
      </main>

      {!chatOpen && unseenDeliveryIssueCount > 0 ? (
        <p className="sr-only" role="status" aria-live="polite">
          보낸 메시지 전송 문제 {unseenDeliveryIssueCount}건. 채팅을 확인하세요.
        </p>
      ) : null}

      <footer className="control-dock" aria-label="통화 제어">
        <button
          className={`control-button${audioEnabled ? '' : ' control-button--off'}`}
          type="button"
          disabled={!audioAvailable && !isActive}
          aria-label={
            !audioAvailable
              ? isActive
                ? '마이크 장치 다시 선택'
                : '사용 가능한 마이크 없음'
              : audioEnabled
                ? '마이크 끄기'
                : '마이크 켜기'
          }
          onClick={audioAvailable ? onToggleAudio : onSelectDevices}
        >
          {audioEnabled ? <MicIcon /> : <MicOffIcon />}
          <span>{!audioAvailable ? '마이크 연결' : audioEnabled ? '마이크' : '음소거'}</span>
        </button>
        <button
          className={`control-button${videoEnabled ? '' : ' control-button--off'}`}
          type="button"
          disabled={screenSharing || (!videoAvailable && !isActive)}
          aria-label={
            screenSharing
              ? '화면 공유 중에는 카메라를 변경할 수 없음'
              : !videoAvailable
                ? isActive
                  ? '카메라 장치 다시 선택'
                  : '사용 가능한 카메라 없음'
                : videoEnabled
                  ? '카메라 끄기'
                  : '카메라 켜기'
          }
          onClick={videoAvailable ? onToggleVideo : onSelectDevices}
        >
          {videoEnabled ? <CameraIcon /> : <CameraOffIcon />}
          <span>{!videoAvailable ? '카메라 연결' : videoEnabled ? '카메라' : '카메라 꺼짐'}</span>
        </button>
        <button
          className={`control-button${screenSharing ? ' control-button--active' : ''}`}
          type="button"
          disabled={!screenShareAvailable || !isActive}
          aria-label={
            !screenShareAvailable
              ? '이 브라우저는 화면 공유를 지원하지 않음'
              : screenSharing
                ? '화면 공유 중지'
                : '화면 공유 시작'
          }
          aria-pressed={screenSharing}
          onClick={onToggleScreenShare}
        >
          <ScreenShareIcon />
          <span>{screenSharing ? '공유 중지' : '화면 공유'}</span>
        </button>
        <button
          className={`control-button${chatOpen ? ' control-button--active' : ''}`}
          type="button"
          aria-label={chatButtonLabel}
          aria-expanded={chatOpen}
          onClick={toggleChat}
        >
          <MessageIcon />
          <span>채팅</span>
          {chatNotificationCount > 0 ? <b>{Math.min(chatNotificationCount, 9)}</b> : null}
        </button>
        <span className="control-dock__divider" />
        <button className="control-button control-button--leave" type="button" onClick={onLeave}>
          <PhoneOffIcon />
          <span>나가기</span>
        </button>
      </footer>
    </div>
  );
}
