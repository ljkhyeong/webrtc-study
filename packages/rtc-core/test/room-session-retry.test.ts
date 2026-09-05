import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@round/protocol';
import {
  createHarness,
  joinSession,
  answerPeer,
  flushMicrotasks,
  ROOM_ID,
  type Harness,
} from './room-session.test-support.js';

let harness: Harness;
afterEach(async () => {
  await harness?.session.leave();
  vi.useRealTimers();
});

async function connectedRoom() {
  harness = createHarness();
  await joinSession(harness, [
    { peerId: 'peer-a', displayName: '가온' },
    { peerId: 'peer-b', displayName: '나래' },
  ]);
  for (const [index, peerId] of ['peer-a', 'peer-b'].entries()) {
    await answerPeer(harness, peerId);
    harness.peerConnections[index]!.setConnectionState('connected');
  }
}

function reconnect(peerId: string, connectionId: string) {
  harness.socket.serverMessage({
    v: PROTOCOL_VERSION,
    type: 'peer.reconnect',
    roomId: ROOM_ID,
    payload: { peerId, connectionId, initiator: true },
  });
}

describe('참가자 재연결과 채팅 재전송', () => {
  it('복구를 소진한 상대만 수동 재연결하고 연속 클릭과 퇴장한 대상의 재시도를 막는다', async () => {
    vi.useFakeTimers();
    harness = createHarness({
      recovery: { peerConnectionTimeoutMs: 20, peerRecoveryTimeoutMs: 30 },
    });
    await joinSession(
      harness,
      [
        { peerId: 'y-healthy', displayName: '가온' },
        { peerId: 'z-failed', displayName: '나래' },
      ],
      'a-self',
    );
    await answerPeer(harness, 'y-healthy');
    await answerPeer(harness, 'z-failed');
    harness.peerConnections[0]!.setConnectionState('connected');
    await vi.advanceTimersByTimeAsync(20);
    await answerPeer(harness, 'z-failed');
    await vi.advanceTimersByTimeAsync(30);
    await answerPeer(harness, 'z-failed');
    await vi.advanceTimersByTimeAsync(20);
    expect(harness.session.retryPeer('y-healthy')).toBe(false);
    expect(harness.session.retryPeer('z-failed')).toBe(true);
    expect(harness.session.retryPeer('z-failed')).toBe(false);
    expect(harness.socket.messagesOfType('peer.reconnect')).toHaveLength(1);
    reconnect('z-failed', 'manual');
    await flushMicrotasks();
    await answerPeer(harness, 'z-failed');
    harness.peerConnections.at(-1)!.setConnectionState('connected');
    expect(harness.peerConnections[0]!.connectionState).toBe('connected');
    expect(harness.audioTrack.stopped).toBe(false);
    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'peer.left',
      roomId: ROOM_ID,
      payload: { peerId: 'z-failed' },
    });
    await flushMicrotasks();
    expect(harness.session.retryPeer('z-failed')).toBe(false);
  });

  it('새 연결 번호로 대상만 교체하고 이전 연결의 SDP와 ICE를 무시한다', async () => {
    await connectedRoom();
    const healthy = harness.peerConnections[1]!;
    const oldOffer = harness.socket.messagesOfType('rtc.offer')[0]!;
    reconnect('peer-a', 'retry-one');
    await flushMicrotasks();
    expect(harness.peerConnections[0]!.connectionState).toBe('closed');
    expect(healthy.connectionState).toBe('connected');
    expect(
      (harness.socket.messagesOfType('rtc.offer').at(-1)!.payload as { negotiationId: string })
        .negotiationId,
    ).toMatch(/^retry-one\./);
    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'rtc.offer',
      roomId: ROOM_ID,
      from: 'peer-a',
      payload: oldOffer.payload,
    });
    await flushMicrotasks();
    expect(harness.socket.messagesOfType('rtc.answer')).toHaveLength(0);
    expect(harness.peerConnections).toHaveLength(3);
    expect(harness.session.getSnapshot().status).toBe('active');
  });

  it('미확인 상대에게만 같은 번호로 재전송하며 재전송 가능 시간을 제한한다', async () => {
    vi.useFakeTimers();
    await connectedRoom();
    const first = harness.peerConnections[0]!.channels[0]!;
    const second = harness.peerConnections[1]!.channels[0]!;
    const sent = harness.session.sendChat('확인 부탁드립니다.');
    first.receive({ type: 'chat.ack', messageId: sent.id });
    await vi.advanceTimersByTimeAsync(45_000);
    expect(harness.session.getSnapshot().messages[0]!.deliveryState).toBe('partial');
    expect(harness.session.retryChat(sent.id, 'peer-a')).toBe(false);
    expect(harness.session.retryChat(sent.id, 'peer-b')).toBe(true);
    expect(
      first.sent.map((raw) => JSON.parse(raw)).filter((message) => message.type === 'chat.message'),
    ).toHaveLength(1);
    expect(
      second.sent
        .map((raw) => JSON.parse(raw))
        .filter((message) => message.type === 'chat.message')
        .map((message) => message.id),
    ).toEqual([sent.id, sent.id]);
    await vi.advanceTimersByTimeAsync(76_000);
    expect(harness.session.retryChat(sent.id)).toBe(false);
  });

  it('연결을 새로 만든 후에도 이미 받은 메시지를 중복 표시하지 않는다', async () => {
    await connectedRoom();
    const message = {
      type: 'chat.message',
      id: 'same-message',
      senderId: 'peer-a',
      text: '질문',
      sentAt: Date.now(),
    };
    harness.peerConnections[0]!.channels[0]!.receive(message);
    reconnect('peer-a', 'retry-two');
    await flushMicrotasks();
    harness.peerConnections[2]!.channels[0]!.receive(message);
    expect(harness.session.getSnapshot().messages).toHaveLength(1);
    expect(
      harness.peerConnections[2]!.channels[0]!.sent.map((raw) => JSON.parse(raw)),
    ).toContainEqual({ type: 'chat.ack', messageId: 'same-message' });
  });
});
