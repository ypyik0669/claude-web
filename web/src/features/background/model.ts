// 后台 (spec 2026-10-12-background-office-design.md §3): the words and counts the page, the composer's pill, the task
// panel and a workflow card share. Pure — no store, so node tests can import it.
import type { BgAgent, BgSession, BgTask } from '@shared';
import { tr } from '@/i18n';

export const BG_TITLE = tr('后台');

const running = (t: BgTask) => t.status === 'running';

export interface LiveCounts { tasks: number; workflows: number; agents: number; shells: number; running: number }

/** What is going now: running tasks by kind, and how many characters are at work (a workflow's running agents + sub-agents). */
export function liveCounts(s: BgSession | undefined): LiveCounts {
  const c: LiveCounts = { tasks: 0, workflows: 0, agents: 0, shells: 0, running: 0 };
  for (const t of s?.tasks ?? []) {
    if (!running(t)) continue;
    c.tasks++;
    if (t.kind === 'workflow') { c.workflows++; c.running += t.agents.filter((a) => a.state === 'running').length; }
    else if (t.kind === 'agent') { c.agents++; c.running++; }
    else if (t.kind === 'shell') c.shells++;
  }
  return c;
}

export const hasLive = (s: BgSession | undefined) => liveCounts(s).tasks > 0;

/** The composer's pill: null when nothing runs. 「后台 · 1 个工作流 · 2 个在跑」 */
export function pillText(s: BgSession | undefined): string | null {
  const c = liveCounts(s);
  if (!c.tasks) return null;
  const parts = [c.workflows && tr('{workflows} 个工作流', { workflows: c.workflows }), c.agents && tr('{agents} 个子代理', { agents: c.agents }), c.shells && tr('{shells} 条命令', { shells: c.shells })].filter(Boolean);
  const busy = c.workflows && c.running ? tr(' · {running} 个在跑', { running: c.running }) : '';
  return `${BG_TITLE} · ${parts.join(' · ')}${busy}`;
}

/** After the turn's Stop: what kept running (the turn's Stop spares it), and where to stop it. */
export function stopNote(s: BgSession | undefined): string | null {
  const n = (s?.tasks ?? []).filter((t) => running(t) && (t.backgrounded || t.kind === 'workflow')).length;
  return n ? tr('后台还有 {n} 个任务在跑，在 自动化 › 运行中 里停', { n }) : null;
}

export function agentStateText(a: BgAgent): string {
  switch (a.state) {
    case 'queued': return tr('排队');
    case 'running': return tr('在跑');
    case 'done': return a.cached ? tr('用了上次的结果') : tr('完成');
    case 'failed': return tr('失败');
    case 'stopped': return tr('已停止');
  }
}

export function taskStateText(t: BgTask): string {
  switch (t.status) {
    case 'running': return tr('运行中');
    case 'completed': return tr('完成');
    case 'failed': return tr('失败');
    case 'stopped': return t.reason ? tr('已停止 · {reason}', { reason: t.reason }) : tr('已停止');
  }
}

export function taskTitle(t: BgTask): string {
  if (t.kind === 'workflow') return t.name || t.description || tr('工作流');
  if (t.kind === 'agent') return t.agents[0]?.label || t.description || tr('子代理');
  return t.description || (t.kind === 'shell' ? tr('后台命令') : tr('后台任务'));
}

/** What kind of thing it is, in a word. */
export const KIND_LABEL: Record<BgTask['kind'], string> = { workflow: tr('工作流'), agent: tr('子代理'), shell: tr('后台命令'), other: tr('后台任务') };

export const agentColor = (n: number) => `var(--agent-${((Math.max(1, n) - 1) % 10) + 1})`;

/** Conversations with something running first, then the rest; newest change first in each. */
export function sortSessions(list: BgSession[]): BgSession[] {
  return [...list].sort((a, b) => Number(hasLive(b)) - Number(hasLive(a)) || b.updatedAt - a.updatedAt);
}

const HARNESS = '[Workflow harness — computed task]';
const FOLLOWS = 'The computed task text follows:';

/**
 * A workflow agent's prompt as the person reading its conversation wants it: official 2.1.283 hands each agent the
 * script's text inside a frame («[Workflow harness — computed task] The task text below was computed at runtime by a
 * workflow script… The computed task text follows:» and the text, every line indented by two spaces) — the frame is
 * for the model. Anything not in that frame is given back as it is.
 */
export function unwrapHarness(text: string): string {
  if (!text.startsWith(HARNESS)) return text;
  const at = text.indexOf(FOLLOWS);
  if (at < 0) return text;
  const body = text.slice(at + FOLLOWS.length).replace(/^\r?\n/, '');
  const out = body.split('\n').map((l) => (l.startsWith('  ') ? l.slice(2) : l)).join('\n').trim();
  return out || text;
}

/** The same, on a transcript message: its text blocks (or string content) unwrapped. */
export function unwrapHarnessMessage(m: any): any {
  if (m?.type !== 'user' || !m.message) return m;
  const c = m.message.content;
  if (typeof c === 'string') return c.startsWith(HARNESS) ? { ...m, message: { ...m.message, content: unwrapHarness(c) } } : m;
  if (!Array.isArray(c) || !c.some((b) => b?.type === 'text' && typeof b.text === 'string' && b.text.startsWith(HARNESS))) return m;
  return { ...m, message: { ...m.message, content: c.map((b) => (b?.type === 'text' && typeof b.text === 'string' ? { ...b, text: unwrapHarness(b.text) } : b)) } };
}

/** 3:12 / 1:02:03 */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(r)}` : `${m}:${two(r)}`;
}

/** 12.3k / 1.2M */
export function tokensText(n: number | undefined): string {
  if (!n) return '0';
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** The agents of a session (or of one task), with the task each belongs to. */
export function agentsOf(s: BgSession, taskId?: string): { task: BgTask; agent: BgAgent }[] {
  const out: { task: BgTask; agent: BgAgent }[] = [];
  for (const t of s.tasks) if (!taskId || t.id === taskId) for (const a of t.agents) out.push({ task: t, agent: a });
  return out;
}

/** The session's tasks worth a header: the running ones first, then the latest ended. */
export function orderedTasks(s: BgSession): BgTask[] {
  return [...s.tasks].sort((a, b) => Number(running(b)) - Number(running(a)) || b.startedAt - a.startedAt);
}
