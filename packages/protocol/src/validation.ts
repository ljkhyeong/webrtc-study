import {
  PROTOCOL_VERSION,
  SIGNALING_ERROR_CODES,
  type AnswerDescription,
  type ClientMessage,
  type OfferDescription,
  type Participant,
  type SerializedIceCandidate,
  type ServerMessage,
} from './types.js';
import { exactKeys, fail, record, type UnknownRecord } from './validation-primitives.js';

export { ProtocolValidationError } from './validation-primitives.js';

export const ROOM_ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const ROOM_ID_SEGMENT_LENGTH = 4;
export const ROOM_ID_SEGMENT_COUNT = 3;
export const ROOM_ID_PATTERN = new RegExp(
  `^[${ROOM_ID_ALPHABET}]{${ROOM_ID_SEGMENT_LENGTH}}(?:-[${ROOM_ID_ALPHABET}]{${ROOM_ID_SEGMENT_LENGTH}}){${ROOM_ID_SEGMENT_COUNT - 1}}$`,
);
const MAX_PEER_ID_LENGTH = 128;
const MAX_DISPLAY_NAME_LENGTH = 64;
export const MIN_HOST_CAPABILITY_LENGTH = 32;
export const MAX_HOST_CAPABILITY_LENGTH = 256;
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_CANDIDATE_LENGTH = 8 * 1024;
const MAX_ERROR_MESSAGE_LENGTH = 1_024;
const PARTICIPANT_ROLES = ['host', 'participant'] as const;
const MODERATED_MEDIA_KINDS = ['audio', 'video'] as const;
const UTF8_ENCODER = new TextEncoder();

export const MAX_SIGNALING_FRAME_BYTES = 64 * 1024;
export const MAX_SDP_BYTES = 48 * 1024;

export function parseClientMessage(input: unknown): ClientMessage {
  const message = record(input, '$');
  literal(message.v, PROTOCOL_VERSION, '$.v');

  switch (message.type) {
    case 'room.join':
      exactKeys(message, ['v', 'type', 'roomId', 'requestId', 'payload'], '$');
      roomId(message.roomId, '$.roomId');
      optionalIdentifier(message.requestId, '$.requestId');
      validateJoinPayload(message.payload, '$.payload');
      return message as unknown as ClientMessage;
    case 'rtc.offer':
      exactKeys(message, ['v', 'type', 'roomId', 'requestId', 'to', 'payload'], '$');
      relayEnvelope(message);
      validateDescriptionPayload(message.payload, 'offer', '$.payload');
      return message as unknown as ClientMessage;
    case 'rtc.answer':
      exactKeys(message, ['v', 'type', 'roomId', 'requestId', 'to', 'payload'], '$');
      relayEnvelope(message);
      validateDescriptionPayload(message.payload, 'answer', '$.payload');
      return message as unknown as ClientMessage;
    case 'rtc.ice':
      exactKeys(message, ['v', 'type', 'roomId', 'requestId', 'to', 'payload'], '$');
      relayEnvelope(message);
      validateIcePayload(message.payload, '$.payload');
      return message as unknown as ClientMessage;
    case 'moderation.media.disable':
      exactKeys(message, ['v', 'type', 'roomId', 'requestId', 'to', 'payload'], '$');
      relayEnvelope(message);
      validateModerationMediaDisablePayload(message.payload, '$.payload');
      return message as unknown as ClientMessage;
    case 'room.leave':
      exactKeys(message, ['v', 'type', 'roomId', 'requestId'], '$');
      roomId(message.roomId, '$.roomId');
      optionalIdentifier(message.requestId, '$.requestId');
      return message as unknown as ClientMessage;
    default:
      fail('$.type', 'must be a supported client message type');
  }
}

export function parseServerMessage(input: unknown): ServerMessage {
  const message = record(input, '$');
  serializeFrame(message);
  return validateServerMessage(message);
}

