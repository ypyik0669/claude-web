// 自动化 › 运行中 as a list (redesign 2026-11, the plan's 自动化 page): one group per thing a conversation runs — a
// workflow with its sub-agents, a single sub-agent, a background command — a conversation's groups together, each
// with the way to its conversation and its Stop. The 3D cafe is the other way to look at the same snapshot. Pure: no
// store, node tests import it.
import type { BgAgent, BgSession, BgTask } from '@shared';
import { tr } from '@/i18n';
import { KIND_LABEL, liveCounts, orderedTasks, sortSessions, tokensText } from './model';
import { projectOf, spanText } from './history-model';

/** 列表 or 网吧: how 运行中 shows what runs (`background.view` in meta.json on a desktop; a phone starts on the list). */
export type RunView = 'list' | 'cafe';
export const RUN_VIEW_KEY = 'background.view';
export const runViewOf = (v: unknown): RunView => (v === 'cafe' ? 'cafe' : 'list');

/** One thing a conversation runs (or ran in the last minute: the snapshot keeps an ended task that long). */
export interface RunGroup { sessionId: string; task: BgTask }

/**
 * Every conversation's tasks as the list's groups: the conversations with work running first, the newest change first
 * (the cafe's zones go in the same order), and within one its running tasks first, the newest start first — a
 * conversation's groups stay together.
 */
export function runGroups(sessions: Record<string, BgSession>): RunGroup[] {
  return sortSessions(Object.values(sessions)).flatMap((s) => orderedTasks(s).map((task) => ({ sessionId: s.sessionId, task })));
}

/** 工作流 / 子代理 Explore / 后台命令 */
export function taskKind(t: BgTask): string {
  const type = t.kind === 'agent' ? t.agents[0]?.agentType : undefined;
  return type ? `${KIND_LABEL.agent} ${type}` : KIND_LABEL[t.kind];
}

/**
 * A group's second line, as the plan draws it: acme-shop · 工作流 · 8 分钟 (how long it has run, or ran). `phase`:
 * a phone's line says where a workflow is instead of how long (acme-shop · 工作流 · 改代码 2/4) — it has no room
 * for the phase beside the name. `short`: a phone's kind without the sub-agent's type (its row says it), as the
 * plan's phone screen writes it.
 */
export function groupMeta(t: BgTask, cwd: string | undefined, now: number, o: { phase?: string | null; short?: boolean } = {}): string {
  const end = t.status === 'running' ? now : (t.endedAt ?? now);
  return [projectOf(cwd), o.short ? KIND_LABEL[t.kind] : taskKind(t), o.phase || spanText(Math.max(0, end - t.startedAt))].filter(Boolean).join(' · ');
}

/**
 * Where a running workflow is: 「改代码 2/4」 — the phase of its first agent at work (else of the first one queued),
 * out of all its phases. None when it has no phases or is over.
 */
export function phaseChip(t: BgTask): string | null {
  if (t.kind !== 'workflow' || t.status !== 'running') return null;
  const at = t.agents.find((a) => a.state === 'running' && a.phase != null) ?? t.agents.find((a) => a.state === 'queued' && a.phase != null);
  if (!at || at.phase == null) return null;
  const total = t.phases?.length || Math.max(...t.agents.map((a) => a.phase ?? 0));
  const title = at.phaseTitle || t.phases?.find((p) => p.index === at.phase)?.title || '';
  return [title, `${at.phase}/${Math.max(total, at.phase)}`].filter(Boolean).join(' ');
}

/** An agent row's name: a workflow agent's label; a single sub-agent's type (its words are the group's title). */
export function agentWho(t: BgTask, a: BgAgent): string {
  return t.kind === 'workflow' ? a.label : a.agentType || KIND_LABEL.agent;
}

/** An agent row's words: what it is doing / did last, and how it ended. */
export function agentLine(a: BgAgent): string {
  const said = a.lastSummary || a.lastTool || '';
  switch (a.state) {
    case 'running': return said || tr('在跑');
    case 'queued': return tr('排队中');
    case 'stopped': return said ? tr('{said} · 已停止', { said }) : tr('已停止');
    case 'failed': return (a.error ?? '').split('\n')[0].trim() || tr('失败');
    case 'done': {
      const end = a.cached ? tr('用了上次的结果') : tr('完成');
      return said ? `${said} · ${end}` : end;
    }
  }
}

/** The tokens at the row's end (none before it has any). */
export const agentTokens = (a: BgAgent): string => (a.tokens ? `${tokensText(a.tokens)} tok` : '');

/**
 * The rows a group shows: every agent up to `max`; past it, the ones at work first (in order), then the rest in order,
 * and how many are left for 「还有 N 个」. `all`: the user opened the rest.
 */
export function shownAgents(agents: BgAgent[], all: boolean, max = 8): { shown: BgAgent[]; more: number } {
  if (all || agents.length <= max) return { shown: agents, more: 0 };
  const at = agents.filter((a) => a.state === 'running');
  const rest = agents.filter((a) => a.state !== 'running');
  return { shown: [...at, ...rest].slice(0, max), more: agents.length - max };
}

/** The line under the tabs while something runs: 3 个在跑 · 2 个对话 · 6 个子代理在干活 · 68.0k tok. */
export function liveSummary(sessions: Record<string, BgSession>): string | undefined {
  const list = Object.values(sessions);
  const going = list.filter((s) => liveCounts(s).tasks > 0);
  if (!going.length) return undefined;
  const tasks = going.reduce((n, s) => n + liveCounts(s).tasks, 0);
  const busy = going.reduce((n, s) => n + liveCounts(s).running, 0);
  const tokens = going.reduce((n, s) => n + s.tasks.filter((t) => t.status === 'running').reduce((m, t) => m + (t.tokens ?? t.agents.reduce((k, a) => k + (a.tokens ?? 0), 0)), 0), 0);
  return [
    tr('{n} 个在跑', { n: tasks }),
    going.length > 1 ? tr('{n} 个对话', { n: going.length }) : '',
    busy ? tr('{n} 个子代理在干活', { n: busy }) : '',
    tokens ? `${tokensText(tokens)} tok` : '',
  ].filter(Boolean).join(' · ');
}
