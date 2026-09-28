import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentKind, Goal } from '../protocol.js';
import { OrchestraService, resolveTemplates, type OrchDeps } from './service.js';
import type { MergeResult, OrchGit } from './git.js';
import type { OrchNode, OrchRun, Workflow } from './types.js';

class FakeSession extends EventEmitter {
  prompts: string[] = [];
  constructor(public sessionId: string, public agent: AgentKind, public cwd: string) { super(); }
  reply(text: string, isError = false) {
    this.emit('message', { type: 'assistant', message: { content: [{ type: 'text', text }] } });
    this.emit('message', { type: 'result', is_error: isError, result: text, total_cost_usd: 0.01 });
  }
}

/** Stateful fake: worktrees (dir → branch, dirty) and branches (tip, commits not in base). */
function fakeGit(o: { repo?: boolean } = {}) {
  const calls: string[] = [];
  const wts = new Map<string, { branch: string; dirty: boolean }>();
  const branches = new Map<string, { tip: string; unmerged: number }>();
  let seq = 0;
  const git: OrchGit & { calls: string[]; branch: string | null; mergeResult: MergeResult; wts: typeof wts; branches: typeof branches; mergeGate?: Promise<void> } = {
    calls, branch: 'main', mergeResult: { ok: true }, wts, branches,
    async root(cwd) { return o.repo === false ? null : cwd; },
    async currentBranch() { return git.branch; },
    async free(_r, dir, branch) { return !wts.has(dir) && !branches.has(branch); },
    async worktreeAdd(_r, dir, branch, from) {
      if (wts.has(dir) || branches.has(branch)) throw new Error('exists');
      calls.push(`add ${path.basename(dir)} ${branch} ${from}`);
      wts.set(dir, { branch, dirty: false });
      branches.set(branch, { tip: `t${++seq}`, unmerged: 0 });
    },
    async commitAll(dir) {
      calls.push(`commit ${path.basename(dir)}`);
      const w = wts.get(dir);
      if (!w) return false;
      w.dirty = false;
      const b = branches.get(w.branch)!;
      b.tip = `t${++seq}`;
      b.unmerged++;
      return true;
    },
    async head(dir) { return branches.get(wts.get(dir)!.branch)!.tip; },
    async diffStat(_r, base, branch) { return { stat: `${base}..${branch} @${branches.get(branch)?.tip}`, files: 1 }; },
    async diff(_r, _b, branch) { return `diff of ${branch}`; },
    async merge(_cwd, branch) {
      if (git.mergeGate) await git.mergeGate;
      calls.push(`merge ${branch}`);
      if (git.mergeResult.ok) { const b = branches.get(branch); if (b) b.unmerged = 0; }
      return git.mergeResult;
    },
    async inspect(_r, dir, branch) { const w = wts.get(dir); const b = branches.get(branch); return { exists: !!w, dirty: !!w?.dirty, branchExists: !!b, tip: b?.tip, unmerged: b?.unmerged ?? 0 }; },
    async worktreeRemove(_r, dir) { if (wts.get(dir)?.dirty) throw new Error('dirty'); calls.push(`rm ${path.basename(dir)}`); wts.delete(dir); },
    async deleteBranch(_r, branch, force) { const b = branches.get(branch); if (!force && b?.unmerged) throw new Error('unmerged'); calls.push(`del ${branch}`); branches.delete(branch); },
  };
  return git;
}

class FakeGoals extends EventEmitter {
  goals = new Map<string, Goal>();
  removed: string[] = [];
  n = 0;
  gate?: Promise<void>;
  constructor(private open: (agent: AgentKind, cwd: string) => FakeSession) { super(); }
  async create(p: { objective: string; cwd: string; agent?: string; sessionId?: string }) {
    if (this.gate) await this.gate;
    const g = { id: `g${++this.n}`, objective: p.objective, cwd: p.cwd, agent: p.agent, sessionId: p.sessionId, status: 'draft', evidence: [], costUsd: 0 } as unknown as Goal;
    this.goals.set(g.id, g);
    return g;
  }
  async start(id: string) { const g = this.goals.get(id)!; g.status = 'active'; if (!g.sessionId) g.sessionId = this.open((g.agent as AgentKind) ?? 'claude', g.cwd).sessionId; this.emit('changed'); return g; }
  async pause(id: string) { const g = this.goals.get(id)!; g.status = 'paused'; return g; }
  async remove(id: string) { this.removed.push(id); this.goals.delete(id); this.emit('changed'); }
  get(id: string) { return this.goals.get(id); }
  set(id: string, patch: Partial<Goal>) { Object.assign(this.goals.get(id)!, patch); this.emit('changed'); }
}

