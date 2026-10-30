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
  const slack = (...ch: string[]) => ev('ExecuteExtraTool', { tool_name: 'mcp__slack__send_message', params: { channel: ch.join(','), text: 'x' } });
  it('perDay counts per rule, across runs of the bot: a 2-channel call counts once and later single-channel calls see it', async () => {
    const policy: Bot['policy'] = { rules: [{ cls: 'send', level: 'do', scope: { channels: ['C1', 'C2'], perDay: 2 } }] };
    await store.addRun({ id: 'run0', botId: 'b1', routineId: 'r1', at: Date.now() - 1000, trigger: 'cron' });
    const g0 = makeGate({ bot: bot(policy), runId: 'run0', routineId: 'r1', store, audit, inbox });
    expect((await g0.gate(slack('C1', 'C2')))?.behavior).toBe('allow');
    const g = makeGate({ bot: bot(policy), runId: 'run1', routineId: 'r1', store, audit, inbox });
    expect((await g.gate(slack('C1')))?.behavior).toBe('allow');
    expect((await g.gate(slack('C2')))?.behavior).toBe('deny'); // the rule's third today, whatever channel: asks
    expect((await g.gate(slack('C1', 'C2')))?.behavior).toBe('deny');
  });
  it('autopilot perDay caps what autopilot does on its own today, across classes', async () => {
    const policy: Bot['policy'] = { rules: [], autoPilot: { on: true, scope: { perDay: 2 } } };
    const g = makeGate({ bot: bot(policy), runId: 'run1', routineId: 'r1', store, audit, inbox });
    expect((await g.gate(slack('C1')))?.behavior).toBe('allow');
    expect((await g.gate(ev('Bash', { command: 'git push https://github.com/me/x.git --delete x' })))?.behavior).toBe('allow');
    expect((await g.gate(ev('Bash', { command: 'git push origin main' })))?.behavior).toBe('deny');
    expect(store.audit('b1', 'run1').map((r) => [r.cls, r.basis, r.result])).toEqual([['send', 'autopilot', 'allowed'], ['delete', 'autopilot', 'allowed'], ['send', 'rule', 'queued']]);
  });
  it('an approval that a rule made unnecessary does not linger for a later call', async () => {
    const policy: Bot['policy'] = { rules: [{ cls: 'send', level: 'do', scope: { channels: ['C1'], perDay: 1 } }] };
    const g = makeGate({ bot: bot(policy), runId: 'run1', routineId: 'r1', store, audit, inbox });
    g.approveOnce('mcp__slack__send_message', { channel: 'C1', text: 'x' });
    expect((await g.gate(slack('C1')))?.behavior).toBe('allow'); // by the rule
    expect((await g.gate(slack('C1')))?.behavior).toBe('deny'); // perDay used up, and the approval was spent
    expect(store.audit('b1', 'run1').map((r) => r.basis)).toEqual(['rule', 'rule']);
  });
  it('an approval is spent only once the call is on record', async () => {
    let fail = true;
    const flaky = { add: async (r: any) => { if (fail && r.result === 'allowed') throw new Error('disk full'); return audit.add(r); } } as unknown as AuditLog;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const g = makeGate({ bot: bot(), runId: 'run1', routineId: 'r1', store, audit: flaky, inbox });
    g.approveOnce('Bash', { command: 'git push origin main' });
    expect((await g.gate(ev('Bash', { command: 'git push origin main' })))?.behavior).toBe('deny');
    fail = false;
    expect((await g.gate(ev('Bash', { command: 'git push origin main' })))?.behavior).toBe('allow');
    expect(store.audit('b1', 'run1')[0]).toMatchObject({ basis: 'user', result: 'allowed' });
    warn.mockRestore();
  });
  it('two concurrent calls cannot both pass one perDay slot or both spend one approval; a failed write gives both back', async () => {
    // a slow audit write: both calls are inside the gate at once
    const slow = { add: async (r: any) => { await new Promise((res) => setTimeout(res, 20)); return audit.add(r); } } as unknown as AuditLog;
    const policy: Bot['policy'] = { rules: [{ cls: 'send', level: 'do', scope: { channels: ['C1'], perDay: 1 } }] };
    const g = makeGate({ bot: bot(policy), runId: 'run1', routineId: 'r1', store, audit: slow, inbox });
    const both = await Promise.all([g.gate(slack('C1')), g.gate(slack('C1'))]);
    expect(both.map((r) => r?.behavior).sort()).toEqual(['allow', 'deny']);

    const g2 = makeGate({ bot: bot(), runId: 'run2', routineId: 'r1', store, audit: slow, inbox });
    g2.approveOnce('Bash', { command: 'git push origin main' });
    const two = await Promise.all([g2.gate(ev('Bash', { command: 'git push origin main' })), g2.gate(ev('Bash', { command: 'git push origin main' }))]);
    expect(two.map((r) => r?.behavior).sort()).toEqual(['allow', 'deny']);

    let fail = true;
    const flaky = { add: async (r: any) => { await new Promise((res) => setTimeout(res, 5)); if (fail && r.result === 'allowed') throw new Error('disk full'); return audit.add(r); } } as unknown as AuditLog;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const g3 = makeGate({ bot: bot(policy), runId: 'run3', routineId: 'r1', store: new BotStore(fs.mkdtempSync(path.join(root, 's3-'))), audit: flaky, inbox });
    expect((await g3.gate(slack('C1')))?.behavior).toBe('deny'); // not on record: the slot goes back
    fail = false;
    expect((await g3.gate(slack('C1')))?.behavior).toBe('allow');
    warn.mockRestore();
  });
  it("audit rows carry the gate's clock", async () => {
    const g = makeGate({ bot: bot(), runId: 'run1', routineId: 'r1', store, audit, inbox, now: () => 12345 });
    await g.gate(ev('Read', { file_path: '/a' }));
    expect(store.audit('b1', 'run1')[0].at).toBe(12345);
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
  it('a bot cannot write its own policy / audit / inbox, even unleashed; its own state/ is fine', async () => {
    const g = makeGate({ bot: bot({ rules: [], unleashed: true }), runId: 'run1', routineId: 'r1', store, audit, inbox });
    const botDir = store.dir('b1');
    for (const [tool, input] of [
      ['Write', { file_path: path.join(botDir, 'bot.json'), content: '{}' }],
      ['Edit', { file_path: path.join(root, 'inbox.json'), old_string: 'a', new_string: 'b' }],
      ['MultiEdit', { file_path: path.join(botDir, 'runs', 'run1.audit.jsonl'), edits: [] }],
      ['NotebookEdit', { notebook_path: path.join(botDir, 'trust.json'), new_source: 'x' }],
      ['Write', { file_path: path.join(root, 'other-bot', 'state', 'x.md'), content: 'x' }],
      // relative to the bot's cwd, and the other slash style / case on Windows
      ['Write', { file_path: path.relative('/p', path.join(botDir, 'bot.json')), content: '{}' }],
      ['Write', { file_path: (process.platform === 'win32' ? botDir.toUpperCase() : botDir).split(path.sep).join('/') + '/bot.json', content: '{}' }],
    ] as const) {
      const r = await g.gate(ev(tool, input as any));
      expect(r, `${tool} ${JSON.stringify(input)}`).toMatchObject({ behavior: 'deny' });
    }
    expect(store.audit('b1', 'run1').every((r) => r.result === 'denied')).toBe(true);
    expect(await g.gate(ev('Write', { file_path: path.join(botDir, 'state', 'r1.checkpoint.md'), content: 'step 2' }))).toMatchObject({ behavior: 'allow' });
    expect(await g.gate(ev('Write', { file_path: path.join(os.tmpdir(), 'elsewhere.md'), content: 'x' }))).toMatchObject({ behavior: 'allow' });
  });

  it('a shell command that names the bots dir (either slash style) goes to the user first, even unleashed', async () => {
    const g = makeGate({ bot: bot({ rules: [], unleashed: true }), runId: 'run1', routineId: 'r1', store, audit, inbox });
    const fwd = root.split(path.sep).join('/');
    const back = root.split('/').join(String.fromCharCode(92));
    for (const command of [`cat > ${fwd}/b1/bot.json`, `echo x >> "${back}${String.fromCharCode(92)}inbox.json"`, 'echo hi > $CLAUDE_WEB_DIR/bots/b1/trust.json']) {
      expect(await g.gate(ev('Bash', { command }))).toMatchObject({ behavior: 'deny' });
    }
    expect(inbox.list('b1').filter((i) => i.kind === 'approval')).toHaveLength(3);
    expect(store.audit('b1', 'run1').every((r) => r.result === 'queued')).toBe(true);
    expect(await g.gate(ev('Bash', { command: 'npm test' }))).toMatchObject({ behavior: 'allow' });
  });
});
