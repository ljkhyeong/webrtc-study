import { RoomStudyPanel } from './RoomStudyPanel';
import { RoomHandQueue } from './RoomHandQueue';
import { LeaveRoomDialog } from './LeaveRoomDialog';
import { InviteDialog } from './InviteDialog';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  ChatMessage,
  RoomConnectionDiagnostics,
  RoomSessionStatus,
  RoomStudySnapshot,
  StudyCommand,
  HandQueueState,
} from '@round/rtc-core';
import {
  CameraIcon,
  CameraOffIcon,
  CheckIcon,
  CloseIcon,
  CopyIcon,
  HandIcon,
  MessageIcon,
  MicIcon,
  MicOffIcon,
  PhoneOffIcon,
  ScreenShareIcon,
  UsersIcon,
} from './Icons';
import { type AudioOutputSelection, type ParticipantView, VideoTile } from './VideoTile';
import { canonicalRoomUrl } from '../lib/room';
import { RoomChatPanel, type ChatNotificationSummary } from './RoomChatPanel';
import { ConnectionDiagnosticsPanel } from './ConnectionDiagnosticsPanel';
import { useRoomShortcuts } from '../lib/use-room-shortcuts';
import { useCallMediaSession } from '../lib/use-call-media-session';
import type { RegisterLeaveGuard } from '../lib/use-room-navigation';

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

type InviteCopyState =
  | { readonly status: 'idle' | 'success' }
  | { readonly status: 'error'; readonly inviteUrl: string };

interface RoomViewProps {
  handQueue?: HandQueueState | null;
  study?: RoomStudySnapshot | null | undefined;
  studyPending?: boolean | undefined;
  studyNotice?: string | null | undefined;
  onStudyCommand?: ((command: StudyCommand, expectedRevision?: number) => boolean) | undefined;
  onSyncStudy?: (() => void) | undefined;
  qualityVisible?: boolean;
  onSetQualityVisible?: ((visible: boolean) => void) | undefined;
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
  screenSharePending?: 'starting' | 'stopping' | null | undefined;
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
  onSetHandRaised: (raised: boolean) => void;
  onDisableParticipantAudio: (peerId: string) => void;
  onDisableParticipantVideo: (peerId: string) => void;
  onRetryMessage?: ((messageId: string, peerId: string) => void) | undefined;
  onSendMessage: (text: string) => boolean;
  onCollectConnectionDiagnostics: () => Promise<RoomConnectionDiagnostics>;
  onSelectDevices: () => void;
  onReconnect: () => void;
  onRetryPeer?: ((peerId: string) => boolean) | undefined;
  onLeave: () => void;
  registerLeaveGuard?: RegisterLeaveGuard | undefined;
}