const tick = () => new Promise((r) => setTimeout(r, 5));
async function until(fn: () => boolean, ms = 2000) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await tick(); }
}
const deferred = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };

let dir: string;
let wtRoot: string;
let sessions: FakeSession[];
let wfs: Workflow[];
let git: ReturnType<typeof fakeGit>;
let notified: string[];
let stopped: string[];
let closed: string[];
let maxParallel: number;
let available: AgentKind[];
let goals: FakeGoals;
let openGate: Promise<void> | undefined;
let made: OrchestraService[] = [];
let events: { run: OrchRun; removed?: boolean }[];

function svcOf() { const s = new OrchestraService(deps()); made.push(s); s.on('changed', (run, removed) => events.push({ run, removed })); return s; }
function deps(): OrchDeps {
  const open = (agent: AgentKind, cwd: string) => { const s = new FakeSession(`s${sessions.length + 1}`, agent, cwd); sessions.push(s); return s; };
  goals = new FakeGoals(open);
  const byId = (sid: string) => sessions.find((x) => x.sessionId === sid)!;
  return {
    dir,
    worktreeRoot: wtRoot,
    open: async (p) => { if (openGate) await openGate; return open(p.agent, p.cwd); },
    send: async (sid, text, isCancelled) => { if (isCancelled?.()) return false; byId(sid).prompts.push(text); return true; },
    watch: (sid, on) => {
      const s = byId(sid);
      const m = (x: unknown) => on.message?.(x);
      const st = (a: string, e?: string) => on.state?.(a, e);
      s.on('message', m); s.on('state', st);
      return () => { s.off('message', m); s.off('state', st); };
    },
    stop: async (sid) => { stopped.push(sid); },
    close: async (sid) => { closed.push(sid); },
    expand: async (t) => t.replace(/<session-ref id="([^"]+)"[^>]*\/>/g, '[briefing $1]'),
    git,
    goals: goals as any,
    workflows: { list: () => wfs, set: async (w) => { wfs = [...wfs.filter((x) => x.id !== w.id), w]; }, remove: async (id) => { wfs = wfs.filter((x) => x.id !== id); } },
    available: async () => available,
    maxParallel: () => maxParallel,
    notify: (_run, id, what) => notified.push(`${what}:${id}`),
  };
}

const task = (id: string, dependsOn: string[] = [], extra: Record<string, unknown> = {}): OrchNode => ({ id, kind: 'task', title: id, agent: 'claude', prompt: `do ${id} {{input}}`, dependsOn, workspace: 'shared', ...extra } as OrchNode);
const compare = (extra: Record<string, unknown> = {}): OrchNode => ({ id: 'cmp', kind: 'compare', title: '比选', agents: ['claude', 'codex'], prompt: 'build {{input}}', dependsOn: [], ...extra } as OrchNode);
const session = (text: string) => sessions.find((s) => s.prompts.some((p) => p.includes(text)))!;
const wtDir = (name: string) => [...git.wts.keys()].find((d) => path.basename(d) === name)!;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-orch-'));
  wtRoot = path.join(dir, 'worktrees');
  sessions = []; closed = []; stopped = []; wfs = []; notified = []; events = []; maxParallel = 3; available = ['claude', 'codex', 'gemini'];
  openGate = undefined;
  git = fakeGit();
});
afterEach(async () => { for (const m of made) await m.flush(); made = []; fs.rmSync(dir, { recursive: true, force: true }); });

async function startRun(svc: OrchestraService, nodes: OrchNode[], input = 'IN') {
  const w = await svc.saveWorkflow({ name: 'wf', cwd: '/repo', nodes });
  return svc.start(w.id, input);
}
async function toWaitingCompare(svc: OrchestraService, extra: Record<string, unknown> = {}, more: OrchNode[] = []) {
  const run = await startRun(svc, [compare(extra), ...more]);
  await until(() => sessions.length === 2);
  sessions[0].reply('claude way'); sessions[1].reply('codex way');
  await until(() => run.state === 'waiting');
  return run;
}

