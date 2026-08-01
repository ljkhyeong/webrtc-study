import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { VideoTile, type ParticipantView } from './VideoTile';

function participant(overrides: Partial<ParticipantView> = {}): ParticipantView {
  return {
    peerId: 'peer-1',
    displayName: '스터디원',
    role: 'participant',
    isLocal: false,
    audioEnabled: true,
    videoEnabled: true,
    videoSource: 'camera',
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

  it('shows an actionable peer connection state before media connects', () => {
    const markup = renderToStaticMarkup(
      <VideoTile participant={participant({ connectionState: 'disconnected' })} />,
    );

    expect(markup).toContain('재연결 중');
    expect(markup).toContain('video-tile__connection--disconnected');
  });

  it('shows screen sharing without cropping and labels a verified host', () => {
    const markup = renderToStaticMarkup(
      <VideoTile
        participant={participant({
          role: 'host',
          videoSource: 'screen',
          stream: {} as MediaStream,
        })}
      />,
    );

    expect(markup).toContain('video-tile__media--screen');
    expect(markup).toContain('화면 공유 중');
    expect(markup).toContain('방장');
  });

  it('offers host-only disable controls for a remote participant', () => {
    const markup = renderToStaticMarkup(<VideoTile participant={participant()} canModerateMedia />);

    expect(markup).toContain('스터디원 마이크 끄기');
    expect(markup).toContain('스터디원 비디오 끄기');
    expect(markup).not.toContain('마이크 켜기');
    expect(markup).not.toContain('비디오 켜기');
  });

  it('never offers moderation controls for a host target', () => {
    const markup = renderToStaticMarkup(
      <VideoTile participant={participant({ role: 'host' })} canModerateMedia />,
    );

    expect(markup).not.toContain('미디어 관리');
  });
});
