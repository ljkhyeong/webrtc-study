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

export interface ChatMessageView {
  id: string;
  senderName: string;
  text: string;
  sentAt: number;
  isLocal: boolean;
}

interface RoomViewProps {
  roomId: string;
  status: string;
  statusLabel: string;
  participants: ParticipantView[];
  messages: ChatMessageView[];
  audioEnabled: boolean;
  videoEnabled: boolean;
  mediaWarning?: string | undefined;
  errorMessage?: string | undefined;
  onToggleAudio: () => void;
  onToggleVideo: () => void;
  onSendMessage: (text: string) => void;
  onLeave: () => void;
}

const messageTime = new Intl.DateTimeFormat('ko-KR', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

async function copyInviteLink() {
  const inviteUrl = window.location.href;
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
  audioEnabled,
  videoEnabled,
  mediaWarning,
  errorMessage,
  onToggleAudio,
  onToggleVideo,
  onSendMessage,
  onLeave,
}: RoomViewProps) {
  const [chatOpen, setChatOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [copied, setCopied] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const previousMessageCount = useRef(messages.length);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (messages.length > previousMessageCount.current && !chatOpen) {
      const newRemoteMessages = messages
        .slice(previousMessageCount.current)
        .filter((item) => !item.isLocal).length;
      setUnreadCount((count) => count + newRemoteMessages);
    }
    previousMessageCount.current = messages.length;
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
      await copyInviteLink();
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

    onSendMessage(text);
    setMessage('');
  };

  const toggleChat = () => {
    setChatOpen((open) => !open);
  };

  const isActive = status === 'active';
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
          <span className={`connection-state connection-state--${status}`}>
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
            <div className="connecting-layer" role="status" aria-live="polite">
              <span className="connecting-ring" />
              <strong>{statusLabel}</strong>
              <p>브라우저 사이에 안전한 직접 연결을 준비하고 있습니다.</p>
            </div>
          ) : null}

          {mediaWarning ? <p className="room-notice room-notice--warning">{mediaWarning}</p> : null}
          {errorMessage ? <p className="room-notice room-notice--error">{errorMessage}</p> : null}
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
                    <time dateTime={new Date(chatMessage.sentAt).toISOString()}>
                      {messageTime.format(chatMessage.sentAt)}
                    </time>
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
          aria-label={audioEnabled ? '마이크 끄기' : '마이크 켜기'}
          onClick={onToggleAudio}
        >
          {audioEnabled ? <MicIcon /> : <MicOffIcon />}
          <span>{audioEnabled ? '마이크' : '음소거'}</span>
        </button>
        <button
          className={`control-button${videoEnabled ? '' : ' control-button--off'}`}
          type="button"
          aria-label={videoEnabled ? '카메라 끄기' : '카메라 켜기'}
          onClick={onToggleVideo}
        >
          {videoEnabled ? <CameraIcon /> : <CameraOffIcon />}
          <span>{videoEnabled ? '카메라' : '카메라 꺼짐'}</span>
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
