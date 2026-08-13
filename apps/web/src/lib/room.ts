import {
  ROOM_ID_ALPHABET,
  ROOM_ID_PATTERN,
  ROOM_ID_SEGMENT_COUNT,
  ROOM_ID_SEGMENT_LENGTH,
} from '@round/protocol';

const ROOM_ID_LENGTH = ROOM_ID_SEGMENT_LENGTH * ROOM_ID_SEGMENT_COUNT;

export const DISPLAY_NAME_MAX_LENGTH = 24;

export function createRoomId(
  randomValues: Uint8Array = crypto.getRandomValues(new Uint8Array(18)),
) {
  const characters = Array.from(
    { length: ROOM_ID_LENGTH },
    (_, index) =>
      ROOM_ID_ALPHABET[randomValues[index % randomValues.length]! % ROOM_ID_ALPHABET.length],
  );

  return Array.from({ length: ROOM_ID_SEGMENT_COUNT }, (_, index) =>
    characters.slice(index * ROOM_ID_SEGMENT_LENGTH, (index + 1) * ROOM_ID_SEGMENT_LENGTH).join(''),
  ).join('-');
}

export function normalizeRoomId(value: string) {
  const compact = value
    .toLowerCase()
    .split('')
    .filter((character) => ROOM_ID_ALPHABET.includes(character))
    .slice(0, ROOM_ID_LENGTH)
    .join('');

  return Array.from({ length: ROOM_ID_SEGMENT_COUNT }, (_, index) =>
    compact.slice(index * ROOM_ID_SEGMENT_LENGTH, (index + 1) * ROOM_ID_SEGMENT_LENGTH),
  )
    .filter(Boolean)
    .join('-');
}

export function isValidRoomId(value: string) {
  return ROOM_ID_PATTERN.test(value);
}

export function sanitizeDisplayName(value: string) {
  return value.replace(/\s+/g, ' ').trim().slice(0, DISPLAY_NAME_MAX_LENGTH);
}

export function roomIdFromPath(pathname: string) {
  const match = /^\/room\/([^/]+)\/?$/.exec(pathname);
  if (!match) {
    return null;
  }

  try {
    const roomId = normalizeRoomId(decodeURIComponent(match[1]!));
    return isValidRoomId(roomId) ? roomId : null;
  } catch {
    return null;
  }
}

export function pathForRoom(roomId: string) {
  return `/room/${encodeURIComponent(roomId)}`;
}

export function canonicalRoomUrl(roomId: string, currentUrl: string) {
  const current = new URL(currentUrl);
  if (current.protocol !== 'https:' && current.protocol !== 'http:') {
    throw new Error('Room links require an HTTP origin');
  }
  return new URL(pathForRoom(roomId), current.origin).toString();
}
