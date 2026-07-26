import { describe, expect, it } from 'vitest';

import {
  PROTOCOL_VERSION,
  ProtocolValidationError,
  isClientMessage,
  isServerMessage,
  parseClientMessage,
  parseServerMessage,
} from '../src/index.js';

describe('client message validation', () => {
  it.each([
    {
      v: PROTOCOL_VERSION,
      type: 'room.join',
      roomId: 'study-room',
      payload: { displayName: 'Ada' },
    },
    {
      v: PROTOCOL_VERSION,
      type: 'rtc.offer',
      roomId: 'study-room',
      to: 'peer-b',
      payload: { description: { type: 'offer', sdp: 'v=0' } },
    },
    {
      v: PROTOCOL_VERSION,
      type: 'rtc.answer',
      roomId: 'study-room',
      to: 'peer-a',
      payload: { description: { type: 'answer' } },
    },
    {
      v: PROTOCOL_VERSION,
      type: 'rtc.ice',
      roomId: 'study-room',
      to: 'peer-a',
      payload: {
        candidate: {
          candidate: 'candidate:1 1 UDP 1 192.0.2.1 5000 typ host',
          sdpMid: '0',
          sdpMLineIndex: 0,
          usernameFragment: null,
        },
      },
    },
    {
      v: PROTOCOL_VERSION,
      type: 'rtc.ice',
      roomId: 'study-room',
      to: 'peer-a',
      payload: { candidate: null },
    },
    {
      v: PROTOCOL_VERSION,
      type: 'room.leave',
      roomId: 'study-room',
    },
  ])('accepts $type', (message) => {
    expect(parseClientMessage(message)).toEqual(message);
    expect(isClientMessage(message)).toBe(true);
  });

  it('rejects a sender identity supplied by a client', () => {
    const spoofed = {
      v: PROTOCOL_VERSION,
      type: 'rtc.offer',
      roomId: 'study-room',
      from: 'pretend-peer',
      to: 'peer-b',
      payload: { description: { type: 'offer', sdp: 'v=0' } },
    };

    expect(() => parseClientMessage(spoofed)).toThrow(ProtocolValidationError);
    expect(isClientMessage(spoofed)).toBe(false);
  });

  it.each([
    [{ v: 2, type: 'room.leave', roomId: 'study-room' }],
    [
      {
        v: 1,
        type: 'room.join',
        roomId: ' study-room ',
        payload: { displayName: 'Ada' },
      },
    ],
    [
      {
        v: 1,
        type: 'rtc.offer',
        roomId: 'study-room',
        to: 'peer-b',
        payload: { description: { type: 'answer', sdp: 'v=0' } },
      },
    ],
    [
      {
        v: 1,
        type: 'rtc.ice',
        roomId: 'study-room',
        to: 'peer-b',
        payload: { candidate: { candidate: 'candidate', sdpMLineIndex: -1 } },
      },
    ],
  ])('rejects malformed messages', (message) => {
    expect(isClientMessage(message)).toBe(false);
  });
});

describe('server message validation', () => {
  it.each([
    {
      v: PROTOCOL_VERSION,
      type: 'room.joined',
      roomId: 'study-room',
      payload: {
        peerId: 'peer-a',
        participants: [{ peerId: 'peer-b', displayName: 'Grace' }],
      },
    },
    {
      v: PROTOCOL_VERSION,
      type: 'peer.joined',
      roomId: 'study-room',
      payload: { participant: { peerId: 'peer-c', displayName: 'Linus' } },
    },
    {
      v: PROTOCOL_VERSION,
      type: 'rtc.answer',
      roomId: 'study-room',
      from: 'peer-b',
      payload: { description: { type: 'answer', sdp: 'v=0' } },
    },
    {
      v: PROTOCOL_VERSION,
      type: 'peer.left',
      roomId: 'study-room',
      payload: { peerId: 'peer-b' },
    },
    {
      v: PROTOCOL_VERSION,
      type: 'error',
      roomId: 'study-room',
      payload: { code: 'ROOM_FULL', message: 'The room is full.' },
    },
  ])('accepts $type', (message) => {
    expect(parseServerMessage(message)).toEqual(message);
    expect(isServerMessage(message)).toBe(true);
  });

  it('rejects an unknown signaling error code', () => {
    expect(
      isServerMessage({
        v: PROTOCOL_VERSION,
        type: 'error',
        payload: { code: 'SURPRISE', message: 'Nope' },
      }),
    ).toBe(false);
  });
});
