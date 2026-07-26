import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { VideoTile, type ParticipantView } from './VideoTile';

function participant(overrides: Partial<ParticipantView> = {}): ParticipantView {
  return {
    peerId: 'peer-1',
    displayName: '스터디원',
    isLocal: false,
    audioEnabled: true,
    videoEnabled: true,
    connectionState: 'connected',
    ...overrides,
  };
}

describe('VideoTile', () => {
  it('keeps the media element mounted for audio when the camera is off', () => {
    const markup = renderToStaticMarkup(
      <VideoTile
        participant={participant({
          stream: {} as MediaStream,
          videoEnabled: false,
        })}
      />,
    );

    expect(markup).toContain('<video');
    expect(markup).toContain('video-tile__media--hidden');
    expect(markup).toContain('카메라 꺼짐');
  });

  it('does not create a media element before a stream exists', () => {
    const markup = renderToStaticMarkup(
      <VideoTile participant={participant({ stream: undefined })} />,
    );

    expect(markup).not.toContain('<video');
    expect(markup).toContain('카메라 꺼짐');
  });
});
