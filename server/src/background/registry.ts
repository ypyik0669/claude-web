// 后台: how the SDK's task messages change one conversation's background — pure, so it can be replayed in tests.
// The shapes are the official CLI's (sdk.d.ts SDKTask*Message; a workflow's `workflow_progress` is not in the d.ts —
// read from its bundle and 60 saved runs, 2026-10-12): our engine sends the same since 2.8.4-cw.3.
import type { BgAgent, BgAgentState, BgEvent, BgKind, BgSession, BgStatus, BgTask } from './types.js';
import { tr } from '../i18n/index.js';

export const AGENT_COLORS = 10;
export const MAX_EVENTS = 200;
export const SNAPSHOT_EVENTS = 50;
export const MAX_BEATS = 24;

export interface BgState extends BgSession {
  /** the next agent's colour − 1 (they go round 1…10 in the order agents appear in the conversation) */
  nextColor: number;
  /** every event kept (the snapshot carries the last SNAPSHOT_EVENTS) */
  allEvents: BgEvent[];
  /** Foreground steps the CLI tracks as tasks (`isForeground`), by task id: kept out of the picture until the CLI
   *  moves one to the background (task_updated patch.is_backgrounded), when it shows up as if it had started then. */
  held: Map<string, { m: any; at: number }>;
  /** The turn's foreground sub-agent calls (an Agent / Task tool_use without run_in_background), by tool_use id: the
   *  call's tool_result coming back is that sub-agent's end, whatever task messages the stream did or did not carry. */
  syncCalls: Set<string>;
}

/** At most this many held foreground steps (they go when they end; a lost notification must not grow the map). */
const MAX_HELD = 64;
/** At most this many foreground calls remembered (an answered one is dropped; a turn has a few at a time). */
const MAX_SYNC_CALLS = 256;

/** A step something waits on, not background work: a command the turn or a sub-agent runs in the foreground
 *  (official 2.1.283 reports a long `sleep` as a local_bash task with is_backgrounded false — a workflow agent's one
 *  owned_by_subagent), or a sub-agent's own foreground sub-agent. The turn's foreground sub-agents stay (spec: 前台后台
 *  都算); a step shown as a 后台命令 would not be one, and its Stop would cut the step short. */
export const isForeground = (m: any): boolean => m?.is_backgrounded === false && (m.task_type === 'local_bash' || m.owned_by_subagent === true);

export function createBgState(sessionId: string): BgState {
  return { sessionId, updatedAt: 0, tasks: [], events: [], nextColor: 0, allEvents: [], held: new Map(), syncCalls: new Set() };
}

const kindOf = (type: unknown, subagentType: unknown): BgKind =>
  type === 'local_workflow' ? 'workflow' : type === 'local_agent' || (type === undefined && typeof subagentType === 'string') ? 'agent' : type === 'local_bash' ? 'shell' : 'other';

const statusOf = (s: unknown): BgStatus | undefined =>
  s === 'completed' ? 'completed' : s === 'failed' ? 'failed' : s === 'stopped' || s === 'killed' ? 'stopped' : s === 'running' ? 'running' : undefined;

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function nextColor(s: BgState): number {
  const c = (s.nextColor % AGENT_COLORS) + 1;
  s.nextColor++;
  return c;
}

/** Who said it, in the feed: a background command's description is its whole command line. */
export const MAX_EVENT_WHO = 40;

function event(s: BgState, e: BgEvent) {
  if (e.who.length > MAX_EVENT_WHO) e.who = `${e.who.slice(0, MAX_EVENT_WHO - 1)}…`;
  s.allEvents.push(e);
  if (s.allEvents.length > MAX_EVENTS) s.allEvents.splice(0, s.allEvents.length - MAX_EVENTS);
}

/** A feed line is one line: a summary can be a paragraph. */
export const MAX_EVENT_TEXT = 140;
const clip = (t: string) => (t.length > MAX_EVENT_TEXT ? `${t.slice(0, MAX_EVENT_TEXT - 1)}…` : t);

