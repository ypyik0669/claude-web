import { describe, it, expect } from 'vitest';
import { usd, runCost, groupInbox, monthlyEstimate, runsPerMonth, cronFieldCount } from './model';
describe('bots model', () => {
  it('usd', () => { expect(usd(0)).toBe('$0.00'); expect(usd(1.2345)).toBe('$1.23'); });
  it('runCost marks an estimate (a model without a known price)', () => {
    expect(runCost({ costUsd: 0.36 })).toBe('$0.36');
    expect(runCost({})).toBe('$0.00');
    expect(runCost({ costUsd: 1.2, costEstimated: true })).toBe('约 $1.20');
  });
  it('groupInbox keeps every kind present', () => {
    const g = groupInbox([{ id: '1', kind: 'draft', botId: 'b', at: 1, title: 't' }]);
    expect(g.draft).toHaveLength(1); expect(g.approval).toEqual([]);
  });
  it('monthlyEstimate', () => {
    expect(monthlyEstimate({ everyMinutes: 5 } as any, 0.05)).toBeCloseTo(432);
    expect(monthlyEstimate({ cron: '0 * * * *' } as any, 0.05)).toBeCloseTo(36);
    // 21.4 weekdays in 30 days
    expect(monthlyEstimate({ cron: '30 7 * * 1-5' } as any, 0.05)).toBeCloseTo((30 * 5 / 7) * 0.05);
  });
  it('runsPerMonth counts lists, ranges, steps and the day fields of a cron', () => {
    const cases: [string, number][] = [
      ['0 9,13,17 * * 1-5', 3 * 30 * 5 / 7],
      ['0,30 * * * *', 2 * 24 * 30],
      ['*/5 9-17 * * *', 12 * 9 * 30],
      ['* * * * *', 30 * 24 * 60],
      ['0 */6 * * *', 4 * 30],
      ['15 10 1,15 * *', 2],
      ['0 8 * * 0,7', 30 / 7],
      ['0 8 * * 1-7', 30],
      ['0 8 * * */7', 30 / 7],
      ['0 8 * * 5-7', 30 * 3 / 7],
      ['0 9-17/2 * * *', 5 * 30],
    ];
    for (const [cron, n] of cases) expect(runsPerMonth({ cron }), cron).toBeCloseTo(n);
    expect(runsPerMonth({ cron: 'nonsense here * * *' })).toBe(30);
  });
  it('cronFieldCount', () => {
    expect([cronFieldCount('*', 0, 59), cronFieldCount('5/15', 0, 59), cronFieldCount('1-3,2', 0, 59), cronFieldCount('70', 0, 59), cronFieldCount('a', 0, 59)]).toEqual([60, 4, 3, null, null]);
  });
});

import { rosterGroups, rowState, lastLineOf, cadenceText, pendingByBot } from './model';
const sb = (id: string, p: any = {}): any => ({ id, name: id, state: 'idle', pendingInbox: 0, unseen: 0, ...p });
const item = (id: string, botId: string, p: any = {}): any => ({ id, kind: 'approval', botId, at: 1, title: 't', ...p });
describe('bots roster', () => {
  it('rosterGroups: who needs you first, the manager apart, hidden last; pinned then the latest line within a group', () => {
    const g = rosterGroups([
      sb('m', { manager: true, lastLine: { text: 'x', at: 99 } }),
      sb('old', { lastLine: { text: 'x', at: 1 } }),
      sb('new', { lastLine: { text: 'x', at: 5 } }),
      sb('pin', { pinned: true, lastLine: { text: 'x', at: 0 } }),
      sb('none'),
      sb('ask', { lastLine: { text: 'x', at: 2 } }),
      sb('attn', { state: 'attention' }),
      sb('hid', { hidden: true, state: 'attention' }),
    ], [item('i1', 'ask'), item('i2', 'old', { done: { at: 2, answer: 'approve' } })]);
    expect(g.manager?.id).toBe('m');
    expect(g.attention.map((b) => b.id)).toEqual(['ask', 'attn']);
    expect(g.rest.map((b) => b.id)).toEqual(['pin', 'new', 'old', 'none']);
    expect(g.hidden.map((b) => b.id)).toEqual(['hid']);
  });
  it('rosterGroups: no manager → undefined', () => { expect(rosterGroups([sb('a')], []).manager).toBeUndefined(); });
  it('pendingByBot counts the open items per bot', () => {
    expect(pendingByBot([item('1', 'a'), item('2', 'a', { kind: 'draft' }), item('3', 'b', { done: { at: 1, answer: 'reject' } })])).toEqual({ a: 2 });
  });
  it('pendingByBot leaves out a run\'s findings (its card in the conversation; a daily routine never needs you for them)', () => {
    expect(pendingByBot([item('1', 'a', { kind: 'finding' }), item('2', 'a', { kind: 'finding' }), item('3', 'a', { kind: 'proposal' })])).toEqual({ a: 1 });
    expect(pendingByBot([item('1', 'b', { kind: 'finding' })])).toEqual({});
  });
  it('rowState: needs you, error, working, fresh, idle', () => {
    expect(rowState(sb('a', { state: 'attention' }))).toBe('attention');
    expect(rowState(sb('a', { pendingInbox: 1 }))).toBe('attention');
    expect(rowState(sb('a', { error: { reason: 'r' }, state: 'running', unseen: 2 }))).toBe('error');
    expect(rowState(sb('a', { state: 'running', unseen: 2 }))).toBe('working');
    expect(rowState(sb('a', { state: 'queued' }))).toBe('working');
    expect(rowState(sb('a', { unseen: 2 }))).toBe('fresh');
    expect(rowState(sb('a', { state: 'paused' }))).toBe('idle');
    expect(rowState(sb('a'))).toBe('idle');
  });
  it('lastLineOf: waiting items, then its last line, then its title', () => {
    expect(lastLineOf(sb('a', { lastLine: { text: 'hi', at: 1 }, title: 'T' }), 3)).toBe('3 件事等你点头');
    expect(lastLineOf(sb('a', { lastLine: { text: 'hi', at: 1 }, title: 'T' }), 0)).toBe('hi');
    expect(lastLineOf(sb('a', { title: 'T' }), 0)).toBe('T');
    expect(lastLineOf(sb('a'), 0)).toBe('');
  });
  it('cadenceText in words', () => {
    expect(cadenceText({ cron: '30 7 * * 1-5' } as any)).toBe('工作日 07:30');
    expect(cadenceText({ everyMinutes: 60 } as any)).toBe('每小时');
    expect(cadenceText({ cron: 'odd thing' } as any)).toBe('odd thing');
    expect(cadenceText({} as any)).toBe('');
  });
});
