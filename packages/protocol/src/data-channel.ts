import { utf8ByteLength } from './validation.js';
import { exactKeys, fail, record } from './validation-primitives.js';

export const MAX_DATA_CHANNEL_FRAME_BYTES = 32 * 1024;
const MAX_CHAT_TEXT_LENGTH = 4_000;
const MAX_DATA_MESSAGE_ID_LENGTH = 128;

const MAX_DATE_TIMESTAMP_MS = 8_640_000_000_000_000;

export interface ChatDataMessage {
  readonly type: 'chat.message';
  readonly id: string;
  readonly senderId: string;
  readonly sentAt: number;
  readonly text: string;
}

export interface ChatAckDataMessage {
  readonly type: 'chat.ack';
  readonly messageId: string;
}

export interface ParticipantMediaDataMessage {
  readonly type: 'participant.media';
  readonly audioEnabled: boolean;
  readonly videoEnabled: boolean;
  readonly videoSource: 'camera' | 'screen';
}

export interface ParticipantHandDataMessage {
  readonly type: 'participant.hand';
  readonly raised: boolean;
}

export type PeerDataMessage =
  ChatDataMessage | ChatAckDataMessage | ParticipantMediaDataMessage | ParticipantHandDataMessage;

export function parsePeerDataMessage(raw: string): PeerDataMessage {
  assertFrameWithinBudget(raw);

  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    fail('$', 'must be valid JSON');
  }
  return validatePeerDataMessage(input);
}

export function serializePeerDataMessage(input: PeerDataMessage): string {
  const serialized = JSON.stringify(validatePeerDataMessage(input));
  assertFrameWithinBudget(serialized);
  return serialized;
}

function validatePeerDataMessage(input: unknown): PeerDataMessage {
  const message = record(input, '$');
  switch (message.type) {
    case 'chat.message':
      exactKeys(message, ['type', 'id', 'senderId', 'sentAt', 'text'], '$');
      boundedIdentifier(message.id, '$.id');
      boundedIdentifier(message.senderId, '$.senderId');
      dateSafeTimestamp(message.sentAt, '$.sentAt');
      boundedText(message.text, '$.text');
      return message as unknown as ChatDataMessage;
    case 'chat.ack':
      exactKeys(message, ['type', 'messageId'], '$');
      boundedIdentifier(message.messageId, '$.messageId');
      return message as unknown as ChatAckDataMessage;
    case 'participant.media':
      exactKeys(message, ['type', 'audioEnabled', 'videoEnabled', 'videoSource'], '$');
      booleanValue(message.audioEnabled, '$.audioEnabled');
      booleanValue(message.videoEnabled, '$.videoEnabled');
      videoSource(message.videoSource, '$.videoSource');
      return message as unknown as ParticipantMediaDataMessage;
    case 'participant.hand':
      exactKeys(message, ['type', 'raised'], '$');
      booleanValue(message.raised, '$.raised');
      return message as unknown as ParticipantHandDataMessage;
    default:
      fail('$.type', 'must be a supported DataChannel message type');
  }
}

function assertFrameWithinBudget(raw: string): void {
  if (
    raw.length > MAX_DATA_CHANNEL_FRAME_BYTES ||
    utf8ByteLength(raw) > MAX_DATA_CHANNEL_FRAME_BYTES
  ) {
    fail('$', `must be at most ${MAX_DATA_CHANNEL_FRAME_BYTES} UTF-8 bytes`);
  }
}

function boundedIdentifier(input: unknown, path: string): void {
  if (
    typeof input !== 'string' ||
    input.length === 0 ||
    input.length > MAX_DATA_MESSAGE_ID_LENGTH
  ) {
    fail(path, `must be a string between 1 and ${MAX_DATA_MESSAGE_ID_LENGTH} characters`);
  }
}

function dateSafeTimestamp(input: unknown, path: string): void {
  if (
    !Number.isSafeInteger(input) ||
    (input as number) < 0 ||
    (input as number) > MAX_DATE_TIMESTAMP_MS
  ) {
    fail(path, 'must be a Date-safe non-negative integer');
  }
}

function boundedText(input: unknown, path: string): void {
  if (typeof input !== 'string' || input.length === 0 || input.length > MAX_CHAT_TEXT_LENGTH) {
    fail(path, `must be a string between 1 and ${MAX_CHAT_TEXT_LENGTH} characters`);
  }
}

function booleanValue(input: unknown, path: string): void {
  if (typeof input !== 'boolean') {
    fail(path, 'must be a boolean');
  }
}

function videoSource(input: unknown, path: string): void {
  if (input !== 'camera' && input !== 'screen') {
    fail(path, 'must be one of camera, screen');
  }
}
