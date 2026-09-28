import { describe, expect, it } from 'vitest';
import { ringLevel, sessionTotals, usageLines } from './stats';

const items = [
  { kind: 'user' },
  { kind: 'assistant', usage: { input: 100, output: 20, cacheRead: 900, cacheWrite: 0 } },
  { kind: 'result', costUsd: 0.5 },
  { kind: 'user', meta: true }, // a meta line (compact summary…) is not a turn
  { kind: 'user' },
  { kind: 'assistant', usage: { input: 50, output: 30, cacheRead: 950, cacheWrite: 0 } },
  { kind: 'result', costUnknown: true },
];

describe('the old stats bar, now behind the usage ring', () => {
  it('turns, tokens in / out, cache share, cost (unknown counted, not zero)', () => {
    expect(sessionTotals(items)).toEqual({ turns: 2, inp: 150, out: 50, cache: 1850, cost: 0.5, costUnknown: 1 });
  });
  it('the ring: none without an occupancy, quiet under 60 %, noted from 60 %, strong from 80 %, error from 95 % (no yellow level)', () => {
    expect(ringLevel(undefined)).toBeNull();
    expect(ringLevel(Number.NaN)).toBeNull();
    expect(ringLevel(0)).toBe('quiet');
    expect(ringLevel(59)).toBe('quiet');
    expect(ringLevel(60)).toBe('note');
    expect(ringLevel(80)).toBe('strong');
    expect(ringLevel(94)).toBe('strong');
    expect(ringLevel(95)).toBe('err');
  });
  it('the lines the hover card shows (every field of the old bar)', () => {
    const lines = usageLines(sessionTotals(items), { lastMs: 4200, context: { percentage: 72, totalTokens: 145_000, maxTokens: 200_000 }, tasks: 2 });
    expect(lines.map((l) => l[0])).toEqual(['轮数', '输入 / 输出', '缓存命中', '费用', '上一轮用时', '上下文', '后台任务']);
    expect(lines.find((l) => l[0] === '轮数')?.[1]).toBe('2');
    expect(lines.find((l) => l[0] === '缓存命中')?.[1]).toBe('93%'); // 1850 of 2000 input tokens
    expect(lines.find((l) => l[0] === '费用')?.[1]).toBe('≥ $0.50');
    expect(lines.find((l) => l[0] === '上下文')?.[1]).toMatch(/^72% · 145/);
  });
  it('fields without data are left out', () => {
    expect(usageLines({ turns: 0, inp: 0, out: 0, cache: 0, cost: 0, costUnknown: 0 }, {}).map((l) => l[0])).toEqual(['轮数', '输入 / 输出']);
  });
});
