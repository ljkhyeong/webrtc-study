import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import {
  countNewLocalDeliveryIssues,
  countNewRemoteMessages,
  RoomView,
  shouldSubmitChatOnEnter,
  type ChatMessageView,
} from './RoomView';

function renderRoom(overrides: Partial<Parameters<typeof RoomView>[0]> = {}) {
  return renderToStaticMarkup(
    <RoomView
      roomId="abcd-efgh-jkmp"
      status="connecting-signal"
      statusLabel="서버에 연결 중"
      participants={[]}
      messages={[]}
      audioAvailable={false}
      audioEnabled={false}
      videoAvailable={false}
      videoEnabled={false}
      screenShareAvailable={false}
      screenSharing={false}
      canModerateMedia={false}
      onToggleAudio={vi.fn()}
      onToggleVideo={vi.fn()}
      onToggleScreenShare={vi.fn()}
      onDisableParticipantAudio={vi.fn()}
      onDisableParticipantVideo={vi.fn()}
      onSendMessage={vi.fn(() => true)}
      onSelectDevices={vi.fn()}
      onReconnect={vi.fn()}
      onLeave={vi.fn()}
      {...overrides}
    />,
  );
}

describe('RoomView connection state', () => {
  it('shows progress without terminal actions while connecting', () => {
    const markup = renderRoom();

    expect(markup).toContain('connecting-ring');
    expect(markup).toContain('서버에 연결 중');
    expect(markup).not.toContain('다시 연결');
  });

  it('replaces indefinite progress with recovery actions on a fatal error', () => {
    const markup = renderRoom({
      status: 'error',
      statusLabel: '연결 오류',
      errorMessage: 'TURN 서버 정보를 받지 못했습니다.',
    });

    expect(markup).not.toContain('connecting-ring');
    expect(markup).toContain('연결하지 못했습니다');
    expect(markup).toContain('TURN 서버 정보를 받지 못했습니다.');
    expect(markup).toContain('다시 연결');
    expect(markup).toContain('나가기');
  });

  it('offers reconnect and leave actions while a failed peer is isolated', () => {
    const markup = renderRoom({
      status: 'active',
      statusLabel: '일부 참가자 연결 실패',
      peerRecoveryMessage: '일부 참가자와 직접 연결하지 못했습니다. 현재 연결은 유지됩니다.',
    });

    expect(markup).not.toContain('connecting-ring');
    expect(markup).toContain('일부 참가자와 직접 연결하지 못했습니다.');
    expect(markup).toContain('방 다시 입장');
    expect(markup).toContain('나가기');
    expect(markup).toContain('connection-state--partial-failure');
  });

  it('stacks peer recovery, warning, and error notices without discarding information', () => {
    const markup = renderRoom({
      status: 'active',
      statusLabel: '일부 참가자 연결 실패',
      peerRecoveryMessage: '일부 참가자 연결 실패 안내',
      mediaWarning: 'TURN 연결 정보 갱신 실패',
      errorMessage: '메시지 전송 실패',
    });

    expect(markup).toContain('room-notice-stack');
    expect(markup).toContain('일부 참가자 연결 실패 안내');
    expect(markup).toContain('TURN 연결 정보 갱신 실패');
    expect(markup).toContain('메시지 전송 실패');
    expect(markup.match(/role="alert"/g)).toHaveLength(2);
    expect(markup).toContain('role="status"');
  });

  it('renders every typed system notice with its own severity', () => {
    const markup = renderRoom({
      status: 'active',
      systemNotices: [
        { id: 'session-error', tone: 'error', message: '세션 오류' },
        { id: 'action-error', tone: 'error', message: '작업 오류' },
        {
          id: 'participation-grant-refresh',
          tone: 'warning',
          message: '참여권 갱신 경고',
        },
        { id: 'turn-refresh', tone: 'warning', message: 'TURN 갱신 경고' },
      ],
    });

    expect(markup).toContain('세션 오류');
    expect(markup).toContain('작업 오류');
    expect(markup).toContain('참여권 갱신 경고');
    expect(markup).toContain('TURN 갱신 경고');
    expect(markup.match(/room-notice--error/g)).toHaveLength(2);
    expect(markup.match(/room-notice--warning/g)).toHaveLength(2);
    expect(markup.match(/role="alert"/g)).toHaveLength(2);
    expect(markup.match(/role="status"/g)).toHaveLength(2);
  });

  it('renders a fallback instead of throwing for an invalid chat timestamp', () => {
    const markup = renderRoom({
      messages: [
        {
          id: 'message-invalid-time',
          senderId: 'peer-a',
          senderName: 'Ara',
          text: '시간 값이 잘못된 메시지',
          sentAt: 1e300,
          isLocal: false,
          deliveryState: 'received',
        },
      ],
    });

    expect(markup).toContain('시간 미상');
    expect(markup).toContain('시간 값이 잘못된 메시지');
  });

  it('shows pending, partial, and failed local delivery states instead of false success', () => {
    const markup = renderRoom({
      messages: [
        {
          id: 'message-pending',
          senderId: 'self',
          senderName: 'Jin',
          text: '첫 번째 메시지',
          sentAt: 1_000,
          isLocal: true,
          deliveryState: 'pending',
        },
        {
          id: 'message-partial',
          senderId: 'self',
          senderName: 'Jin',
          text: '두 번째 메시지',
          sentAt: 2_000,
          isLocal: true,
          deliveryState: 'partial',
        },
        {
          id: 'message-failed',
          senderId: 'self',
          senderName: 'Jin',
          text: '세 번째 메시지',
          sentAt: 3_000,
          isLocal: true,
          deliveryState: 'failed',
        },
      ],
    });

    expect(markup.match(/ · 전송 확인 중<\/time>/g)).toHaveLength(1);
    expect(markup.match(/ · 일부 참가자 수신 확인 실패<\/time>/g)).toHaveLength(1);
    expect(markup.match(/ · 수신 확인 실패<\/time>/g)).toHaveLength(1);
    expect(markup.match(/data-delivery-state="pending"/g)).toHaveLength(1);
    expect(markup.match(/data-delivery-state="partial"/g)).toHaveLength(1);
    expect(markup.match(/data-delivery-state="failed"/g)).toHaveLength(1);
  });

  it('makes the closed chat panel and its controls inert', () => {
    const markup = renderRoom();

    expect(markup).toContain('class="chat-panel" aria-hidden="true" inert=""');
  });

  it('offers device selection for unavailable local media after joining', () => {
    const markup = renderRoom({
      status: 'active',
      statusLabel: '입장 완료 · 대기 중',
      audioAvailable: false,
      audioEnabled: false,
      videoAvailable: false,
      videoEnabled: false,
    });

    expect(markup).toContain('aria-label="마이크 장치 다시 선택"');
    expect(markup).toContain('aria-label="카메라 장치 다시 선택"');
    expect(markup).toContain('마이크 연결');
    expect(markup).toContain('카메라 연결');
    expect(markup).toContain('이 브라우저는 화면 공유를 지원하지 않음');
    expect(markup.match(/disabled=""/g)).toHaveLength(2);
  });

  it('shows device recovery only for a recoverable local media warning', () => {
    const recoverable = renderRoom({
      status: 'active',
      mediaWarning: '마이크 연결이 종료되었습니다.',
      mediaRecoveryAvailable: true,
    });
    const generic = renderRoom({
      status: 'active',
      mediaWarning: 'TURN 연결 정보를 갱신하지 못했습니다.',
    });

    expect(recoverable).toContain('room-notice--recoverable');
    expect(recoverable).toContain('>장치 다시 선택</button>');
    expect(generic).not.toContain('room-notice--recoverable');
    expect(generic).not.toContain('>장치 다시 선택</button>');
  });

  it('shows active screen sharing and locks the camera toggle until sharing stops', () => {
    const markup = renderRoom({
      status: 'active',
      videoAvailable: true,
      videoEnabled: true,
      screenShareAvailable: true,
      screenSharing: true,
    });

    expect(markup).toContain('aria-label="화면 공유 중지"');
    expect(markup).toContain('aria-label="화면 공유 중에는 카메라를 변경할 수 없음"');
    expect(markup).toContain('aria-pressed="true"');
  });

  it('renders the trusted moderation notice alongside other non-terminal notices', () => {
    const markup = renderRoom({
      status: 'active',
      moderationNotice: '방장이 마이크를 껐습니다.',
    });

    expect(markup).toContain('room-notice--moderation');
    expect(markup).toContain('방장이 마이크를 껐습니다.');
    expect(markup).toContain('role="status"');
  });

  it('detects unread messages after the bounded chat list reaches 200 items', () => {
    const previous = Array.from({ length: 200 }, (_, index): ChatMessageView => ({
      id: `message-${index}`,
      senderId: 'peer-a',
      senderName: 'Ara',
      text: `message ${index}`,
      sentAt: index,
      isLocal: false,
      deliveryState: 'received',
    }));
    const next = [
      ...previous.slice(1),
      {
        id: 'message-200',
        senderId: 'peer-a',
        senderName: 'Ara',
        text: 'latest message',
        sentAt: 200,
        isLocal: false,
        deliveryState: 'received' as const,
      },
    ];

    expect(
      countNewRemoteMessages(next, {
        id: 'message-199',
        senderId: 'peer-a',
      }),
    ).toBe(1);
  });

  it('uses sender identity when locating the previous unread cursor', () => {
    const messages: ChatMessageView[] = [
      {
        id: 'shared-id',
        senderId: 'peer-a',
        senderName: 'Ara',
        text: 'earlier',
        sentAt: 1,
        isLocal: false,
        deliveryState: 'received',
      },
      {
        id: 'shared-id',
        senderId: 'peer-b',
        senderName: 'Bora',
        text: 'cursor',
        sentAt: 2,
        isLocal: false,
        deliveryState: 'received',
      },
      {
        id: 'latest',
        senderId: 'peer-a',
        senderName: 'Ara',
        text: 'unread',
        sentAt: 3,
        isLocal: false,
        deliveryState: 'received',
      },
    ];

    expect(
      countNewRemoteMessages(messages, {
        id: 'shared-id',
        senderId: 'peer-b',
      }),
    ).toBe(1);
  });

  it('detects a local delivery issue only when it first becomes terminal', () => {
    const previousDeliveryStates = new Map<string, ChatMessageView['deliveryState']>([
      ['message-partial', 'pending'],
      ['message-failed', 'failed'],
    ]);
    const messages: ChatMessageView[] = [
      {
        id: 'message-partial',
        senderId: 'self',
        senderName: 'Jin',
        text: '참가자 일부에게 보내지 못한 메시지',
        sentAt: 1_000,
        isLocal: true,
        deliveryState: 'partial',
      },
      {
        id: 'message-failed',
        senderId: 'self',
        senderName: 'Jin',
        text: '이미 확인한 실패 메시지',
        sentAt: 2_000,
        isLocal: true,
        deliveryState: 'failed',
      },
      {
        id: 'message-new-failure',
        senderId: 'self',
        senderName: 'Jin',
        text: '곧바로 실패한 새 메시지',
        sentAt: 3_000,
        isLocal: true,
        deliveryState: 'failed',
      },
      {
        id: 'message-remote',
        senderId: 'peer-a',
        senderName: 'Ara',
        text: '원격 메시지',
        sentAt: 4_000,
        isLocal: false,
        deliveryState: 'received',
      },
    ];

    expect(countNewLocalDeliveryIssues(messages, previousDeliveryStates)).toBe(2);
  });
});

describe('RoomView chat enter handling', () => {
  it.each([
    {
      name: 'active Korean composition',
      state: {
        key: 'Enter',
        shiftKey: false,
        isComposing: true,
        compositionActive: true,
        keyCode: 229,
      },
      expected: false,
    },
    {
      name: 'Safari composition commit fallback',
      state: {
        key: 'Enter',
        shiftKey: false,
        isComposing: false,
        compositionActive: false,
        keyCode: 229,
      },
      expected: false,
    },
    {
      name: 'shift-enter newline',
      state: {
        key: 'Enter',
        shiftKey: true,
        isComposing: false,
        compositionActive: false,
        keyCode: 13,
      },
      expected: false,
    },
    {
      name: 'ordinary enter send',
      state: {
        key: 'Enter',
        shiftKey: false,
        isComposing: false,
        compositionActive: false,
        keyCode: 13,
      },
      expected: true,
    },
  ])('$name', ({ state, expected }) => {
    expect(shouldSubmitChatOnEnter(state)).toBe(expected);
  });
});
