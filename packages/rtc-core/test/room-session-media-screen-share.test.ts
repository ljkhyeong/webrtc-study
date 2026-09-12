import { describe, expect, it, vi } from 'vitest';

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
} from './room-session.test-support.js';

describe('RoomSession', () => {
  it('toggles local tracks and announces media state', async () => {
    const harness = createHarness();
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
    const channel = harness.peerConnections[0]?.channels[0];
    expect(channel).toBeDefined();

    expect(harness.session.toggleAudio()).toBe(false);
    expect(harness.session.toggleVideo()).toBe(false);

    expect(harness.audioTrack.enabled).toBe(false);
    expect(harness.videoTrack.enabled).toBe(false);
    expect(harness.session.getSnapshot().localMedia).toMatchObject({
      audioEnabled: false,
      videoEnabled: false,
    });
    expect(channel?.sent.map((raw) => JSON.parse(raw)).slice(-2)).toEqual([
      {
        type: 'participant.media',
        audioEnabled: false,
        videoEnabled: true,
        videoSource: 'camera',
      },
      {
        type: 'participant.media',
        audioEnabled: false,
        videoEnabled: false,
        videoSource: 'camera',
      },
    ]);
  });

  it('publishes ended local tracks as unavailable and detaches their listeners', async () => {
    const harness = createHarness();
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
    const channel = harness.peerConnections[0]?.channels[0];
    if (channel === undefined) {
      throw new Error('Expected an initial DataChannel');
    }
    expect(harness.audioTrack.endedListenerCount()).toBe(1);
    expect(harness.videoTrack.endedListenerCount()).toBe(1);

    harness.audioTrack.end();

    expect(harness.session.getLocalStream()?.getAudioTracks()).toEqual([]);
    expect(harness.session.getSnapshot()).toMatchObject({
      localMedia: {
        audioAvailable: false,
        audioEnabled: false,
        videoAvailable: true,
        videoEnabled: true,
      },
      participants: expect.arrayContaining([
        expect.objectContaining({
          peerId: 'self',
          audioEnabled: false,
          videoEnabled: true,
        }),
      ]),
      warning: { code: 'local-media-ended' },
    });
    expect(harness.session.toggleAudio()).toBe(false);
    expect(
      channel.sent
        .map((raw) => JSON.parse(raw) as { type: string; audioEnabled?: boolean })
        .filter(({ type }) => type === 'participant.media')
        .at(-1),
    ).toEqual({
      type: 'participant.media',
      audioEnabled: false,
      videoEnabled: true,
      videoSource: 'camera',
    });

    harness.videoTrack.end();

    expect(harness.session.getLocalStream()?.getVideoTracks()).toEqual([]);
    expect(harness.session.getSnapshot().localMedia).toEqual({
      audioAvailable: false,
      audioEnabled: false,
      videoAvailable: false,
      videoEnabled: false,
      videoSource: 'camera',
    });
    expect(harness.session.toggleVideo()).toBe(false);
    expect(
      channel.sent
        .map(
          (raw) =>
            JSON.parse(raw) as {
              type: string;
              audioEnabled?: boolean;
              videoEnabled?: boolean;
            },
        )
        .filter(({ type }) => type === 'participant.media')
        .at(-1),
    ).toEqual({
      type: 'participant.media',
      audioEnabled: false,
      videoEnabled: false,
      videoSource: 'camera',
    });
    expect(harness.audioTrack.endedListenerCount()).toBe(0);
    expect(harness.videoTrack.endedListenerCount()).toBe(0);

    await harness.session.leave();

    expect(harness.session.getSnapshot()).toMatchObject({
      status: 'ended',
      warning: null,
    });
    expect(harness.audioTrack.endedListenerCount()).toBe(0);
    expect(harness.videoTrack.endedListenerCount()).toBe(0);
  });

  it('운영 경고를 먼저 표시하고 해결되면 남아 있는 장치 단절 경고를 표시한다', async () => {
    const harness = createHarness();
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
    const peer = harness.peerConnections[0];
    if (peer === undefined) {
      throw new Error('Expected an initial peer connection');
    }
    peer.setConfigurationError = new DOMException(
      'configuration rejected',
      'InvalidModificationError',
    );
    harness.session.updateRtcConfiguration({
      iceServers: [{ urls: 'turn:refreshed.example.test' }],
    });

    harness.audioTrack.end();

    expect(harness.session.getSnapshot()).toMatchObject({
      localMedia: {
        audioAvailable: false,
        audioEnabled: false,
        videoAvailable: true,
        videoEnabled: true,
      },
      warning: {
        code: 'rtc-configuration-update-failed',
      },
    });
    peer.setConfigurationError = null;
    harness.session.updateRtcConfiguration({
      iceServers: [{ urls: 'turn:refreshed.example.test' }],
    });
    expect(harness.session.getSnapshot().warning?.code).toBe('local-media-ended');
    await harness.session.leave();
  });

  it('classifies a denied display picker as a recoverable user cancellation', async () => {
    const harness = createHarness({
      getDisplayMedia: vi.fn(async () => {
        throw new DOMException('User cancelled the picker', 'NotAllowedError');
      }),
    });
    await joinSession(harness);

    await expect(harness.session.startScreenShare()).resolves.toBe('cancelled');
    expect(harness.session.getSnapshot()).toMatchObject({
      status: 'active',
      screenSharing: false,
      warning: null,
      error: null,
    });
    await harness.session.leave();
  });

  it('reports an operational display-capture rejection as a start failure', async () => {
    const harness = createHarness({
      getDisplayMedia: vi.fn(async () => {
        throw new DOMException('The display source could not be read', 'NotReadableError');
      }),
    });
    await joinSession(harness);

    await expect(harness.session.startScreenShare()).resolves.toBe('failed');
    expect(harness.session.getSnapshot()).toMatchObject({
      status: 'active',
      screenSharing: false,
      warning: null,
      error: null,
    });
    await harness.session.leave();
  });

  it('reports a display stream without a live video track as a start failure', async () => {
    const harness = createHarness({
      getDisplayMedia: vi.fn(async () => new FakeMediaStream([]) as unknown as MediaStream),
    });
    await joinSession(harness);

    await expect(harness.session.startScreenShare()).resolves.toBe('failed');
    expect(harness.session.getSnapshot().screenSharing).toBe(false);
    await harness.session.leave();
  });

  it('공유 전에 문서 품질을 선택하고 공유 중 변경을 차단한다', async () => {
    const screenTrack = Object.assign(new FakeTrack('video'), { contentHint: '' });
    const getDisplayMedia = vi.fn(
      async () => new FakeMediaStream([screenTrack]) as unknown as MediaStream,
    );
    const harness = createHarness({ getDisplayMedia });
    await joinSession(harness);
    expect(harness.session.setScreenShareQuality('text')).toBe(true);
    await expect(harness.session.startScreenShare()).resolves.toBe('started');
    expect(getDisplayMedia).toHaveBeenCalledWith({
      video: {
        width: { ideal: 1920, max: 1920 },
        height: { ideal: 1080, max: 1080 },
        frameRate: { ideal: 10, max: 10 },
      },
      audio: false,
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
    });
    expect(screenTrack.contentHint).toBe('text');
    expect(harness.session.setScreenShareQuality('standard')).toBe(false);
    expect(harness.session.getSnapshot().screenShareQuality).toBe('text');
    await harness.session.stopScreenShare();
    expect(harness.session.getLocalStream()?.getVideoTracks()).toContain(harness.videoTrack);
    await harness.session.leave();
  });

  it('replaces camera senders with screen video and restores the disabled camera state', async () => {
    const screenTrack = Object.assign(new FakeTrack('video'), { contentHint: '' });
    const displayStream = new FakeMediaStream([screenTrack]);
    const getDisplayMedia = vi.fn(async () => displayStream as unknown as MediaStream);
    const harness = createHarness({ getDisplayMedia });
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
    const firstPeer = harness.peerConnections[0];
    const channel = firstPeer?.channels[0];
    const cameraSender = firstPeer?.senders.find(
      (sender) => sender.track === (harness.videoTrack as unknown as MediaStreamTrack),
    );
    if (firstPeer === undefined || channel === undefined || cameraSender === undefined) {
      throw new Error('Expected a camera sender and open DataChannel');
    }

    expect(harness.session.getSnapshot()).toMatchObject({
      screenShareAvailable: true,
      screenSharing: false,
      localMedia: { videoSource: 'camera' },
    });
    expect(harness.session.toggleVideo()).toBe(false);
    expect(harness.videoTrack.enabled).toBe(false);

    await expect(harness.session.startScreenShare()).resolves.toBe('started');

    expect(getDisplayMedia).toHaveBeenCalledWith({
      video: {
        width: { ideal: 1280, max: 1280 },
        height: { ideal: 720, max: 720 },
        frameRate: { ideal: 15, max: 15 },
      },
      audio: false,
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
    });
    expect(screenTrack.contentHint).toBe('detail');
    expect(cameraSender.track).toBe(screenTrack as unknown as MediaStreamTrack);
    expect(harness.session.getLocalStream()?.getVideoTracks()).toEqual([
      screenTrack as unknown as MediaStreamTrack,
    ]);
    expect(harness.session.getSnapshot()).toMatchObject({
      screenShareAvailable: true,
      screenSharing: true,
      localMedia: {
        videoAvailable: true,
        videoEnabled: true,
        videoSource: 'screen',
      },
      participants: expect.arrayContaining([
        expect.objectContaining({
          peerId: 'self',
          videoEnabled: true,
          videoSource: 'screen',
        }),
      ]),
    });
    const mediaFramesBeforeToggle = channel.sent.filter(
      (raw) => (JSON.parse(raw) as { type: string }).type === 'participant.media',
    ).length;
    expect(harness.session.toggleVideo()).toBe(false);
    expect(screenTrack.enabled).toBe(true);
    expect(
      channel.sent.filter(
        (raw) => (JSON.parse(raw) as { type: string }).type === 'participant.media',
      ),
    ).toHaveLength(mediaFramesBeforeToggle);

    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'peer.joined',
      roomId: ROOM_ID,
      payload: {
        participant: { peerId: 'peer-b', displayName: 'Bo', role: 'participant' },
      },
    });
    const secondPeer = harness.peerConnections[1];
    expect(secondPeer?.addedTracks).toContain(screenTrack as unknown as MediaStreamTrack);

    await expect(harness.session.stopScreenShare()).resolves.toBe(true);

    expect(cameraSender.track).toBe(harness.videoTrack as unknown as MediaStreamTrack);
    expect(secondPeer?.senders.find((sender) => sender.track?.kind === 'video')?.track).toBe(
      harness.videoTrack as unknown as MediaStreamTrack,
    );
    expect(harness.videoTrack.enabled).toBe(false);
    expect(screenTrack.stopped).toBe(true);
    expect(screenTrack.endedListenerCount()).toBe(0);
    expect(harness.session.getLocalStream()?.getVideoTracks()).toEqual([
      harness.videoTrack as unknown as MediaStreamTrack,
    ]);
    expect(harness.session.getSnapshot()).toMatchObject({
      screenSharing: false,
      localMedia: {
        videoEnabled: false,
        videoSource: 'camera',
      },
    });
    expect(
      channel.sent
        .map((raw) => JSON.parse(raw) as { type: string })
        .filter(({ type }) => type === 'participant.media')
        .at(-1),
    ).toEqual({
      type: 'participant.media',
      audioEnabled: true,
      videoEnabled: false,
      videoSource: 'camera',
    });
    await expect(harness.session.stopScreenShare()).resolves.toBe(false);
    await harness.session.leave();
  });

  it('restores the camera when the browser ends the display track', async () => {
    const screenTrack = new FakeTrack('video');
    const harness = createHarness({
      getDisplayMedia: vi.fn(
        async () => new FakeMediaStream([screenTrack]) as unknown as MediaStream,
      ),
    });
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
    const cameraSender = harness.peerConnections[0]?.senders.find(
      (sender) => sender.track === (harness.videoTrack as unknown as MediaStreamTrack),
    );
    if (cameraSender === undefined) {
      throw new Error('Expected a camera sender');
    }
    await harness.session.startScreenShare();

    screenTrack.end();
    await flushMicrotasks();

    expect(cameraSender.track).toBe(harness.videoTrack as unknown as MediaStreamTrack);
    expect(screenTrack.stopped).toBe(true);
    expect(screenTrack.endedListenerCount()).toBe(0);
    expect(harness.session.getSnapshot()).toMatchObject({
      screenSharing: false,
      localMedia: { videoEnabled: true, videoSource: 'camera' },
    });
    await harness.session.leave();
  });

  it('joins duplicate stop requests to the browser-ended screen stop operation', async () => {
    const screenTrack = new FakeTrack('video');
    const stopGate = createPromiseGate();
    const harness = createHarness({
      getDisplayMedia: vi.fn(
        async () => new FakeMediaStream([screenTrack]) as unknown as MediaStream,
      ),
    });
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
    const peer = harness.peerConnections[0];
    const cameraSender = peer?.senders.find(
      (sender) => sender.track === (harness.videoTrack as unknown as MediaStreamTrack),
    );
    const channel = peer?.channels[0];
    if (cameraSender === undefined || channel === undefined) {
      throw new Error('Expected a camera sender and DataChannel');
    }
    await harness.session.startScreenShare();
    cameraSender.replaceTrackCalls.length = 0;
    cameraSender.replacements.length = 0;
    cameraSender.replaceTrackGates.push(stopGate.promise);
    const mediaFramesBeforeStop = channel.sent.filter(
      (raw) => (JSON.parse(raw) as { type: string }).type === 'participant.media',
    ).length;
    let reentrantStop: Promise<boolean> | null = null;
    const unsubscribe = harness.session.subscribe((snapshot) => {
      if (!snapshot.screenSharing && reentrantStop === null) {
        reentrantStop = harness.session.stopScreenShare();
      }
    });

    screenTrack.end();
    await flushMicrotasks();
    const firstStop = harness.session.stopScreenShare();
    const duplicateStop = harness.session.stopScreenShare();

    expect(duplicateStop).toBe(firstStop);
    expect(reentrantStop).toBe(firstStop);
    expect(cameraSender.replaceTrackCalls).toEqual([
      harness.videoTrack as unknown as MediaStreamTrack,
    ]);
    await expect(harness.session.startScreenShare()).resolves.toBe('cancelled');
    expect(harness.session.getSnapshot()).toMatchObject({
      screenSharing: false,
      localMedia: { videoSource: 'camera' },
    });

    stopGate.resolve();
    await expect(firstStop).resolves.toBe(true);
    await expect(duplicateStop).resolves.toBe(true);
    expect(cameraSender.replacements).toEqual([harness.videoTrack as unknown as MediaStreamTrack]);
    expect(
      channel.sent.filter(
        (raw) => (JSON.parse(raw) as { type: string }).type === 'participant.media',
      ),
    ).toHaveLength(mediaFramesBeforeStop + 1);
    unsubscribe();
    await harness.session.leave();
  });

  it('escalates an in-flight user stop when video moderation disables the camera', async () => {
    const screenTrack = new FakeTrack('video');
    const stopGate = createPromiseGate();
    const harness = createHarness({
      getDisplayMedia: vi.fn(
        async () => new FakeMediaStream([screenTrack]) as unknown as MediaStream,
      ),
    });
    await joinSession(harness, [{ peerId: 'host-peer', displayName: 'Host', role: 'host' }]);
    const cameraSender = harness.peerConnections[0]?.senders.find(
      (sender) => sender.track === (harness.videoTrack as unknown as MediaStreamTrack),
    );
    if (cameraSender === undefined) {
      throw new Error('Expected a camera sender');
    }
    await harness.session.startScreenShare();
    cameraSender.replaceTrackCalls.length = 0;
    cameraSender.replaceTrackGates.push(stopGate.promise);

    const firstStop = harness.session.stopScreenShare();
    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'moderation.media.disabled',
      roomId: ROOM_ID,
      from: 'host-peer',
      payload: { targetPeerId: 'self', kind: 'video' },
    });
    await flushMicrotasks();

    expect(harness.session.stopScreenShare()).toBe(firstStop);
    expect(cameraSender.replaceTrackCalls).toEqual([
      harness.videoTrack as unknown as MediaStreamTrack,
    ]);
    expect(harness.videoTrack.enabled).toBe(false);
    expect(harness.session.getSnapshot()).toMatchObject({
      screenSharing: false,
      localMedia: { videoEnabled: false, videoSource: 'camera' },
      lastModerationNotice: { kind: 'video' },
    });

    stopGate.resolve();
    await expect(firstStop).resolves.toBe(true);
    expect(cameraSender.track).toBe(harness.videoTrack as unknown as MediaStreamTrack);
    expect(harness.videoTrack.enabled).toBe(false);
    await harness.session.leave();
  });

  it('invalidates a pending display picker immediately on video moderation', async () => {
    const screenTrack = new FakeTrack('video');
    const pickerGate = createPromiseGate();
    const getDisplayMedia = vi.fn(async () => {
      await pickerGate.promise;
      return new FakeMediaStream([screenTrack]) as unknown as MediaStream;
    });
    const harness = createHarness({ getDisplayMedia });
    await joinSession(harness, [{ peerId: 'host-peer', displayName: 'Host', role: 'host' }]);
    const cameraSender = harness.peerConnections[0]?.senders.find(
      (sender) => sender.track === (harness.videoTrack as unknown as MediaStreamTrack),
    );
    if (cameraSender === undefined) {
      throw new Error('Expected a camera sender');
    }

    const starting = harness.session.startScreenShare();
    await flushMicrotasks();
    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'moderation.media.disabled',
      roomId: ROOM_ID,
      from: 'host-peer',
      payload: { targetPeerId: 'self', kind: 'video' },
    });
    await flushMicrotasks();

    expect(getDisplayMedia).toHaveBeenCalledOnce();
    expect(harness.videoTrack.enabled).toBe(false);
    expect(harness.session.getSnapshot()).toMatchObject({
      screenSharing: false,
      localMedia: { videoEnabled: false, videoSource: 'camera' },
      lastModerationNotice: { kind: 'video' },
    });
    expect(cameraSender.replaceTrackCalls).toEqual([]);

    pickerGate.resolve();
    await expect(starting).resolves.toBe('cancelled');
    expect(screenTrack.stopped).toBe(true);
    expect(cameraSender.track).toBe(harness.videoTrack as unknown as MediaStreamTrack);
    expect(harness.session.getSnapshot().screenSharing).toBe(false);
    await harness.session.leave();
  });

  it('rolls a pending screen sender replacement back after video moderation', async () => {
    const screenTrack = new FakeTrack('video');
    const replaceGate = createPromiseGate();
    const harness = createHarness({
      getDisplayMedia: vi.fn(
        async () => new FakeMediaStream([screenTrack]) as unknown as MediaStream,
      ),
    });
    await joinSession(harness, [{ peerId: 'host-peer', displayName: 'Host', role: 'host' }]);
    const cameraSender = harness.peerConnections[0]?.senders.find(
      (sender) => sender.track === (harness.videoTrack as unknown as MediaStreamTrack),
    );
    if (cameraSender === undefined) {
      throw new Error('Expected a camera sender');
    }
    cameraSender.replaceTrackGates.push(replaceGate.promise);

    const starting = harness.session.startScreenShare();
    await flushMicrotasks();
    expect(cameraSender.replaceTrackCalls).toEqual([screenTrack as unknown as MediaStreamTrack]);

    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'moderation.media.disabled',
      roomId: ROOM_ID,
      from: 'host-peer',
      payload: { targetPeerId: 'self', kind: 'video' },
    });
    await flushMicrotasks();

    expect(screenTrack.stopped).toBe(true);
    expect(harness.videoTrack.enabled).toBe(false);
    expect(harness.session.getSnapshot()).toMatchObject({
      screenSharing: false,
      localMedia: { videoEnabled: false, videoSource: 'camera' },
    });

    replaceGate.resolve();
    await expect(starting).resolves.toBe('cancelled');
    expect(cameraSender.replaceTrackCalls).toEqual([
      screenTrack as unknown as MediaStreamTrack,
      harness.videoTrack as unknown as MediaStreamTrack,
    ]);
    expect(cameraSender.track).toBe(harness.videoTrack as unknown as MediaStreamTrack);
    expect(harness.videoTrack.enabled).toBe(false);
    await harness.session.leave();
  });

  it('recreates a sender when cancellation rollback cannot restore the camera', async () => {
    const screenTrack = new FakeTrack('video');
    const replaceGate = createPromiseGate();
    const harness = createHarness({
      getDisplayMedia: vi.fn(
        async () => new FakeMediaStream([screenTrack]) as unknown as MediaStream,
      ),
    });
    await joinSession(harness, [{ peerId: 'host-peer', displayName: 'Host', role: 'host' }]);
    const failedPeer = harness.peerConnections[0];
    const cameraSender = failedPeer?.senders.find(
      (sender) => sender.track === (harness.videoTrack as unknown as MediaStreamTrack),
    );
    if (failedPeer === undefined || cameraSender === undefined) {
      throw new Error('Expected a camera sender');
    }
    cameraSender.replaceTrackGates.push(replaceGate.promise);
    cameraSender.replaceTrackErrors.push(undefined, new Error('camera rollback failed'));

    const starting = harness.session.startScreenShare();
    await flushMicrotasks();
    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'moderation.media.disabled',
      roomId: ROOM_ID,
      from: 'host-peer',
      payload: { targetPeerId: 'self', kind: 'video' },
    });
    await flushMicrotasks();

    replaceGate.resolve();
    await expect(starting).resolves.toBe('cancelled');
    await flushMicrotasks();

    const replacementPeer = harness.peerConnections[1];
    const replacementVideo = replacementPeer?.addedTracks.find((track) => track.kind === 'video');
    expect(failedPeer.closed).toBe(true);
    expect(cameraSender.track).toBe(screenTrack as unknown as MediaStreamTrack);
    expect(replacementVideo).toBe(harness.videoTrack as unknown as MediaStreamTrack);
    expect(replacementVideo?.enabled).toBe(false);
    expect(screenTrack.stopped).toBe(true);
    expect(harness.session.getSnapshot()).toMatchObject({
      screenSharing: false,
      localMedia: { videoEnabled: false, videoSource: 'camera' },
      warning: { code: 'screen-share-sender-recovery' },
    });
    await harness.session.leave();
  });

  it('stops a display track returned after leave invalidates the pending picker', async () => {
    const screenTrack = new FakeTrack('video');
    const pickerGate = createPromiseGate();
    const harness = createHarness({
      getDisplayMedia: vi.fn(async () => {
        await pickerGate.promise;
        return new FakeMediaStream([screenTrack]) as unknown as MediaStream;
      }),
    });
    await joinSession(harness);

    const starting = harness.session.startScreenShare();
    await flushMicrotasks();
    await harness.session.leave();

    expect(harness.session.getSnapshot().status).toBe('ended');
    await expect(harness.session.startScreenShare()).resolves.toBe('cancelled');
    pickerGate.resolve();
    await expect(starting).resolves.toBe('cancelled');
    expect(screenTrack.stopped).toBe(true);
    expect(harness.session.getLocalStream()).toBeNull();
    expect(harness.session.getSnapshot()).toMatchObject({
      status: 'ended',
      screenSharing: false,
    });
  });

  it('ignores a pending screen sender replacement after leave disposes its peer', async () => {
    const screenTrack = new FakeTrack('video');
    const replaceGate = createPromiseGate();
    const harness = createHarness({
      getDisplayMedia: vi.fn(
        async () => new FakeMediaStream([screenTrack]) as unknown as MediaStream,
      ),
    });
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
    const disposedPeer = harness.peerConnections[0];
    const cameraSender = disposedPeer?.senders.find(
      (sender) => sender.track === (harness.videoTrack as unknown as MediaStreamTrack),
    );
    if (disposedPeer === undefined || cameraSender === undefined) {
      throw new Error('Expected a camera sender');
    }
    cameraSender.replaceTrackGates.push(replaceGate.promise);

    const starting = harness.session.startScreenShare();
    await flushMicrotasks();
    await harness.session.leave();

    expect(disposedPeer.closed).toBe(true);
    expect(screenTrack.stopped).toBe(true);
    replaceGate.resolve();
    await expect(starting).resolves.toBe('cancelled');
    expect(harness.peerConnections).toHaveLength(1);
    expect(harness.session.getSnapshot()).toMatchObject({
      status: 'ended',
      screenSharing: false,
      warning: null,
    });
  });

  it('recreates a failed screen sender and reports an active recovering share', async () => {
    const screenTrack = new FakeTrack('video');
    const harness = createHarness({
      getDisplayMedia: vi.fn(
        async () => new FakeMediaStream([screenTrack]) as unknown as MediaStream,
      ),
    });
    await joinSession(harness, [{ peerId: 'z-peer', displayName: 'Ara' }], 'a-self');
    const failedPeer = harness.peerConnections[0];
    const cameraSender = failedPeer?.senders.find(
      (sender) => sender.track === (harness.videoTrack as unknown as MediaStreamTrack),
    );
    if (failedPeer === undefined || cameraSender === undefined) {
      throw new Error('Expected a camera sender');
    }
    const offersBeforeRecovery = harness.socket.messagesOfType('rtc.offer').length;
    cameraSender.replaceTrackErrors.push(new Error('screen sender failed'));

    await expect(harness.session.startScreenShare()).resolves.toBe('recovering');
    await flushMicrotasks();

    const replacementPeer = harness.peerConnections[1];
    expect(failedPeer.closed).toBe(true);
    expect(replacementPeer?.addedTracks).toContain(screenTrack as unknown as MediaStreamTrack);
    expect(harness.socket.messagesOfType('rtc.offer')).toHaveLength(offersBeforeRecovery + 1);
    expect(harness.session.getSnapshot()).toMatchObject({
      screenSharing: true,
      localMedia: { videoSource: 'screen' },
      warning: { code: 'screen-share-sender-recovery' },
    });
    await harness.session.stopScreenShare();
    await harness.session.leave();
  });

  it('recreates a failed camera restore sender and reports a non-successful stop', async () => {
    const screenTrack = new FakeTrack('video');
    const harness = createHarness({
      getDisplayMedia: vi.fn(
        async () => new FakeMediaStream([screenTrack]) as unknown as MediaStream,
      ),
    });
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
    const failedPeer = harness.peerConnections[0];
    const videoSender = failedPeer?.senders.find(
      (sender) => sender.track === (harness.videoTrack as unknown as MediaStreamTrack),
    );
    if (failedPeer === undefined || videoSender === undefined) {
      throw new Error('Expected a video sender');
    }
    await harness.session.startScreenShare();
    const offersBeforeRecovery = harness.socket.messagesOfType('rtc.offer').length;
    videoSender.replaceTrackErrors.push(new Error('camera restore failed'));

    await expect(harness.session.stopScreenShare()).resolves.toBe(false);
    await flushMicrotasks();

    const replacementPeer = harness.peerConnections[1];
    expect(failedPeer.closed).toBe(true);
    expect(replacementPeer?.addedTracks).toContain(
      harness.videoTrack as unknown as MediaStreamTrack,
    );
    expect(harness.socket.messagesOfType('rtc.offer')).toHaveLength(offersBeforeRecovery);
    expect(screenTrack.stopped).toBe(true);
    expect(harness.session.getSnapshot()).toMatchObject({
      screenSharing: false,
      localMedia: { videoSource: 'camera' },
      warning: { code: 'screen-share-sender-recovery' },
    });
    await harness.session.leave();
  });

  it('shares to an existing peer without a camera and restores the media-less stream', async () => {
    const screenTrack = new FakeTrack('video');
    const harness = createHarness({
      preparedMediaStream: null,
      getDisplayMedia: vi.fn(
        async () => new FakeMediaStream([screenTrack]) as unknown as MediaStream,
      ),
    });
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
    await answerPeer(harness, 'peer-a');
    const peer = harness.peerConnections[0];
    if (peer === undefined) {
      throw new Error('Expected a peer connection');
    }
    const offersBeforeShare = harness.socket.messagesOfType('rtc.offer').length;

    await expect(harness.session.startScreenShare()).resolves.toBe('started');
    await flushMicrotasks();

    const screenSender = peer.senders.find(
      (sender) => sender.track === (screenTrack as unknown as MediaStreamTrack),
    );
    expect(screenSender).toBeDefined();
    expect(harness.session.getLocalStream()?.getVideoTracks()).toEqual([
      screenTrack as unknown as MediaStreamTrack,
    ]);
    expect(harness.socket.messagesOfType('rtc.offer')).toHaveLength(offersBeforeShare + 1);

    await expect(harness.session.stopScreenShare()).resolves.toBe(true);

    expect(screenSender?.track).toBeNull();
    expect(screenTrack.stopped).toBe(true);
    expect(harness.session.getLocalStream()).toBeNull();
    expect(harness.session.getSnapshot()).toMatchObject({
      screenSharing: false,
      localMedia: {
        videoAvailable: false,
        videoEnabled: false,
        videoSource: 'camera',
      },
    });
    await harness.session.leave();
  });

  it('drains a camera-less screen addTrack renegotiation after signaling becomes stable', async () => {
    const screenTrack = new FakeTrack('video');
    const harness = createHarness({
      preparedMediaStream: null,
      getDisplayMedia: vi.fn(
        async () => new FakeMediaStream([screenTrack]) as unknown as MediaStream,
      ),
    });
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
    const peer = harness.peerConnections[0];
    if (peer === undefined) {
      throw new Error('Expected a peer connection');
    }
    expect(peer.signalingState).toBe('have-local-offer');
    expect(harness.socket.messagesOfType('rtc.offer')).toHaveLength(1);

    await expect(harness.session.startScreenShare()).resolves.toBe('started');
    await flushMicrotasks();

    expect(peer.addedTracks).toContain(screenTrack as unknown as MediaStreamTrack);
    expect(harness.socket.messagesOfType('rtc.offer')).toHaveLength(1);

    await answerPeer(harness, 'peer-a');
    await flushMicrotasks();

    expect(harness.socket.messagesOfType('rtc.offer')).toHaveLength(2);
    expect(harness.socket.messagesOfType('rtc.offer').at(-1)).toMatchObject({
      to: 'peer-a',
      payload: {
        description: { type: 'offer' },
      },
    });
    await harness.session.stopScreenShare();
    await harness.session.leave();
  });

  it('stops both retained camera and active display ownership on leave', async () => {
    const screenTrack = new FakeTrack('video');
    const harness = createHarness({
      getDisplayMedia: vi.fn(
        async () => new FakeMediaStream([screenTrack]) as unknown as MediaStream,
      ),
    });
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
    await harness.session.startScreenShare();

    expect(harness.videoTrack.stopped).toBe(false);
    expect(screenTrack.stopped).toBe(false);
    expect(harness.videoTrack.endedListenerCount()).toBe(1);
    expect(screenTrack.endedListenerCount()).toBe(1);

    await harness.session.leave();

    expect(harness.videoTrack.stopped).toBe(true);
    expect(screenTrack.stopped).toBe(true);
    expect(harness.videoTrack.endedListenerCount()).toBe(0);
    expect(screenTrack.endedListenerCount()).toBe(0);
    expect(harness.session.getLocalStream()).toBeNull();
  });

  it('publishes roles and sends media-disable requests only with server capability', async () => {
    const host = createHarness();
    await joinSession(
      host,
      [
        { peerId: 'peer-a', displayName: 'Ara', role: 'participant' },
        { peerId: 'peer-host', displayName: 'Other host', role: 'host' },
      ],
      'self-host',
      { selfRole: 'host', canModerateMedia: true },
    );

    expect(host.session.getSnapshot()).toMatchObject({
      selfRole: 'host',
      canModerateMedia: true,
      participants: expect.arrayContaining([
        expect.objectContaining({ peerId: 'self-host', role: 'host' }),
        expect.objectContaining({ peerId: 'peer-a', role: 'participant' }),
      ]),
    });
    expect(host.session.disableParticipantMedia('peer-a', 'audio')).toBe(true);
    expect(host.socket.messagesOfType('moderation.media.disable')).toEqual([
      expect.objectContaining({
        v: PROTOCOL_VERSION,
        type: 'moderation.media.disable',
        roomId: ROOM_ID,
        to: 'peer-a',
        payload: { kind: 'audio' },
        requestId: expect.any(String),
      }),
    ]);
    expect(host.session.disableParticipantMedia('self-host', 'audio')).toBe(false);
    expect(host.session.disableParticipantMedia('peer-host', 'video')).toBe(false);
    expect(host.session.disableParticipantMedia('missing-peer', 'video')).toBe(false);

    const participant = createHarness();
    await joinSession(participant, [{ peerId: 'peer-a', displayName: 'Ara' }], 'self-participant', {
      selfRole: 'participant',
      canModerateMedia: false,
    });
    expect(participant.session.disableParticipantMedia('peer-a', 'audio')).toBe(false);
    expect(participant.socket.messagesOfType('moderation.media.disable')).toEqual([]);

    await host.session.leave();
    await participant.session.leave();
  });

  it('applies trusted moderation only to self and gives repeated notices unique ids', async () => {
    const harness = createHarness();
    await joinSession(harness, [{ peerId: 'host-peer', displayName: 'Host', role: 'host' }]);
    const channel = harness.peerConnections[0]?.channels[0];
    if (channel === undefined) {
      throw new Error('Expected an open DataChannel');
    }
    const mediaFramesBefore = channel.sent.length;

    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'moderation.media.disabled',
      roomId: ROOM_ID,
      from: 'host-peer',
      payload: { targetPeerId: 'someone-else', kind: 'audio' },
    });
    await flushMicrotasks();

    expect(harness.audioTrack.enabled).toBe(true);
    expect(harness.session.getSnapshot().lastModerationNotice).toBeNull();
    expect(channel.sent).toHaveLength(mediaFramesBefore);

    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'moderation.media.disabled',
      roomId: ROOM_ID,
      from: 'host-peer',
      requestId: 'moderation-request-1',
      payload: { targetPeerId: 'self', kind: 'audio' },
    });
    await flushMicrotasks();

    const firstNotice = harness.session.getSnapshot().lastModerationNotice;
    expect(harness.audioTrack.enabled).toBe(false);
    expect(firstNotice).toEqual({
      id: 'moderation-1',
      sequence: 1,
      fromPeerId: 'host-peer',
      kind: 'audio',
    });
    expect(
      channel.sent
        .map((raw) => JSON.parse(raw) as { type: string })
        .filter(({ type }) => type === 'participant.media')
        .at(-1),
    ).toEqual({
      type: 'participant.media',
      audioEnabled: false,
      videoEnabled: true,
      videoSource: 'camera',
    });

    expect(harness.session.toggleAudio()).toBe(true);
    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'moderation.media.disabled',
      roomId: ROOM_ID,
      from: 'host-peer',
      requestId: 'moderation-request-2',
      payload: { targetPeerId: 'self', kind: 'audio' },
    });
    await flushMicrotasks();

    const secondNotice = harness.session.getSnapshot().lastModerationNotice;
    expect(harness.audioTrack.enabled).toBe(false);
    expect(secondNotice?.sequence).toBe(2);
    expect(secondNotice?.id).not.toBe(firstNotice?.id);
    await harness.session.leave();
  });

  it('ends screen sharing and disables the restored camera on video moderation', async () => {
    const screenTrack = new FakeTrack('video');
    const harness = createHarness({
      getDisplayMedia: vi.fn(
        async () => new FakeMediaStream([screenTrack]) as unknown as MediaStream,
      ),
    });
    await joinSession(harness, [{ peerId: 'host-peer', displayName: 'Host', role: 'host' }]);
    const peer = harness.peerConnections[0];
    const channel = peer?.channels[0];
    const videoSender = peer?.senders.find(
      (sender) => sender.track === (harness.videoTrack as unknown as MediaStreamTrack),
    );
    if (channel === undefined || videoSender === undefined) {
      throw new Error('Expected video sender and DataChannel');
    }
    await harness.session.startScreenShare();

    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'moderation.media.disabled',
      roomId: ROOM_ID,
      from: 'host-peer',
      payload: { targetPeerId: 'self', kind: 'video' },
    });
    await flushMicrotasks();

    expect(screenTrack.stopped).toBe(true);
    expect(harness.videoTrack.enabled).toBe(false);
    expect(videoSender.track).toBe(harness.videoTrack as unknown as MediaStreamTrack);
    expect(harness.session.getSnapshot()).toMatchObject({
      screenSharing: false,
      localMedia: {
        videoEnabled: false,
        videoSource: 'camera',
      },
      lastModerationNotice: {
        fromPeerId: 'host-peer',
        kind: 'video',
      },
    });
    expect(
      channel.sent
        .map((raw) => JSON.parse(raw) as { type: string })
        .filter(({ type }) => type === 'participant.media')
        .at(-1),
    ).toEqual({
      type: 'participant.media',
      audioEnabled: true,
      videoEnabled: false,
      videoSource: 'camera',
    });
    await harness.session.leave();
  });

  it('forwards host capability only in every room.join frame', async () => {
    const hostCapability = 'standalone-host-proof-test-only-32-characters';
    const harness = createHarness({ hostCapability });
    await joinSession(harness);

    expect(harness.socket.messagesOfType('room.join')).toEqual([
      {
        v: PROTOCOL_VERSION,
        type: 'room.join',
        roomId: ROOM_ID,
        payload: { displayName: 'Jin', hostCapability },
      },
    ]);
    expect(JSON.stringify(harness.session.getSnapshot())).not.toContain(hostCapability);

    const initialSocket = harness.socket;
    initialSocket.serverClose(1006, 'network lost');
    await flushMicrotasks();
    const reconnectSocket = harness.socket;
    reconnectSocket.open();
    await flushMicrotasks();

    expect(reconnectSocket.messagesOfType('room.join')).toEqual([
      {
        v: PROTOCOL_VERSION,
        type: 'room.join',
        roomId: ROOM_ID,
        payload: { displayName: 'Jin', hostCapability },
      },
    ]);
    expect(
      [...initialSocket.sent, ...reconnectSocket.sent]
        .filter((raw) => (JSON.parse(raw) as { type: string }).type !== 'room.join')
        .some((raw) => raw.includes(hostCapability)),
    ).toBe(false);

    reconnectSocket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'room.joined',
      roomId: ROOM_ID,
      payload: {
        peerId: 'self-after-reconnect',
        selfRole: 'host',
        capabilities: { canModerateMedia: true },
        participants: [],
      },
    });
    await flushMicrotasks();
    await harness.session.leave();
  });
});
