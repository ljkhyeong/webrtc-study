import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { countNewRemoteMessages, RoomView, type ChatMessageView } from './RoomView';

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
      onToggleAudio={vi.fn()}
      onToggleVideo={vi.fn()}
      onSendMessage={vi.fn(() => true)}
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

  it('renders a fallback instead of throwing for an invalid chat timestamp', () => {
    const markup = renderRoom({
      messages: [
        {
          id: 'message-invalid-time',
          senderName: 'Ara',
          text: '시간 값이 잘못된 메시지',
          sentAt: 1e300,
          isLocal: false,
        },
      ],
    });

    expect(markup).toContain('시간 미상');
    expect(markup).toContain('시간 값이 잘못된 메시지');
  });

  it('shows pending and failed local delivery states instead of false success', () => {
    const markup = renderRoom({
      messages: [
        {
          id: 'message-pending',
          senderName: 'Jin',
          text: '전송 대기 메시지',
          sentAt: 1_000,
          isLocal: true,
          deliveryState: 'pending',
        },
        {
          id: 'message-failed',
          senderName: 'Jin',
          text: '전송 실패 메시지',
          sentAt: 2_000,
          isLocal: true,
          deliveryState: 'failed',
        },
      ],
    });

    expect(markup).toContain('전송 중');
    expect(markup).toContain('전송 실패');
  });

  it('disables controls for unavailable local media instead of offering a no-op toggle', () => {
    const markup = renderRoom({
      status: 'active',
      statusLabel: '입장 완료 · 대기 중',
      audioAvailable: false,
      audioEnabled: false,
      videoAvailable: false,
      videoEnabled: false,
    });

    expect(markup).toContain('aria-label="사용 가능한 마이크 없음"');
    expect(markup).toContain('aria-label="사용 가능한 카메라 없음"');
    expect(markup).toContain('마이크 없음');
    expect(markup).toContain('카메라 없음');
    expect(markup.match(/disabled=""/g)).toHaveLength(3);
  });

  it('detects unread messages after the bounded chat list reaches 200 items', () => {
    const previous = Array.from({ length: 200 }, (_, index): ChatMessageView => ({
      id: `message-${index}`,
      senderName: 'Ara',
      text: `message ${index}`,
      sentAt: index,
      isLocal: false,
    }));
    const next = [
      ...previous.slice(1),
      {
        id: 'message-200',
        senderName: 'Ara',
        text: 'latest message',
        sentAt: 200,
        isLocal: false,
      },
    ];

    expect(countNewRemoteMessages(next, 'message-199')).toBe(1);
  });
});