describe('OrchestraService scheduling', () => {
  it('runs dependencies in order, fills templates, and finishes done', async () => {
    const svc = svcOf();
    const run = await startRun(svc, [task('a'), task('b', ['a'], { prompt: 'use {{nodes.a.output}}' })]);
    await until(() => sessions.length === 1 && sessions[0].prompts.length === 1);
    expect(sessions[0].prompts[0]).toContain('do a IN');
    expect(sessions[0].prompts[0]).toContain('[编排 wf · a]');
    sessions[0].reply('A-OUT');
    await until(() => sessions.length === 2 && sessions[1].prompts.length === 1);
    expect(sessions[1].prompts[0]).toContain('use A-OUT');
    sessions[1].reply('B-OUT');
    await until(() => run.state === 'done');
    expect(run.nodes.b.output).toBe('B-OUT');
    expect(run.nodes.a.costUsd).toBeCloseTo(0.01);
  });

  it('respects maxParallel for independent nodes', async () => {
    maxParallel = 2;
    const svc = svcOf();
    const run = await startRun(svc, [task('a'), task('b'), task('c')]);
    await until(() => sessions.length === 2);
    await tick();
    expect(sessions.length).toBe(2);
    expect(run.nodes.c.state).toBe('pending');
    sessions[0].reply('x');
    await until(() => sessions.length === 3);
    sessions[1].reply('y'); sessions[2].reply('z');
    await until(() => run.state === 'done');
  });

  it('a failure skips downstream, lets independent branches finish, then fails the run', async () => {
    const svc = svcOf();
    const run = await startRun(svc, [task('a'), task('b', ['a']), task('c')]);
    await until(() => sessions.length === 2 && sessions.every((s) => s.prompts.length));
    session('do a').reply('boom', true);
    await until(() => run.nodes.b.state === 'skipped');
    expect(run.state).toBe('running');
    session('do c').reply('ok');
    await until(() => run.state === 'failed');
    expect(run.error).toContain('a');
  });

  it('a session error fails the node', async () => {
    const svc = svcOf();
    const run = await startRun(svc, [task('a')]);
    await until(() => sessions.length === 1 && sessions[0].prompts.length === 1);
    sessions[0].emit('state', 'error', 'spawn ENOENT\nstack');
    await until(() => run.state === 'failed');
    expect(run.nodes.a.error).toBe('spawn ENOENT');
  });

  it('approval blocks until approved; the comment is available downstream', async () => {
    const svc = svcOf();
    const run = await startRun(svc, [task('a'), { id: 'ok', kind: 'approval', title: '审批', dependsOn: ['a'] }, task('b', ['ok'], { prompt: 'note={{nodes.ok.approval}}' })]);
    await until(() => sessions.length === 1 && sessions[0].prompts.length === 1);
    sessions[0].reply('A');
    await until(() => run.nodes.ok.state === 'waiting');
    expect(run.state).toBe('waiting');
    expect(notified).toEqual(['approval:ok']);
    await svc.approve(run.id, 'ok', 'approve', '可以');
    await until(() => sessions.length === 2 && sessions[1].prompts.length === 1);
    expect(sessions[1].prompts[0]).toContain('note=通过：可以');
    sessions[1].reply('B');
    await until(() => run.state === 'done');
  });

  it('rejecting an approval fails the run and skips downstream; decisions other than approve/reject are refused', async () => {
    const svc = svcOf();
    const run = await startRun(svc, [{ id: 'ok', kind: 'approval', title: '审批', dependsOn: [] }, task('b', ['ok'])]);
    await until(() => run.nodes.ok.state === 'waiting');
    await expect(svc.approve(run.id, 'ok', 'maybe' as any)).rejects.toThrow();
    expect(run.nodes.ok.state).toBe('waiting');
    await svc.approve(run.id, 'ok', 'reject', '太冒险');
    expect(run.state).toBe('failed');
    expect(run.nodes.b.state).toBe('skipped');
  });

  it('retry reruns a failed node with a new session, un-skips downstream; done nodes cannot be retried (M8)', async () => {
    const svc = svcOf();
    const run = await startRun(svc, [task('a'), task('b', ['a'])]);
    await until(() => sessions.length === 1 && sessions[0].prompts.length === 1);
    sessions[0].reply('bad', true);
    await until(() => run.state === 'failed');
    await svc.retry(run.id, 'a');
    await until(() => sessions.length === 2 && sessions[1].prompts.length === 1);
    sessions[0].reply('late');
    sessions[1].reply('good');
    await until(() => sessions.length === 3 && sessions[2].prompts.length === 1);
    sessions[2].reply('b done');
    await until(() => run.state === 'done');
    expect(run.nodes.a.sessionIds).toEqual(['s1', 's2']);
    expect(run.nodes.a.output).toBe('good');
    await expect(svc.retry(run.id, 'a')).rejects.toThrow(/完成/);
  });

  it('double resume / retry is refused instead of scheduling twice (I2)', async () => {
    const svc = svcOf();
    const run = await startRun(svc, [task('a')]);
    await until(() => sessions.length === 1 && sessions[0].prompts.length === 1);
    sessions[0].reply('bad', true);
    await until(() => run.state === 'failed');
    const results = await Promise.allSettled([svc.resume(run.id), svc.resume(run.id), svc.retry(run.id, 'a')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    await tick(); await tick();
    expect(sessions.length).toBe(2);
    expect(run.nodes.a.attempts).toBe(2);
  });

  it('refuses unavailable agents and invalid graphs', async () => {
    available = ['claude'];
    const svc = svcOf();
    await expect(svc.saveWorkflow({ name: 'x', cwd: '/r', nodes: [task('a', ['b']), task('b', ['a'])] })).rejects.toThrow(/环/);
    const w = await svc.saveWorkflow({ name: 'x', cwd: '/r', nodes: [task('a', [], { agent: 'gemini' })] });
    await expect(svc.start(w.id, '')).rejects.toThrow(/gemini/);
  });
});

describe('cancellation (I3 / M4)', () => {
  it('cancel while the session is still opening: the prompt is never sent and the session is closed', async () => {
    const gate = deferred();
    openGate = gate.p;
    const svc = svcOf();
    const run = await startRun(svc, [task('a')]);
    await svc.cancel(run.id);
    gate.open();
    await until(() => sessions.length === 1);
    await tick(); await tick();
    expect(sessions[0].prompts).toEqual([]);
    expect(closed).toContain('s1');
  });

  it('cancel stops running sessions and cancels the rest; late results are ignored', async () => {
    const svc = svcOf();
    const run = await startRun(svc, [task('a'), task('b', ['a'])]);
    await until(() => sessions.length === 1 && sessions[0].prompts.length === 1);
    await svc.cancel(run.id);
    expect(run.state).toBe('cancelled');
    expect(stopped).toEqual(['s1']);
    expect(run.nodes.b.state).toBe('cancelled');
    sessions[0].reply('late');
    await tick();
    expect(run.nodes.a.state).toBe('cancelled');
  });

  it('cancel while a goal is being created removes the goal (untilDone)', async () => {
    const gate = deferred();
    const svc = svcOf();
    const w = await svc.saveWorkflow({ name: 'wf', cwd: '/repo', nodes: [task('a', [], { untilDone: true })] });
    goals.gate = gate.p;
    const run = await svc.start(w.id, '');
    await until(() => sessions.length === 1);
    await svc.cancel(run.id);
    gate.open();
    await until(() => goals.removed.length === 1);
    expect(closed).toContain('s1');
  });

  it('cannot cancel while a merge into the base branch is running', async () => {
    const svc = svcOf();
    const run = await toWaitingCompare(svc);
    const gate = deferred();
    git.mergeGate = gate.p;
    const pick = svc.pick(run.id, 'cmp', 'codex');
    await tick();
    await expect(svc.cancel(run.id)).rejects.toThrow(/合并/);
    gate.open();
    await pick;
    expect(run.state).toBe('done');
  });
});

describe('untilDone tasks (I4 / I5 / M9)', () => {
  it('open the session through the normal path, expand refs, then run the goal protocol', async () => {
    const svc = svcOf();
    const run = await startRun(svc, [task('a', [], { untilDone: true, agent: 'codex', prompt: 'fix <session-ref id="ref1" />' })]);
    await until(() => goals.goals.size === 1);
    const g = [...goals.goals.values()][0];
    expect(g.sessionId).toBe('s1');
    expect(sessions[0].agent).toBe('codex');
    expect(g.objective).toContain('[briefing ref1]');
    goals.set(g.id, { status: 'complete', lastResult: 'all good\nGOAL_STATUS: complete', costUsd: 0.5 });
    await until(() => run.state === 'done');
    expect(run.nodes.a.output).toBe('all good');
  });

  it('a paused goal, a deleted goal or a closed goal session fail the node instead of hanging', async () => {
    const svc = svcOf();
    const run = await startRun(svc, [task('a', [], { untilDone: true }), task('b', [], { untilDone: true }), task('c', [], { untilDone: true })]);
    await until(() => goals.goals.size === 3);
    const [ga, gb, gc] = [...goals.goals.values()];
    goals.set(ga.id, { status: 'paused' });
    await goals.remove(gb.id);
    sessions.find((s) => s.sessionId === gc.sessionId)!.emit('state', 'closed');
    await until(() => run.state === 'failed');
    expect(run.nodes.a.error).toContain('暂停');
    expect(run.nodes.b.error).toContain('删除');
    expect(run.nodes.c.error).toContain('关闭');
  });
});

describe('worktrees and compare (C1 / C2 / I1)', () => {
  it('worktrees live under the data dir, named per run / node / agent', async () => {
    const svc = svcOf();
    const run = await toWaitingCompare(svc);
    const dirs = [...git.wts.keys()];
    expect(dirs.every((d) => d.startsWith(wtRoot))).toBe(true);
    expect(dirs.map((d) => path.basename(d)).sort()).toEqual([`${run.id}-cmp-claude`, `${run.id}-cmp-codex`]);
    expect(run.nodes.cmp.candidates?.every((c) => c.head && c.diffStat?.includes(c.head))).toBe(true);
    expect(notified).toEqual(['compare:cmp']);
  });

  it('pick re-commits the winner, merges it, removes clean worktrees and the unchanged loser branch', async () => {
    const svc = svcOf();
    const run = await toWaitingCompare(svc, {}, [task('after', ['cmp'], { prompt: 'got {{nodes.cmp.output}}' })]);
    const codexDir = wtDir(`${run.id}-cmp-codex`);
    git.wts.get(codexDir)!.dirty = true; // the user tweaked the winner after it finished
    await svc.pick(run.id, 'cmp', 'codex');
    expect(run.nodes.cmp.state).toBe('done');
    expect(git.calls.filter((c) => c === `commit ${run.id}-cmp-codex`)).toHaveLength(2);
    const codex = run.nodes.cmp.candidates!.find((c) => c.agent === 'codex')!;
    expect(codex.diffStat).toContain(git.branches.get(`cw/${run.id}/cmp-codex`)!.tip);
    expect(git.calls).toContain(`merge cw/${run.id}/cmp-codex`);
    expect(git.calls).toEqual(expect.arrayContaining([`rm ${run.id}-cmp-claude`, `rm ${run.id}-cmp-codex`, `del cw/${run.id}/cmp-claude`]));
    expect(git.branches.has(`cw/${run.id}/cmp-codex`)).toBe(true);
    await until(() => sessions.length === 3 && sessions[2].prompts.length === 1);
    expect(sessions[2].prompts[0]).toContain('got codex way');
  });

  it('a loser with new commits or uncommitted work is kept and reported', async () => {
    const svc2 = svcOf();
    const r = await startRun(svc2, [compare({ agents: ['claude', 'codex', 'gemini'] })]);
    await until(() => sessions.length === 3);
    sessions.forEach((s) => s.reply(`${s.agent} way`));
    await until(() => r.state === 'waiting');
    git.branches.get(`cw/${r.id}/cmp-claude`)!.tip = 'user-commit';
    git.wts.get(wtDir(`${r.id}-cmp-gemini`))!.dirty = true;
    await svc2.pick(r.id, 'cmp', 'codex');
    expect(r.nodes.cmp.state).toBe('done');
    expect(git.branches.has(`cw/${r.id}/cmp-claude`)).toBe(true);
    expect(git.wts.has(wtDir(`${r.id}-cmp-gemini`) ?? 'x')).toBe(true);
    expect(r.nodes.cmp.note).toMatch(/claude/);
    expect(r.nodes.cmp.note).toMatch(/gemini/);
  });

  it('a failed merge sends the compare back to waiting with everything kept (C2)', async () => {
    const svc = svcOf();
    const run = await toWaitingCompare(svc);
    git.mergeResult = { ok: false, kind: 'busy', error: '你自己进行中的 merge' };
    await svc.pick(run.id, 'cmp', 'claude');
    expect(run.nodes.cmp.state).toBe('waiting');
    expect(run.state).toBe('waiting');
    expect(run.nodes.cmp.error).toContain('进行中的 merge');
    expect(git.calls.some((c) => c.startsWith('rm ') || c.startsWith('del '))).toBe(false);
    git.mergeResult = { ok: true };
    await svc.pick(run.id, 'cmp', 'claude');
    expect(run.state).toBe('done');
    expect(run.nodes.cmp.error).toBeUndefined();
  });

  it('refuses to merge when the base worktree moved to another branch', async () => {
    const svc = svcOf();
    const run = await toWaitingCompare(svc);
    git.branch = 'feature';
    await svc.pick(run.id, 'cmp', 'claude');
    expect(run.nodes.cmp.state).toBe('waiting');
    expect(run.nodes.cmp.error).toContain('feature');
    expect(git.calls.some((c) => c.startsWith('merge'))).toBe(false);
  });

  it('retrying a compare never deletes: new worktrees get an -attempt suffix, the old ones are retained', async () => {
    const svc = svcOf();
    const run = await toWaitingCompare(svc);
    await svc.retry(run.id, 'cmp');
    await until(() => sessions.length === 4);
    expect(git.calls.some((c) => c.startsWith('rm ') || c.startsWith('del '))).toBe(false);
    expect(git.wts.size).toBe(4);
    expect([...git.wts.keys()].map((d) => path.basename(d))).toEqual(expect.arrayContaining([`${run.id}-cmp-claude-attempt2`, `${run.id}-cmp-codex-attempt2`]));
    expect(run.nodes.cmp.retained?.map((w) => path.basename(w.path)).sort()).toEqual([`${run.id}-cmp-claude`, `${run.id}-cmp-codex`]);
  });

  it('a name that is still taken is skipped rather than reused', async () => {
    const svc = svcOf();
    const run = await startRun(svc, [task('w', [], { workspace: 'worktree' })]);
    await until(() => sessions.length === 1 && sessions[0].prompts.length === 1);
    sessions[0].reply('x', true);
    await until(() => run.state === 'failed');
    git.branches.set(`cw/${run.id}/w-claude-attempt2`, { tip: 'someone', unmerged: 1 });
    await svc.retry(run.id, 'w');
    await until(() => sessions.length === 2);
    expect(path.basename(sessions[1].cwd)).toBe(`${run.id}-w-claude-attempt3`);
  });

  it('a judge recommends a winner, the user still confirms', async () => {
    const svc = svcOf();
    const run = await toWaitingCompare(svc, { judge: 'gemini' });
    await until(() => sessions.length === 3 && sessions[2].prompts.length === 1);
    expect(sessions[2].agent).toBe('gemini');
    expect(sessions[2].prompts[0]).toContain(`diff of cw/${run.id}/cmp-claude`);
    sessions[2].reply('codex is cleaner\nWINNER: codex');
    await until(() => run.nodes.cmp.judge?.state === 'done');
    expect(run.nodes.cmp.judge?.recommended).toBe('codex');
    expect(run.nodes.cmp.state).toBe('waiting');
  });

  it('all candidates failing fails the node; compare without git is rejected at save', async () => {
    const svc = svcOf();
    const run = await startRun(svc, [compare()]);
    await until(() => sessions.length === 2 && sessions.every((s) => s.prompts.length));
    sessions[0].reply('x', true); sessions[1].reply('y', true);
    await until(() => run.state === 'failed');
    expect(run.nodes.cmp.error).toContain('所有候选');
    git = fakeGit({ repo: false });
    const svc2 = svcOf();
    await expect(svc2.saveWorkflow({ name: 'n', cwd: '/x', nodes: [compare()] })).rejects.toThrow(/git/);
  });

  it('a worktree task merges back and removes its worktree + merged branch', async () => {
    const svc = svcOf();
    const run = await startRun(svc, [task('w', [], { workspace: 'worktree', agent: 'codex' })]);
    await until(() => sessions.length === 1 && sessions[0].prompts.length === 1);
    expect(sessions[0].cwd.startsWith(wtRoot)).toBe(true);
    sessions[0].reply('done');
    await until(() => run.state === 'done');
    expect(git.calls).toEqual(expect.arrayContaining([`commit ${run.id}-w-codex`, `merge cw/${run.id}/w-codex`, `rm ${run.id}-w-codex`, `del cw/${run.id}/w-codex`]));
    expect(closed).toContain('s1');
  });

  it('a worktree task whose merge fails keeps its worktree and branch', async () => {
    git.mergeResult = { ok: false, kind: 'conflict', error: 'CONFLICT' };
    const svc = svcOf();
    const run = await startRun(svc, [task('w', [], { workspace: 'worktree' })]);
    await until(() => sessions.length === 1 && sessions[0].prompts.length === 1);
    sessions[0].reply('done');
    await until(() => run.state === 'failed');
    expect(run.nodes.w.error).toContain('保留');
    expect(git.calls.some((c) => c.startsWith('rm ') || c.startsWith('del '))).toBe(false);
  });

  it('a detached HEAD refuses worktree runs up front', async () => {
    git.branch = null;
    const svc = svcOf();
    const w = await svc.saveWorkflow({ name: 'n', cwd: '/repo', nodes: [compare()] });
    await expect(svc.start(w.id, '')).rejects.toThrow(/分离 HEAD/);
  });
});

describe('OrchestraService persistence and removal', () => {
  it('writes runs to disk; a restart fails in-flight runs and resume continues from the failed node', async () => {
    const svc = svcOf();
    const run = await startRun(svc, [task('a'), task('b', ['a'])]);
    await until(() => sessions.length === 1 && sessions[0].prompts.length === 1);
    sessions[0].reply('A-OUT');
    await until(() => sessions.length === 2);
    await svc.flush();
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, `${run.id}.json`), 'utf8')) as OrchRun;
    expect(onDisk.nodes.a.output).toBe('A-OUT');

    const svc2 = svcOf();
    await svc2.init();
    const r2 = svc2.get(run.id);
    expect(r2.state).toBe('failed');
    expect(r2.error).toBe('服务重启中断');
    const before = sessions.length;
    await svc2.resume(run.id);
    await until(() => sessions.length === before + 1 && sessions[before].prompts.length === 1);
    expect(sessions[before].prompts[0]).toContain('do b');
    sessions[before].reply('B');
    await until(() => r2.state === 'done');
    expect(svc2.list()[0]).toMatchObject({ id: run.id, state: 'done', total: 2, done: 2 });
  });

  it('remove broadcasts; with cleanup it removes clean merged leftovers and only lists the rest (M7)', async () => {
    const svc = svcOf();
    const run = await toWaitingCompare(svc);
    git.mergeResult = { ok: false, kind: 'conflict', error: 'CONFLICT' };
    await svc.pick(run.id, 'cmp', 'claude');
    await svc.cancel(run.id);
    git.wts.get(wtDir(`${run.id}-cmp-codex`))!.dirty = true;
    const res = await svc.remove(run.id, true);
    expect(res.kept.map((k) => k.branch).sort()).toEqual([`cw/${run.id}/cmp-claude`, `cw/${run.id}/cmp-codex`]);
    expect(res.kept.find((k) => k.branch.endsWith('codex'))?.reason).toContain('未提交');
    expect(res.kept.find((k) => k.branch.endsWith('claude'))?.reason).toContain('未合并');
    expect(events.at(-1)).toMatchObject({ removed: true });
    await svc.flush();
    expect(fs.existsSync(path.join(dir, `${run.id}.json`))).toBe(false);
  });
});

describe('resolveTemplates', () => {
  it('falls back to Claude for missing task agents and keeps installed compare agents', () => {
    const t = resolveTemplates(['claude', 'gemini']);
    expect(t.find((x) => x.id === 'plan-impl-review')!.nodes.find((n) => n.id === 'impl')).toMatchObject({ agent: 'claude' });
    expect((t.find((x) => x.id === 'three-way')!.nodes[0] as any).agents).toEqual(['claude', 'gemini']);
  });
});