function agentEvent(s: BgState, t: BgTask, a: BgAgent, now: number, tone: BgEvent['tone'], text: string) {
  event(s, { at: now, taskId: t.id, agent: a.key, who: a.label, color: a.color, text: clip(text.replace(/\s+/g, ' ').trim()), tone });
}

function beat(a: BgAgent, calls: number | undefined, now: number) {
  if (calls === undefined) return;
  if (calls > (a.toolCalls ?? 0)) {
    a.beats.push(now);
    if (a.beats.length > MAX_BEATS) a.beats.splice(0, a.beats.length - MAX_BEATS);
  }
  a.toolCalls = calls;
}

function newTask(s: BgState, m: any, now: number, kind: BgKind): BgTask {
  const t: BgTask = {
    id: m.task_id,
    ...(str(m.tool_use_id) ? { toolUseId: m.tool_use_id } : {}),
    kind,
    ...(str(m.task_type) ? { type: m.task_type } : {}),
    description: str(m.description) ?? '',
    ...(str(m.workflow_name) ? { name: m.workflow_name } : {}),
    status: 'running',
    ...(typeof m.is_backgrounded === 'boolean' ? { backgrounded: m.is_backgrounded } : {}),
    startedAt: now,
    agents: [],
  };
  if (kind === 'agent') t.agents.push({ key: t.id, color: nextColor(s), label: t.description || str(m.subagent_type) || tr('子代理'), agentId: t.id, ...(str(m.subagent_type) ? { agentType: m.subagent_type } : {}), state: 'running', startedAt: now, beats: [] });
  s.tasks.push(t);
  return t;
}

const stateOf = (e: any): BgAgentState => (e.state === 'done' ? 'done' : e.state === 'error' ? 'failed' : e.state === 'progress' || (e.state === 'start' && num(e.startedAt) !== undefined) ? 'running' : 'queued');

/** One `workflow_agent` entry into the task's agent (by `index`). Returns whether anything changed. */
export function mergeWorkflowAgent(s: BgState, t: BgTask, e: any, now: number, quiet = false): boolean {
  const index = num(e.index);
  if (index === undefined) return false;
  const key = `w${index}`;
  let a = t.agents.find((x) => x.key === key);
  const state = stateOf(e);
  const label = str(e.label) ?? `#${index}`;
  let changed = false;
  if (!a) {
    a = { key, color: nextColor(s), label, state: 'queued', beats: [] };
    t.agents.push(a);
    changed = true;
  }
  const set = <K extends keyof BgAgent>(k: K, v: BgAgent[K] | undefined) => {
    if (v !== undefined && a![k] !== v) { a![k] = v; changed = true; }
  };
  set('label', label);
  set('phase', num(e.phaseIndex));
  set('phaseTitle', str(e.phaseTitle));
  set('agentId', str(e.agentId));
  set('model', str(e.model));
  set('queuedAt', num(e.queuedAt));
  set('startedAt', num(e.startedAt));
  set('attempt', num(e.attempt));
  set('tokens', num(e.tokens));
  set('lastTool', str(e.lastToolName));
  if (e.cached === true) set('cached', true);
  if (str(e.error)) set('error', e.error);
  const calls = num(e.toolCalls);
  if (calls !== undefined && calls !== a.toolCalls) { beat(a, calls, now); changed = true; }
  const summary = str(e.lastToolSummary);
  if (summary && summary !== a.lastSummary) {
    a.lastSummary = summary;
    changed = true;
    if (!quiet && state === 'running') agentEvent(s, t, a, now, 'tool', summary);
  }
  // a task that has ended keeps how its agents ended: a progress list arriving late does not put them back to work
  const late = t.status !== 'running' && (state === 'queued' || state === 'running') && a.state !== 'queued' && a.state !== 'running';
  if (state !== a.state && !late) {
    const was = a.state;
    a.state = state;
    changed = true;
    if (state === 'done' || state === 'failed') a.endedAt = num(e.startedAt) !== undefined && num(e.durationMs) !== undefined ? e.startedAt + e.durationMs : now;
    if (!quiet) {
      if (state === 'running' && was === 'queued') agentEvent(s, t, a, now, 'start', tr('开始'));
      else if (state === 'done') agentEvent(s, t, a, now, 'done', a.cached ? tr('用了上次的结果') : tr('完成'));
      else if (state === 'failed') agentEvent(s, t, a, now, 'error', a.error ? tr('失败：{error}', { error: a.error }) : tr('失败'));
    }
  }
  return changed;
}

