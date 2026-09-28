import { describe, expect, it } from 'vitest';
import { LogBudget, clientLogLine } from './client-log.js';

describe('client.log', () => {
  it('formats a boundary report, indenting stacks so they cannot pose as log lines', () => {
    const line = clientLogLine({ kind: 'client.log', level: 'error', area: '设置 · 模型', message: 'boom\n[fake] line', stack: 'Error: boom\n    at A', componentStack: '\n    at ModelsSection' }, true)!;
    const lines = line.split('\n');
    expect(lines[0]).toBe('[web error] 设置 · 模型: boom ⏎ [fake] line');
    expect(lines.slice(1).every((l) => l.startsWith('    |') || l === '  component stack:')).toBe(true);
  });

  it('caps sizes and drops reports over budget', () => {
    expect(clientLogLine({ kind: 'client.log', level: 'error', area: 'x', message: 'y'.repeat(2000) }, true)!.length).toBeLessThan(600);
    expect(clientLogLine({ kind: 'client.log', level: 'error', area: 'x', message: 'y' }, false)).toBeNull();
  });

  it('budgets per connection per minute', () => {
    const b = new LogBudget<object>(2, 60_000);
    const a = {}, c = {};
    expect([b.take(a, 0), b.take(a, 1), b.take(a, 2), b.take(c, 3)]).toEqual([true, true, false, true]);
    expect(b.take(a, 60_010)).toBe(true);
  });
});
