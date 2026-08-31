import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type SyntheticEvent,
} from 'react';
import type {
  ChatDeliveryState,
  ChatMessage,
  PeerConnectionDiagnostics,
  PeerConnectionStatus,
  RoomConnectionDiagnostics,
  RoomSessionStatus,
} from '@round/rtc-core';
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
import { type AudioOutputSelection, type ParticipantView, VideoTile } from './VideoTile';
import { canonicalRoomUrl } from '../lib/room';
import { ChatMessageContent } from './ChatMessageContent';

type RoomSystemNoticeId =
  | 'session-error'
  | 'action-warning'
  | 'action-error'
  | 'participation-grant-refresh'
  | 'turn-refresh'
  | 'audio-output';

export interface RoomSystemNoticeView {
  readonly id: RoomSystemNoticeId;
  readonly tone: 'warning' | 'error';
  readonly message: string;
}

interface ChatMessageIdentity {
  readonly id: string;
  readonly senderId: string;
}

type InviteCopyState =
  | { readonly status: 'idle' | 'success' }
  | { readonly status: 'error'; readonly inviteUrl: string };

type ConnectionDiagnosticsState =
  | { readonly status: 'idle' | 'loading' | 'error' }
  | { readonly status: 'ready'; readonly value: RoomConnectionDiagnostics };

