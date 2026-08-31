import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@round/protocol';
import {
  createHarness,
  createPromiseGate,
  FakeMediaStream,
  FakeTrack,
  flushMicrotasks,
  joinSession,
  ROOM_ID,
  type Harness,
} from './room-session.test-support.js';

const sessions: Harness[] = [];
const saver = { maxBitrate: 150_000, maxFramerate: 10, scaleResolutionDownBy: 2 };

function setup() {
  const screen = new FakeTrack('video');
  const h = createHarness({
    getDisplayMedia: async () => new FakeMediaStream([screen]) as unknown as MediaStream,
  });
  sessions.push(h);
  return h;
}

afterEach(async () => {
  for (const h of sessions.splice(0)) await h.session.leave();
  vi.restoreAllMocks();
});

describe('카메라 송신 품질', () => {
  it('재협상 없이 영상 송신에만 절약 설정을 적용하고 일반으로 복원한다', async () => {
    const h = setup();
    await joinSession(h, [{ peerId: 'peer-a', displayName: '참가자' }]);
    const peer = h.peerConnections[0]!;
    const video = peer.senders.find((sender) => sender.track?.kind === 'video')!;
    const audio = peer.senders.find((sender) => sender.track?.kind === 'audio')!;
    const offerCount = peer.offerOptions.length;
    h.session.toggleVideo();
    expect(await h.session.setVideoQualityMode('data-saver')).toBe(true);
    expect(video.parameters.encodings).toEqual([saver]);
    expect(audio.parameters.encodings).toEqual([{}]);
    expect(h.videoTrack.enabled).toBe(false);
    expect(peer.offerOptions).toHaveLength(offerCount);
    expect(await h.session.setVideoQualityMode('standard')).toBe(true);
    expect(video.parameters.encodings).toEqual([{ scaleResolutionDownBy: 1 }]);
  });

  it('새 참가자와 화면 공유 종료 후 카메라에도 현재 선택을 적용한다', async () => {
    const h = setup();
    await joinSession(h);
    await h.session.setVideoQualityMode('data-saver');
    h.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'peer.joined',
      roomId: ROOM_ID,
      payload: { participant: { peerId: 'peer-a', displayName: '참가자', role: 'participant' } },
    });
    await flushMicrotasks();
    const peer = h.peerConnections[0]!;
    h.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'rtc.offer',
      roomId: ROOM_ID,
      from: 'peer-a',
      payload: { negotiationId: 'quality-offer', description: { type: 'offer', sdp: 'offer' } },
    });
    await flushMicrotasks();
    const video = peer.senders.find((sender) => sender.track?.kind === 'video')!;
    expect(video.parameters.encodings).toEqual([saver]);
    expect(await h.session.startScreenShare()).toBe('started');
    expect(video.parameters.encodings).toEqual([{ scaleResolutionDownBy: 1 }]);
    expect(await h.session.stopScreenShare()).toBe(true);
    expect(video.parameters.encodings).toEqual([saver]);
    expect(h.session.getSnapshot().videoQualityMode).toBe('data-saver');
  });

  it('일부 브라우저가 거부해도 나머지 연결에 적용하고 재시도 성공 시 경고를 해제한다', async () => {
    const h = setup();
    await joinSession(h, [
      { peerId: 'peer-a', displayName: '가' },
      { peerId: 'peer-b', displayName: '나' },
    ]);
    const video = h.peerConnections[0]!.senders.find((sender) => sender.track?.kind === 'video')!;
    vi.spyOn(video, 'setParameters').mockRejectedValueOnce(
      new DOMException('미지원', 'NotSupportedError'),
    );
    expect(await h.session.setVideoQualityMode('data-saver')).toBe(false);
    expect(h.session.getSnapshot().warning?.code).toBe('video-quality-update-failed');
    expect(
      h.peerConnections[1]!.senders.find((sender) => sender.track?.kind === 'video')!.parameters
        .encodings,
    ).toEqual([saver]);
    expect(await h.session.setVideoQualityMode('data-saver')).toBe(true);
    expect(h.session.getSnapshot().warning).toBeNull();
    expect(h.peerConnections.every((peer) => !peer.closed)).toBe(true);
  });

  it('연속 설정은 순서대로 적용하고 퇴장하면 끝나지 않은 브라우저 응답을 기다리지 않는다', async () => {
    const h = setup();
    await joinSession(h, [{ peerId: 'peer-a', displayName: '참가자' }]);
    const video = h.peerConnections[0]!.senders.find((sender) => sender.track?.kind === 'video')!;
    const gate = createPromiseGate();
    vi.spyOn(video, 'setParameters').mockImplementationOnce(async (parameters) => {
      await gate.promise;
      video.parameters = parameters;
    });
    const first = h.session.setVideoQualityMode('data-saver');
    await flushMicrotasks();
    const second = h.session.setVideoQualityMode('standard');
    gate.resolve();
    await Promise.all([first, second]);
    expect(video.parameters.encodings).toEqual([{ scaleResolutionDownBy: 1 }]);
    vi.spyOn(video, 'setParameters').mockReturnValueOnce(new Promise(() => {}));
    const pending = h.session.setVideoQualityMode('data-saver');
    await flushMicrotasks();
    await h.session.leave();
    expect(await pending).toBe(false);
  });
});