export function RoomView({
  handQueue = null,
  study = null,
  studyPending = false,
  studyNotice = null,
  onStudyCommand,
  onSyncStudy,
  qualityVisible = false,
  onSetQualityVisible,
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
  screenSharePending = null,
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
  onSetHandRaised,
  onDisableParticipantAudio,
  onDisableParticipantVideo,
  onSendMessage,
  onRetryMessage,
  onCollectConnectionDiagnostics,
  onSelectDevices,
  onReconnect,
  onRetryPeer,
  onLeave,
  registerLeaveGuard,
}: RoomViewProps) {
  const [chatOpen, setChatOpen] = useState(false);
  const [hasDraft, setHasDraft] = useState(false);
  const [confirmAction, setConfirmAction] = useState<'leave' | 'reconnect' | null>(null);
  const leaveConfirmed = useRef(false);
  const navigationDecision = useRef<((accepted: boolean) => void) | null>(null);
  const needsLeaveConfirmation = hasDraft || screenSharing;
  useLayoutEffect(() => {
    registerLeaveGuard?.(() => {
      if (!needsLeaveConfirmation || leaveConfirmed.current) return true;
      if (navigationDecision.current || confirmAction) return false;
      return new Promise<boolean>((resolve) => {
        navigationDecision.current = resolve;
        setConfirmAction('leave');
      });
    });
    return () => registerLeaveGuard?.(null);
  }, [registerLeaveGuard, needsLeaveConfirmation, confirmAction]);
  useEffect(() => () => navigationDecision.current?.(false), []);
  const cancelLeave = () => {
    setConfirmAction(null);
    navigationDecision.current?.(false);
    navigationDecision.current = null;
  };
  useEffect(() => {
    if (!needsLeaveConfirmation) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (leaveConfirmed.current) return;
      event.preventDefault();
      event.returnValue = 'true';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [needsLeaveConfirmation]);
  const requestExit = (action: 'leave' | 'reconnect') => {
    if (leaveConfirmed.current || confirmAction || navigationDecision.current) return;
    if (needsLeaveConfirmation) setConfirmAction(action);
    else {
      leaveConfirmed.current = true;
      if (action === 'reconnect') onReconnect();
      else onLeave();
    }
  };
  const leaveAfterConfirmation = () => {
    if (leaveConfirmed.current || !confirmAction) return;
    leaveConfirmed.current = true;
    const navigate = navigationDecision.current;
    navigationDecision.current = null;
    setConfirmAction(null);
    if (navigate) {
      navigate(true);
    } else if (confirmAction === 'reconnect') onReconnect();
    else onLeave();
  };
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

  const [inviteCopyState, setInviteCopyState] = useState<InviteCopyState>({ status: 'idle' });
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [chatNotifications, setChatNotifications] = useState<ChatNotificationSummary>({
    unreadMessageCount: 0,
    unseenDeliveryIssueCount: 0,
  });
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

  useEffect(() => {
    if (!chatOpen && restoreChatFocus.current) {
      restoreChatFocus.current = false;
      chatButtonRef.current?.focus();
    }
  }, [chatOpen]);

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

  const openInvite = () => setInviteUrl(canonicalRoomUrl(roomId, window.location.href));

  const toggleChat = () => {
    setChatOpen((open) => !open);
  };

  const closeChat = () => {
    restoreChatFocus.current = true;
    setChatOpen(false);
  };

  const isActive = status === 'active';
  useCallMediaSession({
    active: isActive,
    audioAvailable,
    audioEnabled,
    cameraAvailable: videoAvailable && !screenSharing && screenSharePending === null,
    cameraEnabled: videoEnabled,
    onToggleAudio,
    onToggleVideo,
  });
  const handRaised = participants.some(
    (participant) => participant.isLocal && participant.handRaised,
  );
  useRoomShortcuts({
    active: isActive,
    audioAvailable,
    videoAvailable,
    onAudio: onToggleAudio,
    onVideo: onToggleVideo,
    onHand: () => onSetHandRaised(!handRaised),
  });
  const raisedHandNames = participants
    .filter((participant) => participant.handRaised)
    .map((participant) => `${participant.displayName}${participant.isLocal ? ' (나)' : ''}`);
  const terminalConnectionError = !isActive && Boolean(errorMessage);
  const partialPeerFailure = isActive && Boolean(peerRecoveryMessage);
  const gridSize = Math.min(Math.max(participants.length, 1), 6);
  const { unreadMessageCount, unseenDeliveryIssueCount } = chatNotifications;
  const chatNotificationCount = unreadMessageCount + unseenDeliveryIssueCount;
  const connectionDiagnosticsKey = participants
    .filter((participant) => !participant.isLocal)
    .map((participant) => `${participant.peerId}:${participant.connectionState}`)
    .join('|');
  const chatButtonLabel = chatOpen
    ? '채팅 닫기'
    : `채팅 열기${unreadMessageCount > 0 ? `, 새 메시지 ${unreadMessageCount}개` : ''}${
        unseenDeliveryIssueCount > 0 ? `, 수신 미확인 메시지 ${unseenDeliveryIssueCount}개` : ''
      }`;
  return (
    <div
      className={`room-shell${(onStudyCommand && onSyncStudy) || handQueue ? ' room-shell--study' : ''}${chatOpen ? ' room-shell--chat-open' : ''}`}
    >
      <header className="room-header">
        <div className="room-header__brand">
          <span className="wordmark">
            ROUND
            <span>study room</span>
          </span>
          <span className="room-header__rule" />
          <button
            className="room-code"
            type="button"
            aria-label="초대 링크 복사"
            onClick={handleCopy}
          >
            <span>ROOM</span>
            <strong>{roomId}</strong>
            {inviteCopyState.status === 'success' ? <CheckIcon /> : <CopyIcon />}
          </button>
        </div>

        <div className="room-header__status">
          <button className="room-invite-button" type="button" onClick={openInvite}>
            초대
          </button>
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

          <ConnectionDiagnosticsPanel
            connectionContextKey={connectionDiagnosticsKey}
            onCollect={onCollectConnectionDiagnostics}
            qualityVisible={qualityVisible}
            onSetQualityVisible={onSetQualityVisible}
          />
        </div>
      </header>

      {inviteUrl !== null ? (
        <InviteDialog
          inviteUrl={inviteUrl}
          copyStatus={inviteCopyState.status}
          onCopy={handleCopy}
          onClose={() => setInviteUrl(null)}
        />
      ) : null}
      {inviteUrl === null && inviteCopyState.status === 'success' ? (
        <p className="sr-only" role="status" aria-live="polite">
          초대 링크를 복사했습니다.
        </p>
      ) : null}
      {inviteUrl === null && inviteCopyState.status === 'error' ? (
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

      {(onStudyCommand && onSyncStudy) || handQueue ? (
        <div className="room-tools">
          {onStudyCommand && onSyncStudy ? (
            <RoomStudyPanel
              state={study}
              canControl={canModerateMedia}
              hostPresent={
                canModerateMedia || participants.some((participant) => participant.role === 'host')
              }
              active={status === 'active'}
              pending={studyPending}
              notice={studyNotice}
              onCommand={onStudyCommand}
              onSync={onSyncStudy}
            />
          ) : null}
          <RoomHandQueue state={handQueue} participants={participants} active={isActive} />
        </div>
      ) : null}
      <main className="room-workspace">
        <p className="sr-only" aria-live="polite" aria-atomic="true">
          {raisedHandNames.length > 0
            ? `손 든 참가자: ${raisedHandNames.join(', ')}`
            : '손 든 참가자가 없습니다.'}
        </p>
        <section
          ref={stageRef}
          className={`video-stage video-stage--${gridSize}${activePinnedPeerId ? ' video-stage--pinned' : ''}`}
          aria-label="스터디 참가자 영상"
        >
          {participants.map((participant) => (
            <VideoTile
              qualityVisible={qualityVisible}
              onRetryPeer={status === 'active' ? onRetryPeer : undefined}
              key={participant.peerId}
              participant={participant}
              handPosition={
                handQueue?.peerIds.includes(participant.peerId)
                  ? handQueue.peerIds.indexOf(participant.peerId) + 1
                  : undefined
              }
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
              <span>스터디원에게 초대 링크를 공유하세요.</span>
              <button type="button" onClick={openInvite}>
                초대하기
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
              <p>{terminalConnectionError ? errorMessage : '통화에 연결하고 있습니다.'}</p>
              {terminalConnectionError ? (
                <div className="connecting-layer__actions">
                  <button type="button" onClick={() => requestExit('reconnect')}>
                    방 다시 입장
                  </button>
                  <button type="button" onClick={() => requestExit('leave')}>
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
                    <button type="button" onClick={() => requestExit('reconnect')}>
                      방 다시 입장
                    </button>
                    <button type="button" onClick={() => requestExit('leave')}>
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

        <RoomChatPanel
          onRetryMessage={onRetryMessage}
          open={chatOpen}
          messages={messages}
          onSendMessage={onSendMessage}
          onClose={closeChat}
          onNotificationChange={setChatNotifications}
          onDraftChange={setHasDraft}
        />
      </main>
      {confirmAction ? (
        <LeaveRoomDialog
          action={confirmAction}
          hasDraft={hasDraft}
          screenSharing={screenSharing}
          onCancel={cancelLeave}
          onConfirm={leaveAfterConfirmation}
        />
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
          aria-keyshortcuts="Alt+Shift+M"
          title="마이크 전환: Alt+Shift+M"
        >
          {audioEnabled ? <MicIcon /> : <MicOffIcon />}
          <span>{!audioAvailable ? '마이크 연결' : audioEnabled ? '마이크' : '음소거'}</span>
        </button>
        <button
          className={`control-button${videoEnabled ? '' : ' control-button--off'}`}
          type="button"
          disabled={screenSharePending !== null || screenSharing || (!videoAvailable && !isActive)}
          aria-label={
            screenSharePending === 'starting'
              ? '화면 공유를 준비하는 동안 카메라를 변경할 수 없습니다.'
              : screenSharePending === 'stopping'
                ? '화면 공유를 중지하는 동안 카메라를 변경할 수 없습니다.'
                : screenSharing
                  ? '화면 공유 중에는 카메라를 변경할 수 없습니다.'
                  : !videoAvailable
                    ? isActive
                      ? '카메라 장치 다시 선택'
                      : '사용 가능한 카메라 없음'
                    : videoEnabled
                      ? '카메라 끄기'
                      : '카메라 켜기'
          }
          onClick={videoAvailable ? onToggleVideo : onSelectDevices}
          aria-keyshortcuts="Alt+Shift+C"
          title="카메라 전환: Alt+Shift+C"
        >
          {videoEnabled ? <CameraIcon /> : <CameraOffIcon />}
          <span>{!videoAvailable ? '카메라 선택' : videoEnabled ? '카메라' : '카메라 꺼짐'}</span>
        </button>
        <button
          className={`control-button${screenSharing ? ' control-button--active' : ''}`}
          type="button"
          disabled={screenSharePending !== null || !screenShareAvailable || !isActive}
          aria-label={
            screenSharePending === 'starting'
              ? '화면 공유 준비 중'
              : screenSharePending === 'stopping'
                ? '화면 공유 중지 중'
                : !screenShareAvailable
                  ? '이 브라우저는 화면 공유를 지원하지 않습니다.'
                  : screenSharing
                    ? '화면 공유 중지'
                    : '화면 공유 시작'
          }
          aria-pressed={screenSharing}
          onClick={onToggleScreenShare}
        >
          <ScreenShareIcon />
          <span>
            {screenSharePending === 'starting'
              ? '준비 중'
              : screenSharePending === 'stopping'
                ? '중지 중'
                : screenSharing
                  ? '공유 중지'
                  : '화면 공유'}
          </span>
        </button>
        <button
          className={`control-button${handRaised ? ' control-button--active' : ''}`}
          type="button"
          disabled={!isActive}
          aria-label={handRaised ? '손 내리기' : '손들기'}
          aria-pressed={handRaised}
          onClick={() => onSetHandRaised(!handRaised)}
          aria-keyshortcuts="Alt+Shift+H"
          title="손들기 전환: Alt+Shift+H"
        >
          <HandIcon />
          <span>{handRaised ? '손 내리기' : '손들기'}</span>
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
        <button
          className="control-button control-button--leave"
          type="button"
          onClick={() => requestExit('leave')}
        >
          <PhoneOffIcon />
          <span>나가기</span>
        </button>
      </footer>
    </div>
  );
}
