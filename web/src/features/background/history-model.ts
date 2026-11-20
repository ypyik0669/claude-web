// 跑过的 (2026-11-19, docs/notes/background.md): the finished workflows, sub-agents and background commands of every
// conversation — the list's words and day groups, a row as a task (a sub-agent / a command; a workflow is read with
// background.run), and a task at a moment of its replay (the graph; the cafe). Pure: no store, node tests import it.
import type { BgAgent, BgEvent, BgHistoryItem, BgSession, BgTask } from '@shared';
import { dateLocale, tr } from '@/i18n';
import { KIND_LABEL } from './model';

/** The replay's speeds (the time it took ÷ this). */
export const REPLAY_SPEEDS = [10, 60, 120] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];
/** A run's graph: at most this many cards (the node graph's own limit for motion). */
export const HISTORY_GRAPH_MAX = 150;
/** Rows asked for at a time while scrolling. */
export const HISTORY_PAGE = 50;

const dayStart = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** 今天 / 昨天 / 11月2日 / 2025年12月30日 */
export function dayLabel(at: number, now = Date.now()): string {
  const today = dayStart(now);
  if (at >= today) return tr('今天');
  if (at >= dayStart(today - 1)) return tr('昨天');
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  return new Date(at).toLocaleDateString(dateLocale(), sameYear ? { month: 'long', day: 'numeric' } : { year: 'numeric', month: 'long', day: 'numeric' });
}

export interface DayGroup { key: string; label: string; items: BgHistoryItem[] }

/** The rows (newest first) in days, in order. */
export function groupByDay(items: BgHistoryItem[], now = Date.now()): DayGroup[] {
  const out: DayGroup[] = [];
  for (const it of items) {
    const d = new Date(it.startedAt);
    const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    const last = out[out.length - 1];
    if (last?.key === key) last.items.push(it);
    else out.push({ key, label: dayLabel(it.startedAt, now), items: [it] });
  }
  return out;
}

/**
 * The newest page asked for again while the list is open (something live ended) into the rows shown: a row in both is
 * the new one, the pages scrolled to below stay (a plain reload would cut the list back to one page under the reader).
 * In the server's order: the newest start first, then the larger id.
 */
