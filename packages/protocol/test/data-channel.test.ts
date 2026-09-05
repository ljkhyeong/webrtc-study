import { describe, expect, it } from 'vitest';

import {
  MAX_DATA_CHANNEL_FRAME_BYTES,
  ProtocolValidationError,
  parsePeerDataMessage,
  serializePeerDataMessage,
  type PeerDataMessage,
} from '../src/index.js';

describe('DataChannel message validation', () => {
  it.each([true, false])('손들기 상태 %s를 왕복 변환한다', (raised) => {
    const message = { type: 'participant.hand' as const, raised };
    expect(parsePeerDataMessage(serializePeerDataMessage(message))).toEqual(message);
  });

  it.each([
    { type: 'participant.hand' },
    { type: 'participant.hand', raised: 'true' },
    { type: 'participant.hand', raised: true, peerId: '다른 참가자' },
  ])('잘못된 손들기 상태와 대상 지정을 거부한다', (message) => {
    expect(() => parsePeerDataMessage(JSON.stringify(message))).toThrow(ProtocolValidationError);
  });

  it.each<PeerDataMessage>([
    {
      type: 'chat.message',
      id: 'message-1',
      senderId: 'peer-a',
      sentAt: 1_234,
      text: 'hello',
    },
    {
      type: 'chat.ack',
      messageId: 'message-1',
    },
    {
      type: 'participant.media',
      audioEnabled: true,
      videoEnabled: false,
      videoSource: 'camera',
    },
    {
      type: 'participant.media',
      audioEnabled: true,
      videoEnabled: true,
      videoSource: 'screen',
    },
  ])('round-trips $type', (message) => {
    expect(parsePeerDataMessage(serializePeerDataMessage(message))).toEqual(message);
  });

  it.each([
    { type: 'chat.ack', messageId: '' },
    { type: 'chat.ack', messageId: 'm'.repeat(129) },
    { type: 'chat.ack', messageId: 123 },
    { type: 'chat.ack', messageId: 'message-1', extra: true },
  ])('rejects an invalid chat acknowledgement', (message) => {
    expect(() => parsePeerDataMessage(JSON.stringify(message))).toThrow(ProtocolValidationError);
  });

  it('rejects malformed JSON and unsupported message types', () => {
    expect(() => parsePeerDataMessage('{')).toThrow(ProtocolValidationError);
    expect(() => parsePeerDataMessage('{"type":"chat.unknown"}')).toThrow(ProtocolValidationError);
  });

  it.each([
    {
      type: 'participant.media',
      audioEnabled: true,
      videoEnabled: false,
    },
    {
      type: 'participant.media',
      audioEnabled: true,
      videoEnabled: false,
      videoSource: 'window',
    },
    {
      type: 'participant.media',
      audioEnabled: true,
      videoEnabled: false,
      videoSource: 'screen',
      extra: true,
    },
  ])('rejects an invalid participant media source', (message) => {
    expect(() => parsePeerDataMessage(JSON.stringify(message))).toThrow(ProtocolValidationError);
  });

  it('rejects a raw frame before parsing when it exceeds the UTF-8 budget', () => {
    const oversized = JSON.stringify({
      type: 'chat.ack',
      messageId: 'message-1',
      padding: '가'.repeat(MAX_DATA_CHANNEL_FRAME_BYTES),
    });

    expect(() => parsePeerDataMessage(oversized)).toThrow(
      `must be at most ${MAX_DATA_CHANNEL_FRAME_BYTES} UTF-8 bytes`,
    );
  });
});
