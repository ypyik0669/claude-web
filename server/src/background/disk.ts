// 后台: what is on disk about a conversation's workflows — the runs that finished (`<dir>/workflows/<runId>.json`,
// written by the CLI when a workflow ends) and every sub-agent's transcript (`<dir>/subagents/agent-<id>.jsonl`, a
// workflow's under `<dir>/subagents/workflows/<runId>/`). `<dir>` is the conversation's folder next to its
// transcript: `~/.claude/projects/<project>/<sessionId>/`.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { findClaudeTranscript } from '../runtime/transcript-file.js';
import { createBgState, mergeWorkflowProgress } from './registry.js';
import type { BgRunSummary, BgStatus, BgTask } from './types.js';
import { tr } from '../i18n/index.js';

/** The official binary names a run `wf_xxxxxxxx-xxx`; our engine uses its task id, `w` + 8 characters. */
const RUN_ID = /^w[\w-]{1,80}$/;
const AGENT_ID = /^[\w-]{6,80}$/;
const MAX_RUNS = 50;

/** The conversation's own folder (it exists once the CLI wrote anything beside the transcript), or null. */
export function sessionDirOf(sessionId: string): string | null {
  if (!/^[\w-]{8,80}$/.test(sessionId)) return null;
  const f = findClaudeTranscript(sessionId);
  return f ? f.replace(/\.jsonl$/, '') : null;
}

const readJson = async (f: string): Promise<any> => JSON.parse(await fs.readFile(f, 'utf8'));
const statusOf = (s: unknown): BgStatus => (s === 'completed' ? 'completed' : s === 'running' ? 'running' : s === 'failed' ? 'failed' : 'stopped');

/** The finished runs of a conversation, newest first. A file that does not parse is left out. */
export async function listRuns(dir: string): Promise<BgRunSummary[]> {
  const wf = path.join(dir, 'workflows');
  const names = (await fs.readdir(wf).catch(() => [] as string[])).filter((n) => n.endsWith('.json') && RUN_ID.test(n.slice(0, -5)));
  const out: BgRunSummary[] = [];
  for (const n of names) {
    try {
      const j = await readJson(path.join(wf, n));
      const startedAt = typeof j.startTime === 'number' ? j.startTime : Date.parse(j.timestamp ?? '') || 0;
      out.push({
        runId: n.slice(0, -5),
        name: String(j.workflowName ?? j.summary ?? n.slice(0, -5)),
        status: statusOf(j.status),
        startedAt,
        ...(typeof j.durationMs === 'number' ? { durationMs: j.durationMs } : {}),
        agentCount: typeof j.agentCount === 'number' ? j.agentCount : (j.workflowProgress ?? []).filter((e: any) => e?.type === 'workflow_agent').length,
        ...(typeof j.totalTokens === 'number' ? { tokens: j.totalTokens } : {}),
        ...(typeof j.taskId === 'string' ? { taskId: j.taskId } : {}),
      });
    } catch { /* half-written or not ours */ }
  }
  out.sort((a, b) => b.startedAt - a.startedAt);
  return out.slice(0, MAX_RUNS);
}

/** A saved run as a task, the same shape a running one has (its agents, phases, the outcome). */
export function taskFromRun(j: any, runId: string): BgTask {
  const s = createBgState('run');
  const startedAt = typeof j.startTime === 'number' ? j.startTime : Date.parse(j.timestamp ?? '') || 0;
  const reason = runError(j.error, j.status);
  const t: BgTask = {
    id: typeof j.taskId === 'string' ? j.taskId : runId,
    kind: 'workflow',
    type: 'local_workflow',
    description: String(j.summary ?? j.workflowName ?? runId),
    ...(typeof j.workflowName === 'string' ? { name: j.workflowName } : {}),
    status: statusOf(j.status),
    startedAt,
    ...(typeof j.durationMs === 'number' ? { endedAt: startedAt + j.durationMs } : {}),
    ...(typeof j.totalTokens === 'number' ? { tokens: j.totalTokens } : {}),
    ...(typeof j.totalToolCalls === 'number' ? { toolUses: j.totalToolCalls } : {}),
    ...(reason ? { reason } : {}),
    agents: [],
    runId,
  };
  if (Array.isArray(j.phases)) t.phases = j.phases.map((p: any, i: number) => ({ index: i + 1, title: String(p?.title ?? tr('阶段 {i}', { i: i + 1 })) }));
  mergeWorkflowProgress(s, t, Array.isArray(j.workflowProgress) ? j.workflowProgress : [], t.endedAt ?? startedAt, true);
  // a run that ended with agents still marked running / queued: they ended with it (a killed run's are stopped)
  for (const a of t.agents) if (a.state === 'running' || a.state === 'queued') a.state = t.status === 'completed' ? 'done' : t.status === 'stopped' ? 'stopped' : 'failed';
  return t;
}

