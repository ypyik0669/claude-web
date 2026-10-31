import { describe, it, expect } from 'vitest';
import { sortBots, usd, runCost, groupInbox, monthlyEstimate, runsPerMonth, cronFieldCount } from './model';
const b = (id: string, state: any, manager = false): any => ({ id, name: id, state, manager });
describe('bots model', () => {
  it('sortBots: manager, attention, running, queued, idle, paused', () => {
    expect(sortBots([b('p', 'paused'), b('i', 'idle'), b('m', 'idle', true), b('a', 'attention'), b('r', 'running'), b('q', 'queued')]).map((x) => x.id)).toEqual(['m', 'a', 'r', 'q', 'i', 'p']);
  });
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

import { normalizeDraft, draftFromTemplate, draftProblem, fasterThanHourly, lastUserText, underMinimum, isAbsolutePath } from './model';
const draft = (p: any = {}): any => ({ name: 'n', cwd: '/w', charter: { role: 'r', sources: [] }, tier: 'balanced', policy: { rules: [] }, budget: {}, outputs: [{ kind: 'inbox' }], routines: [], ...p });
describe('bots create flow', () => {
  it('normalizeDraft takes the names bots.generate clamped (it already raised them to 15) and drops the wire field', () => {
    // what the server sends: everyMinutes already 15, the routine named in `clamped`
    const { draft: d, clamped } = normalizeDraft(draft({ routines: [{ id: 'r_1', name: 'a', prompt: 'p', everyMinutes: 15 }, { id: 'r_2', name: 'b', prompt: 'p', everyMinutes: 30 }], clamped: ['a'] }));
    expect(clamped).toEqual(['a']);
    expect('clamped' in d).toBe(false);
    expect(d.routines.map((r) => r.everyMinutes)).toEqual([15, 30]);
    expect(normalizeDraft(draft({ routines: [{ name: 'a', prompt: 'p', cron: '0 9 * * *' }] })).clamped).toEqual([]);
  });
  it('normalizeDraft still clamps what an older server left under 15 minutes, and completes routines', () => {
    const { draft: d, clamped } = normalizeDraft(draft({ routines: [{ name: 'a', prompt: 'p', everyMinutes: 5 }] }));
    expect(clamped).toEqual(['a']);
    expect(d.routines[0]).toMatchObject({ id: '', everyMinutes: 15, enabled: true, onFail: 'inbox', acceptance: { kind: 'none' } });
  });
  it('normalizeDraft fills what a generated draft may leave out and keeps the inbox', () => {
    const { draft: d } = normalizeDraft({ name: 'x', charter: { role: 'r' } } as any);
    expect(d.outputs).toEqual([{ kind: 'inbox' }]);
    expect(d.charter.sources).toEqual([]);
    expect(d.tier).toBe('balanced');
    expect(normalizeDraft({ name: 'x', charter: { role: 'r' } } as any, 'cheap').draft.tier).toBe('cheap');
    expect(normalizeDraft(draft({ tier: 'best' }), 'cheap').draft.tier).toBe('best');
    expect(d.routines).toEqual([]);
    expect(normalizeDraft(draft({ outputs: [{ kind: 'file', path: 'a' }] })).draft.outputs).toEqual([{ kind: 'inbox' }, { kind: 'file', path: 'a' }]);
  });
  it('draftFromTemplate puts the folder in', () => {
    const t: any = { id: 't', name: 'T', desc: 'd', bot: draft({ cwd: undefined }) };
    expect(draftFromTemplate(t, '/repo').cwd).toBe('/repo');
  });
  it('draftProblem', () => {
    expect(draftProblem(draft())).toBeNull();
    expect(draftProblem(draft({ name: ' ' }))).toBeTruthy();
    expect(draftProblem(draft({ cwd: '' }))).toBeTruthy();
    expect(draftProblem(draft({ routines: [{ name: 'a', prompt: '', everyMinutes: 60 }] }))).toBeTruthy();
    expect(draftProblem(draft({ routines: [{ name: 'a', prompt: 'p', cron: '0 9 *' }] }))).toBeTruthy();
    expect(draftProblem(draft({ routines: [{ name: 'a', prompt: 'p', cron: '0 9 * * *' }] }))).toBeNull();
    expect(draftProblem(draft({ routines: [{ name: 'a', prompt: 'p', everyMinutes: 1.5 }] }))).toContain('a');
    expect(draftProblem(draft({ routines: [{ name: 'a', prompt: 'p', everyMinutes: 0 }] }))).toBeTruthy();
    expect(draftProblem(draft({ routines: [{ name: 'a', prompt: 'p' }] }))).toContain('a');
    expect(draftProblem(draft({ routines: [{ name: 'a', prompt: 'p', cron: ' ' }] }))).toBeTruthy();
    expect(draftProblem(draft({ outputs: [{ kind: 'inbox' }, { kind: 'file', path: 'out/report.md' }] }))).toBeTruthy();
    expect(draftProblem(draft({ outputs: [{ kind: 'inbox' }, { kind: 'file', path: 'C:\\r\\a.md' }] }))).toBeNull();
  });
  it('fasterThanHourly', () => {
    expect(fasterThanHourly({ everyMinutes: 30 })).toBe(true);
    expect(fasterThanHourly({ everyMinutes: 60 })).toBe(false);
    expect(fasterThanHourly({ cron: '*/10 * * * *' })).toBe(true);
    expect(fasterThanHourly({ cron: '0 9 * * *' })).toBe(false);
  });
  it('underMinimum / isAbsolutePath', () => {
    expect(underMinimum({ everyMinutes: 5 })).toBe(true);
    expect(underMinimum({ everyMinutes: 15 })).toBe(false);
    expect(underMinimum({ cron: '*/5 * * * *' })).toBe(true);
    expect(underMinimum({ cron: '0 9 * * *' })).toBe(false);
    expect(['C:\\x', 'C:/x', '\\\\srv\\x', '/x'].every(isAbsolutePath)).toBe(true);
    // the server takes the path as typed: ~ is not expanded there
    expect(['x', './x', 'C:x', '', '~/x'].some(isAbsolutePath)).toBe(false);
  });
  it('lastUserText skips meta and cross-conversation prompts', () => {
    expect(lastUserText([{ kind: 'user', text: 'first' }, { kind: 'assistant' }, { kind: 'user', text: 'x', meta: true }, { kind: 'user', text: 'y', from: {} }])).toBe('first');
    expect(lastUserText([])).toBe('');
  });
});
