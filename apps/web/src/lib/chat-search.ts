export interface ChatSearchMatch {
  readonly start: number;
  readonly end: number;
}

const graphemes = new Intl.Segmenter('ko', { granularity: 'grapheme' });

export function normalizeChatSearch(text: string): string {
  return text.normalize('NFC').toLocaleLowerCase('ko-KR');
}

export function findChatSearchMatches(text: string, normalizedQuery: string): ChatSearchMatch[] {
  if (!normalizedQuery) return [];
  const normalized = normalizeChatSearch(text);
  const firstMatch = normalized.indexOf(normalizedQuery);
  if (firstMatch === -1) return [];
  const starts: number[] = [];
  const ends: number[] = [];
  for (const { segment, index } of graphemes.segment(text)) {
    const folded = normalizeChatSearch(segment);
    for (let offset = 0; offset < folded.length; offset += 1) {
      starts.push(index);
      ends.push(index + segment.length);
    }
  }
  const matches: ChatSearchMatch[] = [];
  for (
    let index = firstMatch;
    index !== -1;
    index = normalized.indexOf(normalizedQuery, index + normalizedQuery.length)
  ) {
    matches.push({ start: starts[index]!, end: ends[index + normalizedQuery.length - 1]! });
  }
  return matches;
}
