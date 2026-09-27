import { describe, expect, it } from 'vitest';
import { byteRangesToChars, parseRgLine } from './service.js';

describe('rg --json parsing', () => {
  it('turns UTF-8 byte offsets into string indices', () => {
    const text = '中文 foo 测试';
    // "foo" starts at byte 7 (2×3 bytes + space) and char 3
    expect(byteRangesToChars(text, [{ start: 7, end: 10 }])).toEqual([{ start: 3, end: 6 }]);
    expect(text.slice(3, 6)).toBe('foo');
    expect(byteRangesToChars('plain foo', [{ start: 6, end: 9 }])).toEqual([{ start: 6, end: 9 }]);
  });

  it('parses a match line and skips non-UTF-8 paths', () => {
    const line = JSON.stringify({ type: 'match', data: { path: { text: '/a/b.ts' }, lines: { text: 'é foo\n' }, line_number: 4, submatches: [{ match: { text: 'foo' }, start: 3, end: 6 }] } });
    expect(parseRgLine(line)).toEqual({ path: '/a/b.ts', match: { line: 4, text: 'é foo', ranges: [{ start: 2, end: 5 }] } });
    expect(parseRgLine(JSON.stringify({ type: 'match', data: { path: { bytes: 'L2E=' }, lines: { bytes: 'eA==' }, line_number: 1, submatches: [] } }))).toBeNull();
    expect(parseRgLine(JSON.stringify({ type: 'begin', data: {} }))).toBeNull();
    expect(parseRgLine('not json')).toBeNull();
  });
});