export function parseServerMessageText(raw: string): ServerMessage {
  if (raw.length > MAX_SIGNALING_FRAME_BYTES || utf8ByteLength(raw) > MAX_SIGNALING_FRAME_BYTES) {
    fail('$', `message must contain at most ${MAX_SIGNALING_FRAME_BYTES} UTF-8 bytes`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail('$', 'must be valid JSON');
  }

  return validateServerMessage(record(parsed, '$'));
}

function validateServerMessage(message: UnknownRecord): ServerMessage {
  literal(message.v, PROTOCOL_VERSION, '$.v');

  switch (message.type) {
    case 'room.joined':
      exactKeys(message, ['v', 'type', 'roomId', 'requestId', 'payload'], '$');
      roomId(message.roomId, '$.roomId');
      optionalIdentifier(message.requestId, '$.requestId');
      validateRoomJoinedPayload(message.payload, '$.payload');
      return message as unknown as ServerMessage;
    case 'peer.joined':
      exactKeys(message, ['v', 'type', 'roomId', 'payload'], '$');
      roomId(message.roomId, '$.roomId');
      validatePeerJoinedPayload(message.payload, '$.payload');
      return message as unknown as ServerMessage;
    case 'rtc.offer':
      exactKeys(message, ['v', 'type', 'roomId', 'from', 'payload'], '$');
      serverRelayEnvelope(message);
      validateDescriptionPayload(message.payload, 'offer', '$.payload');
      return message as unknown as ServerMessage;
    case 'rtc.answer':
      exactKeys(message, ['v', 'type', 'roomId', 'from', 'payload'], '$');
      serverRelayEnvelope(message);
      validateDescriptionPayload(message.payload, 'answer', '$.payload');
      return message as unknown as ServerMessage;
    case 'rtc.ice':
      exactKeys(message, ['v', 'type', 'roomId', 'from', 'payload'], '$');
      serverRelayEnvelope(message);
      validateIcePayload(message.payload, '$.payload');
      return message as unknown as ServerMessage;
    case 'moderation.media.disabled':
      exactKeys(message, ['v', 'type', 'roomId', 'from', 'requestId', 'payload'], '$');
      roomId(message.roomId, '$.roomId');
      boundedNonBlankString(message.from, MAX_PEER_ID_LENGTH, '$.from');
      optionalIdentifier(message.requestId, '$.requestId');
      validateModerationMediaDisabledPayload(message.payload, '$.payload');
      return message as unknown as ServerMessage;
    case 'peer.left':
      exactKeys(message, ['v', 'type', 'roomId', 'payload'], '$');
      roomId(message.roomId, '$.roomId');
      validatePeerLeftPayload(message.payload, '$.payload');
      return message as unknown as ServerMessage;
    case 'error':
      exactKeys(message, ['v', 'type', 'roomId', 'requestId', 'payload'], '$');
      if (message.roomId !== undefined) {
        roomId(message.roomId, '$.roomId');
      }
      optionalIdentifier(message.requestId, '$.requestId');
      validateErrorPayload(message.payload, '$.payload');
      return message as unknown as ServerMessage;
    default:
      fail('$.type', 'must be a supported server message type');
  }
}

export function serializeClientMessage(input: unknown): string {
  return serializeFrame(parseClientMessage(input) as unknown as UnknownRecord);
}

export function utf8ByteLength(value: string): number {
  return UTF8_ENCODER.encode(value).byteLength;
}

function relayEnvelope(message: UnknownRecord): void {
  roomId(message.roomId, '$.roomId');
  optionalIdentifier(message.requestId, '$.requestId');
  boundedNonBlankString(message.to, MAX_PEER_ID_LENGTH, '$.to');
}

function serverRelayEnvelope(message: UnknownRecord): void {
  roomId(message.roomId, '$.roomId');
  boundedNonBlankString(message.from, MAX_PEER_ID_LENGTH, '$.from');
}

function validateJoinPayload(input: unknown, path: string): void {
  const payload = record(input, path);
  exactKeys(payload, ['displayName', 'hostCapability'], path);
  boundedNormalizedString(payload.displayName, MAX_DISPLAY_NAME_LENGTH, `${path}.displayName`);
  if (payload.hostCapability !== undefined) {
    boundedNonBlankString(
      payload.hostCapability,
      MAX_HOST_CAPABILITY_LENGTH,
      `${path}.hostCapability`,
    );
    if ((payload.hostCapability as string).length < MIN_HOST_CAPABILITY_LENGTH) {
      fail(
        `${path}.hostCapability`,
        `must contain at least ${MIN_HOST_CAPABILITY_LENGTH} characters`,
      );
    }
  }
}

function validateDescriptionPayload(
  input: unknown,
  expectedType: OfferDescription['type'] | AnswerDescription['type'],
  path: string,
): void {
  const payload = record(input, path);
  exactKeys(payload, ['description', 'negotiationId'], path);
  optionalIdentifier(payload.negotiationId, `${path}.negotiationId`);
  const description = record(payload.description, `${path}.description`);
  exactKeys(description, ['type', 'sdp'], `${path}.description`);
  literal(description.type, expectedType, `${path}.description.type`);
  if (description.sdp !== undefined) {
    boundedUtf8String(description.sdp, MAX_SDP_BYTES, `${path}.description.sdp`);
  }
}

function validateIcePayload(input: unknown, path: string): void {
  const payload = record(input, path);
  exactKeys(payload, ['candidate', 'negotiationId'], path);
  optionalIdentifier(payload.negotiationId, `${path}.negotiationId`);
  if (payload.candidate === null) {
    return;
  }
  validateIceCandidate(payload.candidate, `${path}.candidate`);
}

function validateModerationMediaDisablePayload(input: unknown, path: string): void {
  const payload = record(input, path);
  exactKeys(payload, ['kind'], path);
  oneOf(payload.kind, MODERATED_MEDIA_KINDS, `${path}.kind`);
}

function validateModerationMediaDisabledPayload(input: unknown, path: string): void {
  const payload = record(input, path);
  exactKeys(payload, ['targetPeerId', 'kind'], path);
  boundedNonBlankString(payload.targetPeerId, MAX_PEER_ID_LENGTH, `${path}.targetPeerId`);
  oneOf(payload.kind, MODERATED_MEDIA_KINDS, `${path}.kind`);
}

function validateIceCandidate(
  input: unknown,
  path: string,
): asserts input is SerializedIceCandidate {
  const candidate = record(input, path);
  exactKeys(candidate, ['candidate', 'sdpMid', 'sdpMLineIndex', 'usernameFragment'], path);
  boundedString(candidate.candidate, MAX_CANDIDATE_LENGTH, `${path}.candidate`);
  nullableOptionalString(candidate.sdpMid, 256, `${path}.sdpMid`);
  if (
    candidate.sdpMLineIndex !== undefined &&
    candidate.sdpMLineIndex !== null &&
    (!Number.isInteger(candidate.sdpMLineIndex) ||
      (candidate.sdpMLineIndex as number) < 0 ||
      (candidate.sdpMLineIndex as number) > 65_535)
  ) {
    fail(`${path}.sdpMLineIndex`, 'must be null or an integer between 0 and 65535');
  }
  nullableOptionalString(candidate.usernameFragment, 256, `${path}.usernameFragment`);
}

function validateRoomJoinedPayload(input: unknown, path: string): void {
  const payload = record(input, path);
  exactKeys(payload, ['peerId', 'selfRole', 'capabilities', 'participants'], path);
  boundedNonBlankString(payload.peerId, MAX_PEER_ID_LENGTH, `${path}.peerId`);
  oneOf(payload.selfRole, PARTICIPANT_ROLES, `${path}.selfRole`);
  validateCapabilities(payload.capabilities, `${path}.capabilities`);
  if (!Array.isArray(payload.participants)) {
    fail(`${path}.participants`, 'must be an array');
  }
  payload.participants.forEach((participant, index) => {
    validateParticipant(participant, `${path}.participants[${index}]`);
  });
}

function validatePeerJoinedPayload(input: unknown, path: string): void {
  const payload = record(input, path);
  exactKeys(payload, ['participant'], path);
  validateParticipant(payload.participant, `${path}.participant`);
}

function validatePeerLeftPayload(input: unknown, path: string): void {
  const payload = record(input, path);
  exactKeys(payload, ['peerId'], path);
  boundedNonBlankString(payload.peerId, MAX_PEER_ID_LENGTH, `${path}.peerId`);
}

function validateParticipant(input: unknown, path: string): asserts input is Participant {
  const participant = record(input, path);
  exactKeys(participant, ['peerId', 'displayName', 'role'], path);
  boundedNonBlankString(participant.peerId, MAX_PEER_ID_LENGTH, `${path}.peerId`);
  boundedNormalizedString(participant.displayName, MAX_DISPLAY_NAME_LENGTH, `${path}.displayName`);
  oneOf(participant.role, PARTICIPANT_ROLES, `${path}.role`);
}

function validateCapabilities(input: unknown, path: string): void {
  const capabilities = record(input, path);
  exactKeys(capabilities, ['canModerateMedia'], path);
  if (typeof capabilities.canModerateMedia !== 'boolean') {
    fail(`${path}.canModerateMedia`, 'must be a boolean');
  }
}

function validateErrorPayload(input: unknown, path: string): void {
  const payload = record(input, path);
  exactKeys(payload, ['code', 'message'], path);
  oneOf(payload.code, SIGNALING_ERROR_CODES, `${path}.code`);
  boundedNonBlankString(payload.message, MAX_ERROR_MESSAGE_LENGTH, `${path}.message`);
}

function roomId(input: unknown, path: string): void {
  if (typeof input !== 'string' || !ROOM_ID_PATTERN.test(input)) {
    fail(path, 'must be a canonical ROUND room id');
  }
}

function optionalIdentifier(input: unknown, path: string): void {
  if (input !== undefined) {
    boundedNonBlankString(input, MAX_IDENTIFIER_LENGTH, path);
  }
}

function nullableOptionalString(input: unknown, maximumLength: number, path: string): void {
  if (input !== undefined && input !== null) {
    boundedString(input, maximumLength, path);
  }
}

function boundedNormalizedString(input: unknown, maximumLength: number, path: string): void {
  boundedNonBlankString(input, maximumLength, path);
  if ((input as string).trim() !== input) {
    fail(path, 'must not start or end with whitespace');
  }
}

function boundedNonBlankString(input: unknown, maximumLength: number, path: string): void {
  boundedString(input, maximumLength, path);
  if ((input as string).trim().length === 0) {
    fail(path, 'must not be blank');
  }
}

function boundedString(input: unknown, maximumLength: number, path: string): void {
  if (typeof input !== 'string') {
    fail(path, 'must be a string');
  }
  if (input.length > maximumLength) {
    fail(path, `must contain at most ${maximumLength} characters`);
  }
}

function boundedUtf8String(input: unknown, maximumBytes: number, path: string): void {
  if (typeof input !== 'string') {
    fail(path, 'must be a string');
  }
  if (utf8ByteLength(input) > maximumBytes) {
    fail(path, `must contain at most ${maximumBytes} UTF-8 bytes`);
  }
}

function serializeFrame(message: UnknownRecord): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(message);
  } catch {
    fail('$', 'must be serializable as JSON');
  }
  if (serialized === undefined) {
    fail('$', 'must be serializable as a JSON object');
  }
  if (utf8ByteLength(serialized) > MAX_SIGNALING_FRAME_BYTES) {
    fail('$', `serialized message must contain at most ${MAX_SIGNALING_FRAME_BYTES} UTF-8 bytes`);
  }
  return serialized;
}

function literal<T extends string | number>(
  input: unknown,
  expected: T,
  path: string,
): asserts input is T {
  if (input !== expected) {
    fail(path, `must equal ${JSON.stringify(expected)}`);
  }
}

function oneOf<const T extends readonly string[]>(
  input: unknown,
  allowed: T,
  path: string,
): asserts input is T[number] {
  if (typeof input !== 'string' || !allowed.includes(input)) {
    fail(path, `must be one of ${allowed.join(', ')}`);
  }
}
