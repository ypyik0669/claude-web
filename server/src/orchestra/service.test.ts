import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentKind, Goal } from '../protocol.js';
import { OrchestraService, resolveTemplates, type OrchDeps, type OrchGit } from './service.js';
import type { OrchNode, OrchRun, Workflow } from './types.js';

class FakeSession extends EventEmitter {
  prompts: string[] = [];
  constructor(public sessionId: string, public agent: AgentKind, public cwd: string) { super(); }
  reply(text: string, isError = false) {
    this.emit('message', { type: 'assistant', message: { content: [{ type: 'text', text }] } });
    this.emit('message', { type: 'result', is_error: isError, result: text, total_cost_usd: 0.01 });
  }
}

function fakeGit(o: { repo?: boolean; branch?: string; mergeFail?: boolean } = {}) {
  const calls: string[] = [];
  const git: OrchGit & { calls: string[]; branch: string | null; mergeFail: boolean } = {
    calls, branch: o.branch ?? 'main', mergeFail: !!o.mergeFail,
    async root(cwd) { return o.repo === false ? null : cwd; },
    async currentBranch() { return git.branch; },
    async exclude(root) { calls.push(`exclude ${root}`); },
    async worktreeAdd(_root, dir, branch, from) { calls.push(`add ${path.basename(dir)} ${branch} ${from}`); },
    async commitAll(dir) { calls.push(`commit ${path.basename(dir)}`); return true; },
    async diffStat(_r, base, branch) { return { stat: `${base}..${branch} 1 file changed`, files: 1 }; },
    async diff(_r, _b, branch) { return `diff of ${branch}`; },
    async merge(_cwd, branch) { calls.push(`merge ${branch}`); return git.mergeFail ? { ok: false, error: 'CONFLICT' } : { ok: true }; },
    async worktreeRemove(_root, dir) { calls.push(`rm ${path.basename(dir)}`); },
    async deleteBranch(_root, branch) { calls.push(`del ${branch}`); },
  };
  return git;
}

class FakeGoals extends EventEmitter {
  goals = new Map<string, Goal>();
  n = 0;
  constructor(private open: (agent: AgentKind, cwd: string) => FakeSession) { super(); }
  async create(p: { objective: string; cwd: string; agent?: string }) {
    const g = { id: `g${++this.n}`, objective: p.objective, cwd: p.cwd, agent: p.agent, status: 'draft', evidence: [], costUsd: 0 } as unknown as Goal;
    this.goals.set(g.id, g);
    return g;
  }
  async start(id: string) { const g = this.goals.get(id)!; g.status = 'active'; g.sessionId = this.open((g.agent as AgentKind) ?? 'claude', g.cwd).sessionId; this.emit('changed'); return g; }
  async pause(id: string) { const g = this.goals.get(id)!; g.status = 'paused'; return g; }
  get(id: string) { return this.goals.get(id); }
  set(id: string, patch: Partial<Goal>) { Object.assign(this.goals.get(id)!, patch); this.emit('changed'); }
}

const tick = () => new Promise((r) => setTimeout(r, 5));
async function until(fn: () => boolean, ms = 2000) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await tick(); }
}

let dir: string;
let sessions: FakeSession[];
let wfs: Workflow[];
let git: ReturnType<typeof fakeGit>;
let notified: string[];
let interrupted: string[];
let closed: string[] = [];
let maxParallel: number;
let available: AgentKind[];
let goals: FakeGoals;
let made: OrchestraService[] = [];

function svcOf() { const s = new OrchestraService(deps()); made.push(s); return s; }
function deps(): OrchDeps {
  const open = (agent: AgentKind, cwd: string) => { const s = new FakeSession(`s${sessions.length + 1}`, agent, cwd); sessions.push(s); return s; };
  goals = new FakeGoals(open);
  return {
    dir,
    open: async (p) => open(p.agent, p.cwd),
    send: async (s, text) => { (s as FakeSession).prompts.push(text); },
    interrupt: async (sid) => { interrupted.push(sid); },
    close: async (sid) => { closed.push(sid); },
    git,
    goals: goals as any,
    workflows: { list: () => wfs, set: async (w) => { wfs = [...wfs.filter((x) => x.id !== w.id), w]; }, remove: async (id) => { wfs = wfs.filter((x) => x.id !== id); } },
    available: async () => available,
    maxParallel: () => maxParallel,
    notify: (_run, id, what) => notified.push(`${what}:${id}`),
  };
}

