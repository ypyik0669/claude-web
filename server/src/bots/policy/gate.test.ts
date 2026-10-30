import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { BotStore } from '../store.js'; import { AuditLog } from '../audit.js'; import { Inbox } from '../inbox.js';
import { makeGate, callKey } from './gate.js';
import type { Bot } from '../../protocol.js';

const bot = (policy: Bot['policy'] = { rules: [] }): Bot => ({ id: 'b1', name: 'x', charter: { role: 'r', sources: [] }, cwd: '/p', tier: 'balanced', policy, budget: {}, routines: [], outputs: [], createdAt: 0, updatedAt: 0 });

describe('makeGate', () => {
  let root: string; let store: BotStore; let inbox: Inbox; let audit: AuditLog;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-gate-')); store = new BotStore(root); inbox = new Inbox(store); audit = new AuditLog(store); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const ev = (toolName: string, input: Record<string, unknown>) => ({ requestId: 'q', sessionId: 's1', toolName, input });

  it('read runs and is audited', async () => {
    const g = makeGate({ bot: bot(), runId: 'run1', routineId: 'r1', store, audit, inbox });
    expect(await g.gate(ev('Read', { file_path: '/a' }))).toEqual({ behavior: 'allow', updatedInput: { file_path: '/a' } });
    expect(store.audit('b1', 'run1')).toMatchObject([{ cls: 'read', level: 'do', result: 'allowed', basis: 'rule' }]);
    expect(g.calls).toBe(1);
  });
  it('install runs and tells', async () => {
    const told: string[] = [];
    const g = makeGate({ bot: bot(), runId: 'run1', routineId: 'r1', store, audit, inbox, onTell: (t) => told.push(t) });
    expect((await g.gate(ev('Bash', { command: 'npm i -g foo' })))?.behavior).toBe('allow');
    expect(told).toEqual(['Bash: npm i -g foo']);
  });
  it('send is queued: denied with a message, an approval item in the inbox, audited as queued', async () => {
    const g = makeGate({ bot: bot(), runId: 'run1', routineId: 'r1', store, audit, inbox });
    const r = await g.gate(ev('Bash', { command: 'git push origin main' }));
    expect(r).toMatchObject({ behavior: 'deny' });
    expect((r as any).message).toContain('收件箱');
    const items = inbox.list('b1');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'approval', toolName: 'Bash', input: { command: 'git push origin main' }, cls: 'send', runId: 'run1', sessionId: 's1' });
    expect(store.audit('b1', 'run1')[0].result).toBe('queued');
  });
  it('approveOnce lets exactly that call through, once', async () => {
    const g = makeGate({ bot: bot(), runId: 'run1', routineId: 'r1', store, audit, inbox });
    g.approveOnce('Bash', { command: 'git push origin main' });
    expect((await g.gate(ev('Bash', { command: 'git push origin main' })))?.behavior).toBe('allow');
    expect(store.audit('b1', 'run1')[0].basis).toBe('user');
    expect((await g.gate(ev('Bash', { command: 'git push origin main' })))?.behavior).toBe('deny');
  });
  it('deny is denied with the class named', async () => {
    const g = makeGate({ bot: bot({ rules: [{ cls: 'pay', level: 'deny' }] }), runId: 'run1', routineId: 'r1', store, audit, inbox });
    const r = await g.gate(ev('Bash', { command: 'curl https://api.stripe.com/v1/charges -d amount=1' }));
    expect(r).toMatchObject({ behavior: 'deny' });
    expect(inbox.list('b1')).toEqual([]);
    expect(store.audit('b1', 'run1')[0]).toMatchObject({ result: 'denied', level: 'deny' });
  });
  it('unleashed: everything runs, basis unleashed', async () => {
    const g = makeGate({ bot: bot({ rules: [], unleashed: true }), runId: 'run1', routineId: 'r1', store, audit, inbox });
    expect((await g.gate(ev('Bash', { command: 'git push origin --delete x' })))?.behavior).toBe('allow');
    expect(store.audit('b1', 'run1')[0].basis).toBe('unleashed');
  });

  // ---- beyond the brief: wrapped MCP calls, perDay across runs, the rule that allowed a call, failures ----

  const wrapped = { tool_name: 'mcp__slack__send_message', params: { channel: 'C9', text: 'hi' } };
  it('a ccb-wrapped MCP call is classified, summarised, targeted and audited by the tool inside', async () => {
    const g = makeGate({ bot: bot(), runId: 'run1', routineId: 'r1', store, audit, inbox });
    expect((await g.gate(ev('ExecuteExtraTool', wrapped)))?.behavior).toBe('deny');
    expect(inbox.list('b1')[0]).toMatchObject({ toolName: 'ExecuteExtraTool', input: wrapped, cls: 'send', title: 'mcp__slack__send_message: C9' });
    expect(store.audit('b1', 'run1')[0]).toMatchObject({ toolName: 'mcp__slack__send_message', cls: 'send', scope: 'channel:C9', result: 'queued' });
  });
  it('approveOnce matches a wrapped call and the same call made directly, either way round', async () => {
    expect(callKey('ExecuteExtraTool', wrapped)).toBe(callKey('mcp__slack__send_message', { text: 'hi', channel: 'C9' }));
    const g = makeGate({ bot: bot(), runId: 'run1', routineId: 'r1', store, audit, inbox });
    g.approveOnce('ExecuteExtraTool', wrapped);
    expect((await g.gate(ev('mcp__slack__send_message', { channel: 'C9', text: 'hi' })))?.behavior).toBe('allow');
    g.approveOnce('mcp__slack__send_message', { channel: 'C9', text: 'hi' });
    expect((await g.gate(ev('ExecuteExtraTool', wrapped)))?.behavior).toBe('allow');
    expect((await g.gate(ev('ExecuteExtraTool', wrapped)))?.behavior).toBe('deny');
  });
  it('approveOnce does not get past a deny rule', async () => {
    const g = makeGate({ bot: bot({ rules: [{ cls: 'send', level: 'deny' }] }), runId: 'run1', routineId: 'r1', store, audit, inbox });
    g.approveOnce('Bash', { command: 'git push origin main' });
    expect((await g.gate(ev('Bash', { command: 'git push origin main' })))?.behavior).toBe('deny');
  });
  it('perDay counts today\'s allowed calls of that class and scope, across runs of the bot', async () => {
    const send = (ch: string) => ev('ExecuteExtraTool', { tool_name: 'mcp__slack__send_message', params: { channel: ch, text: 'x' } });
    const policy: Bot['policy'] = { rules: [{ cls: 'send', level: 'do', scope: { channels: ['C1', 'C2'], perDay: 2 } }] };
    await store.save(bot(policy));
    await store.addRun({ id: 'run0', botId: 'b1', routineId: 'r1', at: Date.now() - 1000, trigger: 'cron' });
    const g0 = makeGate({ bot: bot(policy), runId: 'run0', routineId: 'r1', store, audit, inbox });
    expect((await g0.gate(send('C1')))?.behavior).toBe('allow');
    const g = makeGate({ bot: bot(policy), runId: 'run1', routineId: 'r1', store, audit, inbox });
    expect((await g.gate(send('C1')))?.behavior).toBe('allow');
    expect((await g.gate(send('C1')))?.behavior).toBe('deny'); // third today on C1: asks
    expect((await g.gate(send('C2')))?.behavior).toBe('allow'); // another scope key has its own count
  });
  it('yesterday\'s calls do not count', async () => {
    const policy: Bot['policy'] = { rules: [{ cls: 'send', level: 'do', scope: { channels: ['C1'], perDay: 1 } }] };
    const send = ev('mcp__slack__send_message', { channel: 'C1', text: 'x' });
    let t = new Date(2026, 9, 29, 23, 0).getTime();
    const g = makeGate({ bot: bot(policy), runId: 'run1', routineId: 'r1', store, audit, inbox, now: () => t });
    expect((await g.gate(send))?.behavior).toBe('allow');
    expect((await g.gate(send))?.behavior).toBe('deny');
    t += 2 * 3600_000; // past midnight
    expect((await g.gate(send))?.behavior).toBe('allow');
  });
  it('remembers the rule that let each call through, and hands it to onTell', async () => {
    const rule = { cls: 'install' as const, level: 'do_tell' as const };
    const seen: unknown[] = [];
    const g = makeGate({ bot: bot({ rules: [rule] }), runId: 'run1', routineId: 'r1', store, audit, inbox, onTell: (_t, c) => seen.push(c) });
    await g.gate(ev('Bash', { command: 'pip install x' }));
    expect(g.allowed('Bash', { command: 'pip install x' })).toMatchObject({ cls: 'install', rule, key: '*' });
    expect(seen).toEqual([g.allowed('Bash', { command: 'pip install x' })]);
    expect(store.audit('b1', 'run1')[0].rule).toEqual(rule);
    expect(g.allowed('Bash', { command: 'git push' })).toBeUndefined();
  });
  it('a failure inside the gate refuses the call instead of falling through to the card', async () => {
    const broken = { add: async () => { throw new Error('disk full'); } } as unknown as AuditLog;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const g = makeGate({ bot: bot(), runId: 'run1', routineId: 'r1', store, audit: broken, inbox });
    expect(await g.gate(ev('Read', { file_path: '/a' }))).toMatchObject({ behavior: 'deny' });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
