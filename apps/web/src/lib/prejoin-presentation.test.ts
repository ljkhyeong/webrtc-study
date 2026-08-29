import { describe, expect, it } from 'vitest';
import { prejoinMediaIssueMessage } from './prejoin-presentation';

describe('prejoinMediaIssueMessage', () => {
  it('keeps device-specific Korean guidance in the web layer', () => {
    expect(prejoinMediaIssueMessage('audio', 'permission-denied')).toContain('마이크 권한');
    expect(prejoinMediaIssueMessage('video', 'device-not-found')).toContain(
      '카메라를 찾지 못했습니다',
    );
    expect(prejoinMediaIssueMessage('audio', 'device-busy')).toContain('다른 앱이 사용 중');
    expect(prejoinMediaIssueMessage('video', 'track-ended')).toContain('카메라 연결이 종료');
  });
});
