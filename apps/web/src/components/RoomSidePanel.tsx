import type { KeyboardEvent } from 'react';
import type { ChatMessage, HandQueueState } from '@round/rtc-core';
import { CloseIcon } from './Icons';
import { badgeCount } from './RoomControlDock';
import { RoomChatPanel, type ChatNotificationSummary } from './RoomChatPanel';
import { RoomHandQueue } from './RoomHandQueue';
import { RoomParticipantList } from './RoomParticipantList';
import type { ParticipantView } from './VideoTile';

export type RoomPanel = 'chat' | 'hands' | 'people';

const PANEL_TABS: readonly RoomPanel[] = ['chat', 'hands', 'people'];

interface RoomSidePanelProps {
  readonly panel: RoomPanel | null;
  readonly onSelectPanel: (panel: RoomPanel) => void;
  readonly onClose: () => void;
  readonly chatNotificationCount: number;
  readonly handCount: number;
  readonly participants: readonly ParticipantView[];
  readonly handQueue: HandQueueState | null;
  readonly active: boolean;
  readonly canModerateMedia: boolean;
  readonly onDisableParticipantAudio: (peerId: string) => void;
  readonly onDisableParticipantVideo: (peerId: string) => void;
  readonly messages: readonly ChatMessage[];
  readonly onSendMessage: (text: string) => boolean;
  readonly onRetryMessage?: ((messageId: string, peerId: string) => void) | undefined;
  readonly onNotificationChange: (summary: ChatNotificationSummary) => void;
  readonly onDraftChange: (hasDraft: boolean) => void;
}

// 오른쪽 패널은 채팅·손들기·참가자를 탭으로 바꿔 보여 준다. 채팅은 다른 탭에서도 초안과 읽음 상태를 유지한다.
export function RoomSidePanel({
  panel,
  onSelectPanel,
  onClose,
  chatNotificationCount,
  handCount,
  participants,
  handQueue,
  active,
  canModerateMedia,
  onDisableParticipantAudio,
  onDisableParticipantVideo,
  messages,
  onSendMessage,
  onRetryMessage,
  onNotificationChange,
  onDraftChange,
}: RoomSidePanelProps) {
  const moveTab = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = PANEL_TABS.indexOf(panel ?? 'chat');
    const next =
      event.key === 'ArrowRight'
        ? (current + 1) % PANEL_TABS.length
        : event.key === 'ArrowLeft'
          ? (current + PANEL_TABS.length - 1) % PANEL_TABS.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? PANEL_TABS.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    onSelectPanel(PANEL_TABS[next]!);
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };

  // 채팅 검색이 먼저 처리한 Esc와 한글 조합 중 Esc는 패널을 닫지 않는다.
  const closeOnEscape = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      event.key !== 'Escape' ||
      event.defaultPrevented ||
      event.nativeEvent.isComposing ||
      event.keyCode === 229
    )
      return;
    event.preventDefault();
    onClose();
  };

  return (
    <div className="side-panel" inert={panel === null} onKeyDown={closeOnEscape}>
      <div className="side-panel__tabs" role="tablist" aria-label="통화 패널" onKeyDown={moveTab}>
        <button
          type="button"
          role="tab"
          aria-selected={panel === 'chat'}
          aria-controls="room-chat-panel"
          tabIndex={(panel ?? 'chat') === 'chat' ? 0 : -1}
          onClick={() => onSelectPanel('chat')}
        >
          채팅
          {panel !== 'chat' && chatNotificationCount > 0 ? (
            <b>{badgeCount(chatNotificationCount)}</b>
          ) : null}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={panel === 'hands'}
          aria-controls="room-hand-panel"
          tabIndex={panel === 'hands' ? 0 : -1}
          onClick={() => onSelectPanel('hands')}
        >
          손들기
          {handCount > 0 ? <b>{badgeCount(handCount)}</b> : null}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={panel === 'people'}
          aria-controls={panel === 'people' ? 'room-people-panel' : undefined}
          tabIndex={panel === 'people' ? 0 : -1}
          onClick={() => onSelectPanel('people')}
        >
          참가자 {participants.length}
        </button>
      </div>
      <RoomChatPanel
        onRetryMessage={onRetryMessage}
        open={panel === 'chat'}
        messages={messages}
        onSendMessage={onSendMessage}
        onClose={onClose}
        onNotificationChange={onNotificationChange}
        onDraftChange={onDraftChange}
      />
      <section
        id="room-hand-panel"
        className="side-panel__section"
        aria-labelledby="hand-queue-title"
        hidden={panel !== 'hands'}
      >
        <header className="side-panel__header">
          <strong id="hand-queue-title">손들기 대기</strong>
          <button type="button" aria-label="손들기 목록 닫기" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>
        <RoomHandQueue state={handQueue} participants={participants} active={active} />
      </section>
      {panel === 'people' ? (
        <section
          id="room-people-panel"
          className="side-panel__section"
          aria-labelledby="participant-list-title"
        >
          <header className="side-panel__header">
            <strong id="participant-list-title">참가자 목록</strong>
            <button type="button" aria-label="참가자 목록 닫기" onClick={onClose}>
              <CloseIcon />
            </button>
          </header>
          <RoomParticipantList
            participants={participants}
            handQueue={handQueue}
            canModerateMedia={canModerateMedia}
            onDisableAudio={onDisableParticipantAudio}
            onDisableVideo={onDisableParticipantVideo}
          />
        </section>
      ) : null}
    </div>
  );
}