interface RoomViewProps {
  roomId: string;
  status: RoomSessionStatus;
  statusLabel: string;
  participants: ParticipantView[];
  audioOutput?: AudioOutputSelection | undefined;
  messages: readonly ChatMessage[];
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
  systemNotices?: readonly RoomSystemNoticeView[] | undefined;
  onToggleAudio: () => void;
  onToggleVideo: () => void;
  onToggleScreenShare: () => void;
  onDisableParticipantAudio: (peerId: string) => void;
  onDisableParticipantVideo: (peerId: string) => void;
  onSendMessage: (text: string) => boolean;
  onCollectConnectionDiagnostics: () => Promise<RoomConnectionDiagnostics>;
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
  deliveryState: ChatMessage['deliveryState'];
}) {
  const deliveryLabel = chatDeliveryLabels[deliveryState];
  const date = new Date(sentAt);
  return (
    <time dateTime={date.toISOString()}>
      {messageTime.format(date)}
      {deliveryLabel}
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

const connectionStateLabels: Record<PeerConnectionStatus, string> = {
  new: '연결 준비',
  connecting: '연결 중',
  connected: '연결됨',
  disconnected: '연결 끊김',
  failed: '연결 실패',
  closed: '연결 종료',
  negotiating: '협상 중',
};

const candidateTypeLabels: Record<RTCIceCandidateType, string> = {
  host: '직접 경로',
  srflx: '공인 주소 경로',
  prflx: '피어 반사 경로',
  relay: 'TURN 중계',
};

function diagnosticValue(value: number | null, unit: string) {
  return value === null ? '측정 불가' : `${value}${unit}`;
}

export function connectionDiagnosticAdvice(diagnostic: PeerConnectionDiagnostics): string {
  if (diagnostic.connectionState !== 'connected') {
    return '연결 복구 중에는 품질을 판단하기 어렵습니다. 연결된 뒤 다시 측정해 주세요.';
  }
  if (diagnostic.packetLossPercent === null) {
    return '수신 표본이 부족합니다. 상대방이 소리나 영상을 보내는 동안 다시 측정해 주세요.';
  }
  if (diagnostic.packetLossPercent >= 3 || (diagnostic.jitterMs ?? 0) >= 30) {
    return '최근 수신이 불안정합니다. Wi-Fi 상태를 확인하고 상대방에게 데이터 절약 모드나 카메라 끄기를 요청해 보세요.';
  }
  if ((diagnostic.roundTripTimeMs ?? 0) >= 300) {
    return '왕복 지연이 큽니다. 다운로드를 멈추거나 유선망·다른 Wi-Fi에서 다시 측정해 보세요.';
  }
  return '이번 측정에서 큰 수신 손실은 보이지 않습니다. 끊김이 반복되면 문제가 발생할 때 다시 측정해 주세요.';
}

function candidateTypeLabel(type: RTCIceCandidateType | null) {
  return type === null ? '확인 전' : candidateTypeLabels[type];
}

function ConnectionDiagnosticItem({
  diagnostic,
}: {
  readonly diagnostic: PeerConnectionDiagnostics;
}) {
  return (
    <article className="connection-diagnostics__item">
      <strong>연결 {diagnostic.connectionNumber}</strong>
      <dl>
        <div>
          <dt>상태</dt>
          <dd>{connectionStateLabels[diagnostic.connectionState]}</dd>
        </div>
        <div>
          <dt>경로</dt>
          <dd>
            {candidateTypeLabel(diagnostic.localCandidateType)} →{' '}
            {candidateTypeLabel(diagnostic.remoteCandidateType)}
          </dd>
        </div>
        <div>
          <dt>왕복 지연</dt>
          <dd>{diagnosticValue(diagnostic.roundTripTimeMs, 'ms')}</dd>
        </div>
        <div>
          <dt>최근 수신 손실</dt>
          <dd>{diagnosticValue(diagnostic.packetLossPercent, '%')}</dd>
        </div>
        <div>
          <dt>최대 jitter</dt>
          <dd>{diagnosticValue(diagnostic.jitterMs, 'ms')}</dd>
        </div>
      </dl>
      <p>{connectionDiagnosticAdvice(diagnostic)}</p>
    </article>
  );
}

export function RoomView({
  roomId,
  status,
  statusLabel,
  participants,
  audioOutput,
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
  systemNotices = [],
  onToggleAudio,
  onToggleVideo,
  onToggleScreenShare,
  onDisableParticipantAudio,
  onDisableParticipantVideo,
  onSendMessage,
  onCollectConnectionDiagnostics,
  onSelectDevices,
  onReconnect,
  onLeave,
}: RoomViewProps) {
  const [chatOpen, setChatOpen] = useState(false);
  const [pinnedPeerId, setPinnedPeerId] = useState<string | null>(null);
  const stageRef = useRef<HTMLElement>(null);
  const activePinnedPeerId =
    participants.find(
      (participant) =>
        participant.peerId === pinnedPeerId &&
        !participant.isLocal &&
        participant.videoSource === 'screen' &&
        participant.videoEnabled &&
        participant.stream,
    )?.peerId ?? null;

  useEffect(() => {
    if (pinnedPeerId !== null && activePinnedPeerId === null) {
      setPinnedPeerId(null);
    }
  }, [pinnedPeerId, activePinnedPeerId]);

  useLayoutEffect(() => {
    if (activePinnedPeerId !== null && stageRef.current) {
      stageRef.current.scrollTop = 0;
    }
  }, [activePinnedPeerId]);

  const [message, setMessage] = useState('');
  const [inviteCopyState, setInviteCopyState] = useState<InviteCopyState>({ status: 'idle' });
  const [unreadMessageCount, setUnreadMessageCount] = useState(0);
  const [unseenDeliveryIssueCount, setUnseenDeliveryIssueCount] = useState(0);
  const [followingChat, setFollowingChat] = useState(true);
  const [connectionDiagnostics, setConnectionDiagnostics] = useState<ConnectionDiagnosticsState>({
    status: 'idle',
  });
  const [diagnosticsCopyState, setDiagnosticsCopyState] = useState<'idle' | 'success' | 'error'>(
    'idle',
  );
  const previousLastMessage = useRef<ChatMessageIdentity | null>(
    chatMessageIdentity(messages.at(-1)),
  );
  const previousLocalDeliveryStates = useRef(collectLocalDeliveryStates(messages));
  const hasObservedMessages = useRef(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const followingChatRef = useRef(true);
  const chatCompositionActive = useRef(false);
  const chatButtonRef = useRef<HTMLButtonElement>(null);
  const restoreChatFocus = useRef(false);
  const inviteCopyResetTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (inviteCopyResetTimer.current !== null) {
        window.clearTimeout(inviteCopyResetTimer.current);
      }
    },
    [],
  );

  // 자동 스크롤 이벤트보다 먼저 새 메시지 높이에 맞춰 스크롤 위치를 갱신한다.
  useLayoutEffect(() => {
    const currentLocalDeliveryStates = collectLocalDeliveryStates(messages);
    if (!hasObservedMessages.current) {
      hasObservedMessages.current = true;
      previousLastMessage.current = chatMessageIdentity(messages.at(-1));
      previousLocalDeliveryStates.current = currentLocalDeliveryStates;
      return;
    }
    if (!chatOpen || !followingChatRef.current) {
      const newRemoteMessages = countNewRemoteMessages(messages, previousLastMessage.current);
      const newDeliveryIssues = countNewLocalDeliveryIssues(
        messages,
        previousLocalDeliveryStates.current,
      );
      setUnreadMessageCount((count) => count + newRemoteMessages);
      setUnseenDeliveryIssueCount((count) => count + newDeliveryIssues);
    } else if (
      messages.at(-1)?.id !== previousLastMessage.current?.id ||
      messages.at(-1)?.senderId !== previousLastMessage.current?.senderId
    ) {
      const list = messagesRef.current;
      if (list !== null) list.scrollTop = list.scrollHeight;
    }
    previousLastMessage.current = chatMessageIdentity(messages.at(-1));
    previousLocalDeliveryStates.current = currentLocalDeliveryStates;
  }, [chatOpen, messages]);

  useEffect(() => {
    if (!chatOpen) {
      if (restoreChatFocus.current) {
        restoreChatFocus.current = false;
        chatButtonRef.current?.focus();
      }
      return;
    }

    followingChatRef.current = true;
    setFollowingChat(true);
    setUnreadMessageCount(0);
    setUnseenDeliveryIssueCount(0);
    const list = messagesRef.current;
    if (list !== null) list.scrollTop = list.scrollHeight;
  }, [chatOpen]);

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
    if (list === null || !chatOpen) return;
    const following = list.scrollHeight - list.scrollTop - list.clientHeight <= 32;
    followingChatRef.current = following;
    setFollowingChat(following);
    if (following) {
      setUnreadMessageCount(0);
      setUnseenDeliveryIssueCount(0);
    }
  };

  const handleCopy = async () => {
    if (inviteCopyResetTimer.current !== null) {
      window.clearTimeout(inviteCopyResetTimer.current);
    }
    const inviteUrl = canonicalRoomUrl(roomId, window.location.href);
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setInviteCopyState({ status: 'success' });
      inviteCopyResetTimer.current = window.setTimeout(() => {
        setInviteCopyState({ status: 'idle' });
        inviteCopyResetTimer.current = null;
      }, 1800);
    } catch {
      setInviteCopyState({ status: 'error', inviteUrl });
    }
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const text = message.trim();
    if (!text) {
      return;
    }

    if (onSendMessage(message)) {
      setMessage('');
      showLatestMessages();
    }
  };

  const toggleChat = () => {
    setChatOpen((open) => !open);
  };

  const closeChat = () => {
    restoreChatFocus.current = true;
    setChatOpen(false);
  };

  const collectConnectionDiagnostics = async () => {
    setConnectionDiagnostics({ status: 'loading' });
    setDiagnosticsCopyState('idle');
    try {
      setConnectionDiagnostics({
        status: 'ready',
        value: await onCollectConnectionDiagnostics(),
      });
    } catch {
      setConnectionDiagnostics({ status: 'error' });
    }
  };

  const handleDiagnosticsToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    if (event.currentTarget.open && connectionDiagnostics.status === 'idle') {
      void collectConnectionDiagnostics();
    }
  };

  const copyConnectionDiagnostics = async () => {
    if (connectionDiagnostics.status !== 'ready') {
      return;
    }
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(
          {
            measurement: '요청 후 약 3초 동안의 수신 손실과 측정 종료 시점의 지연·jitter',
            ...connectionDiagnostics.value,
          },
          null,
          2,
        ),
      );
      setDiagnosticsCopyState('success');
    } catch {
      setDiagnosticsCopyState('error');
    }
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
  const readyConnectionDiagnostics =
    connectionDiagnostics.status === 'ready' ? connectionDiagnostics.value : null;

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
            {inviteCopyState.status === 'success' ? <CheckIcon /> : <CopyIcon />}
          </button>
        </div>

        <div className="room-header__status">
          <button
            className="room-devices-button"
            type="button"
            disabled={!isActive}
            aria-label="통화 장치 설정"
            onClick={onSelectDevices}
          >
            장치
          </button>
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
          <details className="connection-diagnostics" onToggle={handleDiagnosticsToggle}>
            <summary>진단</summary>
            <section className="connection-diagnostics__panel" aria-label="연결 진단">
              <header>
                <div>
                  <span>CONNECTION</span>
                  <strong>연결 진단</strong>
                </div>
                <button
                  type="button"
                  disabled={connectionDiagnostics.status === 'loading'}
                  onClick={() => void collectConnectionDiagnostics()}
                >
                  새로고침
                </button>
              </header>
              <p className="connection-diagnostics__privacy">
                요청 후 약 3초 동안 수신 손실을 측정합니다. 지연·jitter는 마지막 측정값이며, IP
                주소, 방 코드, 참가자 식별자를 포함하거나 서버로 보내지 않습니다.
              </p>
              {connectionDiagnostics.status === 'error' ? (
                <p role="alert">연결 진단을 수집하지 못했습니다. 잠시 후 다시 시도해 주세요.</p>
              ) : connectionDiagnostics.status === 'idle' ? (
                <p>연결 진단을 열면 약 3초 동안 측정합니다.</p>
              ) : readyConnectionDiagnostics === null ? (
                <p role="status">최근 수신 상태를 약 3초 동안 측정하고 있습니다.</p>
              ) : (
                <>
                  {readyConnectionDiagnostics.connections.length === 0 ? (
                    <p>진단할 원격 연결이 없습니다.</p>
                  ) : (
                    <div className="connection-diagnostics__list">
                      {readyConnectionDiagnostics.connections.map((diagnostic) => (
                        <ConnectionDiagnosticItem
                          key={diagnostic.connectionNumber}
                          diagnostic={diagnostic}
                        />
                      ))}
                    </div>
                  )}
                  <button
                    className="connection-diagnostics__copy"
                    type="button"
                    onClick={() => void copyConnectionDiagnostics()}
                  >
                    {diagnosticsCopyState === 'success' ? '진단 정보 복사됨' : '진단 정보 복사'}
                  </button>
                  {diagnosticsCopyState === 'error' ? (
                    <p role="alert">클립보드에 복사하지 못했습니다.</p>
                  ) : null}
                  <pre tabIndex={0}>{JSON.stringify(readyConnectionDiagnostics, null, 2)}</pre>
                </>
              )}
            </section>
          </details>
        </div>
      </header>

      {inviteCopyState.status === 'success' ? (
        <p className="sr-only" role="status" aria-live="polite">
          초대 링크를 복사했습니다.
        </p>
      ) : null}
      {inviteCopyState.status === 'error' ? (
        <div className="room-copy-recovery" role="alert">
          <strong>초대 링크를 복사하지 못했습니다.</strong>
          <span>아래 주소를 직접 선택해 복사해 주세요.</span>
          <input
            aria-label="초대 링크 수동 복사"
            readOnly
            value={inviteCopyState.inviteUrl}
            onFocus={(event) => event.currentTarget.select()}
          />
        </div>
      ) : null}

      <main className="room-workspace">
        <section
          ref={stageRef}
          className={`video-stage video-stage--${gridSize}${activePinnedPeerId ? ' video-stage--pinned' : ''}`}
          aria-label="스터디 참가자 영상"
        >
          {participants.map((participant) => (
            <VideoTile
              key={participant.peerId}
              participant={participant}
              audioOutput={audioOutput}
              onSelectDevices={onSelectDevices}
              pinned={participant.peerId === activePinnedPeerId}
              onTogglePin={() =>
                setPinnedPeerId(
                  participant.peerId === activePinnedPeerId ? null : participant.peerId,
                )
              }
              canModerateMedia={canModerateMedia}
              onDisableAudio={onDisableParticipantAudio}
              onDisableVideo={onDisableParticipantVideo}
            />
          ))}

          {participants.length === 1 && isActive ? (
            <div className="waiting-note">
              <span>링크를 공유하면 이 자리에 스터디원이 나타납니다.</span>
              <button type="button" onClick={handleCopy}>
                {inviteCopyState.status === 'success' ? '링크 복사됨' : '초대 링크 복사'}
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
          systemNotices.length > 0 ||
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
              {systemNotices.map((notice) => (
                <p
                  key={notice.id}
                  className={`room-notice room-notice--${notice.tone}`}
                  role={notice.tone === 'error' ? 'alert' : 'status'}
                >
                  {notice.message}
                </p>
              ))}
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
            <button type="button" aria-label="채팅 닫기" onClick={closeChat}>
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
          ref={chatButtonRef}
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
