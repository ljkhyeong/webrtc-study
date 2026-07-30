import { describe, expect, it, vi } from 'vitest';
import {
  createWithPreparedMedia,
  stopMediaStreamTracks,
  withPreparedMediaFailureCleanup,
} from './prepared-media';

function preparedStream(...tracks: Array<{ stop: () => void }>): MediaStream {
  return {
    getTracks: () => tracks,
  } as unknown as MediaStream;
}

describe('prepared media ownership transfer', () => {
  it('stops every track while the prepared stream is still app-owned', () => {
    const audioTrack = { stop: vi.fn() };
    const videoTrack = { stop: vi.fn() };

    stopMediaStreamTracks(preparedStream(audioTrack, videoTrack));

    expect(audioTrack.stop).toHaveBeenCalledOnce();
    expect(videoTrack.stop).toHaveBeenCalledOnce();
  });

  it('transfers a prepared stream without stopping it when session creation succeeds', () => {
    const track = { stop: vi.fn() };
    const stream = preparedStream(track);
    const create = vi.fn(() => 'session');

    expect(createWithPreparedMedia(() => stream, create)).toBe('session');
    expect(create).toHaveBeenCalledWith(stream);
    expect(track.stop).not.toHaveBeenCalled();
  });

  it('stops a transferred stream when session creation throws', () => {
    const track = { stop: vi.fn() };
    const stream = preparedStream(track);

    expect(() =>
      createWithPreparedMedia(
        () => stream,
        () => {
          throw new Error('session creation failed');
        },
      ),
    ).toThrow('session creation failed');
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it.each(['invalid endpoint configuration', 'TURN request rejected'])(
    'releases app-owned media when current room startup fails: %s',
    async (message) => {
      const release = vi.fn();

      await expect(
        withPreparedMediaFailureCleanup(
          async () => {
            throw new Error(message);
          },
          {
            hasSession: () => false,
            isCurrent: () => true,
            release,
          },
        ),
      ).rejects.toThrow(message);
      expect(release).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { hasSession: false, isCurrent: false, label: 'stale startup' },
    { hasSession: true, isCurrent: true, label: 'session-owned media' },
  ])('keeps media ownership unchanged after a $label failure', async (state) => {
    const release = vi.fn();

    await expect(
      withPreparedMediaFailureCleanup(
        async () => {
          throw new Error('startup failed');
        },
        {
          hasSession: () => state.hasSession,
          isCurrent: () => state.isCurrent,
          release,
        },
      ),
    ).rejects.toThrow('startup failed');
    expect(release).not.toHaveBeenCalled();
  });
});