/** A `workflow_progress` list into the task (phases by index, agents by index). */
export function mergeWorkflowProgress(s: BgState, t: BgTask, list: unknown[], now: number, quiet = false): boolean {
  let changed = false;
  for (const e of list as any[]) {
    if (e?.type === 'workflow_phase') {
      const index = num(e.index);
      if (index === undefined) continue;
      t.phases ??= [];
      const p = t.phases.find((x) => x.index === index);
      const title = str(e.title) ?? tr('阶段 {index}', { index });
      if (!p) { t.phases.push({ index, title }); t.phases.sort((a, b) => a.index - b.index); changed = true; }
      else if (p.title !== title) { p.title = title; changed = true; }
    } else if (e?.type === 'workflow_agent') {
      if (mergeWorkflowAgent(s, t, e, now, quiet)) changed = true;
    }
  }
  return changed;
}

/** The end of a task settles what of it was still going: running → its outcome, queued → done / failed with it. */
/** The agents still queued or at work when their task ends end with it: done, failed, or — the task stopped — stopped
 *  (a workflow the user stopped did not fail; its agents' cards and faces must not say it did). */
function settleAgents(t: BgTask, now: number, status: BgStatus, why?: string) {
  const to: BgAgentState = status === 'completed' ? 'done' : status === 'stopped' ? 'stopped' : 'failed';
  for (const a of t.agents) {
    if (a.state !== 'queued' && a.state !== 'running') continue;
    a.state = to;
    a.endedAt = now;
    if (to === 'failed' && why && !a.error) a.error = why;
  }
}

const END_TEXT: Record<BgStatus, string> = { completed: tr('完成'), failed: tr('失败'), stopped: tr('已停止'), running: '' };
const END_TONE: Record<BgStatus, BgEvent['tone']> = { completed: 'done', failed: 'error', stopped: 'stop', running: 'tool' };

function endTask(s: BgState, t: BgTask, status: BgStatus, now: number, summary?: string, reason?: string) {
  t.status = status;
  t.endedAt = now;
  if (summary) t.summary = summary;
  if (reason) t.reason = reason;
  settleAgents(t, now, status, reason);
  const who = t.kind === 'workflow' ? (t.name ?? t.description) : t.agents[0]?.label ?? t.description;
  const text = reason ? `${END_TEXT[status]} · ${reason}` : END_TEXT[status];
  event(s, { at: now, taskId: t.id, ...(t.agents.length === 1 && t.kind === 'agent' ? { agent: t.agents[0].key, color: t.agents[0].color } : {}), who, text, tone: END_TONE[status] });
}

/** A task comes into the picture: started at `at`, its 开始 in the feed at `now` (later for a step moved to the background). */
function startTask(s: BgState, m: any, at: number, now = at): BgTask {
  const t = newTask(s, m, at, kindOf(m.task_type, m.subagent_type));
  const a = t.agents[0];
  const text = t.kind === 'workflow' ? tr('工作流 {name} 开始', { name: t.name ?? t.description }) : t.kind === 'shell' ? tr('开始运行：{description}', { description: t.description }) : tr('开始');
  event(s, { at: now, taskId: t.id, ...(a ? { agent: a.key, color: a.color } : {}), who: a?.label ?? t.name ?? t.description, text, tone: 'start' });
  return t;
}

