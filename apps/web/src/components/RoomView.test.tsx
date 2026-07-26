import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { RoomView } from './RoomView';

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
});
