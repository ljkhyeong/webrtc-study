import {
  CLIENT_MESSAGE_TYPES,
  PROTOCOL_VERSION,
  SERVER_MESSAGE_TYPES,
  SIGNALING_ERROR_CODES,
  type AnswerDescription,
  type ClientMessage,
  type OfferDescription,
  type Participant,
  type SerializedIceCandidate,
  type ServerMessage,
} from './types.js';

const MAX_ROOM_ID_LENGTH = 128;
const MAX_PEER_ID_LENGTH = 128;
const MAX_DISPLAY_NAME_LENGTH = 64;
const MAX_REQUEST_ID_LENGTH = 128;
const MAX_SDP_LENGTH = 64 * 1024;
const MAX_CANDIDATE_LENGTH = 8 * 1024;
const MAX_ERROR_MESSAGE_LENGTH = 1_024;

type UnknownRecord = Record<string, unknown>;

export class ProtocolValidationError extends Error {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`${path}: ${reason}`);
    this.name = 'ProtocolValidationError';
    this.path = path;
  }
}

export function parseClientMessage(input: unknown): ClientMessage {
  const message = record(input, '$');
  literal(message.v, PROTOCOL_VERSION, '$.v');
  oneOf(message.type, CLIENT_MESSAGE_TYPES, '$.type');

  switch (message.type) {
    case 'room.join':
      exactKeys(message, ['v', 'type', 'roomId', 'requestId', 'payload'], '$');
      roomId(message.roomId, '$.roomId');
      optionalRequestId(message.requestId, '$.requestId');
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
    case 'room.leave':
      exactKeys(message, ['v', 'type', 'roomId', 'requestId'], '$');
      roomId(message.roomId, '$.roomId');
      optionalRequestId(message.requestId, '$.requestId');
      return message as unknown as ClientMessage;
  }
}

export function parseServerMessage(input: unknown): ServerMessage {
  const message = record(input, '$');
  literal(message.v, PROTOCOL_VERSION, '$.v');
  oneOf(message.type, SERVER_MESSAGE_TYPES, '$.type');

  switch (message.type) {
    case 'room.joined':
      exactKeys(message, ['v', 'type', 'roomId', 'requestId', 'payload'], '$');
      roomId(message.roomId, '$.roomId');
      optionalRequestId(message.requestId, '$.requestId');
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
      optionalRequestId(message.requestId, '$.requestId');
      validateErrorPayload(message.payload, '$.payload');
      return message as unknown as ServerMessage;
  }
}

export function isClientMessage(input: unknown): input is ClientMessage {
  try {
    parseClientMessage(input);
    return true;
  } catch {
    return false;
  }
}

export function isServerMessage(input: unknown): input is ServerMessage {
  try {
    parseServerMessage(input);
    return true;
  } catch {
    return false;
  }
}

function relayEnvelope(message: UnknownRecord): void {
  roomId(message.roomId, '$.roomId');
  optionalRequestId(message.requestId, '$.requestId');
  boundedNonBlankString(message.to, MAX_PEER_ID_LENGTH, '$.to');
}

function serverRelayEnvelope(message: UnknownRecord): void {
  roomId(message.roomId, '$.roomId');
  boundedNonBlankString(message.from, MAX_PEER_ID_LENGTH, '$.from');
}

function validateJoinPayload(input: unknown, path: string): void {
  const payload = record(input, path);
  exactKeys(payload, ['displayName'], path);
  boundedNormalizedString(payload.displayName, MAX_DISPLAY_NAME_LENGTH, `${path}.displayName`);
}

function validateDescriptionPayload(
  input: unknown,
  expectedType: OfferDescription['type'] | AnswerDescription['type'],
  path: string,
): void {
  const payload = record(input, path);
  exactKeys(payload, ['description'], path);
  const description = record(payload.description, `${path}.description`);
  exactKeys(description, ['type', 'sdp'], `${path}.description`);
  literal(description.type, expectedType, `${path}.description.type`);
  if (description.sdp !== undefined) {
    boundedString(description.sdp, MAX_SDP_LENGTH, `${path}.description.sdp`);
  }
}

function validateIcePayload(input: unknown, path: string): void {
  const payload = record(input, path);
  exactKeys(payload, ['candidate'], path);
  if (payload.candidate === null) {
    return;
  }
  validateIceCandidate(payload.candidate, `${path}.candidate`);
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
  exactKeys(payload, ['peerId', 'participants'], path);
  boundedNonBlankString(payload.peerId, MAX_PEER_ID_LENGTH, `${path}.peerId`);
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
  exactKeys(participant, ['peerId', 'displayName'], path);
  boundedNonBlankString(participant.peerId, MAX_PEER_ID_LENGTH, `${path}.peerId`);
  boundedNormalizedString(participant.displayName, MAX_DISPLAY_NAME_LENGTH, `${path}.displayName`);
}

function validateErrorPayload(input: unknown, path: string): void {
  const payload = record(input, path);
  exactKeys(payload, ['code', 'message'], path);
  oneOf(payload.code, SIGNALING_ERROR_CODES, `${path}.code`);
  boundedNonBlankString(payload.message, MAX_ERROR_MESSAGE_LENGTH, `${path}.message`);
}

function roomId(input: unknown, path: string): void {
  boundedNormalizedString(input, MAX_ROOM_ID_LENGTH, path);
}

function optionalRequestId(input: unknown, path: string): void {
  if (input !== undefined) {
    boundedNonBlankString(input, MAX_REQUEST_ID_LENGTH, path);
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

function record(input: unknown, path: string): UnknownRecord {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    fail(path, 'must be an object');
  }
  return input as UnknownRecord;
}

function exactKeys(input: UnknownRecord, allowedKeys: readonly string[], path: string): void {
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(input).find((key) => !allowed.has(key));
  if (unexpected !== undefined) {
    fail(`${path}.${unexpected}`, 'is not allowed');
  }
}

function fail(path: string, reason: string): never {
  throw new ProtocolValidationError(path, reason);
}