/** Apply one SDK message. Returns true when the conversation's background changed. */
export function applyBg(s: BgState, m: any, now: number): boolean {
  if (m?.type !== 'system' || typeof m.task_id !== 'string') return false;
  const changed = applyTaskMessage(s, m, now);
  if (changed) s.updatedAt = now;
  return changed;
}

function applyTaskMessage(s: BgState, m: any, now: number): boolean {
  let t = s.tasks.find((x) => x.id === m.task_id);
  switch (m.subtype) {
    case 'task_started': {
      if (m.ambient === true || m.skip_transcript === true) return false;
      if (t) return false;
      if (isForeground(m)) {
        if (s.held.size >= MAX_HELD) s.held.delete(s.held.keys().next().value!);
        s.held.set(m.task_id, { m, at: now });
        return false;
      }
      t = startTask(s, m, now);
      return true;
    }
    case 'task_progress': {
      if (!t) {
        // a window opened mid-run, or a server that started after the task: a workflow's progress still says enough
        if (!Array.isArray(m.workflow_progress)) return false;
        t = newTask(s, { ...m, task_type: 'local_workflow' }, now, 'workflow');
      }
      let changed = false;
      const usage = m.usage ?? {};
      if (num(usage.total_tokens) !== undefined && usage.total_tokens !== t.tokens) { t.tokens = usage.total_tokens; changed = true; }
      if (num(usage.tool_uses) !== undefined && usage.tool_uses !== t.toolUses) { t.toolUses = usage.tool_uses; changed = true; }
      if (str(m.last_tool_name) && m.last_tool_name !== t.lastTool) { t.lastTool = m.last_tool_name; changed = true; }
      if (t.kind === 'agent' && t.agents[0]) {
        const a = t.agents[0];
        if (t.tokens !== undefined) a.tokens = t.tokens;
        const toolWas = a.lastTool;
        if (t.lastTool !== undefined) a.lastTool = t.lastTool;
        if (num(usage.tool_uses) !== undefined && usage.tool_uses !== a.toolCalls) beat(a, usage.tool_uses, now);
        const summary = str(m.summary);
        if (summary && summary !== a.lastSummary) {
          // the model's one-line progress (agentProgressSummaries): the line in the feed
          a.lastSummary = summary;
          if (t.status === 'running') agentEvent(s, t, a, now, 'tool', summary);
          changed = true;
        } else if (!summary && a.lastTool && a.lastTool !== toolWas && t.status === 'running') {
          // no summary yet (they come every ~30 s): the tool it moved on to
          agentEvent(s, t, a, now, 'tool', a.lastTool);
        }
      } else if (str(m.summary) && m.summary !== t.summary && t.kind !== 'workflow') {
        t.summary = m.summary;
        changed = true;
      }
      if (Array.isArray(m.workflow_progress) && mergeWorkflowProgress(s, t, m.workflow_progress, now)) changed = true;
      return changed;
    }
    case 'task_updated': {
      if (!m.patch) return false;
      const held = !t ? s.held.get(m.task_id) : undefined;
      if (held) {
        // a held foreground step: it shows up once it is moved to the background; one that ends is let go
        if (statusOf(m.patch.status) && m.patch.status !== 'running') { s.held.delete(m.task_id); return false; }
        if (m.patch.is_backgrounded !== true) return false;
        s.held.delete(m.task_id);
        t = startTask(s, { ...held.m, is_backgrounded: true, ...(str(m.patch.description) ? { description: m.patch.description } : {}) }, held.at, now);
        return true;
      }
      if (!t) return false;
      let changed = false;
      if (str(m.patch.description) && m.patch.description !== t.description) { t.description = m.patch.description; changed = true; }
      if (typeof m.patch.is_backgrounded === 'boolean' && m.patch.is_backgrounded !== t.backgrounded) { t.backgrounded = m.patch.is_backgrounded; changed = true; }
      const st = statusOf(m.patch.status);
      if (st && st !== 'running' && t.status === 'running') { endTask(s, t, st, now, undefined, str(m.patch.error)); changed = true; }
      return changed;
    }
    case 'task_notification': {
      if (!t) { s.held.delete(m.task_id); return false; }
      const st = statusOf(m.status) ?? 'completed';
      if (t.status !== 'running') {
        // a task_updated already ended it: keep the notification's summary
        if (str(m.summary) && m.summary !== t.summary) { t.summary = m.summary; return true; }
        return false;
      }
      endTask(s, t, st, now, str(m.summary));
      return true;
    }
  }
  return false;
}

