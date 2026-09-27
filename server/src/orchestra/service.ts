import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentKind, Goal, PermissionMode } from '../protocol.js';
import { agentSlug, downstreamOf, nodeAgents, parseWinner, renderPrompt, validateWorkflow } from './dag.js';
import type { CompareCandidate, NodeRun, OrchCompareNode, OrchNode, OrchRun, OrchRunSummary, OrchTaskNode, OrchWorktree, Workflow, WorkflowTemplate } from './types.js';

export const DEFAULT_MAX_PARALLEL = 3;
const JUDGE_REPLY_LIMIT = 4000;
const JUDGE_DIFF_LIMIT = 12000;
const RESTART_ERROR = '服务重启中断';

/** A live agent session as the orchestrator sees it: an AgentDriver emits exactly these. */
export interface OrchSession extends EventEmitter { readonly sessionId: string }

/** Git operations the engine needs, as a narrow seam (the real one wraps GitService; tests use a fake). */
export interface OrchGit {
  root(cwd: string): Promise<string | null>;
  currentBranch(cwd: string): Promise<string | null>;
  /** keep `/.claude-web/` out of the main worktree's `git status` */
  exclude(root: string): Promise<void>;
  /** add `dir` on a new `branch` from `from`; a leftover worktree / branch with those names is removed first */
  worktreeAdd(root: string, dir: string, branch: string, from: string): Promise<void>;
  /** commit everything in `dir`; false when there was nothing to commit */
  commitAll(dir: string, message: string): Promise<boolean>;
  diffStat(root: string, base: string, branch: string): Promise<{ stat: string; files: number }>;
  diff(root: string, base: string, branch: string): Promise<string>;
  /** `merge --no-ff`; on conflict the merge is aborted and the error returned */
  merge(cwd: string, branch: string, message: string): Promise<{ ok: true } | { ok: false; error: string }>;
  worktreeRemove(root: string, dir: string): Promise<void>;
  deleteBranch(root: string, branch: string): Promise<void>;
}

/** The slice of GoalService an `untilDone` task uses. */
export interface OrchGoals extends EventEmitter {
  create(p: { objective: string; cwd: string; agent?: string; permissionMode?: string; model?: string }): Promise<Goal>;
  start(id: string): Promise<Goal>;
  pause(id: string): Promise<Goal>;
  get(id: string): Goal | undefined;
}

export interface OrchDeps {
  /** `<dataDir>/orchestra` — one `<runId>.json` per run */
  dir: string;
  /** open a brand-new session (the same path as the hub's `session.open`) */
  open(p: { agent: AgentKind; cwd: string; model?: string; permissionMode?: PermissionMode; title: string }): Promise<OrchSession>;
  /** send a prompt once the session is ready (expands `<session-ref>`, mirrors into canonical) */
  send(s: OrchSession, text: string): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  /** stop a finished session's process (Windows can't delete a worktree some process still has as its cwd) */
  close(sessionId: string): Promise<void>;
  git: OrchGit;
  goals?: OrchGoals;
  workflows: { list(): Workflow[]; set(w: Workflow): Promise<void>; remove(id: string): Promise<void> };
  /** installed + enabled agents */
  available(): Promise<AgentKind[]>;
  maxParallel(): number;
  /** a node started waiting for a human (approval / compare pick) */
  notify?(run: OrchRun, nodeId: string, what: 'approval' | 'compare'): void;
}

interface Finish { ok: boolean; output?: string; error?: string; costUsd?: number }

const TERMINAL = new Set(['done', 'failed', 'skipped', 'cancelled']);
const BAD = new Set(['failed', 'skipped', 'cancelled']);

