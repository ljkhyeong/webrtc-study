import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@round/protocol';
import {
  FakeMediaStream,
  FakeTrack,
  ROOM_ID,
  answerPeer,
  createHarness,
  createPromiseGate,
  flushMicrotasks,
  joinSession,
  type Harness,
} from './room-session.test-support.js';

const sessions: Harness[] = [];

function deviceHarness(kind: 'audio' | 'video' = 'audio', withoutMedia = false) {
  const audioTrack = new FakeTrack('audio');
  const videoTrack = new FakeTrack('video');
  const next = new FakeTrack(kind);
  const stream = new FakeMediaStream([next]) as unknown as MediaStream;
  const getUserMedia = vi.fn(async (_constraints?: MediaStreamConstraints) => stream);
  const harness = createHarness({
    preparedMediaStream: withoutMedia
      ? null
      : (new FakeMediaStream([audioTrack, videoTrack]) as unknown as MediaStream),
    getUserMedia,
    getDisplayMedia: async () =>
      new FakeMediaStream([new FakeTrack('video')]) as unknown as MediaStream,
  });
  sessions.push(harness);
  return Object.assign(harness, { audioTrack, videoTrack, next, stream, getUserMedia });
}

afterEach(async () => {
  for (const harness of sessions.splice(0)) await harness.session.leave();
});

