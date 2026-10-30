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

import { normalizeDraft, draftFromTemplate, draftProblem, fasterThanHourly, lastUserText } from './model';
const draft = (p: any = {}): any => ({ name: 'n', cwd: '/w', charter: { role: 'r', sources: [] }, tier: 'balanced', policy: { rules: [] }, budget: {}, outputs: [{ kind: 'inbox' }], routines: [], ...p });
describe('bots create flow', () => {
  it('normalizeDraft clamps intervals under 15 minutes and says so', () => {
    const { draft: d, clamped } = normalizeDraft(draft({ routines: [{ name: 'a', prompt: 'p', everyMinutes: 5 }, { name: 'b', prompt: 'p', everyMinutes: 30 }] }));
    expect(clamped).toBe(true);
    expect(d.routines.map((r) => r.everyMinutes)).toEqual([15, 30]);
    expect(d.routines[0]).toMatchObject({ id: '', enabled: true, onFail: 'inbox', acceptance: { kind: 'none' } });
    expect(normalizeDraft(draft({ routines: [{ name: 'a', prompt: 'p', cron: '0 9 * * *' }] })).clamped).toBe(false);
  });
  it('normalizeDraft fills what a generated draft may leave out and keeps the inbox', () => {
    const { draft: d } = normalizeDraft({ name: 'x', charter: { role: 'r' } } as any);
    expect(d.outputs).toEqual([{ kind: 'inbox' }]);
    expect(d.charter.sources).toEqual([]);
    expect(d.tier).toBe('balanced');
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
  });
  it('fasterThanHourly', () => {
    expect(fasterThanHourly({ everyMinutes: 30 })).toBe(true);
    expect(fasterThanHourly({ everyMinutes: 60 })).toBe(false);
    expect(fasterThanHourly({ cron: '*/10 * * * *' })).toBe(true);
    expect(fasterThanHourly({ cron: '0 9 * * *' })).toBe(false);
  });
  it('lastUserText skips meta and cross-conversation prompts', () => {
    expect(lastUserText([{ kind: 'user', text: 'first' }, { kind: 'assistant' }, { kind: 'user', text: 'x', meta: true }, { kind: 'user', text: 'y', from: {} }])).toBe('first');
    expect(lastUserText([])).toBe('');
  });
});
