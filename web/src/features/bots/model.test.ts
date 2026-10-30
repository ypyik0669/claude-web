import { describe, it, expect } from 'vitest';
import { sortBots, usd, groupInbox, monthlyEstimate } from './model';
const b = (id: string, state: any, manager = false): any => ({ id, name: id, state, manager });
describe('bots model', () => {
  it('sortBots: manager, attention, running, queued, idle, paused', () => {
    expect(sortBots([b('p', 'paused'), b('i', 'idle'), b('m', 'idle', true), b('a', 'attention'), b('r', 'running'), b('q', 'queued')]).map((x) => x.id)).toEqual(['m', 'a', 'r', 'q', 'i', 'p']);
  });
  it('usd', () => { expect(usd(0)).toBe('$0.00'); expect(usd(1.2345)).toBe('$1.23'); });
  it('groupInbox keeps every kind present', () => {
    const g = groupInbox([{ id: '1', kind: 'draft', botId: 'b', at: 1, title: 't' }]);
    expect(g.draft).toHaveLength(1); expect(g.approval).toEqual([]);
  });
  it('monthlyEstimate', () => {
    expect(monthlyEstimate({ everyMinutes: 5 } as any, 0.05)).toBeCloseTo(432);
    expect(monthlyEstimate({ cron: '0 * * * *' } as any, 0.05)).toBeCloseTo(36);
    expect(monthlyEstimate({ cron: '30 7 * * 1-5' } as any, 0.05)).toBeCloseTo(1.5);
  });
});