describe('통화 중 입력 장치 교체', () => {
  it.each(['audio', 'video'] as const)(
    '%s 장치를 바꿔도 음소거·연결·채팅을 유지한다',
    async (kind) => {
      const h = deviceHarness(kind);
      await joinSession(h, [{ peerId: 'peer-a', displayName: '참가자' }]);
      const peer = h.peerConnections[0]!;
      const old = kind === 'audio' ? h.audioTrack : h.videoTrack;
      const sender = peer.senders.find((item) => item.track?.kind === kind)!;
      const local = h.session.getLocalStream();
      if (kind === 'audio') h.session.toggleAudio();
      else h.session.toggleVideo();
      h.session.sendChat('교체 전 대화');
      expect(await h.session.selectInputDevice(kind, 'selected-device')).toBe(true);
      expect(h.getUserMedia).toHaveBeenCalledWith({
        audio: false,
        video: false,
        [kind]: { deviceId: { exact: 'selected-device' } },
      });
      expect(sender.track).toBe(h.next);
      expect(h.next.enabled).toBe(false);
      expect(old.stopped).toBe(true);
      expect(old.endedListenerCount()).toBe(0);
      expect(h.next.endedListenerCount()).toBe(1);
      expect(h.session.getLocalStream()).toBe(local);
      expect(h.peerConnections).toHaveLength(1);
      expect(peer.channels[0]!.readyState).toBe('open');
      expect(h.session.getSnapshot().messages[0]?.text).toBe('교체 전 대화');
    },
  );

  it.each(['audio', 'video'] as const)(
    '%s 장치가 분리돼도 마지막 켜기·끄기 선택을 유지한다',
    async (kind) => {
      const h = deviceHarness(kind);
      await joinSession(h, [{ peerId: 'peer-a', displayName: '참가자' }]);
      const old = kind === 'audio' ? h.audioTrack : h.videoTrack;
      const sender = h.peerConnections[0]!.senders.find((item) => item.track?.kind === kind)!;
      const toggle = () => (kind === 'audio' ? h.session.toggleAudio() : h.session.toggleVideo());
      expect(toggle()).toBe(false);
      old.end();

      expect(await h.session.selectInputDevice(kind, 'replacement')).toBe(true);
      expect(sender.track).toBe(h.next);
      expect(h.next.enabled).toBe(false);

      expect(toggle()).toBe(true);
      h.next.end();
      const enabledReplacement = new FakeTrack(kind);
      h.getUserMedia.mockResolvedValueOnce(
        new FakeMediaStream([enabledReplacement]) as unknown as MediaStream,
      );
      expect(await h.session.selectInputDevice(kind, 'enabled-replacement')).toBe(true);
      expect(sender.track).toBe(enabledReplacement);
      expect(enabledReplacement.enabled).toBe(true);
    },
  );

  it.each(['audio', 'video'] as const)(
    '%s 장치가 없는 동안 받은 방장 끄기 요청을 다음 장치에 적용한다',
    async (kind) => {
      const h = deviceHarness(kind, true);
      await joinSession(h, [{ peerId: 'peer-a', displayName: '방장', role: 'host' }]);
      h.socket.serverMessage({
        v: PROTOCOL_VERSION,
        type: 'moderation.media.disabled',
        roomId: ROOM_ID,
        from: 'peer-a',
        payload: { targetPeerId: 'self', kind },
      });
      await flushMicrotasks();

      expect(await h.session.selectInputDevice(kind, 'replacement')).toBe(true);
      expect(h.next.enabled).toBe(false);
      expect(h.peerConnections[0]!.senders[0]!.track).toBe(h.next);
    },
  );

  it('일부 송신자 교체가 거부되면 기존 트랙으로 복원한다', async () => {
    const h = deviceHarness();
    await joinSession(h, [
      { peerId: 'peer-a', displayName: '가' },
      { peerId: 'peer-b', displayName: '나' },
    ]);
    const [first, second] = h.peerConnections;
    second!.senders[0]!.replaceTrackErrors.push(
      new DOMException('교체 불가', 'InvalidModificationError'),
    );
    expect(await h.session.selectInputDevice('audio', 'other')).toBe(false);
    expect(first!.senders[0]!.replacements).toEqual([h.next, h.audioTrack]);
    expect(h.audioTrack.stopped).toBe(false);
    expect(h.next.stopped).toBe(true);
    expect(h.session.getLocalStream()?.getAudioTracks()).toEqual([h.audioTrack]);
    expect(h.peerConnections).toHaveLength(2);
  });

  it('권한 거부 시 기존 장치를 그대로 사용한다', async () => {
    const h = deviceHarness();
    await joinSession(h);
    h.getUserMedia.mockRejectedValueOnce(new DOMException('거부됨', 'NotAllowedError'));
    expect(await h.session.selectInputDevice('audio', 'other')).toBe(false);
    expect(h.audioTrack.stopped).toBe(false);
    expect(h.session.getSnapshot().status).toBe('active');
  });

  it('퇴장 뒤 늦게 받은 트랙을 즉시 정리한다', async () => {
    const h = deviceHarness();
    await joinSession(h);
    const gate = createPromiseGate();
    h.getUserMedia.mockImplementationOnce(async () => {
      await gate.promise;
      return h.stream;
    });
    const changing = h.session.selectInputDevice('audio', 'other');
    await h.session.leave();
    gate.resolve();
    expect(await changing).toBe(false);
    expect(h.next.stopped).toBe(true);
    expect(h.session.getLocalStream()).toBeNull();
  });

  it.each(['사용자 음소거', '방장 음소거'] as const)(
    '교체 대기 중 %s를 새 트랙에도 반영한다',
    async (action) => {
      const h = deviceHarness();
      await joinSession(h, [{ peerId: 'peer-a', displayName: '방장', role: 'host' }]);
      const gate = createPromiseGate();
      h.peerConnections[0]!.senders[0]!.replaceTrackGates.push(gate.promise);
      const changing = h.session.selectInputDevice('audio', 'other');
      await flushMicrotasks();
      expect(h.next.enabled).toBe(false);
      if (action === '사용자 음소거') h.session.toggleAudio();
      else {
        h.socket.serverMessage({
          v: PROTOCOL_VERSION,
          type: 'moderation.media.disabled',
          roomId: ROOM_ID,
          from: 'peer-a',
          payload: { targetPeerId: 'self', kind: 'audio' },
        });
        await flushMicrotasks();
      }
      gate.resolve();
      expect(await changing).toBe(true);
      expect(h.next.enabled).toBe(false);
    },
  );

  it('송신자 교체 대기 중 퇴장하면 새 트랙을 바로 끈다', async () => {
    const h = deviceHarness();
    await joinSession(h, [{ peerId: 'peer-a', displayName: '참가자' }]);
    const gate = createPromiseGate();
    h.peerConnections[0]!.senders[0]!.replaceTrackGates.push(gate.promise);
    const changing = h.session.selectInputDevice('audio', 'other');
    await flushMicrotasks();
    await h.session.leave();
    expect(h.next.stopped).toBe(true);
    expect(await changing).toBe(false);
    gate.resolve();
    expect(h.session.getSnapshot().status).toBe('ended');
  });

  it('교체 중 새로 입장한 참가자도 새 트랙을 받는다', async () => {
    const h = deviceHarness();
    await joinSession(h, [{ peerId: 'peer-a', displayName: '참가자' }]);
    const gate = createPromiseGate();
    h.peerConnections[0]!.senders[0]!.replaceTrackGates.push(gate.promise);
    const changing = h.session.selectInputDevice('audio', 'other');
    await flushMicrotasks();
    h.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'peer.joined',
      roomId: ROOM_ID,
      payload: { participant: { peerId: 'peer-b', displayName: '새 참가자' } },
    });
    await flushMicrotasks();
    gate.resolve();
    expect(await changing).toBe(true);
    expect(h.peerConnections).toHaveLength(2);
    expect(h.peerConnections[1]!.senders[0]!.track).toBe(h.next);
  });

  it('기존 트랙 복원까지 실패한 연결만 다시 만든다', async () => {
    const h = deviceHarness();
    await joinSession(
      h,
      [
        { peerId: 'peer-a', displayName: '가' },
        { peerId: 'peer-b', displayName: '나' },
      ],
      'aaa',
    );
    const [first, second] = h.peerConnections;
    const originalReplace = first!.senders[0]!.replaceTrack.bind(first!.senders[0]!);
    vi.spyOn(first!.senders[0]!, 'replaceTrack').mockImplementation(async (track) => {
      if (track === (h.audioTrack as unknown as MediaStreamTrack)) throw new Error('복원 실패');
      return originalReplace(track);
    });
    second!.senders[0]!.replaceTrackErrors.push(new Error('교체 실패'));
    expect(await h.session.selectInputDevice('audio', 'other')).toBe(false);
    expect(first!.closed).toBe(true);
    expect(second!.closed).toBe(false);
    expect(h.peerConnections[2]!.addedTracks).toContain(h.audioTrack);
    expect(h.session.getSnapshot().warning?.code).toBe('media-device-sender-recovery');
    h.peerConnections[2]!.setConnectionState('connected');
    expect(h.session.getSnapshot().warning).toBeNull();
  });

  it('장치 없이 입장한 뒤 첫 트랙만 추가 협상하고 채팅 연결은 유지한다', async () => {
    const h = deviceHarness('audio', true);
    await joinSession(h, [{ peerId: 'peer-a', displayName: '참가자' }]);
    await answerPeer(h, 'peer-a');
    const peer = h.peerConnections[0]!;
    const offers = peer.offerOptions.length;
    expect(await h.session.selectInputDevice('audio', '')).toBe(true);
    await flushMicrotasks();
    expect(peer.addedTracks).toEqual([h.next]);
    expect(peer.offerOptions.length).toBeGreaterThan(offers);
    expect(peer.channels[0]!.readyState).toBe('open');
    expect(h.session.getSnapshot().localMedia.audioEnabled).toBe(true);
  });

  it('화면 공유 중에는 마이크만 교체할 수 있다', async () => {
    const h = deviceHarness();
    await joinSession(h, [{ peerId: 'peer-a', displayName: '참가자' }]);
    expect(await h.session.startScreenShare()).toBe('started');
    expect(await h.session.selectInputDevice('video', 'camera')).toBe(false);
    expect(h.getUserMedia).not.toHaveBeenCalled();
    expect(await h.session.selectInputDevice('audio', 'mic')).toBe(true);
    expect(h.session.getSnapshot().screenSharing).toBe(true);
  });

  it.each(['교체', '복원'] as const)(
    '%s 대기 중 피어가 퇴장해도 남은 통화를 유지한다',
    async (phase) => {
      const h = deviceHarness();
      await joinSession(h, [
        { peerId: 'peer-a', displayName: '가' },
        { peerId: 'peer-b', displayName: '나' },
      ]);
      const [first, second] = h.peerConnections;
      const pending = new Promise<void>(() => {});
      const target = phase === '교체' ? second! : first!;
      if (phase === '교체') {
        target.senders[0]!.replaceTrackGates.push(pending);
      } else {
        first!.senders[0]!.replaceTrackGates.push(Promise.resolve(), pending);
        second!.senders[0]!.replaceTrackErrors.push(new Error('교체 실패'));
      }
      const changing = h.session.selectInputDevice('audio', 'mic');
      await vi.waitFor(() =>
        expect(target.senders[0]!.replaceTrackCalls).toHaveLength(phase === '교체' ? 1 : 2),
      );
      h.socket.serverMessage({
        v: PROTOCOL_VERSION,
        type: 'peer.left',
        roomId: ROOM_ID,
        payload: { peerId: phase === '교체' ? 'peer-b' : 'peer-a' },
      });
      expect(await changing).toBe(phase === '교체');
      const remaining = phase === '교체' ? first! : second!;
      expect(remaining.senders[0]!.track).toBe(phase === '교체' ? h.next : h.audioTrack);
      expect(remaining.senders[0]!.track?.enabled).toBe(true);
      expect(remaining.channels[0]!.readyState).toBe('open');
      expect(await h.session.startScreenShare()).toBe('started');
    },
  );

  it.each(['시작', '중지'] as const)(
    '화면 공유 %s 대기 중 피어가 퇴장해도 전환을 마친다',
    async (phase) => {
      const h = deviceHarness();
      await joinSession(h, [
        { peerId: 'peer-a', displayName: '가' },
        { peerId: 'peer-b', displayName: '나' },
      ]);
      if (phase === '중지') expect(await h.session.startScreenShare()).toBe('started');
      const sender = h.peerConnections[1]!.senders.find((item) => item.track?.kind === 'video')!;
      sender.replaceTrackGates.push(new Promise<void>(() => {}));
      const sharing = phase === '시작' ? h.session.startScreenShare() : h.session.stopScreenShare();
      await vi.waitFor(() =>
        expect(sender.replaceTrackCalls).toHaveLength(phase === '시작' ? 1 : 2),
      );
      h.socket.serverMessage({
        v: PROTOCOL_VERSION,
        type: 'peer.left',
        roomId: ROOM_ID,
        payload: { peerId: 'peer-b' },
      });
      expect(await sharing).toBe(phase === '시작' ? 'started' : true);
      expect(h.session.getSnapshot().screenSharing).toBe(phase === '시작');
      expect(
        h.peerConnections[0]!.senders.find((item) => item.track?.kind === 'video')!.track,
      ).toBe(h.session.getLocalStream()!.getVideoTracks()[0]);
      expect(await h.session.selectInputDevice('audio', 'mic')).toBe(true);
    },
  );

  it.each(['브라우저', '앱'] as const)(
    '화면 공유 중 마이크를 교체한 뒤 %s에서 공유를 종료하면 경고와 화면 리스너가 남지 않는다',
    async (source) => {
      const h = deviceHarness();
      await joinSession(h, [{ peerId: 'peer-a', displayName: '참가자' }]);
      expect(await h.session.startScreenShare()).toBe('started');
      const screenTrack = h.session.getLocalStream()!.getVideoTracks()[0] as unknown as FakeTrack;
      expect(await h.session.selectInputDevice('audio', 'mic')).toBe(true);

      if (source === '브라우저') {
        screenTrack.end();
        await flushMicrotasks();
      } else {
        expect(await h.session.stopScreenShare()).toBe(true);
      }

      expect(screenTrack.endedListenerCount()).toBe(0);
      expect(h.session.getSnapshot()).toMatchObject({ screenSharing: false, warning: null });
      expect(
        h.peerConnections[0]!.senders.find((sender) => sender.track?.kind === 'video')?.track,
      ).toBe(h.videoTrack);
      expect(h.next.endedListenerCount()).toBe(1);
    },
  );

  it('교체 도중 트랙이 종료되면 기존 트랙으로 복원한다', async () => {
    const h = deviceHarness();
    await joinSession(h, [{ peerId: 'peer-a', displayName: '참가자' }]);
    const gate = createPromiseGate();
    const sender = h.peerConnections[0]!.senders[0]!;
    sender.replaceTrackGates.push(gate.promise);
    const changing = h.session.selectInputDevice('audio', 'other');
    await flushMicrotasks();
    h.next.end();
    gate.resolve();
    expect(await changing).toBe(false);
    expect(sender.track).toBe(h.audioTrack);
    expect(h.audioTrack.stopped).toBe(false);
  });
});
