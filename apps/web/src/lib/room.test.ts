import { describe, expect, it } from 'vitest';
import {
  createRoomId,
  isValidRoomId,
  normalizeRoomId,
  pathForRoom,
  roomIdFromPath,
  sanitizeDisplayName,
} from './room';

describe('room helpers', () => {
  it('creates a readable room id without ambiguous characters', () => {
    const roomId = createRoomId(new Uint8Array(Array.from({ length: 18 }, (_, index) => index)));

    expect(roomId).toMatch(/^[a-z2-9]{4}(?:-[a-z2-9]{4}){2}$/);
    expect(isValidRoomId(roomId)).toBe(true);
  });

  it('normalizes pasted room ids', () => {
    expect(normalizeRoomId(' ABCD / EFGH / JKMP ')).toBe('abcd-efgh-jkmp');
  });

  it('parses only complete room routes', () => {
    expect(roomIdFromPath('/room/abcd-efgh-jkmp')).toBe('abcd-efgh-jkmp');
    expect(roomIdFromPath('/room/short')).toBeNull();
    expect(roomIdFromPath('/settings')).toBeNull();
    expect(pathForRoom('abcd-efgh-jkmp')).toBe('/room/abcd-efgh-jkmp');
  });

  it('keeps display names compact and readable', () => {
    expect(sanitizeDisplayName('  Lim    Study  ')).toBe('Lim Study');
    expect(sanitizeDisplayName('가'.repeat(40))).toHaveLength(24);
  });
});