const task = (id: string, dependsOn: string[] = [], extra: Record<string, unknown> = {}): OrchNode => ({ id, kind: 'task', title: id, agent: 'claude', prompt: `do ${id} {{input}}`, dependsOn, workspace: 'shared', ...extra } as OrchNode);
const session = (agentOrCwdPart: string) => sessions.find((s) => s.prompts.some((p) => p.includes(agentOrCwdPart)))!;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-orch-'));
  sessions = []; wfs = []; notified = []; interrupted = []; maxParallel = 3; available = ['claude', 'codex', 'gemini'];
  git = fakeGit();
});
afterEach(async () => { for (const m of made) await m.flush(); made = []; fs.rmSync(dir, { recursive: true, force: true }); });

async function startRun(svc: OrchestraService, nodes: OrchNode[], input = 'IN') {
  const w = await svc.saveWorkflow({ name: 'wf', cwd: '/repo', nodes });
  return svc.start(w.id, input);
}

describe('OrchestraService scheduling', () => {
  it('runs dependencies in order, fills templates, and finishes done', async () => {
    const svc = svcOf();
    const run = await startRun(svc, [task('a'), task('b', ['a'], { prompt: 'use {{nodes.a.output}}' })]);
    await until(() => sessions.length === 1);
    expect(sessions[0].prompts[0]).toContain('do a IN');
    expect(sessions[0].prompts[0]).toContain('[编排 wf · a]');
    sessions[0].reply('A-OUT');
    await until(() => sessions.length === 2);
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
    await until(() => sessions.length === 2);
    session('do a').reply('boom', true);
    await until(() => run.nodes.b.state === 'skipped');
    expect(run.state).toBe('running'); // c still going
    session('do c').reply('ok');
    await until(() => run.state === 'failed');
    expect(run.nodes.a.state).toBe('failed');
    expect(run.error).toContain('a');
  });

  it('a session error fails the node', async () => {
    const svc = svcOf();
    const run = await startRun(svc, [task('a')]);
    await until(() => sessions.length === 1);
    sessions[0].emit('state', 'error', 'spawn ENOENT\nstack');
    await until(() => run.state === 'failed');
    expect(run.nodes.a.error).toBe('spawn ENOENT');
  });

  it('approval blocks until approved; the comment is available downstream', async () => {
    const svc = svcOf();
    const run = await startRun(svc, [task('a'), { id: 'ok', kind: 'approval', title: '审批', dependsOn: ['a'] }, task('b', ['ok'], { prompt: 'note={{nodes.ok.approval}}' })]);
    await until(() => sessions.length === 1);
    sessions[0].reply('A');
    await until(() => run.nodes.ok.state === 'waiting');
    expect(run.state).toBe('waiting');
    expect(notified).toEqual(['approval:ok']);
    await tick();
    expect(sessions.length).toBe(1);
    await svc.approve(run.id, 'ok', 'approve', '可以');
    await until(() => sessions.length === 2);
    expect(sessions[1].prompts[0]).toContain('note=通过：可以');
    sessions[1].reply('B');
    await until(() => run.state === 'done');
  });

  it('rejecting an approval fails the run and skips downstream', async () => {
    const svc = svcOf();
    const run = await startRun(svc, [{ id: 'ok', kind: 'approval', title: '审批', dependsOn: [] }, task('b', ['ok'])]);
    await until(() => run.nodes.ok.state === 'waiting');
    await svc.approve(run.id, 'ok', 'reject', '太冒险');
    expect(run.state).toBe('failed');
    expect(run.nodes.ok.approval?.comment).toBe('太冒险');
    expect(run.nodes.b.state).toBe('skipped');
    await expect(svc.approve(run.id, 'ok', 'approve')).rejects.toThrow();
  });

  it('retry reruns a failed node with a new session and un-skips downstream', async () => {
    const svc = svcOf();
    const run = await startRun(svc, [task('a'), task('b', ['a'])]);
    await until(() => sessions.length === 1);
    sessions[0].reply('bad', true);
    await until(() => run.state === 'failed');
    await svc.retry(run.id, 'a');
    await until(() => sessions.length === 2);
    expect(run.nodes.b.state).toBe('pending');
    // a late event from the old session must not touch the new attempt
    sessions[0].reply('late');
    sessions[1].reply('good');
    await until(() => sessions.length === 3);
    sessions[2].reply('b done');
    await until(() => run.state === 'done');
    expect(run.nodes.a.sessionIds).toEqual(['s1', 's2']);
    expect(run.nodes.a.output).toBe('good');
  });

  it('cancel interrupts running sessions and cancels the rest', async () => {
    const svc = svcOf();
    const run = await startRun(svc, [task('a'), task('b', ['a'])]);
    await until(() => sessions.length === 1);
    await svc.cancel(run.id);
    expect(run.state).toBe('cancelled');
    expect(interrupted).toEqual(['s1']);
    expect(run.nodes.b.state).toBe('cancelled');
    sessions[0].reply('late');
    await tick();
    expect(run.nodes.a.state).toBe('cancelled');
  });

  it('untilDone tasks run through the goal protocol', async () => {
    const svc = svcOf();
    const run = await startRun(svc, [task('a', [], { untilDone: true, agent: 'codex' })]);
    await until(() => goals.goals.size === 1 && sessions.length === 1);
    const g = [...goals.goals.values()][0];
    expect(g.agent).toBe('codex');
    expect(g.objective).toContain('do a IN');
    // intermediate turns don't finish the node
    sessions[0].reply('turn 1\nGOAL_STATUS: continue');
    await tick();
    expect(run.nodes.a.state).toBe('running');
    goals.set(g.id, { status: 'complete', lastResult: 'all good\nGOAL_STATUS: complete', costUsd: 0.5 });
    await until(() => run.state === 'done');
    expect(run.nodes.a.output).toBe('all good');
    expect(run.nodes.a.sessionIds).toEqual(['s1']);
  });

  it('refuses unavailable agents and invalid graphs', async () => {
    available = ['claude'];
    const svc = svcOf();
    await expect(svc.saveWorkflow({ name: 'x', cwd: '/r', nodes: [task('a', ['b']), task('b', ['a'])] })).rejects.toThrow(/环/);
    const w = await svc.saveWorkflow({ name: 'x', cwd: '/r', nodes: [task('a', [], { agent: 'gemini' })] });
    await expect(svc.start(w.id, '')).rejects.toThrow(/gemini/);
  });
});

