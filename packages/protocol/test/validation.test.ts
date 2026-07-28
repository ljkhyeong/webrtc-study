import { describe, expect, it } from 'vitest';

import {
  MAX_SDP_BYTES,
  MAX_SIGNALING_FRAME_BYTES,
  PROTOCOL_VERSION,
  ProtocolValidationError,
  isClientMessage,
  isServerMessage,
  parseClientMessage,
  parseServerMessage,
  serializeClientMessage,
  utf8ByteLength,
} from '../src/index.js';

describe('client message validation', () => {
  it.each([
    {
      v: PROTOCOL_VERSION,
      type: 'room.join',
      roomId: 'abcd-efgh-jkmp',
      payload: { displayName: 'Ada' },
    },
    {
      v: PROTOCOL_VERSION,
      type: 'rtc.offer',
      roomId: 'abcd-efgh-jkmp',
      to: 'peer-b',
      payload: { description: { type: 'offer', sdp: 'v=0' } },
    },
    {
      v: PROTOCOL_VERSION,
      type: 'rtc.answer',
      roomId: 'abcd-efgh-jkmp',
      to: 'peer-a',
      payload: { description: { type: 'answer' } },
    },
    {
      v: PROTOCOL_VERSION,
      type: 'rtc.ice',
      roomId: 'abcd-efgh-jkmp',
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
      roomId: 'abcd-efgh-jkmp',
      to: 'peer-a',
      payload: { candidate: null },
    },
    {
      v: PROTOCOL_VERSION,
      type: 'room.leave',
      roomId: 'abcd-efgh-jkmp',
    },
  ])('accepts $type', (message) => {
    expect(parseClientMessage(message)).toEqual(message);
    expect(isClientMessage(message)).toBe(true);
  });

  it('rejects a sender identity supplied by a client', () => {
    const spoofed = {
      v: PROTOCOL_VERSION,
      type: 'rtc.offer',
      roomId: 'abcd-efgh-jkmp',
      from: 'pretend-peer',
      to: 'peer-b',
      payload: { description: { type: 'offer', sdp: 'v=0' } },
    };

    expect(() => parseClientMessage(spoofed)).toThrow(ProtocolValidationError);
    expect(isClientMessage(spoofed)).toBe(false);
  });

  it.each(['room', 'Study-A', 'abcd-efgh-ijkl', 'abcd-efgh-jkmp-extra'])(
    'rejects non-canonical room id %s',
    (roomId) => {
      expect(
        isClientMessage({
          v: PROTOCOL_VERSION,
          type: 'room.join',
          roomId,
          payload: { displayName: 'Ada' },
        }),
      ).toBe(false);
    },
  );

  it.each([
    [{ v: 2, type: 'room.leave', roomId: 'abcd-efgh-jkmp' }],
    [
      {
        v: 1,
        type: 'room.join',
        roomId: ' abcd-efgh-jkmp ',
        payload: { displayName: 'Ada' },
      },
    ],
    [
      {
        v: 1,
        type: 'rtc.offer',
        roomId: 'abcd-efgh-jkmp',
        to: 'peer-b',
        payload: { description: { type: 'answer', sdp: 'v=0' } },
      },
    ],
    [
      {
        v: 1,
        type: 'rtc.ice',
        roomId: 'abcd-efgh-jkmp',
        to: 'peer-b',
        payload: { candidate: { candidate: 'candidate', sdpMLineIndex: -1 } },
      },
    ],
  ])('rejects malformed messages', (message) => {
    expect(isClientMessage(message)).toBe(false);
  });

  it.each([
    ['ASCII', 'x'.repeat(MAX_SDP_BYTES)],
    ['multibyte', '가'.repeat(MAX_SDP_BYTES / 3)],
  ])('serializes a maximum-size %s SDP within the transport frame budget', (_kind, sdp) => {
    const message = {
      v: PROTOCOL_VERSION,
      type: 'rtc.offer',
      roomId: 'abcd-efgh-jkmp',
      requestId: 'r'.repeat(128),
      to: 'p'.repeat(128),
      payload: { description: { type: 'offer', sdp } },
    };

    expect(utf8ByteLength(sdp)).toBe(MAX_SDP_BYTES);
    const serialized = serializeClientMessage(message);

    expect(utf8ByteLength(serialized)).toBeLessThanOrEqual(MAX_SIGNALING_FRAME_BYTES);
    expect(JSON.parse(serialized)).toEqual(message);
  });

  it.each([
    ['ASCII', 'x'.repeat(MAX_SDP_BYTES + 1)],
    ['multibyte', '가'.repeat(MAX_SDP_BYTES / 3 + 1)],
  ])('rejects a %s SDP over the UTF-8 byte budget', (_kind, sdp) => {
    const message = {
      v: PROTOCOL_VERSION,
      type: 'rtc.offer',
      roomId: 'abcd-efgh-jkmp',
      to: 'peer-b',
      payload: { description: { type: 'offer', sdp } },
    };

    expect(utf8ByteLength(sdp)).toBeGreaterThan(MAX_SDP_BYTES);
    expect(() => serializeClientMessage(message)).toThrow(
      `must contain at most ${MAX_SDP_BYTES} UTF-8 bytes`,
    );
  });

  it('rejects an escape-heavy SDP whose serialized frame exceeds 64 KiB', () => {
    const message = {
      v: PROTOCOL_VERSION,
      type: 'rtc.offer',
      roomId: 'abcd-efgh-jkmp',
      to: 'peer-b',
      payload: {
        description: {
          type: 'offer',
          sdp: '\n'.repeat(MAX_SDP_BYTES),
        },
      },
    };

    expect(utf8ByteLength(message.payload.description.sdp)).toBe(MAX_SDP_BYTES);
    expect(utf8ByteLength(JSON.stringify(message))).toBeGreaterThan(MAX_SIGNALING_FRAME_BYTES);
    expect(() => serializeClientMessage(message)).toThrow(
      `serialized message must contain at most ${MAX_SIGNALING_FRAME_BYTES} UTF-8 bytes`,
    );
  });
});