/** The tool names a sub-agent is started with (Claude Code's Agent; older builds and ccb call it Task). */
const AGENT_TOOLS = new Set(['Agent', 'Task']);

/**
 * The main conversation's own messages (2026-11-27, issue #19: two finished sub-agents stayed 在跑 and their Stop said
 * "No task found"): an assistant message's foreground Agent calls are remembered, and a user message's tool_result for
 * one ends the sub-agent task started by it (`tool_use_id`) — the call returns only when the sub-agent is done. A
 * background one (run_in_background, is_backgrounded, or moved there) returns at once and is left to its notification;
 * a resumed one (SendMessage) is never a foreground Agent call. Sub-agents' own messages (parent_tool_use_id) are not
 * the turn's. Returns true when the background changed.
 */
export function applyTurnMessage(s: BgState, m: any, now: number): boolean {
  if ((m?.type !== 'assistant' && m?.type !== 'user') || m.parent_tool_use_id) return false;
  const content = m.message?.content;
  if (!Array.isArray(content)) return false;
  let changed = false;
  for (const b of content) {
    if (m.type === 'assistant' && b?.type === 'tool_use' && typeof b.id === 'string' && AGENT_TOOLS.has(b.name) && b.input?.run_in_background !== true) {
      if (s.syncCalls.size >= MAX_SYNC_CALLS) s.syncCalls.delete(s.syncCalls.values().next().value!);
      s.syncCalls.add(b.id);
    } else if (m.type === 'user' && b?.type === 'tool_result' && typeof b.tool_use_id === 'string' && s.syncCalls.delete(b.tool_use_id)) {
      const t = s.tasks.find((x) => x.toolUseId === b.tool_use_id && x.kind === 'agent');
      if (!t || t.status !== 'running' || t.backgrounded === true) continue;
      endTask(s, t, b.is_error === true ? 'failed' : 'completed', now);
      changed = true;
    }
  }
  if (changed) s.updatedAt = now;
  return changed;
}

/**
 * A task the CLI says it does not have (its Stop answered "No task found"): it ended without us hearing. Shown as
 * stopped, not left 在跑 with a Stop that can only fail. Returns true when it was still running here.
 */
export function endGone(s: BgState, taskId: string, now: number): boolean {
  const t = s.tasks.find((x) => x.id === taskId);
  if (!t || t.status !== 'running') return false;
  endTask(s, t, 'stopped', now, undefined, tr('停止前就已经结束了'));
  s.updatedAt = now;
  return true;
}

/** The CLI process went away (closed, crashed, restarted): its background work went with it. */
export function endRunning(s: BgState, reason: string, now: number): boolean {
  s.held.clear();
  let changed = false;
  for (const t of s.tasks) {
    if (t.status !== 'running') continue;
    endTask(s, t, 'stopped', now, undefined, reason);
    changed = true;
  }
  if (changed) s.updatedAt = now;
  return changed;
}

/** What goes to the windows: no prompts, the latest SNAPSHOT_EVENTS events. */
export function snapshotBg(s: BgState): BgSession {
  return {
    sessionId: s.sessionId,
    updatedAt: s.updatedAt,
    tasks: s.tasks.map((t) => ({ ...t, ...(t.phases ? { phases: t.phases.map((p) => ({ ...p })) } : {}), agents: t.agents.map((a) => ({ ...a, beats: [...a.beats] })) })),
    events: s.allEvents.slice(-SNAPSHOT_EVENTS),
  };
}
