import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { EventEmitter } from 'node:events';
import { BotStore } from './store.js'; import { AuditLog } from './audit.js'; import { Inbox } from './inbox.js';
import { runRoutine, buildPrompt, policyLine, ledgerCost, type PipelineDeps } from './pipeline.js';
import type { Bot, Routine } from '../protocol.js';

/** a runner that answers the first send with a result, after running `calls` through its gate */
function fakeRunner(o: { resultText?: string; isError?: boolean; calls?: { toolName: string; input: Record<string, unknown> }[]; agent?: string; gated?: boolean; never?: boolean } = {}) {
  const r: any = new EventEmitter();
  r.sessionId = `s_${Math.random().toString(36).slice(2, 8)}`; r.state = 'idle'; r.sent = [] as string[];
  r.info = { agent: o.agent ?? 'claude' }; r.gated = o.gated ?? true;
  r.interrupted = 0; r.closed = 0; r.gateAtSend = undefined;
  r.send = (text: string) => {
    r.sent.push(text); r.state = 'running'; r.gateAtSend ??= r.gate;
    if (o.never) return;
    setTimeout(async () => {
      for (const c of o.calls ?? []) await r.gate?.({ requestId: 'q', sessionId: r.sessionId, toolName: c.toolName, input: c.input });
      r.state = 'idle';
      r.emit('message', { type: 'result', is_error: !!o.isError, result: o.resultText ?? 'done' });
    }, 0);
  };
  r.interrupt = async () => { r.interrupted++; }; r.close = async () => { r.closed++; r.state = 'closed'; };
  return r;
}

const routine = (p: Partial<Routine> = {}): Routine => ({ id: 'r1', name: '晨报', prompt: '汇总 issue', enabled: true, acceptance: { kind: 'none' }, onFail: 'inbox', ...p });
const bot = (routines: Routine[]): Bot => ({ id: 'b1', name: '小晨', charter: { role: '每天出晨报', sources: ['github'] }, cwd: process.cwd(), tier: 'balanced', policy: { rules: [] }, budget: {}, routines, outputs: [{ kind: 'inbox' }], createdAt: 0, updatedAt: 0 });

