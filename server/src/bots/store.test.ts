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

  it('remove deletes the directory', async () => {
    await s.save(bot('b_1')); await s.remove('b_1');
    expect(s.list()).toEqual([]); expect(fs.existsSync(path.join(root, 'b_1'))).toBe(false);
  });
});
