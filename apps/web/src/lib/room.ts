const ROOM_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const ROOM_SEGMENT_LENGTH = 4;
const ROOM_SEGMENT_COUNT = 3;
const ROOM_ID_LENGTH = ROOM_SEGMENT_LENGTH * ROOM_SEGMENT_COUNT;

export const DISPLAY_NAME_MAX_LENGTH = 24;

export function createRoomId(
  randomValues: Uint8Array = crypto.getRandomValues(new Uint8Array(18)),
) {
  const characters = Array.from(
    { length: ROOM_ID_LENGTH },
    (_, index) => ROOM_ALPHABET[randomValues[index % randomValues.length]! % ROOM_ALPHABET.length],
  );

  return Array.from({ length: ROOM_SEGMENT_COUNT }, (_, index) =>
    characters.slice(index * ROOM_SEGMENT_LENGTH, (index + 1) * ROOM_SEGMENT_LENGTH).join(''),
  ).join('-');
}

export function normalizeRoomId(value: string) {
  const compact = value
    .toLowerCase()
    .split('')
    .filter((character) => ROOM_ALPHABET.includes(character))
    .slice(0, ROOM_ID_LENGTH)
    .join('');

  return Array.from({ length: ROOM_SEGMENT_COUNT }, (_, index) =>
    compact.slice(index * ROOM_SEGMENT_LENGTH, (index + 1) * ROOM_SEGMENT_LENGTH),
  )
    .filter(Boolean)
    .join('-');
}

export function isValidRoomId(value: string) {
  return new RegExp(
    `^[${ROOM_ALPHABET}]{${ROOM_SEGMENT_LENGTH}}(?:-[${ROOM_ALPHABET}]{${ROOM_SEGMENT_LENGTH}}){${
      ROOM_SEGMENT_COUNT - 1
    }}$`,
  ).test(value);
}

export function sanitizeDisplayName(value: string) {
  return value.replace(/\s+/g, ' ').trim().slice(0, DISPLAY_NAME_MAX_LENGTH);
}

export function roomIdFromPath(pathname: string) {
  const match = /^\/room\/([^/]+)\/?$/.exec(pathname);
  if (!match) {
    return null;
  }

  const roomId = normalizeRoomId(decodeURIComponent(match[1]!));
  return isValidRoomId(roomId) ? roomId : null;
}

export function pathForRoom(roomId: string) {
  return `/room/${encodeURIComponent(roomId)}`;
}