const PLAN_TEMPLATE: WorkflowTemplate = {
  id: 'plan-impl-review', name: '计划 → 实现 → 审查', description: 'Claude 规划、人工审批、Codex 实现、Claude 审查',
  nodes: [
    { id: 'plan', kind: 'task', title: '规划', agent: 'claude', workspace: 'shared', permissionMode: 'plan', dependsOn: [], prompt: '为下面的需求写一份实现计划：要改哪些文件、每一步做什么、怎么验证。只写计划，不要改代码。\n\n需求：{{input}}' },
    { id: 'approve', kind: 'approval', title: '审批计划', note: '看一眼计划；驳回时写下意见，整个编排会停下', dependsOn: ['plan'] },
    { id: 'impl', kind: 'task', title: '实现', agent: 'codex', workspace: 'shared', permissionMode: 'acceptEdits', dependsOn: ['approve'], prompt: '按下面的计划实现，完成后跑相关测试并汇报结果。\n\n需求：{{input}}\n\n计划：\n{{nodes.plan.output}}\n\n审批意见：{{nodes.approve.approval}}' },
    { id: 'review', kind: 'task', title: '审查', agent: 'claude', workspace: 'shared', permissionMode: 'default', dependsOn: ['impl'], prompt: '审查工作区里刚完成的改动（git diff）：正确性、边界、测试覆盖、和计划是否一致。列出问题，按严重程度排序。\n\n需求：{{input}}\n\n实现者的汇报：\n{{nodes.impl.output}}' },
  ],
};
const COMPARE_TEMPLATE: WorkflowTemplate = {
  id: 'three-way', name: '三方比选', description: '同一个任务交给多个 agent 各自在 worktree 里做，比较后选一个合并',
  nodes: [{ id: 'compare', kind: 'compare', title: '比选实现', agents: ['claude', 'codex', 'gemini'], dependsOn: [], permissionMode: 'acceptEdits', prompt: '{{input}}\n\n完成后简要说明你的做法和改动。' }],
};
const BUGFIX_TEMPLATE: WorkflowTemplate = {
  id: 'bugfix', name: '修 bug + 测试', description: '先写复现测试，再一直修到测试通过，最后回归',
  nodes: [
    { id: 'repro', kind: 'task', title: '复现', agent: 'claude', workspace: 'shared', permissionMode: 'acceptEdits', dependsOn: [], prompt: '先写一个能复现下面这个 bug 的失败测试（不要修 bug），跑一下确认它确实失败，汇报测试文件和失败信息。\n\nbug：{{input}}' },
    { id: 'fix', kind: 'task', title: '修复', agent: 'claude', workspace: 'shared', permissionMode: 'acceptEdits', untilDone: true, dependsOn: ['repro'], prompt: '修复这个 bug，让复现测试通过，且不破坏其它测试。\n\nbug：{{input}}\n\n复现情况：\n{{nodes.repro.output}}' },
    { id: 'verify', kind: 'task', title: '回归', agent: 'claude', workspace: 'shared', permissionMode: 'acceptEdits', dependsOn: ['fix'], prompt: '跑完整测试套件，确认 bug 已修复、没有回归。汇报通过 / 失败的数字和改动摘要。' },
  ],
};
export const ORCH_TEMPLATES: WorkflowTemplate[] = [PLAN_TEMPLATE, COMPARE_TEMPLATE, BUGFIX_TEMPLATE];

/** Templates with their agents resolved against what's installed: tasks fall back to Claude, compare keeps the installed ones. */
export function resolveTemplates(available: AgentKind[]): WorkflowTemplate[] {
  const has = (a: AgentKind) => available.includes(a);
  return ORCH_TEMPLATES.map((t) => ({
    ...t,
    nodes: t.nodes.map((n): OrchNode => {
      if (n.kind === 'task') return { ...n, agent: has(n.agent) ? n.agent : 'claude' };
      if (n.kind === 'compare') {
        const agents = n.agents.filter(has);
        return { ...n, agents: agents.length >= 2 ? agents : [...new Set([...agents, ...available])].slice(0, Math.max(2, agents.length)) };
      }
      return { ...n };
    }),
  }));
}

function newNodeRun(prev?: NodeRun): NodeRun {
  // keep the session history of earlier attempts: the user can still open what went wrong
  return { state: 'pending', sessionIds: prev ? [...prev.sessionIds] : [], attempts: prev?.attempts ?? 0 };
}

const stripStatus = (t: string) => t.replace(/\n?\s*GOAL_STATUS:.*$/i, '').trim();

/**
 * Multi-agent orchestration engine. A run is a DAG of nodes; every task node is an ordinary session
 * (opened through the same path as the UI), so it shows up in the sidebar, Mission Control, permission
 * prompts and the ledger. State lives in memory and is written to `<dir>/<runId>.json` on every change.
 * Emits `changed(run)` and `workflows` (templates list changed).
 */
export class OrchestraService extends EventEmitter {
  private runs = new Map<string, OrchRun>();
  private writes = new Map<string, Promise<void>>();
  private mergeChain: Promise<unknown> = Promise.resolve();
  private goalWatch = new Map<string, (g: Goal) => void>();

  constructor(private d: OrchDeps) {
    super();
    d.goals?.on('changed', () => {
      for (const [id, cb] of [...this.goalWatch]) { const g = d.goals!.get(id); if (g) cb(g); }
    });
  }

