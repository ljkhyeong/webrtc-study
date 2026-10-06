import { RoomStudyPanel } from './RoomStudyPanel';
import { RoomSidePanel, type RoomPanel } from './RoomSidePanel';
import { RoomControlDock } from './RoomControlDock';
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
import { CheckIcon, CloseIcon, CopyIcon, LinkIcon } from './Icons';
import { type AudioOutputSelection, type ParticipantView, VideoTile } from './VideoTile';
import { canonicalRoomUrl } from '../lib/room';
import type { ChatNotificationSummary } from './RoomChatPanel';
import { ConnectionDiagnosticsPanel } from './ConnectionDiagnosticsPanel';
import { useRoomShortcuts } from '../lib/use-room-shortcuts';
import { useCallMediaSession } from '../lib/use-call-media-session';
import { setDocumentTitleUnreadCount } from '../lib/document-title';
import { useInviteCopy } from '../lib/use-invite-copy';
import type { RegisterLeaveGuard } from '../lib/use-room-navigation';
import { useLeaveConfirmation } from '../lib/use-leave-confirmation';
import { emptySeatCount, useGalleryLayout } from '../lib/gallery-layout';

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
  const [panel, setPanel] = useState<RoomPanel | null>(null);
  const chatOpen = panel === 'chat';
  const [hasDraft, setHasDraft] = useState(false);
  const { confirmAction, requestExit, cancelExit, confirmExit } = useLeaveConfirmation({
    needsConfirmation: hasDraft || screenSharing,
    registerLeaveGuard,
    onLeave,
    onReconnect,
  });
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

  const { state: inviteCopyState, copy: handleCopy } = useInviteCopy(roomId);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [chatNotifications, setChatNotifications] = useState<ChatNotificationSummary>({
    unreadMessageCount: 0,
    unseenDeliveryIssueCount: 0,
  });
  const chatButtonRef = useRef<HTMLButtonElement>(null);
  const peopleButtonRef = useRef<HTMLButtonElement>(null);
  // 패널 안에서 닫으면 마지막으로 패널을 연 버튼으로 초점을 돌려준다.
  const panelOpener = useRef<HTMLButtonElement | null>(null);
  const restorePanelFocus = useRef(false);

  useEffect(() => {
    if (panel === null && restorePanelFocus.current) {
      restorePanelFocus.current = false;
      panelOpener.current?.focus();
    }
  }, [panel]);

  const openInvite = () => setInviteUrl(canonicalRoomUrl(roomId, window.location.href));

  const togglePanel = (next: RoomPanel, opener: HTMLButtonElement | null) => {
    panelOpener.current = opener;
    setPanel((current) => (current === next ? null : next));
  };

  const closePanel = () => {
    restorePanelFocus.current = true;
    setPanel(null);
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
  const handCount = handQueue
    ? handQueue.peerIds.length
    : participants.filter((participant) => participant.handRaised).length;
  const { unreadMessageCount, unseenDeliveryIssueCount } = chatNotifications;
  useEffect(() => {
    setDocumentTitleUnreadCount(unreadMessageCount);
  }, [unreadMessageCount]);
  useEffect(() => () => setDocumentTitleUnreadCount(0), []);
  const chatNotificationCount = unreadMessageCount + unseenDeliveryIssueCount;
  const gallery = useGalleryLayout(stageRef, participants.length, activePinnedPeerId === null);
  // 격자 마지막 줄의 남는 칸은 빈 좌석으로 채운다.
  const emptySeats = emptySeatCount(participants.length, gallery.columns);
  const connectionDiagnosticsKey = participants
    .filter((participant) => !participant.isLocal)
    .map((participant) => `${participant.peerId}:${participant.connectionState}`)
    .join('|');
  return (
    <div className={`room-shell${panel ? ' room-shell--panel-open' : ''}`}>
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
            aria-label={
              inviteCopyState.status === 'copying' ? '초대 링크 복사 중' : '초대 링크 복사'
            }
            disabled={inviteCopyState.status === 'copying'}
            onClick={handleCopy}
          >
            <span>{inviteCopyState.status === 'copying' ? '복사 중' : 'ROOM'}</span>
            <strong>{roomId}</strong>
            {inviteCopyState.status === 'success' ? <CheckIcon /> : <CopyIcon />}
          </button>
        </div>

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

        <div className="room-header__status">
          <span
            className={`connection-state connection-state--${
              partialPeerFailure ? 'partial-failure' : status
            }`}
          >
            <i />
            {statusLabel}
          </span>
          <button
            ref={peopleButtonRef}
            className="participant-count"
            type="button"
            aria-label={`참가자 목록 ${panel === 'people' ? '닫기' : '열기'}, 참가자 ${participants.length}명`}
            aria-expanded={panel === 'people'}
            onClick={() => togglePanel('people', peopleButtonRef.current)}
          >
            재실 {participants.length}명
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
          <ConnectionDiagnosticsPanel
            connectionContextKey={connectionDiagnosticsKey}
            onCollect={onCollectConnectionDiagnostics}
            qualityVisible={qualityVisible}
            onSetQualityVisible={onSetQualityVisible}
          />
          <button className="room-invite-button" type="button" onClick={openInvite}>
            <LinkIcon />
            초대
          </button>
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

      <main className="room-workspace">
        <p className="sr-only" aria-live="polite" aria-atomic="true">
          {raisedHandNames.length > 0
            ? `손 든 참가자: ${raisedHandNames.join(', ')}`
            : '손 든 참가자가 없습니다.'}
        </p>
        <section
          ref={stageRef}
          className={`video-stage${activePinnedPeerId ? ' video-stage--pinned' : ''}`}
          style={gallery.style}
          aria-label="스터디 참가자 영상"
        >
          {participants.map((participant, index) => (
            <VideoTile
              seat={index + 1}
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
          {Array.from({ length: emptySeats }, (_, index) => (
            <div key={`empty-seat-${index}`} className="seat-empty" aria-hidden="true">
              <span className="video-tile__seat">
                {String(participants.length + index + 1).padStart(2, '0')}
              </span>
              빈 좌석
            </div>
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

        <RoomSidePanel
          panel={panel}
          onSelectPanel={setPanel}
          onClose={closePanel}
          chatNotificationCount={chatNotificationCount}
          handCount={handCount}
          participants={participants}
          handQueue={handQueue}
          active={isActive}
          canModerateMedia={canModerateMedia}
          onDisableParticipantAudio={onDisableParticipantAudio}
          onDisableParticipantVideo={onDisableParticipantVideo}
          messages={messages}
          onSendMessage={onSendMessage}
          onRetryMessage={onRetryMessage}
          onNotificationChange={setChatNotifications}
          onDraftChange={setHasDraft}
        />
      </main>
      {confirmAction ? (
        <LeaveRoomDialog
          action={confirmAction}
          hasDraft={hasDraft}
          screenSharing={screenSharing}
          onCancel={cancelExit}
          onConfirm={confirmExit}
        />
      ) : null}

      <RoomControlDock
        active={isActive}
        audioAvailable={audioAvailable}
        audioEnabled={audioEnabled}
        videoAvailable={videoAvailable}
        videoEnabled={videoEnabled}
        screenShareAvailable={screenShareAvailable}
        screenSharing={screenSharing}
        screenSharePending={screenSharePending}
        handRaised={handRaised}
        handCount={handCount}
        chatOpen={chatOpen}
        unreadMessageCount={unreadMessageCount}
        unseenDeliveryIssueCount={unseenDeliveryIssueCount}
        chatButtonRef={chatButtonRef}
        onToggleAudio={onToggleAudio}
        onToggleVideo={onToggleVideo}
        onToggleScreenShare={onToggleScreenShare}
        onSetHandRaised={onSetHandRaised}
        onSelectDevices={onSelectDevices}
        onToggleChat={() => togglePanel('chat', chatButtonRef.current)}
        onLeave={() => requestExit('leave')}
      />
    </div>
  );
}
