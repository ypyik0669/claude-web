import type { BgAgent, BgSession, BgTask } from '@shared';
import type { EdgeStyle, NgEdge, NgNode, NgRow, NodeGraphData, NodeState } from '@/ui/node-graph/schema';
import { agentColor, agentStateText, clock, KIND_LABEL, taskStateText, taskTitle, tokensText } from './model';
import { tr } from '@/i18n';
// spec 2026-10-24 D2: the background registry as a node graph (replaces the radial CommandGraph). Pure.
// Card ids: the hub `main`; a workflow `wf|<taskId>`; its phase `wf|<taskId>|p<index>`; an agent `<taskId>|<agentKey>`;
// a command `shell|<taskId>` (agent and command ids are the old graph's). Edge ids `from>to`.

export const HUB = 'main';
export interface BgGraph { graph: NodeGraphData; more: number; picks: Record<string, { agentKey: string; taskId: string }> }
const AGENT: Record<BgAgent['state'], NodeState> = { queued: 'queued', running: 'running', done: 'done', failed: 'failed', stopped: 'stopped' };
const TASK: Record<BgTask['status'], NodeState> = { running: 'running', completed: 'done', failed: 'failed', stopped: 'stopped' };
export const edgeStyleFor = (s: NodeState): EdgeStyle => (s === 'running' ? 'strong' : s === 'failed' ? 'error' : s === 'done' ? 'normal' : 'dashed');
export function phaseState(agents: BgAgent[]): NodeState {
  if (agents.some((a) => a.state === 'running')) return 'running';
  if (agents.some((a) => a.state === 'failed')) return 'failed';
  return agents.length && agents.every((a) => a.state === 'done') ? 'done' : 'queued';
}

function agentRows(t: BgTask, a: BgAgent, now: number): NgRow[] {
  const end = a.endedAt ?? (a.state === 'running' ? now : undefined);
  const rows: Omit<NgRow, 'options'>[] = [{ id: 'type', label: tr('类型'), value: a.agentType ?? KIND_LABEL[t.kind] }];
  if (a.model) rows.push({ id: 'model', label: tr('模型'), value: a.model });
  if (a.tokens != null) rows.push({ id: 'tokens', label: 'token', value: tokensText(a.tokens) });
  if (a.startedAt && end) rows.push({ id: 'time', label: tr('用时'), value: clock(end - a.startedAt) });
  return rows.map((r) => ({ ...r, options: [] }));
}

/** The cards that are not agents: the hub, each workflow and its phases, each command. */
function frameCards(tasks: BgTask[]): number {
  let n = 1;
  for (const t of tasks) {
    if (t.kind === 'shell') n++;
    else if (t.kind === 'workflow') n += 1 + (t.phases?.length ? t.phases.length : new Set(t.agents.filter((a) => a.phase != null).map((a) => a.phase)).size);
  }
  return n;
}

/** 跑过的's one line for an agent: how it is (ended) and how long it took (so far). */
function terseLine(a: BgAgent, now: number): string {
  if (a.state === 'queued' || a.startedAt === undefined) return agentStateText(a);
  return `${agentStateText(a)} ${clock(Math.max(0, (a.endedAt ?? now) - a.startedAt))}`;
}

/**
 * `maxCards` (跑过的, a run read from disk): every card counted, the agents get what the rest leaves — up to the node
 * graph's 150. Without it the live board's budget: 40 agents on the page, 16 in the right panel.
 * `terse` (跑过的): an agent's card is one line, its state and time — a run of nine with four rows each only fitted at 25%.
 */
export function backgroundGraph(session: BgSession, o: { taskId?: string; compact?: boolean; now: number; maxCards?: number; terse?: boolean }): BgGraph {
  const tasks = o.taskId ? session.tasks.filter((t) => t.id === o.taskId) : session.tasks;
  const all = tasks.flatMap((t) => t.agents.map((a) => ({ t, a })));
  // too many to draw: the ones at work first, the rest in order; what is left out is counted in `more`
  const order = [...all.filter((x) => x.a.state === 'running'), ...all.filter((x) => x.a.state !== 'running')];
  const budget = o.maxCards ? Math.max(0, o.maxCards - frameCards(tasks)) : o.compact ? 16 : 40;
  const keep = new Set(order.slice(0, budget).map((x) => `${x.t.id}|${x.a.key}`));
  const running = all.filter((x) => x.a.state === 'running').length + tasks.filter((t) => t.kind === 'shell' && t.status === 'running').length;
  const nodes: NgNode[] = [{ id: HUB, title: tr('主对话'), subtitle: running ? tr('{running} 个在跑', { running }) : tr('没有在跑的'), icon: 'chat', rows: [] }];
  const edges: NgEdge[] = [];
  const picks: BgGraph['picks'] = {};
  // a failed edge stays red but does not flow: nothing is moving along it any more
  const edge = (from: string, to: string, s: NodeState) => edges.push({ id: `${from}>${to}`, from, to, style: edgeStyleFor(s), pulse: s === 'failed' ? false : undefined });
  const agentNode = (t: BgTask, a: BgAgent) => {
    const id = `${t.id}|${a.key}`;
    const subtitle = o.terse ? terseLine(a, o.now) : o.compact ? agentStateText(a) : a.phaseTitle ?? agentStateText(a);
    nodes.push({ id, title: a.label, subtitle, icon: 'agent', accent: agentColor(a.color), state: AGENT[a.state], tip: a.lastSummary, rows: o.compact || o.terse ? [] : agentRows(t, a, o.now) });
    picks[id] = { agentKey: a.key, taskId: t.id };
    return id;
  };
  for (const t of tasks) {
    if (t.kind === 'shell') {
      const id = `shell|${t.id}`;
      nodes.push({ id, title: t.description, subtitle: `${KIND_LABEL.shell} · ${taskStateText(t)}`, icon: 'terminal', state: TASK[t.status], rows: [] });
      edge(HUB, id, TASK[t.status]);
      continue;
    }
    if (t.kind !== 'workflow') { for (const a of t.agents) if (keep.has(`${t.id}|${a.key}`)) edge(HUB, agentNode(t, a), AGENT[a.state]); continue; }
    const wf = `wf|${t.id}`;
    nodes.push({ id: wf, title: taskTitle(t), subtitle: `${KIND_LABEL.workflow} · ${taskStateText(t)}`, icon: 'workflow', state: TASK[t.status], rows: [] });
    edge(HUB, wf, TASK[t.status]);
    const phases = t.phases?.length ? t.phases : [...new Map(t.agents.filter((a) => a.phase != null).map((a) => [a.phase!, { index: a.phase!, title: a.phaseTitle ?? String(a.phase) }])).values()];
    for (const p of phases) {
      const mine = t.agents.filter((a) => a.phase === p.index);
      const pid = `wf|${t.id}|p${p.index}`, ps = phaseState(mine);
      nodes.push({ id: pid, title: p.title, subtitle: tr('阶段 {index}', { index: p.index }), icon: 'tasks', state: ps, rows: [] });
      edge(wf, pid, ps);
      for (const a of mine) if (keep.has(`${t.id}|${a.key}`)) edge(pid, agentNode(t, a), AGENT[a.state]);
    }
    for (const a of t.agents) if (!phases.some((p) => p.index === a.phase) && keep.has(`${t.id}|${a.key}`)) edge(wf, agentNode(t, a), AGENT[a.state]);
  }
  return { graph: { nodes, edges }, more: all.length - keep.size, picks };
}
