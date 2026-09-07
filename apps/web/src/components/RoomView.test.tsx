// @vitest-environment jsdom

import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatMessage } from '@round/rtc-core';
import { describe, expect, it, vi } from 'vitest';

import { RoomView } from './RoomView';
import { connectionDiagnosticAdvice } from './ConnectionDiagnosticsPanel';
import {
  countNewLocalDeliveryIssues,
  countNewRemoteMessages,
  shouldSubmitChatOnEnter,
} from './RoomChatPanel';

describe('진단 안내', () => {
  it.each([
    { packetLossPercent: null, roundTripTimeMs: 34, jitterMs: 10, message: '측정 데이터가 부족' },
    { packetLossPercent: 3, roundTripTimeMs: 34, jitterMs: 10, message: '상대방에게 데이터 절약' },
    { packetLossPercent: 0, roundTripTimeMs: 34, jitterMs: 30, message: '수신이 불안정' },
    { packetLossPercent: 0, roundTripTimeMs: 300, jitterMs: 10, message: '왕복 지연이 큽니다' },
    { packetLossPercent: 0, roundTripTimeMs: 34, jitterMs: 10, message: '이번 측정' },
  ])('수신 표본에 맞는 안내를 표시한다: $message', ({ message, ...values }) => {
    expect(
      connectionDiagnosticAdvice({
        connectionNumber: 1,
        connectionState: 'connected',
        localCandidateType: null,
        remoteCandidateType: null,
        ...values,
      }),
    ).toContain(message);
  });
});

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
      onSetHandRaised={vi.fn()}
      onDisableParticipantAudio={vi.fn()}
      onDisableParticipantVideo={vi.fn()}
      onSendMessage={vi.fn(() => true)}
      onCollectConnectionDiagnostics={vi.fn(async () => ({
        status: 'active' as const,
        connections: [],
      }))}
      onSelectDevices={vi.fn()}
      onReconnect={vi.fn()}
      onLeave={vi.fn()}
      {...overrides}
    />,
  );
}

describe('RoomView connection state', () => {
  it('방장 부재를 표시하되 방장의 미디어 연결 실패나 서버 재연결을 퇴장으로 취급하지 않는다', () => {
    const props = { status: 'active' as const, onStudyCommand: () => true, onSyncStudy: () => {} };
    expect(renderRoom(props)).toContain('방장 없음');
    expect(renderRoom(props)).toContain('진행 중인 타이머는 계속됩니다.');
    expect(renderRoom({ ...props, canModerateMedia: true })).not.toContain('방장 없음');
    expect(renderRoom({ ...props, status: 'connecting-signal' })).not.toContain('방장 없음');
    expect(
      renderRoom({
        ...props,
        participants: [
          {
            peerId: 'host',
            displayName: '방장',
            role: 'host',
            isLocal: false,
            audioEnabled: true,
            videoEnabled: true,
            videoSource: 'camera',
            handRaised: false,
            connectionState: 'failed',
          },
        ],
      }),
    ).not.toContain('방장 없음');
  });

  it('shows progress without terminal actions while connecting', () => {
    const markup = renderRoom();

    expect(markup).toContain('connecting-ring');
    expect(markup).toContain('서버에 연결 중');
    expect(markup).not.toContain('방 다시 입장');
  });

  it('replaces indefinite progress with recovery actions on a fatal error', () => {
    const markup = renderRoom({
      status: 'error',
      statusLabel: '연결 오류',
      errorMessage: '통화 연결 정보를 받지 못했습니다.',
    });

    expect(markup).not.toContain('connecting-ring');
    expect(markup).toContain('연결하지 못했습니다');
    expect(markup).toContain('통화 연결 정보를 받지 못했습니다.');
    expect(markup).toContain('방 다시 입장');
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
      mediaWarning: '통화 연결 정보 갱신 실패',
      errorMessage: '메시지 전송 실패',
    });

    expect(markup).toContain('room-notice-stack');
    expect(markup).toContain('일부 참가자 연결 실패 안내');
    expect(markup).toContain('통화 연결 정보 갱신 실패');
    expect(markup).toContain('메시지 전송 실패');
    expect(markup.match(/role="alert"/g)).toHaveLength(2);
    expect(markup).toContain('role="status"');
  });

  it('시스템 안내마다 오류·경고에 맞는 알림 역할을 적용한다', () => {
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
    const document = new DOMParser().parseFromString(markup, 'text/html');
    expect(document.querySelectorAll('.room-notice--error[role="alert"]')).toHaveLength(2);
    expect(document.querySelectorAll('.room-notice--warning[role="status"]')).toHaveLength(2);
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

    expect(markup.match(/ · 수신 확인 중<\/time>/g)).toHaveLength(1);
    expect(markup.match(/ · 일부 수신 미확인<\/time>/g)).toHaveLength(1);
    expect(markup.match(/ · 수신 미확인<\/time>/g)).toHaveLength(1);
    expect(markup.match(/data-delivery-state="pending"/g)).toHaveLength(1);
    expect(markup.match(/data-delivery-state="partial"/g)).toHaveLength(1);
    expect(markup.match(/data-delivery-state="failed"/g)).toHaveLength(1);
  });

  it('makes the closed chat panel and its controls inert', () => {
    const renderedDocument = new DOMParser().parseFromString(renderRoom(), 'text/html');
    const chatPanel = renderedDocument.querySelector('.chat-panel');

    expect(chatPanel).not.toBeNull();
    expect(chatPanel?.getAttribute('aria-hidden')).toBe('true');
    expect(chatPanel?.hasAttribute('inert')).toBe(true);
  });

  it('offers device selection for unavailable local media after joining', () => {
    const markup = renderRoom({
      status: 'active',
      statusLabel: '다른 참가자 기다리는 중',
      audioAvailable: false,
      audioEnabled: false,
      videoAvailable: false,
      videoEnabled: false,
    });
    const renderedDocument = new DOMParser().parseFromString(markup, 'text/html');
    const microphoneButton = renderedDocument.querySelector<HTMLButtonElement>(
      'button[aria-label="마이크 장치 다시 선택"]',
    );
    const cameraButton = renderedDocument.querySelector<HTMLButtonElement>(
      'button[aria-label="카메라 장치 다시 선택"]',
    );
    const screenShareButton = renderedDocument.querySelector<HTMLButtonElement>(
      'button[aria-label="이 브라우저는 화면 공유를 지원하지 않음"]',
    );

    expect(markup).toContain('마이크 연결');
    expect(markup).toContain('카메라 연결');
    expect(microphoneButton?.disabled).toBe(false);
    expect(cameraButton?.disabled).toBe(false);
    expect(screenShareButton?.disabled).toBe(true);
  });

  it('shows device recovery only for a recoverable local media warning', () => {
    const recoverable = renderRoom({
      status: 'active',
      mediaWarning: '마이크 연결이 종료되었습니다.',
      mediaRecoveryAvailable: true,
    });
    const generic = renderRoom({
      status: 'active',
      mediaWarning: '통화 연결 정보를 갱신하지 못했습니다.',
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
    const previous = Array.from({ length: 200 }, (_, index): ChatMessage => ({
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
    const messages: ChatMessage[] = [
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
    const previousDeliveryStates = new Map<string, ChatMessage['deliveryState']>([
      ['message-partial', 'pending'],
      ['message-failed', 'failed'],
    ]);
    const messages: ChatMessage[] = [
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