export function mergeFirstPage(shown: BgHistoryItem[], fresh: BgHistoryItem[]): BgHistoryItem[] {
  const ids = new Set(fresh.map((i) => i.id));
  return [...fresh, ...shown.filter((i) => !ids.has(i.id))].sort((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/** 刚刚 / 12 分钟前 / 3 小时前 / 昨天 / 11月17日 */
export function agoText(at: number, now = Date.now()): string {
  const m = Math.floor((now - at) / 60_000);
  if (m < 1) return tr('刚刚');
  if (m < 60) return tr('{m} 分钟前', { m });
  if (at >= dayStart(now)) return tr('{h} 小时前', { h: Math.floor(m / 60) });
  return dayLabel(at, now);
}

/** 40 秒 / 12 分钟 / 1 小时 5 分钟 */
export function spanText(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return tr('{s} 秒', { s });
  const m = Math.floor(s / 60);
  if (m < 60) return tr('{m} 分钟', { m });
  const hours = Math.floor(m / 60), rest = m % 60;
  return rest ? tr('{h} 小时 {m} 分钟', { h: hours, m: rest }) : tr('{h} 小时', { h: hours });
}

export const itemSpan = (it: { startedAt: number; endedAt?: number }) => (it.endedAt !== undefined && it.endedAt >= it.startedAt ? it.endedAt - it.startedAt : undefined);

export interface StatusChip { text: string; tone: 'ok' | 'bad' | 'muted' }

/** How it ended, as the row's chip: 完成 · N 个失败 (a workflow that finished with failed agents) · 失败 · 已停止. */
export function statusChip(it: Pick<BgHistoryItem, 'status' | 'failed'>): StatusChip {
  if (it.status === 'failed') return { text: tr('失败'), tone: 'bad' };
  if (it.status === 'stopped') return { text: tr('已停止'), tone: 'muted' };
  if (it.failed) return { text: tr('{n} 个失败', { n: it.failed }), tone: 'bad' };
  return { text: tr('完成'), tone: 'ok' };
}

/** The folder's name: C:\work\acme-shop → acme-shop. */
export const projectOf = (cwd: string | undefined) => (cwd ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '';

/** 工作流 / 子代理 Explore / 后台命令 */
export const kindText = (it: Pick<BgHistoryItem, 'kind' | 'agentType'>) => (it.kind === 'agent' && it.agentType ? `${KIND_LABEL.agent} ${it.agentType}` : KIND_LABEL[it.kind]);

/** A row's second line: acme-shop · 工作流 · 12 分钟 */
export function rowMeta(it: BgHistoryItem): string {
  const span = itemSpan(it);
  return [projectOf(it.cwd), kindText(it), span !== undefined ? spanText(span) : ''].filter(Boolean).join(' · ');
}

/** A row's title (a sub-agent sent without a description has none of its own). */
export const rowTitle = (it: BgHistoryItem) => it.title || (it.kind === 'shell' ? it.command : '') || kindText(it);

const AGENT_END: Record<BgTask['status'], BgAgent['state']> = { completed: 'done', failed: 'failed', stopped: 'stopped', running: 'running' };
const keyOf = (it: BgHistoryItem) => it.id.slice(it.id.lastIndexOf('|') + 1) || it.id;

/** A sub-agent's or a command's row as the task the board / graph / cafe draw (a workflow's is read with background.run). */
export function taskOfItem(it: BgHistoryItem): BgTask {
  const id = keyOf(it);
  const t: BgTask = { id, kind: it.kind, description: it.kind === 'shell' ? it.command || it.title : it.title, status: it.status, startedAt: it.startedAt, agents: [] };
  if (it.endedAt !== undefined) t.endedAt = it.endedAt;
  if (it.tokens !== undefined) t.tokens = it.tokens;
  if (it.toolUses !== undefined) t.toolUses = it.toolUses;
  if (it.kind === 'agent') {
    const a: BgAgent = { key: id, color: 1, label: rowTitle(it), state: AGENT_END[it.status], startedAt: it.startedAt, beats: [] };
    if (it.agentId) a.agentId = it.agentId;
    if (it.agentType) a.agentType = it.agentType;
    if (it.model) a.model = it.model;
    if (it.endedAt !== undefined) a.endedAt = it.endedAt;
    if (it.tokens !== undefined) a.tokens = it.tokens;
    if (it.toolUses !== undefined) a.toolCalls = it.toolUses;
    t.agents.push(a);
  }
  return t;
}

/** From the start (the first agent queued, if earlier) to the last end. */
export function replaySpan(t: BgTask): { start: number; end: number } {
  let start = t.startedAt, end = t.endedAt ?? 0;
  for (const a of t.agents) {
    const s = a.queuedAt ?? a.startedAt;
    if (s !== undefined && s < start) start = s;
    if (a.endedAt !== undefined && a.endedAt > end) end = a.endedAt;
  }
  return { start, end: end > start ? end : start + 1000 };
}

function agentAt(a: BgAgent, at: number): BgAgent {
  const base: BgAgent = { ...a, beats: [] };
  if (a.startedAt === undefined || at < a.startedAt) return { ...base, state: 'queued', endedAt: undefined, tokens: undefined };
  if (a.endedAt !== undefined && at >= a.endedAt) return { ...base, state: a.state === 'running' || a.state === 'queued' ? 'done' : a.state };
  return { ...base, state: 'running', endedAt: undefined, tokens: undefined };
}

/**
 * The task as it was at `at` (absolute ms): before its end it runs, its agents queued until they started, at work
 * until they ended; from its end on it is what it was. `appear`: an agent is not there before it was queued (the cafe —
 * a customer walks in then); the graph keeps every card, so it does not move about while it plays.
 */
export function taskAt(t: BgTask, at: number, o: { appear?: boolean } = {}): BgTask {
  const { end } = replaySpan(t);
  if (at >= end) return { ...t, agents: t.agents.map((a) => ({ ...a, beats: [] })) };
  const agents = t.agents.filter((a) => !o.appear || at >= (a.queuedAt ?? a.startedAt ?? t.startedAt)).map((a) => agentAt(a, at));
  return { ...t, status: 'running', endedAt: undefined, tokens: undefined, summary: undefined, reason: undefined, agents };
}

/** What happened up to `at`: each agent's start and end (the cafe's 动态). */
function eventsUntil(t: BgTask, at: number): BgEvent[] {
  const out: BgEvent[] = [];
  for (const a of t.agents) {
    if (a.startedAt === undefined || a.startedAt > at) continue;
    out.push({ at: a.startedAt, taskId: t.id, agent: a.key, who: a.label, color: a.color, text: tr('开始'), tone: 'start' });
    if (a.endedAt !== undefined && a.endedAt <= at) {
      const failed = a.state === 'failed';
      out.push({ at: a.endedAt, taskId: t.id, agent: a.key, who: a.label, color: a.color, text: failed ? tr('失败') : a.state === 'stopped' ? tr('已停止') : tr('完成'), tone: failed ? 'error' : a.state === 'stopped' ? 'stop' : 'done' });
    }
  }
  return out.sort((x, y) => x.at - y.at).slice(-50);
}

/** The run at `at` as a conversation's background — what the cafe draws while it replays it. */
export function sessionAt(sessionId: string, t: BgTask, at: number): BgSession {
  return { sessionId, updatedAt: at, tasks: [taskAt(t, at, { appear: true })], events: eventsUntil(t, at) };
}
