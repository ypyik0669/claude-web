import { describe, expect, it } from 'vitest';
import { countAt, countText, splitNumbers } from './count-up';
import { turnSummaryParts } from '@/model/turn';

describe('splitNumbers', () => {
  it('numbers apart from the words around them', () => {
    expect(splitNumbers('已处理 1 分 42 秒')).toEqual([{ text: '已处理 ' }, { to: 1, s: '1' }, { text: ' 分 ' }, { to: 42, s: '42' }, { text: ' 秒' }]);
    expect(splitNumbers('读了 4 个文件')).toEqual([{ text: '读了 ' }, { to: 4, s: '4' }, { text: ' 个文件' }]);
  });
  it('no number → the text as it is; only a number → only the number; nothing → nothing', () => {
    expect(splitNumbers('已处理')).toEqual([{ text: '已处理' }]);
    expect(splitNumbers('12')).toEqual([{ to: 12, s: '12' }]);
    expect(splitNumbers('')).toEqual([]);
  });
});

describe('countAt / countText', () => {
  const n = { to: 42, s: '42' };
  it('0 at the start, the number at the end, in between never past it and never going back', () => {
    expect(countAt(n, 0)).toBe('0');
    expect(countAt(n, 1)).toBe('42');
    expect(countAt(n, 7)).toBe('42');
    let last = 0;
    for (let i = 0; i <= 52; i++) {
      const v = Number(countAt(n, i / 52));
      expect(v).toBeGreaterThanOrEqual(last);
      expect(v).toBeLessThanOrEqual(42);
      last = v;
    }
    // ease-out: more than half way by the middle
    expect(Number(countAt(n, 0.5))).toBeGreaterThan(21);
  });
  it('a progress that is not a number shows the result, not NaN', () => {
    expect(countAt(n, NaN)).toBe('42');
    expect(countAt(n, -1)).toBe('0');
  });
  it('at rest the line is exactly the summary’s own text (ui-smoke compares it literally)', () => {
    const summary = { durationMs: 102_000, reads: 4, edits: 2, commands: 2, searches: 0, others: 0, failed: 1, tools: 9 };
    for (const part of turnSummaryParts(summary)) {
      const parts = splitNumbers(part.text);
      expect(countText(parts, 1)).toBe(part.text);
      expect(countText(parts, 1.3)).toBe(part.text);
    }
    expect(turnSummaryParts(summary).map((p) => countText(splitNumbers(p.text), 0)).join(' · ')).toBe('已处理 0 分 0 秒 · 失败 0 个 · 读了 0 个文件 · 改了 0 个 · 运行 0 条命令');
  });
  it('a number written with leading zeros comes back as written', () => {
    const parts = splitNumbers('第 007 步');
    expect(countText(parts, 1)).toBe('第 007 步');
  });
});
