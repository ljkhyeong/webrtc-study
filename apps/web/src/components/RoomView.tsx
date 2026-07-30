import { useEffect, useRef, useState, type FormEvent } from 'react';
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
  SendIcon,
  UsersIcon,
} from './Icons';
import { type ParticipantView, VideoTile } from './VideoTile';
import { canonicalRoomUrl } from '../lib/room';

export interface ChatMessageView {
  id: string;
  senderName: string;
  text: string;
  sentAt: number;
  isLocal: boolean;
  deliveryState?: 'pending' | 'sent' | 'failed' | 'received';
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
  peerRecoveryMessage?: string | undefined;
  mediaWarning?: string | undefined;
  errorMessage?: string | undefined;
  onToggleAudio: () => void;
  onToggleVideo: () => void;
  onSendMessage: (text: string) => boolean;
  onReconnect: () => void;
  onLeave: () => void;
}

const messageTime = new Intl.DateTimeFormat('ko-KR', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function ChatMessageTime({
  sentAt,
  deliveryState,
}: {
  sentAt: number;
  deliveryState: ChatMessageView['deliveryState'];
}) {
  const deliveryLabel =
    deliveryState === 'pending' ? ' · 전송 중' : deliveryState === 'failed' ? ' · 전송 실패' : '';
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
  previousLastMessageId: string | null,
) {
  if (messages.length === 0) {
    return 0;
  }
  const previousIndex =
    previousLastMessageId === null
      ? -1
      : messages.findIndex((item) => item.id === previousLastMessageId);
  const unseen = previousIndex >= 0 ? messages.slice(previousIndex + 1) : messages;
  return unseen.filter((item) => !item.isLocal).length;
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
  peerRecoveryMessage,
  mediaWarning,
  errorMessage,
  onToggleAudio,
  onToggleVideo,
  onSendMessage,
  onReconnect,
  onLeave,
}: RoomViewProps) {
  const [chatOpen, setChatOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [copied, setCopied] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const previousLastMessageId = useRef<string | null>(messages.at(-1)?.id ?? null);
  const hasObservedMessages = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!hasObservedMessages.current) {
      hasObservedMessages.current = true;
      previousLastMessageId.current = messages.at(-1)?.id ?? null;
      return;
    }
    if (!chatOpen) {
      const newRemoteMessages = countNewRemoteMessages(messages, previousLastMessageId.current);
      setUnreadCount((count) => count + newRemoteMessages);
    }
    previousLastMessageId.current = messages.at(-1)?.id ?? null;
  }, [chatOpen, messages]);

  useEffect(() => {
    if (!chatOpen) {
      return;
    }

    setUnreadCount(0);
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
          <span className="participant-count">
            <UsersIcon />
            {participants.length}
          </span>
        </div>
      </header>

      <main className="room-workspace">
        <section className={`video-stage video-stage--${gridSize}`} aria-label="스터디 참가자 영상">
          {participants.map((participant) => (
            <VideoTile key={participant.peerId} participant={participant} />
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

          {peerRecoveryMessage || mediaWarning || (errorMessage && !terminalConnectionError) ? (
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
                <p className="room-notice room-notice--warning" role="status">
                  {mediaWarning}
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

        <aside className="chat-panel" aria-hidden={!chatOpen}>
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
                  key={chatMessage.id}
                  className={`chat-message${chatMessage.isLocal ? ' chat-message--mine' : ''}`}
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
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <button type="submit" aria-label="메시지 보내기" disabled={!message.trim()}>
              <SendIcon />
            </button>
          </form>
        </aside>
      </main>

      <footer className="control-dock" aria-label="통화 제어">
        <button
          className={`control-button${audioEnabled ? '' : ' control-button--off'}`}
          type="button"
          disabled={!audioAvailable}
          aria-label={
            !audioAvailable
              ? '사용 가능한 마이크 없음'
              : audioEnabled
                ? '마이크 끄기'
                : '마이크 켜기'
          }
          onClick={onToggleAudio}
        >
          {audioEnabled ? <MicIcon /> : <MicOffIcon />}
          <span>{!audioAvailable ? '마이크 없음' : audioEnabled ? '마이크' : '음소거'}</span>
        </button>
        <button
          className={`control-button${videoEnabled ? '' : ' control-button--off'}`}
          type="button"
          disabled={!videoAvailable}
          aria-label={
            !videoAvailable
              ? '사용 가능한 카메라 없음'
              : videoEnabled
                ? '카메라 끄기'
                : '카메라 켜기'
          }
          onClick={onToggleVideo}
        >
          {videoEnabled ? <CameraIcon /> : <CameraOffIcon />}
          <span>{!videoAvailable ? '카메라 없음' : videoEnabled ? '카메라' : '카메라 꺼짐'}</span>
        </button>
        <button
          className={`control-button${chatOpen ? ' control-button--active' : ''}`}
          type="button"
          aria-label={chatOpen ? '채팅 닫기' : '채팅 열기'}
          aria-expanded={chatOpen}
          onClick={toggleChat}
        >
          <MessageIcon />
          <span>채팅</span>
          {unreadCount > 0 ? <b>{Math.min(unreadCount, 9)}</b> : null}
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
