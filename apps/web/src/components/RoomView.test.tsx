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
      audioEnabled={false}
      videoEnabled={false}
      onToggleAudio={vi.fn()}
      onToggleVideo={vi.fn()}
      onSendMessage={vi.fn()}
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
