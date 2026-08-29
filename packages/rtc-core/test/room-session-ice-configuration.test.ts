import { describe, expect, it } from 'vitest';

import { PROTOCOL_VERSION } from '@round/protocol';

import {
  ROOM_ID,
  answerPeer,
  createHarness,
  flushMicrotasks,
  joinSession,
} from './room-session.test-support.js';

describe('RoomSession', () => {
  it('isolates RTC configuration for current and future peers without renegotiation', async () => {
    const initialUrls = ['stun:initial.example.test'];
    const initialIceServers: RTCIceServer[] = [{ urls: initialUrls }];
    const initialConfiguration: RTCConfiguration = {
      iceServers: initialIceServers,
      iceCandidatePoolSize: 1,
    };
    const harness = createHarness({ rtcConfiguration: initialConfiguration });

    initialUrls[0] = 'stun:mutated-before-join.example.test';
    initialIceServers.push({ urls: 'stun:injected.example.test' });
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);

    const currentPeer = harness.peerConnections[0];
    const currentChannel = currentPeer?.channels[0];
    expect(currentPeer?.initialConfiguration).toEqual({
      iceServers: [{ urls: ['stun:initial.example.test'] }],
      iceCandidatePoolSize: 1,
    });

    const refreshedUrls = ['turn:relay.example.test?transport=udp'];
    const refreshedIceServers: RTCIceServer[] = [
      {
        urls: refreshedUrls,
        username: 'refresh-user',
        credential: 'refresh-credential',
      },
    ];
    const refreshedConfiguration: RTCConfiguration = {
      iceServers: refreshedIceServers,
      iceTransportPolicy: 'all',
    };
    const offerCount = harness.socket.messagesOfType('rtc.offer').length;

    harness.session.updateRtcConfiguration(refreshedConfiguration);

    expect(currentPeer?.configurationCalls).toEqual([
      {
        iceServers: [
          {
            urls: ['turn:relay.example.test?transport=udp'],
            username: 'refresh-user',
            credential: 'refresh-credential',
          },
        ],
        iceTransportPolicy: 'all',
      },
    ]);
    expect(harness.peerConnections).toHaveLength(1);
    expect(currentPeer?.channels[0]).toBe(currentChannel);
    expect(harness.sockets).toHaveLength(1);
    expect(harness.socket.messagesOfType('rtc.offer')).toHaveLength(offerCount);

    refreshedUrls[0] = 'turn:mutated.example.test';
    refreshedIceServers.push({ urls: 'turn:injected.example.test' });
    const appliedIceServers = currentPeer?.configurationCalls[0]?.iceServers;
    if (appliedIceServers !== undefined) {
      appliedIceServers[0] = { urls: 'turn:mutated-by-peer.example.test' };
      appliedIceServers.push({ urls: 'turn:injected-by-peer.example.test' });
    }
    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'peer.joined',
      roomId: ROOM_ID,
      payload: {
        participant: { peerId: 'peer-b', displayName: 'Bo' },
      },
    });
    await flushMicrotasks();

    expect(harness.peerConnections).toHaveLength(2);
    expect(harness.peerConnections[1]?.initialConfiguration).toEqual({
      iceServers: [
        {
          urls: ['turn:relay.example.test?transport=udp'],
          username: 'refresh-user',
          credential: 'refresh-credential',
        },
      ],
      iceTransportPolicy: 'all',
    });
    expect(harness.peerConnections[1]?.initialConfiguration).not.toBe(
      currentPeer?.configurationCalls[0],
    );
    expect(harness.sockets).toHaveLength(1);
    expect(harness.socket.messagesOfType('rtc.offer')).toHaveLength(offerCount);
  });

  it('lets only the deterministic initiator restart ICE after a TURN refresh', async () => {
    const initiator = createHarness();
    await joinSession(initiator, [{ peerId: 'z-peer', displayName: 'Zoe' }], 'a-self');
    await answerPeer(initiator, 'z-peer');
    const initiatorPeer = initiator.peerConnections[0];
    const initiatorChannel = initiatorPeer?.channels[0];
    initiatorPeer?.setConnectionState('connected');

    const refreshedConfiguration: RTCConfiguration = {
      iceServers: [
        {
          urls: 'turn:refreshed.example.test',
          username: 'refresh-user',
          credential: 'refresh-credential',
        },
      ],
    };
    initiator.session.updateRtcConfiguration(refreshedConfiguration, {
      restartIce: true,
    });
    await flushMicrotasks();

    expect(initiatorPeer?.configurationCalls).toEqual([refreshedConfiguration]);
    expect(initiatorPeer?.offerOptions).toEqual([undefined, { iceRestart: true }]);
    expect(initiatorPeer?.channels[0]).toBe(initiatorChannel);
    expect(initiator.socket.messagesOfType('rtc.offer').at(-1)).toMatchObject({
      to: 'z-peer',
      payload: {
        description: { type: 'offer', sdp: 'restart-offer-sdp' },
      },
    });
    await answerPeer(initiator, 'z-peer');
    expect(initiator.session.getSnapshot().participants).toContainEqual(
      expect.objectContaining({
        peerId: 'z-peer',
        connectionState: 'connected',
      }),
    );
    await initiator.session.leave();

    const responder = createHarness();
    await joinSession(responder, [{ peerId: 'a-peer', displayName: 'Ara' }], 'z-self');
    await answerPeer(responder, 'a-peer');
    const responderPeer = responder.peerConnections[0];
    responderPeer?.setConnectionState('connected');

    responder.session.updateRtcConfiguration(refreshedConfiguration, {
      restartIce: true,
    });
    await flushMicrotasks();

    expect(responderPeer?.configurationCalls).toEqual([refreshedConfiguration]);
    expect(responderPeer?.offerOptions).toEqual([undefined]);
    expect(responder.socket.messagesOfType('rtc.offer')).toHaveLength(1);
    await responder.session.leave();
  });

  it('reports one non-fatal warning when configuration refresh fails for current peers', async () => {
    const harness = createHarness();
    await joinSession(harness, [
      { peerId: 'peer-a', displayName: 'Ara' },
      { peerId: 'peer-b', displayName: 'Bo' },
    ]);
    const firstPeer = harness.peerConnections[0];
    const secondPeer = harness.peerConnections[1];
    const firstChannel = firstPeer?.channels[0];
    const secondChannel = secondPeer?.channels[0];
    if (firstPeer === undefined) {
      throw new Error('Expected the first peer connection');
    }
    firstPeer.setConfigurationError = new DOMException(
      'configuration rejected',
      'InvalidModificationError',
    );

    const refreshedConfiguration: RTCConfiguration = {
      iceServers: [{ urls: 'turn:refreshed.example.test', username: 'u', credential: 'c' }],
    };
    harness.session.updateRtcConfiguration(refreshedConfiguration);

    expect(firstPeer.configurationCalls).toHaveLength(1);
    expect(secondPeer?.configurationCalls).toHaveLength(1);
    expect(firstPeer.channels[0]).toBe(firstChannel);
    expect(secondPeer?.channels[0]).toBe(secondChannel);
    expect(harness.session.getSnapshot()).toMatchObject({
      status: 'active',
      error: null,
      warning: {
        code: 'rtc-configuration-update-failed',
        message:
          'Could not apply refreshed ICE configuration to 1 peer connection(s); existing connections remain active',
      },
    });

    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'peer.joined',
      roomId: ROOM_ID,
      payload: {
        participant: { peerId: 'peer-c', displayName: 'Cy' },
      },
    });
    await flushMicrotasks();
    expect(harness.peerConnections[2]?.initialConfiguration).toEqual(refreshedConfiguration);

    firstPeer.setConfigurationError = null;
    harness.session.updateRtcConfiguration({
      iceServers: [{ urls: 'turn:next.example.test', username: 'next', credential: 'next' }],
    });

    expect(harness.session.getSnapshot().warning).toBeNull();
    expect(harness.session.getSnapshot().error).toBeNull();
  });

  it('skips stale closed peers and safely ignores configuration updates after leave', async () => {
    const harness = createHarness();
    await joinSession(harness, [{ peerId: 'peer-a', displayName: 'Ara' }]);
    const stalePeer = harness.peerConnections[0];

    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'peer.left',
      roomId: ROOM_ID,
      payload: { peerId: 'peer-a' },
    });
    await flushMicrotasks();
    expect(stalePeer?.closed).toBe(true);

    const refreshedConfiguration: RTCConfiguration = {
      iceServers: [{ urls: 'turn:future.example.test', username: 'future', credential: 'future' }],
    };
    harness.session.updateRtcConfiguration(refreshedConfiguration);
    expect(stalePeer?.configurationCalls).toEqual([]);

    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'peer.joined',
      roomId: ROOM_ID,
      payload: {
        participant: { peerId: 'peer-b', displayName: 'Bo' },
      },
    });
    await flushMicrotasks();
    const futurePeer = harness.peerConnections[1];
    expect(futurePeer?.initialConfiguration).toEqual(refreshedConfiguration);

    await harness.session.leave();
    const callCountAfterLeave = futurePeer?.configurationCalls.length;
    expect(() => {
      harness.session.updateRtcConfiguration({
        iceServers: [{ urls: 'turn:ignored.example.test' }],
      });
    }).not.toThrow();

    expect(futurePeer?.configurationCalls).toHaveLength(callCountAfterLeave ?? 0);
    expect(harness.peerConnections).toHaveLength(2);
    expect(harness.sockets).toHaveLength(1);
    expect(harness.session.getSnapshot()).toMatchObject({
      status: 'ended',
      error: null,
    });
  });

  it('queues ICE received before the remote description and flushes it on offer', async () => {
    const harness = createHarness();
    await joinSession(harness);

    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'peer.joined',
      roomId: 'abcd-efgh-jkmp',
      payload: {
        participant: { peerId: 'peer-a', displayName: 'Ara' },
      },
    });
    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'rtc.ice',
      roomId: 'abcd-efgh-jkmp',
      from: 'peer-a',
      payload: {
        candidate: {
          candidate: 'candidate:1',
          sdpMid: '0',
          sdpMLineIndex: 0,
          usernameFragment: null,
        },
      },
    });
    await flushMicrotasks();

    const peer = harness.peerConnections[0];
    expect(peer?.addedCandidates).toEqual([]);

    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'rtc.offer',
      roomId: 'abcd-efgh-jkmp',
      from: 'peer-a',
      payload: {
        description: { type: 'offer', sdp: 'remote-offer' },
      },
    });
    await flushMicrotasks();

    expect(peer?.addedCandidates).toEqual([
      {
        candidate: 'candidate:1',
        sdpMid: '0',
        sdpMLineIndex: 0,
        usernameFragment: null,
      },
    ]);
    expect(harness.socket.messagesOfType('rtc.answer')).toEqual([
      {
        v: PROTOCOL_VERSION,
        type: 'rtc.answer',
        roomId: 'abcd-efgh-jkmp',
        requestId: expect.any(String),
        to: 'peer-a',
        payload: {
          description: { type: 'answer', sdp: 'answer-sdp' },
        },
      },
    ]);
  });

  it('bounds pending remote ICE candidates and retains the newest candidates', async () => {
    const harness = createHarness();
    await joinSession(harness);

    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'peer.joined',
      roomId: ROOM_ID,
      payload: {
        participant: { peerId: 'peer-a', displayName: 'Ara' },
      },
    });
    for (let index = 0; index <= 256; index += 1) {
      harness.socket.serverMessage({
        v: PROTOCOL_VERSION,
        type: 'rtc.ice',
        roomId: ROOM_ID,
        from: 'peer-a',
        payload: {
          candidate: {
            candidate: `candidate:${index}`,
            sdpMid: '0',
            sdpMLineIndex: 0,
            usernameFragment: null,
          },
        },
      });
    }
    await flushMicrotasks();

    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'rtc.offer',
      roomId: ROOM_ID,
      from: 'peer-a',
      payload: {
        description: { type: 'offer', sdp: 'remote-offer' },
      },
    });
    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, 0);
    });

    const peer = harness.peerConnections[0];
    expect(peer?.addedCandidates).toHaveLength(256);
    expect(peer?.addedCandidates.at(0)).toEqual({
      candidate: 'candidate:1',
      sdpMid: '0',
      sdpMLineIndex: 0,
      usernameFragment: null,
    });
    expect(peer?.addedCandidates.at(-1)).toEqual({
      candidate: 'candidate:256',
      sdpMid: '0',
      sdpMLineIndex: 0,
      usernameFragment: null,
    });
    expect(harness.session.getSnapshot().warning).toEqual({
      code: 'ice-candidate-queue-overflow',
      message: 'Oldest pending ICE candidate for peer-a was discarded',
    });

    harness.socket.serverMessage({
      v: PROTOCOL_VERSION,
      type: 'peer.left',
      roomId: ROOM_ID,
      payload: { peerId: 'peer-a' },
    });
    await flushMicrotasks();
    expect(harness.session.getSnapshot().warning).toBeNull();
    await harness.session.leave();
  });
});
