// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setDocumentTitleNotice, setDocumentTitleUnreadCount } from './document-title';

describe('통화 중 브라우저 탭 제목', () => {
  beforeEach(() => {
    document.title = 'ROUND — study room';
  });

  afterEach(() => {
    setDocumentTitleNotice(null);
    setDocumentTitleUnreadCount(0);
  });

  it('새 메시지 수와 타이머 종료 안내를 함께 표시하고 순서와 관계없이 원래 제목으로 되돌린다', () => {
    setDocumentTitleUnreadCount(2);
    expect(document.title).toBe('(2) ROUND — study room');

    setDocumentTitleNotice('집중 시간이 끝났습니다');
    expect(document.title).toBe('(2) 집중 시간이 끝났습니다 · ROUND');

    setDocumentTitleUnreadCount(0);
    expect(document.title).toBe('집중 시간이 끝났습니다 · ROUND');

    setDocumentTitleNotice(null);
    expect(document.title).toBe('ROUND — study room');
  });

  it('많은 메시지는 99+로 줄여 표시한다', () => {
    setDocumentTitleUnreadCount(120);
    expect(document.title).toBe('(99+) ROUND — study room');
  });
});
