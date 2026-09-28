import { describe, expect, it } from 'vitest';
import { ClientLogGate } from './client-log.js';

const report = (message: string, area = '设置 · 模型', extra: Record<string, string> = {}) => ({ kind: 'client.log' as const, level: 'error' as const, area, message, ...extra });

describe('client.log gate', () => {
  const gate = (o: { perConn?: number; global?: number } = {}) => {
    let t = 0;
    return { g: new ClientLogGate<object>({ ...o, windowMs: 60_000, now: () => t }), at: (ms: number) => { t = ms; } };
  };

  it('formats a boundary report, indenting stacks so they cannot pose as log lines', () => {
    const { g } = gate();
    const line = g.admit({}, report('boom\n[fake] line', '设置 · 模型', { stack: 'Error: boom\n    at A', componentStack: '\n    at ModelsSection' }))!;
    const lines = line.split('\n');
    expect(lines[0]).toBe('[web error] 设置 · 模型: boom ⏎ [fake] line');
    expect(lines.slice(1).every((l) => l.startsWith('    |') || l === '  component stack:')).toBe(true);
  });

  it('strips ANSI escapes and control characters everywhere', () => {
    const { g } = gate();
    const line = g.admit({}, report('\x1b[31mred\x1b[0m\x07 bell\x00\x1b]0;title\x07 done', 'area\x1b[2J', { stack: 'at \x1b[1mX\x1b[22m\x08' }))!;
    expect(line).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
    expect(line.split('\n')[0]).toBe('[web error] area: red bell done');
    expect(line).toContain('at X');
  });

  it('strips C1 controls and bidi overrides (a report must not reorder or hide text in the log)', () => {
    const { g } = gate();
    const line = g.admit({}, report('a\u0085b\u009bc\u202ed\u2066e\u2069f\u202ag', 'x\u202ey', { stack: 'at \u2067Z\u2069\u0090' }))!;
    expect(line).not.toMatch(/[\u0080-\u009f\u202a-\u202e\u2066-\u2069]/);
    expect(line.split('\n')[0]).toBe('[web error] xy: abcdefg');
    expect(line).toContain('at Z');
  });

  it('truncates before cleaning: a huge report costs little, and the cut is counted on what was sent', () => {
    const { g } = gate();
    const raw = `${'x'.repeat(600)}${'\x1b[31m'.repeat(100)}`; // 600 + 500 characters
    expect(g.admit({}, report(raw))!.split('\n')[0]).toMatch(/… \(\+600\)$/);
    const t0 = Date.now();
    const huge = g.admit({}, report('\x1b[1m'.repeat(1_000_000), 'big', { stack: '\u202e'.repeat(2_000_000) }))!;
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(huge.length).toBeLessThan(6000);
  });

  it('caps sizes', () => {
    const { g } = gate();
    expect(g.admit({}, report('y'.repeat(2000)))!.length).toBeLessThan(600);
  });

  it('the same report again within the window is counted, not logged; the next one after it says how many', () => {
    const { g, at } = gate();
    const c = {};
    expect(g.admit(c, report('same'))).toBeTruthy();
    at(1000);
    expect(g.admit(c, report('same'))).toBeNull();
    expect(g.admit({}, report('same'))).toBeNull(); // from another connection too (a render loop in every window)
    expect(g.admit(c, report('other'))).toBeTruthy(); // a different message is not a duplicate
    at(61_000);
    expect(g.admit(c, report('same'))).toMatch(/（自上次记录以来重复 2 次）/);
  });

  it('per connection and global budgets per window; duplicates do not use them up', () => {
    const { g, at } = gate({ perConn: 3, global: 5 });
    const a = {}, b = {};
    const n = (conn: object, prefix: string, k: number) => Array.from({ length: k }, (_, i) => g.admit(conn, report(`${prefix}${i}`))).filter(Boolean).length;
    expect(g.admit(a, report('dup'))).toBeTruthy();
    for (let i = 0; i < 10; i++) g.admit(a, report('dup'));
    expect(n(a, 'a', 5)).toBe(2); // 1 used by the first 'dup' → 2 more for this connection
    expect(n(b, 'b', 5)).toBe(2); // global 5: 3 used by a → 2 left for everyone
    at(60_001);
    expect(n(b, 'c', 5)).toBe(3); // new window: per-connection cap again
  });
});
