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

const MAX_NEGOTIATION_ID_LENGTH = 128;
const MAX_PEER_ID_LENGTH = 128;
const MAX_HOST_CAPABILITY_LENGTH = 256;
const MIN_HOST_CAPABILITY_LENGTH = 32;
const RELAY_PAYLOAD_CASES = [
  {
    type: 'rtc.offer',
    contents: { description: { type: 'offer', sdp: 'v=0' } },
  },
  {
    type: 'rtc.answer',
    contents: { description: { type: 'answer', sdp: 'v=0' } },
  },
  {
    type: 'rtc.ice',
    contents: { candidate: null },
  },
] as const;

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
      type: 'room.join',
      roomId: 'abcd-efgh-jkmp',
      requestId: 'join-as-host',
      payload: {
        displayName: 'Grace',
        hostCapability: 'c'.repeat(MAX_HOST_CAPABILITY_LENGTH),
      },
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
      type: 'moderation.media.disable',
      roomId: 'abcd-efgh-jkmp',
      requestId: 'moderate-audio-1',
      to: 'peer-a',
      payload: { kind: 'audio' },
    },
    {
      v: PROTOCOL_VERSION,
      type: 'moderation.media.disable',
      roomId: 'abcd-efgh-jkmp',
      to: 'p'.repeat(MAX_PEER_ID_LENGTH),
      payload: { kind: 'video' },
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

  it.each(RELAY_PAYLOAD_CASES)(
    'accepts a maximum-length negotiation id for $type',
    ({ type, contents }) => {
      const message = {
        v: PROTOCOL_VERSION,
        type,
        roomId: 'abcd-efgh-jkmp',
        to: 'peer-b',
        payload: {
          ...contents,
          negotiationId: 'n'.repeat(MAX_NEGOTIATION_ID_LENGTH),
        },
      };

      expect(parseClientMessage(message)).toEqual(message);
      expect(isClientMessage(message)).toBe(true);
    },
  );

  it.each(
    RELAY_PAYLOAD_CASES.flatMap(({ type, contents }) =>
      ['', ' ', 'n'.repeat(MAX_NEGOTIATION_ID_LENGTH + 1)].map((negotiationId) => ({
        type,
        contents,
        negotiationId,
      })),
    ),
  )('rejects an invalid negotiation id for $type', ({ type, contents, negotiationId }) => {
    const message = {
      v: PROTOCOL_VERSION,
      type,
      roomId: 'abcd-efgh-jkmp',
      to: 'peer-b',
      payload: { ...contents, negotiationId },
    };

    expect(() => parseClientMessage(message)).toThrow('$.payload.negotiationId');
    expect(isClientMessage(message)).toBe(false);
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
        v: PROTOCOL_VERSION,
        type: 'room.join',
        roomId: ' abcd-efgh-jkmp ',
        payload: { displayName: 'Ada' },
      },
    ],
    [
      {
        v: PROTOCOL_VERSION,
        type: 'rtc.offer',
        roomId: 'abcd-efgh-jkmp',
        to: 'peer-b',
        payload: { description: { type: 'answer', sdp: 'v=0' } },
      },
    ],
    [
      {
        v: PROTOCOL_VERSION,
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
    ['empty', ''],
    ['blank', ' \t '],
    ['too-short', 'c'.repeat(MIN_HOST_CAPABILITY_LENGTH - 1)],
    ['overlong', 'c'.repeat(MAX_HOST_CAPABILITY_LENGTH + 1)],
    ['non-string', 42],
  ])('rejects an %s host capability', (_case, hostCapability) => {
    const message = {
      v: PROTOCOL_VERSION,
      type: 'room.join',
      roomId: 'abcd-efgh-jkmp',
      payload: { displayName: 'Ada', hostCapability },
    };

    expect(() => parseClientMessage(message)).toThrow('$.payload.hostCapability');
    expect(isClientMessage(message)).toBe(false);
  });

  it('rejects unsupported room.join fields', () => {
    const message = {
      v: PROTOCOL_VERSION,
      type: 'room.join',
      roomId: 'abcd-efgh-jkmp',
      payload: { displayName: 'Ada', hostCapability: 'proof', role: 'host' },
    };

    expect(() => parseClientMessage(message)).toThrow('$.payload.role');
    expect(isClientMessage(message)).toBe(false);
  });

  it.each([
    ['unknown', 'screen'],
    ['empty', ''],
    ['non-string', true],
    ['missing', undefined],
  ])('rejects an %s moderation media kind', (_case, kind) => {
    const message = {
      v: PROTOCOL_VERSION,
      type: 'moderation.media.disable',
      roomId: 'abcd-efgh-jkmp',
      to: 'peer-b',
      payload: { kind },
    };

    expect(() => parseClientMessage(message)).toThrow('$.payload.kind');
    expect(isClientMessage(message)).toBe(false);
  });

  it.each([
    ['blank', ' '],
    ['overlong', 'p'.repeat(MAX_PEER_ID_LENGTH + 1)],
  ])('rejects a %s moderation target peer id', (_case, to) => {
    const message = {
      v: PROTOCOL_VERSION,
      type: 'moderation.media.disable',
      roomId: 'abcd-efgh-jkmp',
      to,
      payload: { kind: 'audio' },
    };

    expect(() => parseClientMessage(message)).toThrow('$.to');
    expect(isClientMessage(message)).toBe(false);
  });

  it.each([
    [
      'envelope',
      {
        v: PROTOCOL_VERSION,
        type: 'moderation.media.disable',
        roomId: 'abcd-efgh-jkmp',
        from: 'spoofed-host',
        to: 'peer-b',
        payload: { kind: 'audio' },
      },
      '$.from',
    ],
    [
      'payload',
      {
        v: PROTOCOL_VERSION,
        type: 'moderation.media.disable',
        roomId: 'abcd-efgh-jkmp',
        to: 'peer-b',
        payload: { kind: 'video', enabled: false },
      },
      '$.payload.enabled',
    ],
  ])('rejects an unsupported moderation %s field', (_case, message, path) => {
    expect(() => parseClientMessage(message)).toThrow(path);
    expect(isClientMessage(message)).toBe(false);
  });

  it('rejects an unsupported media-enable request', () => {
    const message = {
      v: PROTOCOL_VERSION,
      type: 'moderation.media.enable',
      roomId: 'abcd-efgh-jkmp',
      to: 'peer-b',
      payload: { kind: 'audio' },
    };

    expect(() => parseClientMessage(message)).toThrow('$.type');
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

  it('uses the platform UTF-8 replacement semantics for an unpaired surrogate', () => {
    expect(utf8ByteLength('\ud800')).toBe(3);
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
        selfRole: 'host',
        capabilities: { canModerateMedia: true },
        participants: [{ peerId: 'peer-b', displayName: 'Grace', role: 'participant' }],
      },
    },
    {
      v: PROTOCOL_VERSION,
      type: 'room.joined',
      roomId: 'abcd-efgh-jkmp',
      requestId: 'join-as-participant',
      payload: {
        peerId: 'p'.repeat(MAX_PEER_ID_LENGTH),
        selfRole: 'participant',
        capabilities: { canModerateMedia: false },
        participants: [
          {
            peerId: 'h'.repeat(MAX_PEER_ID_LENGTH),
            displayName: 'Host',
            role: 'host',
          },
        ],
      },
    },
    {
      v: PROTOCOL_VERSION,
      type: 'peer.joined',
      roomId: 'abcd-efgh-jkmp',
      payload: {
        participant: { peerId: 'peer-c', displayName: 'Linus', role: 'participant' },
      },
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
      type: 'moderation.media.disabled',
      roomId: 'abcd-efgh-jkmp',
      from: 'peer-host',
      requestId: 'moderate-video-1',
      payload: { targetPeerId: 'peer-b', kind: 'video' },
    },
    {
      v: PROTOCOL_VERSION,
      type: 'moderation.media.disabled',
      roomId: 'abcd-efgh-jkmp',
      from: 'p'.repeat(MAX_PEER_ID_LENGTH),
      payload: { targetPeerId: 't'.repeat(MAX_PEER_ID_LENGTH), kind: 'audio' },
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
    {
      v: PROTOCOL_VERSION,
      type: 'error',
      requestId: 'moderate-video-1',
      payload: { code: 'FORBIDDEN', message: 'Only the host can moderate media.' },
    },
  ])('accepts $type', (message) => {
    expect(parseServerMessage(message)).toEqual(message);
    expect(isServerMessage(message)).toBe(true);
  });

  it.each(RELAY_PAYLOAD_CASES)(
    'accepts a maximum-length negotiation id for $type',
    ({ type, contents }) => {
      const message = {
        v: PROTOCOL_VERSION,
        type,
        roomId: 'abcd-efgh-jkmp',
        from: 'peer-b',
        payload: {
          ...contents,
          negotiationId: 'n'.repeat(MAX_NEGOTIATION_ID_LENGTH),
        },
      };

      expect(parseServerMessage(message)).toEqual(message);
      expect(isServerMessage(message)).toBe(true);
    },
  );

  it.each(
    RELAY_PAYLOAD_CASES.flatMap(({ type, contents }) =>
      ['', ' ', 'n'.repeat(MAX_NEGOTIATION_ID_LENGTH + 1)].map((negotiationId) => ({
        type,
        contents,
        negotiationId,
      })),
    ),
  )('rejects an invalid negotiation id for $type', ({ type, contents, negotiationId }) => {
    const message = {
      v: PROTOCOL_VERSION,
      type,
      roomId: 'abcd-efgh-jkmp',
      from: 'peer-b',
      payload: { ...contents, negotiationId },
    };

    expect(() => parseServerMessage(message)).toThrow('$.payload.negotiationId');
    expect(isServerMessage(message)).toBe(false);
  });

  it.each([
    ['invalid', 'owner'],
    ['missing', undefined],
  ])('rejects an %s participant role', (_case, role) => {
    const message = {
      v: PROTOCOL_VERSION,
      type: 'peer.joined',
      roomId: 'abcd-efgh-jkmp',
      payload: {
        participant: { peerId: 'peer-b', displayName: 'Grace', role },
      },
    };

    expect(() => parseServerMessage(message)).toThrow('$.payload.participant.role');
    expect(isServerMessage(message)).toBe(false);
  });

  it.each([
    [
      'self',
      {
        v: PROTOCOL_VERSION,
        type: 'room.joined',
        roomId: 'abcd-efgh-jkmp',
        payload: {
          peerId: 'p'.repeat(MAX_PEER_ID_LENGTH + 1),
          selfRole: 'participant',
          capabilities: { canModerateMedia: false },
          participants: [],
        },
      },
      '$.payload.peerId',
    ],
    [
      'participant',
      {
        v: PROTOCOL_VERSION,
        type: 'peer.joined',
        roomId: 'abcd-efgh-jkmp',
        payload: {
          participant: {
            peerId: 'p'.repeat(MAX_PEER_ID_LENGTH + 1),
            displayName: 'Grace',
            role: 'participant',
          },
        },
      },
      '$.payload.participant.peerId',
    ],
  ])('rejects an overlong %s peer id', (_case, message, path) => {
    expect(() => parseServerMessage(message)).toThrow(path);
    expect(isServerMessage(message)).toBe(false);
  });

  it.each([
    ['invalid', 'owner'],
    ['missing', undefined],
  ])('rejects an %s self role', (_case, selfRole) => {
    const message = {
      v: PROTOCOL_VERSION,
      type: 'room.joined',
      roomId: 'abcd-efgh-jkmp',
      payload: {
        peerId: 'peer-a',
        selfRole,
        capabilities: { canModerateMedia: false },
        participants: [],
      },
    };

    expect(() => parseServerMessage(message)).toThrow('$.payload.selfRole');
    expect(isServerMessage(message)).toBe(false);
  });

  it.each([
    ['missing object', undefined, '$.payload.capabilities'],
    ['missing flag', {}, '$.payload.capabilities.canModerateMedia'],
    ['non-boolean flag', { canModerateMedia: 'yes' }, '$.payload.capabilities.canModerateMedia'],
    [
      'extra flag',
      { canModerateMedia: true, canEnableMedia: true },
      '$.payload.capabilities.canEnableMedia',
    ],
  ])('rejects room.joined capabilities with a %s', (_case, capabilities, path) => {
    const message = {
      v: PROTOCOL_VERSION,
      type: 'room.joined',
      roomId: 'abcd-efgh-jkmp',
      payload: {
        peerId: 'peer-a',
        selfRole: 'participant',
        capabilities,
        participants: [],
      },
    };

    expect(() => parseServerMessage(message)).toThrow(path);
    expect(isServerMessage(message)).toBe(false);
  });

  it.each([
    [
      'room.joined payload',
      {
        v: PROTOCOL_VERSION,
        type: 'room.joined',
        roomId: 'abcd-efgh-jkmp',
        payload: {
          peerId: 'peer-a',
          selfRole: 'host',
          capabilities: { canModerateMedia: true },
          participants: [],
          hostCapability: 'leaked-proof',
        },
      },
      '$.payload.hostCapability',
    ],
    [
      'participant',
      {
        v: PROTOCOL_VERSION,
        type: 'peer.joined',
        roomId: 'abcd-efgh-jkmp',
        payload: {
          participant: {
            peerId: 'peer-b',
            displayName: 'Grace',
            role: 'participant',
            canModerateMedia: false,
          },
        },
      },
      '$.payload.participant.canModerateMedia',
    ],
  ])('rejects an unsupported %s field', (_case, message, path) => {
    expect(() => parseServerMessage(message)).toThrow(path);
    expect(isServerMessage(message)).toBe(false);
  });

  it.each([
    ['unknown', 'screen'],
    ['empty', ''],
    ['non-string', false],
    ['missing', undefined],
  ])('rejects an %s disabled-media kind', (_case, kind) => {
    const message = {
      v: PROTOCOL_VERSION,
      type: 'moderation.media.disabled',
      roomId: 'abcd-efgh-jkmp',
      from: 'peer-host',
      payload: { targetPeerId: 'peer-b', kind },
    };

    expect(() => parseServerMessage(message)).toThrow('$.payload.kind');
    expect(isServerMessage(message)).toBe(false);
  });

  it.each([
    ['blank sender', ' ', 'peer-b', '$.from'],
    ['overlong sender', 'p'.repeat(MAX_PEER_ID_LENGTH + 1), 'peer-b', '$.from'],
    ['blank target', 'peer-host', ' ', '$.payload.targetPeerId'],
    ['overlong target', 'peer-host', 'p'.repeat(MAX_PEER_ID_LENGTH + 1), '$.payload.targetPeerId'],
  ])('rejects a disabled-media message with a %s', (_case, from, targetPeerId, path) => {
    const message = {
      v: PROTOCOL_VERSION,
      type: 'moderation.media.disabled',
      roomId: 'abcd-efgh-jkmp',
      from,
      payload: { targetPeerId, kind: 'audio' },
    };

    expect(() => parseServerMessage(message)).toThrow(path);
    expect(isServerMessage(message)).toBe(false);
  });

  it.each([
    [
      'envelope',
      {
        v: PROTOCOL_VERSION,
        type: 'moderation.media.disabled',
        roomId: 'abcd-efgh-jkmp',
        from: 'peer-host',
        to: 'peer-b',
        payload: { targetPeerId: 'peer-b', kind: 'video' },
      },
      '$.to',
    ],
    [
      'payload',
      {
        v: PROTOCOL_VERSION,
        type: 'moderation.media.disabled',
        roomId: 'abcd-efgh-jkmp',
        from: 'peer-host',
        payload: { targetPeerId: 'peer-b', kind: 'video', enabled: false },
      },
      '$.payload.enabled',
    ],
  ])('rejects an unsupported disabled-media %s field', (_case, message, path) => {
    expect(() => parseServerMessage(message)).toThrow(path);
    expect(isServerMessage(message)).toBe(false);
  });

  it('rejects an unsupported media-enabled event', () => {
    const message = {
      v: PROTOCOL_VERSION,
      type: 'moderation.media.enabled',
      roomId: 'abcd-efgh-jkmp',
      from: 'peer-host',
      payload: { targetPeerId: 'peer-b', kind: 'audio' },
    };

    expect(() => parseServerMessage(message)).toThrow('$.type');
    expect(isServerMessage(message)).toBe(false);
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
        selfRole: 'participant',
        capabilities: { canModerateMedia: false },
        participants: Array.from({ length: 400 }, (_, index) => ({
          peerId: `peer-${index}`,
          displayName: '가'.repeat(64),
          role: 'participant',
        })),
      },
    };

    expect(utf8ByteLength(JSON.stringify(message))).toBeGreaterThan(MAX_SIGNALING_FRAME_BYTES);
    expect(() => parseServerMessage(message)).toThrow(
      `serialized message must contain at most ${MAX_SIGNALING_FRAME_BYTES} UTF-8 bytes`,
    );
  });
});