  /** Load runs from disk; anything that was running when the server stopped is failed (resumable). */
  async init() {
    await fs.mkdir(this.d.dir, { recursive: true });
    const files = (await fs.readdir(this.d.dir).catch(() => [] as string[])).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      try {
        const run = JSON.parse(await fs.readFile(path.join(this.d.dir, f), 'utf8')) as OrchRun;
        if (!run?.id || !run.nodes) continue;
        if (run.state === 'running' || run.state === 'waiting') {
          for (const nr of Object.values(run.nodes)) {
            if (nr.state === 'running' || nr.state === 'waiting') { nr.state = 'failed'; nr.error = RESTART_ERROR; nr.finishedAt = Date.now(); }
            for (const c of nr.candidates ?? []) if (c.state === 'running') { c.state = 'failed'; c.error = RESTART_ERROR; }
            if (nr.judge?.state === 'running') { nr.judge.state = 'failed'; nr.judge.error = RESTART_ERROR; }
          }
          run.state = 'failed';
          run.error = RESTART_ERROR;
          run.finishedAt = Date.now();
          this.runs.set(run.id, run);
          void this.write(run);
        } else this.runs.set(run.id, run);
      } catch { /* a torn / foreign file: skip it */ }
    }
  }

  // ---- workflows ----
  templates = async () => resolveTemplates(await this.d.available());
  workflows() { return [...this.d.workflows.list()].sort((a, b) => b.updatedAt - a.updatedAt); }

  async saveWorkflow(w: Omit<Workflow, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Promise<Workflow> {
    if (!w.name?.trim()) throw new Error('工作流需要一个名字');
    if (!w.cwd?.trim()) throw new Error('工作流需要一个工作目录');
    const nodes = (w.nodes ?? []).map((n) => ({ ...n, dependsOn: [...new Set(n.dependsOn ?? [])] })) as OrchNode[];
    const errs = validateWorkflow({ nodes }, { isGitRepo: !!(await this.d.git.root(w.cwd)) });
    if (errs.length) throw new Error(errs.join('\n'));
    const prev = w.id ? this.d.workflows.list().find((x) => x.id === w.id) : undefined;
    const now = Date.now();
    const out: Workflow = { id: prev?.id ?? randomBytes(5).toString('hex'), name: w.name.trim(), description: w.description, cwd: w.cwd, nodes, createdAt: prev?.createdAt ?? now, updatedAt: now };
    await this.d.workflows.set(out);
    this.emit('workflows');
    return out;
  }

  async removeWorkflow(id: string) { await this.d.workflows.remove(id); this.emit('workflows'); }

  // ---- runs ----
  list(): OrchRunSummary[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt).map((r) => {
      const nodes = Object.values(r.nodes);
      return { id: r.id, workflowId: r.workflowId, name: r.name, cwd: r.cwd, state: r.state, startedAt: r.startedAt, finishedAt: r.finishedAt, total: nodes.length, done: nodes.filter((n) => n.state === 'done').length, waiting: nodes.filter((n) => n.state === 'waiting').length };
    });
  }

  get(id: string): OrchRun {
    const r = this.runs.get(id);
    if (!r) throw new Error('运行记录不存在');
    return r;
  }

  async start(workflowId: string, input: string): Promise<OrchRun> {
    const w = this.d.workflows.list().find((x) => x.id === workflowId);
    if (!w) throw new Error('工作流不存在');
    const root = await this.d.git.root(w.cwd);
    const errs = validateWorkflow(w, { isGitRepo: !!root, available: await this.d.available() });
    if (errs.length) throw new Error(errs.join('\n'));
    const needsWorktree = w.nodes.some((n) => n.kind === 'compare' || (n.kind === 'task' && n.workspace === 'worktree'));
    const baseBranch = root ? (await this.d.git.currentBranch(w.cwd)) ?? undefined : undefined;
    if (needsWorktree && !baseBranch) throw new Error('工作目录处于分离 HEAD：worktree / 比选需要一个分支来合并结果，先切到一个分支');
    if (needsWorktree && root) await this.d.git.exclude(root).catch(() => { /* cosmetic */ });
    const run: OrchRun = {
      id: randomBytes(4).toString('hex'), workflowId: w.id, name: w.name, cwd: w.cwd, input: input ?? '', baseBranch,
      startedAt: Date.now(), state: 'running', workflow: structuredClone(w.nodes),
      nodes: Object.fromEntries(w.nodes.map((n) => [n.id, newNodeRun()])),
    };
    this.runs.set(run.id, run);
    this.tick(run);
    return run;
  }

  async cancel(runId: string): Promise<OrchRun> {
    const run = this.get(runId);
    if (TERMINAL.has(run.state)) return run;
    run.state = 'cancelled';
    run.finishedAt = Date.now();
    for (const [id, nr] of Object.entries(run.nodes)) {
      if (nr.state === 'running') {
        const live = [...(nr.candidates ?? []).filter((c) => c.state === 'running').map((c) => c.sessionId), nr.judge?.state === 'running' ? nr.judge.sessionId : undefined, nr.sessionIds[nr.sessionIds.length - 1]];
        for (const sid of new Set(live)) if (sid) void this.d.interrupt(sid).catch(() => {});
        if (nr.goalId) { this.goalWatch.delete(nr.goalId); void this.d.goals?.pause(nr.goalId).catch(() => {}); }
      }
      if (!TERMINAL.has(nr.state)) { run.nodes[id] = { ...nr, state: 'cancelled', finishedAt: Date.now() }; }
    }
    this.save(run);
    return run;
  }

  /** Continue a failed / cancelled run: every node that isn't done goes back to pending (done outputs are kept). */
  async resume(runId: string): Promise<OrchRun> {
    const run = this.get(runId);
    if (run.state !== 'failed' && run.state !== 'cancelled') throw new Error('只有失败或已取消的运行可以续跑');
    for (const n of run.workflow) if (run.nodes[n.id].state !== 'done') { await this.release(run.nodes[n.id]); run.nodes[n.id] = newNodeRun(run.nodes[n.id]); }
    run.state = 'running';
    run.error = undefined;
    run.finishedAt = undefined;
    this.tick(run);
    return run;
  }

  async retry(runId: string, nodeId: string): Promise<OrchRun> {
    const run = this.get(runId);
    const nr = run.nodes[nodeId];
    if (!nr) throw new Error('节点不存在');
    if (nr.state === 'running' || nr.state === 'pending') throw new Error('节点还没结束');
    if (nr.state === 'waiting' && this.nodeOf(run, nodeId).kind === 'approval') throw new Error('审批节点直接通过 / 驳回即可');
    await this.release(nr);
    run.nodes[nodeId] = newNodeRun(nr);
    // downstream nodes that never got to run (skipped / cancelled / failed) get another chance too
    for (const id of downstreamOf(run.workflow, nodeId)) if (run.nodes[id].state !== 'done') { await this.release(run.nodes[id]); run.nodes[id] = newNodeRun(run.nodes[id]); }
    if (run.state !== 'running' && run.state !== 'waiting') { run.state = 'running'; run.error = undefined; run.finishedAt = undefined; }
    this.tick(run);
    return run;
  }

  async approve(runId: string, nodeId: string, decision: 'approve' | 'reject', comment?: string): Promise<OrchRun> {
    const run = this.get(runId);
    const node = this.nodeOf(run, nodeId);
    const nr = run.nodes[nodeId];
    if (node.kind !== 'approval' || nr.state !== 'waiting') throw new Error('这个节点不在等待审批');
    nr.approval = { decision, comment: comment?.trim() || undefined, at: Date.now() };
    nr.finishedAt = Date.now();
    if (decision === 'approve') { nr.state = 'done'; nr.output = nr.approval.comment ?? ''; }
    else { nr.state = 'failed'; nr.error = `被驳回${nr.approval.comment ? `：${nr.approval.comment}` : ''}`; }
    this.tick(run);
    return run;
  }

  /** Compare: merge the winner's branch into the base branch, drop the other worktrees + branches. */
  async pick(runId: string, nodeId: string, winner: AgentKind): Promise<OrchRun> {
    const run = this.get(runId);
    const node = this.nodeOf(run, nodeId);
    const nr = run.nodes[nodeId];
    if (node.kind !== 'compare' || nr.state !== 'waiting') throw new Error('这个节点不在等待选择');
    const cand = nr.candidates?.find((c) => c.agent === winner);
    if (!cand || cand.state !== 'done' || !cand.worktree) throw new Error('只能选一个成功完成的候选');
    nr.state = 'running'; // merging; blocks a double pick
    this.save(run);
    const res = await this.mergeBack(run, cand.worktree, `orchestra(${run.name}): ${node.title} ← ${winner}`);
    if (run.nodes[nodeId] !== nr) return run;
    nr.winner = winner;
    nr.finishedAt = Date.now();
    if (!res.ok) {
      nr.state = 'failed';
      nr.error = `合并 ${cand.worktree.branch} 失败（worktree 已保留，可手动处理后重试）：${res.error}`;
    } else {
      nr.state = 'done';
      nr.output = cand.output ?? '';
      const root = (await this.d.git.root(run.cwd)) ?? run.cwd;
      for (const c of nr.candidates ?? []) {
        if (!c.worktree) continue;
        if (c.sessionId) await this.d.close(c.sessionId).catch(() => {});
        await this.d.git.worktreeRemove(root, c.worktree.path).catch(() => {});
        if (c.agent !== winner) await this.d.git.deleteBranch(root, c.worktree.branch).catch(() => {});
      }
    }
    this.tick(run);
    return run;
  }

  async diff(runId: string, nodeId: string, agent: AgentKind): Promise<string> {
    const run = this.get(runId);
    const nr = run.nodes[nodeId];
    const wt = nr?.candidates?.find((c) => c.agent === agent)?.worktree ?? nr?.worktrees?.find((w) => w.agent === agent);
    if (!wt || !run.baseBranch) throw new Error('没有这个候选的 worktree');
    const root = (await this.d.git.root(run.cwd)) ?? run.cwd;
    return this.d.git.diff(root, run.baseBranch, wt.branch);
  }

  async remove(runId: string) {
    const run = this.get(runId);
    if (run.state === 'running' || run.state === 'waiting') throw new Error('运行中的编排先取消再删除');
    this.runs.delete(runId);
    await this.writes.get(runId);
    await fs.rm(path.join(this.d.dir, `${runId}.json`), { force: true });
  }

  /**
   * Before a node is reset: stop the sessions that live in its worktrees — the next attempt recreates the
   * same paths, and Windows can't remove a directory a live process still uses as its cwd.
   */
  private async release(nr: NodeRun) {
    const sids = nr.candidates ? nr.candidates.map((c) => c.sessionId) : nr.worktrees?.length ? nr.sessionIds.slice(-1) : [];
    for (const sid of sids) if (sid) await this.d.close(sid).catch(() => {});
  }

  // ---- scheduling ----
  private nodeOf(run: OrchRun, id: string): OrchNode {
    const n = run.workflow.find((x) => x.id === id);
    if (!n) throw new Error('节点不存在');
    return n;
  }

  private alive(run: OrchRun) { return this.runs.get(run.id) === run && (run.state === 'running' || run.state === 'waiting'); }

  /** Advance a run: skip what can't run, start what's ready (≤ maxParallel), then derive the run state. */
  private tick(run: OrchRun) {
    if (!this.alive(run)) { this.save(run); return; }
    // skips cascade: loop until nothing changes
    for (let changed = true; changed;) {
      changed = false;
      for (const n of run.workflow) {
        const nr = run.nodes[n.id];
        if (nr.state !== 'pending') continue;
        const bad = n.dependsOn.find((d) => BAD.has(run.nodes[d]?.state));
        if (bad) { run.nodes[n.id] = { ...nr, state: 'skipped', error: `上游「${this.nodeOf(run, bad).title || bad}」没有完成`, finishedAt: Date.now() }; changed = true; }
      }
    }
    const limit = Math.max(1, this.d.maxParallel() || DEFAULT_MAX_PARALLEL);
    let running = Object.values(run.nodes).filter((x) => x.state === 'running').length;
    for (const n of run.workflow) {
      const nr = run.nodes[n.id];
      if (nr.state !== 'pending' || !n.dependsOn.every((d) => run.nodes[d]?.state === 'done')) continue;
      if (n.kind === 'approval') {
        nr.state = 'waiting';
        nr.startedAt = Date.now();
        this.d.notify?.(run, n.id, 'approval');
        continue;
      }
      if (running >= limit) continue;
      running++;
      nr.state = 'running';
      nr.startedAt = Date.now();
      nr.attempts = (nr.attempts ?? 0) + 1;
      if (n.kind === 'task') void this.startTask(run, n, nr);
      else void this.startCompare(run, n, nr);
    }
    const states = Object.values(run.nodes).map((x) => x.state);
    if (states.includes('running')) run.state = 'running';
    else if (states.includes('waiting')) run.state = 'waiting';
    else if (states.every((s) => TERMINAL.has(s))) {
      const failed = run.workflow.find((n) => run.nodes[n.id].state === 'failed');
      const bad = states.some((s) => BAD.has(s));
      run.state = bad ? 'failed' : 'done';
      if (bad) run.error = failed ? `「${failed.title || failed.id}」${run.nodes[failed.id].error ? `：${run.nodes[failed.id].error}` : '失败'}` : '有节点没有完成';
      run.finishedAt = Date.now();
    }
    this.save(run);
  }

  private ctx(run: OrchRun) { return { input: run.input, nodes: run.nodes }; }
  private header(run: OrchRun, n: OrchNode) { return `[编排 ${run.name} · ${n.title || n.id}]\n\n`; }

  private async startTask(run: OrchRun, n: OrchTaskNode, nr: NodeRun) {
    const current = () => this.alive(run) && run.nodes[n.id] === nr && nr.state === 'running';
    try {
      let cwd = run.cwd;
      let wt: OrchWorktree | undefined;
      if (n.workspace === 'worktree') {
        wt = await this.makeWorktree(run, n.id, n.agent);
        nr.worktrees = [wt];
        cwd = wt.path;
      }
      if (!current()) return;
      const prompt = this.header(run, n) + renderPrompt(n.prompt, this.ctx(run));
      const finish = (f: Finish) => void this.finishTask(run, n, nr, f, wt);
      if (n.untilDone && this.d.goals) {
        const goals = this.d.goals;
        const g = await goals.create({ objective: prompt, cwd, agent: n.agent === 'claude' ? undefined : n.agent, permissionMode: n.permissionMode ?? 'acceptEdits', model: n.model });
        nr.goalId = g.id;
        this.goalWatch.set(g.id, (cur) => {
          if (cur.sessionId && !nr.sessionIds.includes(cur.sessionId)) { nr.sessionIds.push(cur.sessionId); this.save(run); }
          if (cur.status === 'complete') { this.goalWatch.delete(g.id); finish({ ok: true, output: stripStatus(cur.lastResult ?? ''), costUsd: cur.costUsd }); }
          else if (cur.status === 'blocked' || cur.status === 'max_turns') { this.goalWatch.delete(g.id); finish({ ok: false, output: stripStatus(cur.lastResult ?? ''), costUsd: cur.costUsd, error: cur.status === 'blocked' ? `目标卡住：${cur.evidence.filter((e) => e.kind === 'blocked' || e.kind === 'error').pop()?.summary ?? '需要人工介入'}` : '目标达到轮数 / token 上限' }); }
        });
        const started = await goals.start(g.id);
        if (started.sessionId && !nr.sessionIds.includes(started.sessionId)) nr.sessionIds.push(started.sessionId);
        this.save(run);
        return;
      }
      const s = await this.d.open({ agent: n.agent, cwd, model: n.model, permissionMode: n.permissionMode, title: `${run.name} · ${n.title}` });
      nr.sessionIds.push(s.sessionId);
      this.save(run);
      this.watchSession(s, finish);
      await this.d.send(s, prompt);
    } catch (e: any) {
      if (current()) void this.finishTask(run, n, nr, { ok: false, error: e?.message ?? String(e) }, nr.worktrees?.[0]);
    }
  }

  private async finishTask(run: OrchRun, n: OrchTaskNode, nr: NodeRun, f: Finish, wt?: OrchWorktree) {
    if (!this.alive(run) || run.nodes[n.id] !== nr || nr.state !== 'running') return;
    nr.output = f.output;
    nr.costUsd = (nr.costUsd ?? 0) + (f.costUsd ?? 0);
    if (f.ok && wt) {
      // a worktree task's changes flow back into the base branch so downstream nodes see them
      const committed = await this.d.git.commitAll(wt.path, `orchestra(${run.name}): ${n.title} by ${n.agent}`).catch((e: any) => { f = { ...f, ok: false, error: `提交 worktree 失败：${e?.message ?? e}` }; return false; });
      void committed;
      if (f.ok) {
        const res = await this.mergeBack(run, wt, `orchestra(${run.name}): ${n.title}`);
        if (!res.ok) f = { ...f, ok: false, error: `合并 ${wt.branch} 失败（worktree 已保留）：${res.error}` };
        else {
          const root = (await this.d.git.root(run.cwd)) ?? run.cwd;
          const sid = nr.sessionIds[nr.sessionIds.length - 1];
          if (sid) await this.d.close(sid).catch(() => {});
          await this.d.git.worktreeRemove(root, wt.path).catch(() => {});
          await this.d.git.deleteBranch(root, wt.branch).catch(() => {});
        }
      }
    }
    if (run.nodes[n.id] !== nr || nr.state !== 'running') return;
    nr.state = f.ok ? 'done' : 'failed';
    if (!f.ok) nr.error = f.error ?? '失败';
    nr.finishedAt = Date.now();
    this.tick(run);
  }

  private async startCompare(run: OrchRun, n: OrchCompareNode, nr: NodeRun) {
    const prompt = this.header(run, n) + renderPrompt(n.prompt, this.ctx(run));
    nr.candidates = n.agents.map((agent): CompareCandidate => ({ agent, state: 'running' }));
    nr.worktrees = [];
    this.save(run);
    await Promise.all(nr.candidates.map(async (c) => {
      const done = (f: Finish) => {
        if (c.state !== 'running') return;
        c.state = f.ok ? 'done' : 'failed';
        c.output = f.output;
        c.error = f.ok ? undefined : f.error ?? '失败';
        c.costUsd = f.costUsd;
        void this.candidateDone(run, n, nr);
      };
      try {
        c.worktree = await this.makeWorktree(run, n.id, c.agent);
        nr.worktrees!.push(c.worktree);
        if (!this.alive(run) || run.nodes[n.id] !== nr) return;
        const s = await this.d.open({ agent: c.agent, cwd: c.worktree.path, permissionMode: n.permissionMode ?? 'acceptEdits', title: `${run.name} · ${n.title} · ${c.agent}` });
        c.sessionId = s.sessionId;
        nr.sessionIds.push(s.sessionId);
        this.save(run);
        this.watchSession(s, done);
        await this.d.send(s, prompt);
      } catch (e: any) {
        done({ ok: false, error: e?.message ?? String(e) });
      }
    }));
  }

  private async candidateDone(run: OrchRun, n: OrchCompareNode, nr: NodeRun) {
    this.save(run);
    const cands = nr.candidates ?? [];
    if (cands.some((c) => c.state === 'running') || nr.state !== 'running' || run.nodes[n.id] !== nr || !this.alive(run)) return;
    nr.state = 'waiting'; // claim the transition before the awaits below (every candidate calls in here)
    const root = (await this.d.git.root(run.cwd)) ?? run.cwd;
    for (const c of cands) {
      if (c.state !== 'done' || !c.worktree) continue;
      try {
        await this.d.git.commitAll(c.worktree.path, `orchestra(${run.name}): ${n.title} by ${c.agent}`);
        const st = await this.d.git.diffStat(root, run.baseBranch!, c.worktree.branch);
        c.diffStat = st.stat;
        c.files = st.files;
      } catch (e: any) {
        c.state = 'failed';
        c.error = `提交 / 对比 worktree 失败：${e?.message ?? e}`;
      }
    }
    nr.costUsd = cands.reduce((a, c) => a + (c.costUsd ?? 0), 0);
    if (run.nodes[n.id] !== nr || !this.alive(run)) return;
    if (!cands.some((c) => c.state === 'done')) {
      nr.state = 'failed';
      nr.error = '所有候选都失败了';
      nr.finishedAt = Date.now();
      this.tick(run);
      return;
    }
    this.d.notify?.(run, n.id, 'compare');
    this.tick(run);
    if (n.judge) void this.startJudge(run, n, nr, root);
  }

  private async startJudge(run: OrchRun, n: OrchCompareNode, nr: NodeRun, root: string) {
    const judge = n.judge!;
    const cands = (nr.candidates ?? []).filter((c) => c.state === 'done');
    nr.judge = { agent: judge, state: 'running' };
    this.save(run);
    const parts: string[] = [];
    for (const c of cands) {
      const diff = await this.d.git.diff(root, run.baseBranch!, c.worktree!.branch).catch(() => '');
      parts.push(`## 候选 ${c.agent}\n\n### 回复\n${(c.output ?? '').slice(0, JUDGE_REPLY_LIMIT)}\n\n### diff --stat\n${c.diffStat ?? ''}\n\n### diff\n\`\`\`diff\n${diff.slice(0, JUDGE_DIFF_LIMIT)}${diff.length > JUDGE_DIFF_LIMIT ? '\n…（已截断）' : ''}\n\`\`\``);
    }
    const prompt = `${this.header(run, n)}你是裁判。下面是 ${cands.length} 个 agent 对同一个任务的实现（各自在独立的 worktree 里做的）。比较正确性、完整度、改动范围和代码质量，给出推荐理由。不要修改任何文件。\n最后一行只写：WINNER: <agent>（从 ${cands.map((c) => c.agent).join(' / ')} 里选一个）\n\n# 任务\n${renderPrompt(n.prompt, this.ctx(run))}\n\n${parts.join('\n\n')}`;
    const settle = (f: Finish) => {
      if (!nr.judge || nr.judge.state !== 'running') return;
      nr.judge.state = f.ok ? 'done' : 'failed';
      nr.judge.output = f.output;
      nr.judge.error = f.ok ? undefined : f.error;
      nr.judge.recommended = f.output ? parseWinner(f.output, cands.map((c) => c.agent)) : undefined;
      nr.costUsd = (nr.costUsd ?? 0) + (f.costUsd ?? 0);
      this.save(run);
    };
    try {
      const s = await this.d.open({ agent: judge, cwd: run.cwd, permissionMode: 'default', title: `${run.name} · ${n.title} · 裁判` });
      nr.judge.sessionId = s.sessionId;
      nr.sessionIds.push(s.sessionId);
      this.save(run);
      this.watchSession(s, settle);
      await this.d.send(s, prompt);
    } catch (e: any) {
      settle({ ok: false, error: e?.message ?? String(e) });
    }
  }

  /** First `result` ends the task; `is_error`, a session error or the session closing fail it. */
  private watchSession(s: OrchSession, cb: (f: Finish) => void) {
    let lastText = '';
    let settled = false;
    const off = () => { s.off('message', onMsg); s.off('state', onState); };
    const end = (f: Finish) => { if (settled) return; settled = true; off(); cb(f); };
    const onMsg = (m: any) => {
      if (m?.type === 'assistant') {
        const t = (m.message?.content ?? []).filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('');
        if (t.trim()) lastText = t;
      } else if (m?.type === 'result') {
        const out = typeof m.result === 'string' && m.result.trim() ? m.result : lastText;
        end(m.is_error ? { ok: false, output: out, error: out?.slice(0, 300) || m.subtype || '会话报错', costUsd: m.total_cost_usd } : { ok: true, output: out, costUsd: m.total_cost_usd });
      }
    };
    const onState = (st: string, err?: string) => {
      if (st === 'error') end({ ok: false, output: lastText, error: (err ?? '会话出错').split('\n')[0] });
      else if (st === 'closed') end({ ok: false, output: lastText, error: '会话已关闭' });
    };
    s.on('message', onMsg);
    s.on('state', onState);
  }

  private async makeWorktree(run: OrchRun, nodeId: string, agent: AgentKind): Promise<OrchWorktree> {
    const root = await this.d.git.root(run.cwd);
    if (!root || !run.baseBranch) throw new Error('工作目录不是 git 仓库（或处于分离 HEAD），不能用 worktree');
    const slug = agentSlug(agent);
    const dir = path.join(root, '.claude-web', 'worktrees', `${run.id}-${nodeId}-${slug}`);
    const branch = `cw/${run.id}/${nodeId}-${slug}`;
    await this.d.git.worktreeAdd(root, dir, branch, run.baseBranch);
    return { agent, path: dir, branch };
  }

  /** Merges are serialized: parallel nodes finishing together must not race on the same working tree. */
  private mergeBack(run: OrchRun, wt: OrchWorktree, message: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const job = this.mergeChain.then(async () => {
      const cur = await this.d.git.currentBranch(run.cwd);
      if (cur !== run.baseBranch) return { ok: false as const, error: `工作目录当前在 ${cur ?? '分离 HEAD'}，不是编排开始时的 ${run.baseBranch}；切回去后重试` };
      return this.d.git.merge(run.cwd, wt.branch, message);
    });
    this.mergeChain = job.catch(() => {});
    return job.catch((e: any) => ({ ok: false as const, error: e?.message ?? String(e) }));
  }

  /** Broadcast + write `<runId>.json` (writes of one run are chained; last state wins). */
  private save(run: OrchRun) {
    if (this.runs.get(run.id) !== run) return;
    this.emit('changed', run);
    void this.write(run);
  }

  private write(run: OrchRun): Promise<void> {
    const prev = this.writes.get(run.id) ?? Promise.resolve();
    const next = prev.then(async () => {
      if (this.runs.get(run.id) !== run) return;
      const file = path.join(this.d.dir, `${run.id}.json`);
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.mkdir(this.d.dir, { recursive: true });
      await fs.writeFile(tmp, JSON.stringify(run, null, 1));
      await fs.rename(tmp, file);
    }).catch((e) => console.error('orchestra: write failed', e));
    this.writes.set(run.id, next);
    return next;
  }

  /** For tests / shutdown: wait until every queued write is on disk. */
  async flush() { await Promise.all(this.writes.values()); }

  /** Which agents the node set needs (for the UI's availability hint). */
  static agentsOf(nodes: OrchNode[]) { return [...new Set(nodes.flatMap(nodeAgents))]; }
}