describe('OrchestraService worktrees and compare', () => {
  const compare = (extra: Record<string, unknown> = {}): OrchNode => ({ id: 'cmp', kind: 'compare', title: '比选', agents: ['claude', 'codex'], prompt: 'build {{input}}', dependsOn: [], ...extra } as OrchNode);

  it('fans out to worktrees, waits, merges the winner and cleans up', async () => {
    const svc = svcOf();
    const run = await startRun(svc, [compare(), task('after', ['cmp'], { prompt: 'got {{nodes.cmp.output}}' })]);
    await until(() => sessions.length === 2);
    expect(git.calls).toContain(`exclude /repo`);
    expect(git.calls).toContain(`add ${run.id}-cmp-claude cw/${run.id}/cmp-claude main`);
    expect(sessions.map((s) => path.basename(s.cwd)).sort()).toEqual([`${run.id}-cmp-claude`, `${run.id}-cmp-codex`]);
    sessions[0].reply('claude way');
    await tick();
    expect(run.nodes.cmp.state).toBe('running');
    sessions[1].reply('codex way');
    await until(() => run.state === 'waiting');
    expect(run.state).toBe('waiting');
    expect(notified).toEqual(['compare:cmp']);
    expect(run.nodes.cmp.candidates?.every((c) => c.diffStat?.includes('main..cw/'))).toBe(true);
    expect(await svc.diff(run.id, 'cmp', 'codex')).toBe(`diff of cw/${run.id}/cmp-codex`);
    await svc.pick(run.id, 'cmp', 'codex');
    expect(run.nodes.cmp.state).toBe('done');
    expect(run.nodes.cmp.winner).toBe('codex');
    expect(git.calls).toContain(`merge cw/${run.id}/cmp-codex`);
    expect(git.calls).toContain(`rm ${run.id}-cmp-claude`);
    expect(git.calls).toContain(`rm ${run.id}-cmp-codex`);
    expect(git.calls).toContain(`del cw/${run.id}/cmp-claude`);
    expect(closed).toEqual(expect.arrayContaining(['s1', 's2']));
    expect(git.calls).not.toContain(`del cw/${run.id}/cmp-codex`);
    await until(() => sessions.length === 3);
    expect(sessions[2].prompts[0]).toContain('got codex way');
  });

  it('a merge conflict fails the node and keeps the worktrees', async () => {
    git.mergeFail = true;
    const svc = svcOf();
    const run = await startRun(svc, [compare()]);
    await until(() => sessions.length === 2);
    sessions[0].reply('a'); sessions[1].reply('b');
    await until(() => run.state === 'waiting');
    await svc.pick(run.id, 'cmp', 'claude');
    expect(run.nodes.cmp.state).toBe('failed');
    expect(run.nodes.cmp.error).toContain('CONFLICT');
    expect(git.calls.some((c) => c.startsWith('rm '))).toBe(false);
    expect(run.state).toBe('failed');
  });

  it('refuses to merge when the base worktree moved to another branch', async () => {
    const svc = svcOf();
    const run = await startRun(svc, [compare()]);
    await until(() => sessions.length === 2);
    sessions[0].reply('a'); sessions[1].reply('b');
    await until(() => run.state === 'waiting');
    git.branch = 'feature';
    await svc.pick(run.id, 'cmp', 'claude');
    expect(run.nodes.cmp.state).toBe('failed');
    expect(run.nodes.cmp.error).toContain('feature');
    expect(git.calls.some((c) => c.startsWith('merge'))).toBe(false);
  });

  it('a judge recommends a winner, the user still confirms', async () => {
    const svc = svcOf();
    const run = await startRun(svc, [compare({ judge: 'gemini' })]);
    await until(() => sessions.length === 2);
    sessions[0].reply('a'); sessions[1].reply('b');
    await until(() => sessions.length === 3);
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
    await until(() => sessions.length === 2);
    sessions[0].reply('x', true); sessions[1].reply('y', true);
    await until(() => run.state === 'failed');
    expect(run.nodes.cmp.error).toContain('所有候选');
    git = fakeGit({ repo: false });
    const svc2 = svcOf();
    await expect(svc2.saveWorkflow({ name: 'n', cwd: '/x', nodes: [compare()] })).rejects.toThrow(/git/);
  });

  it('a worktree task merges back and removes its worktree + branch', async () => {
    const svc = svcOf();
    const run = await startRun(svc, [task('w', [], { workspace: 'worktree', agent: 'codex' })]);
    await until(() => sessions.length === 1);
    expect(path.basename(sessions[0].cwd)).toBe(`${run.id}-w-codex`);
    sessions[0].reply('done');
    await until(() => run.state === 'done');
    expect(git.calls).toEqual(expect.arrayContaining([`commit ${run.id}-w-codex`, `merge cw/${run.id}/w-codex`, `rm ${run.id}-w-codex`, `del cw/${run.id}/w-codex`]));
  });

  it('a detached HEAD refuses worktree runs up front', async () => {
    git.branch = null as any;
    const svc = svcOf();
    const w = await svc.saveWorkflow({ name: 'n', cwd: '/repo', nodes: [compare()] });
    await expect(svc.start(w.id, '')).rejects.toThrow(/分离 HEAD/);
  });
});

