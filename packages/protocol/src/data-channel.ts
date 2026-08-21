import { ProtocolValidationError, utf8ByteLength } from './validation.js';

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

export type PeerDataMessage = ChatDataMessage | ChatAckDataMessage | ParticipantMediaDataMessage;

export function parsePeerDataMessage(raw: string): PeerDataMessage {
  assertFrameWithinBudget(raw);

  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new ProtocolValidationError('$', 'must be valid JSON');
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
    default:
      throw new ProtocolValidationError('$.type', 'must be a supported DataChannel message type');
  }
}

function assertFrameWithinBudget(raw: string): void {
  if (
    raw.length > MAX_DATA_CHANNEL_FRAME_BYTES ||
    utf8ByteLength(raw) > MAX_DATA_CHANNEL_FRAME_BYTES
  ) {
    throw new ProtocolValidationError(
      '$',
      `must be at most ${MAX_DATA_CHANNEL_FRAME_BYTES} UTF-8 bytes`,
    );
  }
}

function record(input: unknown, path: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ProtocolValidationError(path, 'must be an object');
  }
  return input as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  path: string,
): void {
  const actualKeys = Object.keys(value);
  if (
    actualKeys.length !== allowedKeys.length ||
    actualKeys.some((key) => !allowedKeys.includes(key))
  ) {
    throw new ProtocolValidationError(path, `must contain exactly: ${allowedKeys.join(', ')}`);
  }
}

function boundedIdentifier(input: unknown, path: string): void {
  if (
    typeof input !== 'string' ||
    input.length === 0 ||
    input.length > MAX_DATA_MESSAGE_ID_LENGTH
  ) {
    throw new ProtocolValidationError(
      path,
      `must be a string between 1 and ${MAX_DATA_MESSAGE_ID_LENGTH} characters`,
    );
  }
}

function dateSafeTimestamp(input: unknown, path: string): void {
  if (
    !Number.isSafeInteger(input) ||
    (input as number) < 0 ||
    (input as number) > MAX_DATE_TIMESTAMP_MS
  ) {
    throw new ProtocolValidationError(path, 'must be a Date-safe non-negative integer');
  }
}

function boundedText(input: unknown, path: string): void {
  if (typeof input !== 'string' || input.length === 0 || input.length > MAX_CHAT_TEXT_LENGTH) {
    throw new ProtocolValidationError(
      path,
      `must be a string between 1 and ${MAX_CHAT_TEXT_LENGTH} characters`,
    );
  }
}

function booleanValue(input: unknown, path: string): void {
  if (typeof input !== 'boolean') {
    throw new ProtocolValidationError(path, 'must be a boolean');
  }
}

function videoSource(input: unknown, path: string): void {
  if (input !== 'camera' && input !== 'screen') {
    throw new ProtocolValidationError(path, 'must be one of camera, screen');
  }
}
