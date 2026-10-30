import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BotStore } from './store.js';
import type { Bot, BotRun } from '../protocol.js';

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
});
