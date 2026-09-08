import { describe, expect, it } from 'vitest';
import { findChatSearchMatches, normalizeChatSearch } from './chat-search';

describe('채팅 검색 위치', () => {
  it.each([
    ['앞 가이드 / 가이드 뒤', '가이드', ['가이드', '가이드']],
    [`😀 ${'가이드'.normalize('NFD')} 뒤`, '가이드', ['가이드'.normalize('NFD')]],
    ['GUIDE guide', 'guide', ['GUIDE', 'guide']],
    ['ΟΣ 다음', 'ΟΣ', ['ΟΣ']],
    ['İ 다음 guide', 'guide', ['guide']],
    ['자료 [a+b]와 aab', '[a+b]', ['[a+b]']],
    ['메시지', '', []],
    ['메시지', '없는 내용', []],
  ])('원문 %s에서 %s의 표시 범위를 찾는다', (text, query, expected) => {
    const matches = findChatSearchMatches(text, normalizeChatSearch(query));
    expect(matches.map(({ start, end }) => text.slice(start, end))).toEqual(expected);
  });
});
