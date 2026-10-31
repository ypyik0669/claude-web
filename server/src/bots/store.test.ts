import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BotStore, TIMELINE_COMPACT_AT, TIMELINE_KEEP } from './store.js';
import type { Bot, BotRun, BotTimelineEntry } from '../protocol.js';

const bot = (id: string): Bot => ({ id, name: '晨报', charter: { role: '每天早上汇总 issue', sources: ['github'] }, cwd: '/p', tier: 'balanced', policy: { rules: [] }, budget: {}, routines: [], outputs: [{ kind: 'inbox' }], createdAt: 1, updatedAt: 1 });

describe('BotStore', () => {
  let root: string; let s: BotStore;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-bots-')); s = new BotStore(root); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('saves a bot as <root>/<id>/bot.json and lists it after a fresh load', async () => {
    await s.save(bot('b_1'));
    expect(fs.existsSync(path.join(root, 'b_1', 'bot.json'))).toBe(true);
    expect(new BotStore(root).list().map((b) => b.id)).toEqual(['b_1']);
  });

  it('reload() picks up what another store on the same dir wrote, after its own writes in flight', async () => {
    await s.save(bot('b_1'));
    const other = new BotStore(root);
    await other.update('b_1', (b) => ({ ...b, name: '改了' }));
    await other.save(bot('b_2'));
    fs.mkdirSync(path.join(root, 'not a bot'), { recursive: true });
    const mine = s.save(bot('b_3'));
    await s.reload();
    await mine;
    expect(s.get('b_1')!.name).toBe('改了');
    expect(s.list().map((b) => b.id).sort()).toEqual(['b_1', 'b_2', 'b_3']);
  });

  it('keeps routine state and trust per bot', async () => {
    await s.save(bot('b_1'));
    await s.setState('b_1', 'r1', { fingerprint: 'abc' });
    expect(s.stateOf('b_1', 'r1').fingerprint).toBe('abc');
    expect(s.stateOf('b_1', 'r2').fingerprint).toBeUndefined();
    await s.setTrust('b_1', { 'send|slack:#dev': { approvals: 2, lastAt: 5 } });
    expect(new BotStore(root).trust('b_1')['send|slack:#dev'].approvals).toBe(2);
  });

  it('appends runs newest-first and replaces a run with the same id', async () => {
    await s.save(bot('b_1'));
    const r = (id: string, at: number): BotRun => ({ id, botId: 'b_1', routineId: 'r1', at, trigger: 'cron' });
    await s.addRun(r('run1', 1)); await s.addRun(r('run2', 2)); await s.addRun({ ...r('run1', 1), ok: true });
    expect(s.runs('b_1').map((x) => [x.id, x.ok])).toEqual([['run2', undefined], ['run1', true]]);
  });

  it('audit rows go to runs/<runId>.audit.jsonl', async () => {
    await s.save(bot('b_1'));
    await s.appendAudit('b_1', 'run1', { at: 1, runId: 'run1', botId: 'b_1', toolName: 'Bash', cls: 'read', level: 'do', basis: 'rule', summary: 'ls', result: 'allowed' });
    expect(s.audit('b_1', 'run1')).toHaveLength(1);
    expect(fs.existsSync(path.join(root, 'b_1', 'runs', 'run1.audit.jsonl'))).toBe(true);
  });

  it('inbox is one file for every bot, filterable by bot', async () => {
    await s.setInbox([{ id: 'i1', kind: 'finding', botId: 'b_1', at: 1, title: 'x' }, { id: 'i2', kind: 'finding', botId: 'b_2', at: 2, title: 'y' }]);
    expect(s.inbox('b_2').map((i) => i.id)).toEqual(['i2']);
    expect(new BotStore(root).inbox()).toHaveLength(2);
  });

  it('rejects ids that are not plain names, and never deletes anything for them', async () => {
    await s.save(bot('b_1'));
    fs.writeFileSync(path.join(root, 'keep.txt'), 'x');
    for (const bad of ['..', '../x', 'a/b', 'a\\b', '', '.']) {
      expect(() => s.dir(bad)).toThrow();
      await expect(s.remove(bad)).rejects.toThrow();
      await expect(s.appendAudit('b_1', bad, { at: 1, runId: bad, botId: 'b_1', toolName: 'Bash', cls: 'read', level: 'do', basis: 'rule', summary: '', result: 'allowed' })).rejects.toThrow();
    }
    await s.remove('b_unknown');
    expect(fs.existsSync(path.join(root, 'keep.txt'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'b_1', 'bot.json'))).toBe(true);
  });

  it('a truncated last line in runs/index.jsonl keeps the earlier runs', async () => {
    await s.save(bot('b_1'));
    await s.addRun({ id: 'run1', botId: 'b_1', routineId: 'r1', at: 1, trigger: 'cron' });
    fs.appendFileSync(path.join(root, 'b_1', 'runs', 'index.jsonl'), '{"id":"run2","bo');
    const warn = console.warn; console.warn = () => {};
    try { expect(s.runs('b_1').map((r) => r.id)).toEqual(['run1']); } finally { console.warn = warn; }
  });

  it('a corrupt json file falls back instead of throwing', async () => {
    await s.save(bot('b_1'));
    fs.writeFileSync(path.join(root, 'b_1', 'trust.json'), '{not json');
    const warn = console.warn; console.warn = () => {};
    try { expect(s.trust('b_1')).toEqual({}); } finally { console.warn = warn; }
  });

  it('writes leave no tmp files behind', async () => {
    await s.save(bot('b_1')); await s.setTrust('b_1', {}); await s.setInbox([]);
    const all = fs.readdirSync(root, { recursive: true }).map(String);
    expect(all.filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('concurrent updates to different routines of one bot both land (on disk too); unknown id / undefined change nothing', async () => {
    const r = (id: string) => ({ id, name: id, prompt: 'p', enabled: true, acceptance: { kind: 'none' as const }, onFail: 'inbox' as const });
    await s.save({ ...bot('b_u'), routines: [r('r1'), r('r2')] });
    const bump = (rid: string) => s.update('b_u', (b) => ({ ...b, routines: b.routines.map((x) => (x.id === rid ? { ...x, failures: 2 } : x)) }));
    await Promise.all([bump('r1'), bump('r2'), s.update('b_u', (b) => ({ ...b, name: '改名' }))]);
    for (const b of [s.get('b_u')!, new BotStore(root).get('b_u')!]) {
      expect(b.routines.map((x) => x.failures)).toEqual([2, 2]);
      expect(b.name).toBe('改名');
    }
    expect(await s.update('nope', (b) => b)).toBeUndefined();
    expect((await s.update('b_u', () => undefined))?.name).toBe('改名');
  });

  it('concurrent setState patches to the same routine both land', async () => {
    await s.save(bot('b_1'));
    await Promise.all([s.setState('b_1', 'r1', { fingerprint: 'f' }), s.setState('b_1', 'r1', { checkpoint: 'c' }), s.setState('b_1', 'r1', { lastSummary: 'l' })]);
    const st = new BotStore(root).stateOf('b_1', 'r1');
    expect([st.fingerprint, st.checkpoint, st.lastSummary]).toEqual(['f', 'c', 'l']);
  });

  it('concurrent inbox writes keep their order', async () => {
    await Promise.all([s.setInbox([{ id: 'a', kind: 'finding', botId: 'b_1', at: 1, title: 'a' }]), s.setInbox([{ id: 'b', kind: 'finding', botId: 'b_1', at: 1, title: 'b' }])]);
    expect(new BotStore(root).inbox().map((i) => i.id)).toEqual(['b']);
  });

  it('remove deletes the directory', async () => {
    await s.save(bot('b_1')); await s.remove('b_1');
    expect(s.list()).toEqual([]); expect(fs.existsSync(path.join(root, 'b_1'))).toBe(false);
  });

  const entry = (id: string, at: number): BotTimelineEntry => ({ id, botId: 'b_1', at, kind: 'system', text: id });
  it('timeline: append → read round-trip, oldest first, a re-appended id keeps its place with the new content', async () => {
    await s.appendTimeline('b_1', entry('a', 2));
    await s.appendTimeline('b_1', entry('b', 1));
    await s.appendTimeline('b_1', { ...entry('a', 2), text: 'a2' });
    expect(fs.existsSync(path.join(root, 'b_1', 'timeline.jsonl'))).toBe(true);
    expect(s.timeline('b_1').map((e) => [e.id, e.text])).toEqual([['b', 'b'], ['a', 'a2']]);
    expect(s.timeline('b_2')).toEqual([]);
  });

  it('timeline: a torn last line is skipped', async () => {
    await s.appendTimeline('b_1', entry('a', 1));
    fs.appendFileSync(path.join(root, 'b_1', 'timeline.jsonl'), '{"id":"b","botId":"b_1","at');
    const warn = console.warn; console.warn = () => {};
    try { expect(s.timeline('b_1').map((e) => e.id)).toEqual(['a']); } finally { console.warn = warn; }
  });

  it('timeline: before / limit page backwards from the newest, still oldest first; default limit 300', async () => {
    for (let i = 1; i <= 310; i++) await s.appendTimeline('b_1', entry(`e${i}`, i));
    const all = s.timeline('b_1');
    expect(all.length).toBe(300);
    expect(all[0].id).toBe('e11'); expect(all[299].id).toBe('e310');
    expect(s.timeline('b_1', { limit: 3 }).map((e) => e.id)).toEqual(['e308', 'e309', 'e310']);
    expect(s.timeline('b_1', { before: 5, limit: 2 }).map((e) => e.id)).toEqual(['e3', 'e4']);
    expect(s.timeline('b_1', { before: 1 })).toEqual([]);
  });

  it('timelineCount counts entries after a time without reading the file again; a write by another process is seen', async () => {
    await s.appendTimeline('b_1', entry('a', 1));
    await s.appendTimeline('b_1', entry('b', 5));
    await s.appendTimeline('b_1', { ...entry('a', 1), text: 'a2' }); // the same entry again: counted once
    const read = vi.spyOn(fs, 'readFileSync');
    try {
      expect(s.timelineCount('b_1', 0)).toBe(2);
      expect(s.timelineCount('b_1', 1)).toBe(1);
      expect(s.timelineCount('b_2', 0)).toBe(0);
      expect(read.mock.calls.filter(([f]) => String(f).endsWith('timeline.jsonl'))).toHaveLength(1); // b_2's (missing) only
    } finally { read.mockRestore(); }
    fs.appendFileSync(path.join(root, 'b_1', 'timeline.jsonl'), JSON.stringify(entry('c', 9)) + '\n');
    expect(s.timelineCount('b_1', 1)).toBe(2);
  });

  it(`timeline.jsonl past ${TIMELINE_COMPACT_AT} lines is cut to the newest ${TIMELINE_KEEP} entries`, async () => {
    const f = path.join(root, 'b_1', 'timeline.jsonl');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, Array.from({ length: TIMELINE_COMPACT_AT }, (_, i) => JSON.stringify(entry(`e${i}`, i + 1)) + '\n').join(''));
    await s.appendTimeline('b_1', entry('last', TIMELINE_COMPACT_AT + 10));
    const lines = fs.readFileSync(f, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(TIMELINE_KEEP);
    expect(JSON.parse(lines.at(-1)!).id).toBe('last');
    expect(s.timelineCount('b_1', 0)).toBe(TIMELINE_KEEP);
    expect(s.timeline('b_1', { limit: 1 })[0].id).toBe('last');
  });

  it('thread state: defaults, then patches merge', async () => {
    expect(s.threadState('b_1')).toEqual({ updatedAt: 0 });
    await s.setThreadState('b_1', { lastLine: { text: '好的', at: 5 } });
    await s.setThreadState('b_1', { seenAt: 7 });
    const t = new BotStore(root).threadState('b_1');
    expect(t.lastLine).toEqual({ text: '好的', at: 5 });
    expect(t.seenAt).toBe(7);
    expect(t.updatedAt).toBeGreaterThan(0);
  });
});