describe('OrchestraService persistence', () => {
  it('writes runs to disk; a restart fails in-flight runs and resume continues from the failed node', async () => {
    const svc = svcOf();
    const run = await startRun(svc, [task('a'), task('b', ['a'])]);
    await until(() => sessions.length === 1);
    sessions[0].reply('A-OUT');
    await until(() => sessions.length === 2);
    await svc.flush();
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, `${run.id}.json`), 'utf8')) as OrchRun;
    expect(onDisk.nodes.a.output).toBe('A-OUT');
    expect(onDisk.nodes.b.state).toBe('running');

    const svc2 = svcOf();
    await svc2.init();
    const r2 = svc2.get(run.id);
    expect(r2.state).toBe('failed');
    expect(r2.error).toBe('服务重启中断');
    expect(r2.nodes.b.state).toBe('failed');
    const before = sessions.length;
    await svc2.resume(run.id);
    await until(() => sessions.length === before + 1);
    expect(sessions[sessions.length - 1].prompts[0]).toContain('do b');
    expect(r2.nodes.a.state).toBe('done');
    sessions[sessions.length - 1].reply('B');
    await until(() => r2.state === 'done');
    expect(svc2.list()[0]).toMatchObject({ id: run.id, state: 'done', total: 2, done: 2 });
    await svc2.flush();
    await svc2.remove(run.id);
    expect(fs.existsSync(path.join(dir, `${run.id}.json`))).toBe(false);
  });
});

describe('resolveTemplates', () => {
  it('falls back to Claude for missing task agents and keeps installed compare agents', () => {
    const t = resolveTemplates(['claude', 'gemini']);
    const plan = t.find((x) => x.id === 'plan-impl-review')!;
    expect(plan.nodes.find((n) => n.id === 'impl')).toMatchObject({ agent: 'claude' });
    const cmp = t.find((x) => x.id === 'three-way')!.nodes[0] as any;
    expect(cmp.agents).toEqual(['claude', 'gemini']);
    expect(t).toHaveLength(3);
  });
});