describe('runRoutine', () => {
  let root: string; let store: BotStore; let inbox: Inbox; let audit: AuditLog; let opened: any[];
  const deps = (runner: any, extra: Partial<PipelineDeps> = {}): PipelineDeps => ({ store, audit, inbox, open: (p) => { opened.push(p); return runner; }, memories: () => ['只看 claude-web 仓库'], costOf: async () => ({ usd: 0.0123 }), defaultProvider: () => 'relay-1', ...extra });
  beforeEach(async () => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-pipe-')); store = new BotStore(root); inbox = new Inbox(store); audit = new AuditLog(store); opened = []; });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('a plain run: new conversation, prompt built, result recorded with cost, a finding delivered', async () => {
    const b = bot([routine()]); await store.save(b);
    const runner = fakeRunner({ resultText: '今天 3 个 issue' });
    const { run } = await runRoutine(deps(runner), b, b.routines[0], 'cron');
    expect(opened[0]).toMatchObject({ cwd: process.cwd(), providerId: 'relay-1', drivenBy: 'schedule', gated: true, botId: 'b1', permissionMode: 'default' });
    expect(opened[0].sessionId).toBeUndefined();
    expect(opened[0].model).toBeUndefined();
    expect(run).toMatchObject({ ok: true, costUsd: 0.0123, said: '今天 3 个 issue', trigger: 'cron' });
    expect(run.skipped).toBeUndefined();
    expect(run.costEstimated).toBeUndefined();
    expect(store.runs('b1')[0].id).toBe(run.id);
    expect(inbox.list('b1')[0]).toMatchObject({ kind: 'finding', title: '晨报', body: '今天 3 个 issue' });
    expect(store.stateOf('b1', 'r1').lastSummary).toBe('今天 3 个 issue');
    // the gate was in place before the prompt went out; the conversation is closed once the run is over
    expect(typeof runner.gateAtSend).toBe('function');
    expect(runner.closed).toBe(1);
  });

  it('precheck: same fingerprint skips without opening a conversation', async () => {
    const echo = process.platform === 'win32' ? 'Write-Output same' : 'echo same';
    const b = bot([routine({ precheck: echo })]); await store.save(b);
    const first = await runRoutine(deps(fakeRunner()), b, b.routines[0], 'cron');
    expect(first.run.skipped).toBeUndefined(); expect(opened).toHaveLength(1);
    const second = await runRoutine(deps(fakeRunner()), b, b.routines[0], 'cron');
    expect(second.run.skipped).toBe(true); expect(opened).toHaveLength(1);
  });

  it('precheck: the fingerprint is kept only once a run ends ok — a failed, stopped or handed-over run is not "unchanged" next time', async () => {
    const echo = process.platform === 'win32' ? 'Write-Output same' : 'echo same';
    const b = bot([routine({ precheck: echo })]); await store.save(b);
    await runRoutine(deps(fakeRunner({ isError: true })), b, b.routines[0], 'cron');
    expect(store.stateOf('b1', 'r1').fingerprint).toBeUndefined();
    const ac = new AbortController();
    const runner = fakeRunner({ never: true });
    const p = runRoutine(deps(runner), b, b.routines[0], 'cron', { signal: ac.signal });
    for (let i = 0; i < 500 && !runner.sent.length; i++) await new Promise((res) => setTimeout(res, 10));
    ac.abort('handoff');
    expect((await p).run.handoff).toBe(true);
    expect(store.stateOf('b1', 'r1').fingerprint).toBeUndefined();
    const third = await runRoutine(deps(fakeRunner()), b, b.routines[0], 'cron');
    expect(third.run.skipped).toBeUndefined(); expect(opened).toHaveLength(3);
    expect(store.stateOf('b1', 'r1').fingerprint).toMatch(/^[0-9a-f]{40}$/);
  });

  it('a failing precheck is named in the language of the app (tr), and the run still goes on', async () => {
    const fail = process.platform === 'win32' ? 'Write-Error nope; exit 3' : 'echo nope >&2; exit 3';
    const b = bot([routine({ precheck: fail })]); await store.save(b);
    const { run } = await runRoutine(deps(fakeRunner()), b, b.routines[0], 'cron');
    expect(opened).toHaveLength(1);
    expect(run.error).toMatch(/^预检查出错：/);
  });

  it('an ask inside the run is queued, the run still ends ok, and resume approves exactly that call', async () => {
    const b = bot([routine()]); await store.save(b);
    const push = { toolName: 'Bash', input: { command: 'git push origin main' } };
    const first = await runRoutine(deps(fakeRunner({ calls: [push] })), b, b.routines[0], 'cron');
    const item = inbox.list('b1').find((i) => i.kind === 'approval')!;
    expect(item).toMatchObject({ toolName: 'Bash', runId: first.run.id, sessionId: first.run.sessionId });
    const r2 = fakeRunner({ calls: [push] });
    const second = await runRoutine(deps(r2), b, b.routines[0], 'resume', { resume: { sessionId: item.sessionId!, approved: [{ toolName: item.toolName!, input: item.input! }] } });
    expect(opened[1].sessionId).toBe(item.sessionId);
    expect(r2.sent[0]).toContain('已经批准');
    expect(store.audit('b1', second.run.id).map((a) => a.result)).toEqual(['allowed']);
  });

  it('an estimated cost is recorded with costEstimated (budgets count it)', async () => {
    const b = bot([routine()]); await store.save(b);
    const { run } = await runRoutine(deps(fakeRunner(), { costOf: async () => ({ usd: 1.2, estimated: true }) }), b, b.routines[0], 'manual');
    expect(run).toMatchObject({ ok: true, costUsd: 1.2, costEstimated: true });
  });

  it('acceptance script decides ok; three failures disable the routine and say so', async () => {
    const fail = 'exit 1';
    const b = bot([routine({ acceptance: { kind: 'script', script: fail } })]); await store.save(b);
    for (let i = 0; i < 3; i++) await runRoutine(deps(fakeRunner()), store.get('b1')!, store.get('b1')!.routines[0], 'cron');
    const runs = store.runs('b1');
    expect(runs.every((r) => r.ok === false && r.verified?.ok === false)).toBe(true);
    expect(store.get('b1')!.routines[0]).toMatchObject({ enabled: false, failures: 3 });
    expect(inbox.list('b1').some((i) => i.title.includes('停用'))).toBe(true);
  });

  it('drafts in the answer become draft items', async () => {
    const b = bot([routine()]); await store.save(b);
    await runRoutine(deps(fakeRunner({ resultText: '写好了 <draft>嗨，这是回复</draft> 请过目' })), b, b.routines[0], 'manual');
    expect(inbox.list('b1').map((i) => i.kind).sort()).toEqual(['draft', 'finding']);
    expect(inbox.list('b1').find((i) => i.kind === 'draft')!.body).toBe('嗨，这是回复');
  });

  it('a driver that does not honour the gate (another agent, or an ungated runner) is closed and the run fails, nothing sent', async () => {
    const b = bot([routine()]); await store.save(b);
    for (const runner of [fakeRunner({ agent: 'codex' }), fakeRunner({ gated: false })]) {
      const { run } = await runRoutine(deps(runner), b, store.get('b1')!.routines[0], 'manual');
      expect(run.ok).toBe(false);
      expect(run.error).toMatch(/策略/);
      expect(runner.sent).toEqual([]);
      expect(runner.closed).toBe(1);
    }
    // both counted as failures, each with its notice
    expect(store.get('b1')!.routines[0].failures).toBe(2);
    expect(inbox.list('b1').filter((i) => i.title.includes('不经过策略检查'))).toHaveLength(2);
    // the third (open throws) disables the routine
    const { run } = await runRoutine(deps(fakeRunner(), { open: () => { throw new Error('no provider'); } }), b, store.get('b1')!.routines[0], 'manual');
    expect(run).toMatchObject({ ok: false, error: 'no provider' });
    expect(store.get('b1')!.routines[0]).toMatchObject({ failures: 3, enabled: false });
    expect(inbox.list('b1').some((i) => i.title.includes('已停用') && i.body === 'no provider')).toBe(true);
  });

  it('a conversation that cannot be opened counts as a failure with its own notice', async () => {
    const b = bot([routine()]); await store.save(b);
    const { run } = await runRoutine(deps(fakeRunner(), { open: () => { throw new Error('boom'); } }), b, b.routines[0], 'cron');
    expect(run.ok).toBe(false);
    expect(store.get('b1')!.routines[0].failures).toBe(1);
    expect(inbox.list('b1')[0]).toMatchObject({ kind: 'finding', title: expect.stringContaining('对话打不开'), body: 'boom' });
  });

  it('the failure notice names its cause: an error result vs a failed check', async () => {
    const b = bot([routine()]); await store.save(b);
    await runRoutine(deps(fakeRunner({ isError: true, resultText: 'api 500' })), b, store.get('b1')!.routines[0], 'cron');
    expect(inbox.list('b1').some((i) => i.title === '例行「晨报」出错了')).toBe(true);
    await store.update('b1', (x) => ({ ...x, routines: [{ ...x.routines[0], acceptance: { kind: 'script', script: 'exit 1' } }] }));
    await runRoutine(deps(fakeRunner()), store.get('b1')!, store.get('b1')!.routines[0], 'cron');
    expect(inbox.list('b1').some((i) => i.title === '例行「晨报」没通过验收')).toBe(true);
  });

  it('the write-back keeps what changed in bot.json while the run went; outputs are read as they are now; drafts past 2000 chars count', async () => {
    const b = bot([routine(), routine({ id: 'r2', name: '周报' })]); await store.save(b);
    const runner = fakeRunner({ resultText: 'x'.repeat(2100) + '<draft>晚到的草稿</draft>' });
    const send = runner.send;
    runner.send = (t: string) => {
      // meanwhile: the other routine fails, and the user renames the bot and drops the inbox output
      void store.update('b1', (x) => ({ ...x, name: '新名字', outputs: [], routines: x.routines.map((r) => (r.id === 'r2' ? { ...r, failures: 2 } : r)) }));
      send(t);
    };
    const { run } = await runRoutine(deps(runner), b, b.routines[0], 'cron');
    expect(run.ok).toBe(true);
    const now = store.get('b1')!;
    expect(now.name).toBe('新名字');
    expect(now.routines.find((r) => r.id === 'r2')!.failures).toBe(2);
    expect(now.routines.find((r) => r.id === 'r1')!).toMatchObject({ failures: 0, lastRunAt: run.at });
    expect(inbox.list('b1')).toEqual([]); // no inbox output any more

    await store.update('b1', (x) => ({ ...x, outputs: [{ kind: 'inbox' }] }));
    await runRoutine(deps(fakeRunner({ resultText: 'x'.repeat(2100) + '<draft>晚到的草稿</draft>' })), store.get('b1')!, store.get('b1')!.routines[0], 'cron');
    expect(inbox.list('b1').find((i) => i.kind === 'draft')!.body).toBe('晚到的草稿');
  });

  it('the hard stop: aborting interrupts and closes the conversation; the run is recorded as stopped, not as a failure', async () => {
    const b = bot([routine()]); await store.save(b);
    const runner = fakeRunner({ never: true });
    const ac = new AbortController();
    const p = runRoutine(deps(runner), b, b.routines[0], 'manual', { signal: ac.signal });
    for (let i = 0; i < 500 && !runner.sent.length; i++) await new Promise((res) => setTimeout(res, 10));
    expect(runner.sent).toHaveLength(1);
    ac.abort();
    const { run } = await p;
    expect(runner.interrupted).toBe(1); expect(runner.closed).toBe(1);
    expect(run).toMatchObject({ ok: false, error: '被停下了' });
    expect(store.get('b1')!.routines[0].failures ?? 0).toBe(0);
    expect(inbox.list('b1')).toEqual([]);
  });

  it('a stop during the pre-check kills it and opens nothing', async () => {
    const slow = process.platform === 'win32' ? 'Start-Sleep -Seconds 20; Write-Output x' : 'sleep 20; echo x';
    const b = bot([routine({ precheck: slow })]); await store.save(b);
    const ac = new AbortController();
    const t0 = Date.now();
    const p = runRoutine(deps(fakeRunner()), b, b.routines[0], 'manual', { signal: ac.signal });
    setTimeout(() => ac.abort(), 300);
    const { run } = await p;
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(opened).toHaveLength(0);
    expect(run).toMatchObject({ ok: false, error: '被停下了' });
  }, 15_000);

  it('buildPrompt carries charter, routine, state, memories and the rules', () => {
    const p = buildPrompt(bot([routine()]), routine(), { lastSummary: '上次 2 个', checkpoint: '做到第 3 步', updatedAt: 0 }, ['只看 claude-web'], '/x/cp.md');
    for (const s of ['小晨', '每天出晨报', 'github', '汇总 issue', '上次 2 个', '做到第 3 步', '只看 claude-web', '/x/cp.md', '<draft>', 'mcp__claude-web-memory__memory_write']) expect(p).toContain(s);
    expect(p).not.toMatch(/memory\.write|scope 填 bot/);
    expect(p).toContain('只是告知（由系统把关，不用你自己拦）：对外发送/付款/删除会先问人。');
  });
  it('buildPrompt: the checkpoint is written and cleared with the Write tool, no shell in the state folder (Task 22: mkdir / rm there always ask)', () => {
    const p = buildPrompt(bot([routine()]), routine(), { updatedAt: 0 }, [], '/x/state/cp.md');
    expect(p).toContain('- 长任务每完成一步就用 Write 工具把进度写进 /x/state/cp.md（覆盖写），做完后用 Write 把它写成空的。');
    expect(p).toContain('- 这个文件夹已经建好：不要用命令行（mkdir / rm / echo > 等）碰 /x/state，命令行碰它每次都要先问人。');
    expect(p).not.toContain('删掉它');
  });
  it("the prompt's policy line is built from the bot's own levels", () => {
    expect(policyLine({ rules: [{ cls: 'pay', level: 'deny' }, { cls: 'delete', level: 'do_tell' }, { cls: 'send', level: 'do', scope: { domains: ['hooks.slack.com'] } }] }))
      .toBe('- 只是告知（由系统把关，不用你自己拦）：对外发送会先问人（放行范围内的直接做）；付款不允许；删除可以直接做（做完告诉人）。');
    expect(policyLine({ rules: [{ cls: 'pay', level: 'deny' }], unleashed: true })).toBe('- 只是告知（由系统把关，不用你自己拦）：对外发送/付款/删除可以直接做。');
  });
});

describe('ledgerCost', () => {
  const row = (p: Record<string, unknown>) => ({ ts: 0, sessionId: 's', model: 'm', durationMs: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, ok: true, ...p }) as any;
  it('known prices are summed as they are', () => {
    expect(ledgerCost([row({ costUsd: 0.25 }), row({ costUsd: 0.5 })])).toEqual({ usd: 0.75, estimated: false });
    expect(ledgerCost([])).toEqual({ usd: 0, estimated: false });
  });
  it('an unknown price (deepseek on a relay) is estimated from its tokens at a Sonnet-class price, and says so', () => {
    const c = ledgerCost([row({ costUsd: 0.1 }), row({ model: 'deepseek-v4.1-flash', costUnknown: true, input: 350_000, output: 10_000, cacheRead: 100_000, cacheWrite: 20_000 })]);
    expect(c.estimated).toBe(true);
    expect(c.usd).toBeCloseTo(0.1 + (350_000 * 3 + 10_000 * 15 + 20_000 * 3.75 + 100_000 * 0.3) / 1e6, 6);
  });
  it('an unknown row without tokens (a retry note) adds nothing and is not an estimate', () => {
    expect(ledgerCost([row({ costUnknown: true })])).toEqual({ usd: 0, estimated: false });
  });
});