/** A run file's `error` is the thrown error's stack (2026-10-13, official 2.1.283: a stopped workflow's is
 *  「Error: Workflow aborted」 and the Bun stack under it): its first line, without the `Error: ` the stack starts with —
 *  and nothing for a run the user stopped (being stopped is the status, not a reason). */
export function runError(error: unknown, status: unknown): string | undefined {
  if (typeof error !== 'string') return undefined;
  const line = (error.split('\n').find((l) => l.trim()) ?? '').trim().replace(/^Error:\s*/, '');
  if (!line || (status === 'killed' && /^(workflow )?(aborted|killed|cancell?ed|stopped)\b/i.test(line))) return undefined;
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

export async function readRun(dir: string, runId: string): Promise<BgTask | null> {
  if (!RUN_ID.test(runId)) return null;
  let t: BgTask;
  try { t = taskFromRun(await readJson(path.join(dir, 'workflows', `${runId}.json`)), runId); } catch { return null; }
  // the run file says `model ?? the main model` for each agent, whatever it really ran on (a subagent model the user
  // picked is forced over it): what the agent's own transcript recorded is what was asked for
  await Promise.all(t.agents.map(async (a) => {
    if (!a.agentId || !AGENT_ID.test(a.agentId)) return;
    const f = await findAgentFile(dir, a.agentId);
    const m = f ? await firstModel(f) : null;
    if (m) a.model = m;
  }));
  return t;
}

/** The model of a transcript's first assistant message (the alias of the split route turned back into the real name). */
export async function firstModel(file: string, maxBytes = 1 << 20): Promise<string | null> {
  let fh: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    fh = await fs.open(file, 'r');
    const buf = Buffer.alloc(Math.min(maxBytes, (await fh.stat()).size));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    for (const line of buf.toString('utf8', 0, bytesRead).split('\n')) {
      if (!line.includes('"assistant"')) continue;
      try { const e = JSON.parse(line); if (e?.type === 'assistant' && typeof e.message?.model === 'string') return e.message.model; } catch { /* a line cut at the end */ }
    }
  } catch { /* unreadable */ } finally { await fh?.close(); }
  return null;
}

/** Where a sub-agent's transcript is: beside the others, or in one of the workflow runs' folders. */
async function findAgentFile(dir: string, agentId: string): Promise<string | null> {
  const sub = path.join(dir, 'subagents');
  const direct = path.join(sub, `agent-${agentId}.jsonl`);
  if (await fs.access(direct).then(() => true, () => false)) return direct;
  const runs = await fs.readdir(path.join(sub, 'workflows')).catch(() => [] as string[]);
  for (const r of runs) {
    const f = path.join(sub, 'workflows', r, `agent-${agentId}.jsonl`);
    if (await fs.access(f).then(() => true, () => false)) return f;
  }
  return null;
}

/** A sub-agent's messages, in the shape `getSubagentMessages` returns (the web's `applyTranscript` reads it). */
export async function readAgentTranscript(dir: string, agentId: string): Promise<unknown[]> {
  if (!AGENT_ID.test(agentId)) return [];
  const f = await findAgentFile(dir, agentId);
  if (!f) return [];
  const text = await fs.readFile(f, 'utf8').catch(() => '');
  const out: unknown[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if ((e.type !== 'user' && e.type !== 'assistant') || !e.message) continue;
    out.push({ type: e.type, uuid: e.uuid, session_id: e.sessionId ?? e.session_id, message: e.message, parent_tool_use_id: null, ...(e.timestamp ? { timestamp: e.timestamp } : {}) });
  }
  return out;
}
