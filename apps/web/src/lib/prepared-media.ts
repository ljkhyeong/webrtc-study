export function stopMediaStreamTracks(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) {
    track.stop();
  }
}

export function createWithPreparedMedia<T>(
  takePreparedMediaStream: () => MediaStream | null,
  create: (preparedMediaStream: MediaStream | null) => T,
): T {
  const preparedMediaStream = takePreparedMediaStream();
  try {
    return create(preparedMediaStream);
  } catch (error) {
    stopMediaStreamTracks(preparedMediaStream);
    throw error;
  }
}

export interface PreparedMediaFailureCleanup {
  readonly isCurrent: () => boolean;
  readonly hasSession: () => boolean;
  readonly release: () => void;
}

export async function withPreparedMediaFailureCleanup<T>(
  operation: () => Promise<T>,
  cleanup: PreparedMediaFailureCleanup,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (cleanup.isCurrent() && !cleanup.hasSession()) {
      cleanup.release();
    }
    throw error;
  }
}