describe('server message validation', () => {
  it.each([
    {
      v: PROTOCOL_VERSION,
      type: 'room.joined',
      roomId: 'abcd-efgh-jkmp',
      payload: {
        peerId: 'peer-a',
        participants: [{ peerId: 'peer-b', displayName: 'Grace' }],
      },
    },
    {
      v: PROTOCOL_VERSION,
      type: 'peer.joined',
      roomId: 'abcd-efgh-jkmp',
      payload: { participant: { peerId: 'peer-c', displayName: 'Linus' } },
    },
    {
      v: PROTOCOL_VERSION,
      type: 'rtc.answer',
      roomId: 'abcd-efgh-jkmp',
      from: 'peer-b',
      payload: { description: { type: 'answer', sdp: 'v=0' } },
    },
    {
      v: PROTOCOL_VERSION,
      type: 'peer.left',
      roomId: 'abcd-efgh-jkmp',
      payload: { peerId: 'peer-b' },
    },
    {
      v: PROTOCOL_VERSION,
      type: 'error',
      roomId: 'abcd-efgh-jkmp',
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

  it('rejects a server message whose serialized UTF-8 frame exceeds 64 KiB', () => {
    const message = {
      v: PROTOCOL_VERSION,
      type: 'room.joined',
      roomId: 'abcd-efgh-jkmp',
      payload: {
        peerId: 'peer-a',
        participants: Array.from({ length: 400 }, (_, index) => ({
          peerId: `peer-${index}`,
          displayName: '가'.repeat(64),
        })),
      },
    };

    expect(utf8ByteLength(JSON.stringify(message))).toBeGreaterThan(MAX_SIGNALING_FRAME_BYTES);
    expect(() => parseServerMessage(message)).toThrow(
      `serialized message must contain at most ${MAX_SIGNALING_FRAME_BYTES} UTF-8 bytes`,
    );
  });
});
