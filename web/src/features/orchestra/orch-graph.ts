import { fmtMs } from '@/util';
import type { IconName } from '@/ui/icons';
import type { NodeRun, OrchNode } from '@shared';
import { own, type NgEdge, type NgNode, type NodeGraphData, type NodeState } from '@/ui/node-graph/schema';
import { agentLabel } from './labels';
import { tr } from '@/i18n';
// spec 2026-10-24 D3: the orchestra's run view and editor preview as a node graph. Pure (unit tested).

const KIND_ICON: Record<OrchNode['kind'], IconName> = { task: 'agent', approval: 'approval' };
/** A stored run / workflow may still hold a kind that was removed (`compare`, 2026-11-01): it gets a neutral icon. */
export const kindIcon = (kind: string): IconName => (KIND_ICON as Record<string, IconName | undefined>)[kind] ?? 'agent';

export function sub(n: OrchNode): string {
  if (n.kind === 'task') return `${agentLabel(n.agent)}${n.workspace === 'worktree' ? tr(' · 独立副本') : ''}${n.untilDone ? tr(' · 直到完成') : ''}`;
  if (n.kind === 'approval') return tr('人工审批');
  return tr('不再支持的节点');
}

export const STATE_L: Record<NodeRun['state'], string> = { pending: tr('待执行'), running: tr('运行中'), waiting: tr('等你'), done: tr('完成'), failed: tr('失败'), skipped: tr('跳过'), cancelled: tr('已取消') };

export const ORCH_CARD_W = 170;
/** review D5: the panel's width fits the graph down to 50 % (then it pans), 160–420 px tall, room for the zoom buttons */
export const ORCH_FIT = { min: 0.5, max: 1, pad: 10, top: 16, bottom: 44, lo: 160, hi: 420 };
const RUN: Record<NodeRun['state'], NodeState> = { pending: 'idle', running: 'running', waiting: 'waiting', done: 'done', failed: 'failed', skipped: 'stopped', cancelled: 'stopped' };

/** Cards = nodes (state from the run, when there is one); edges = dependsOn — into a running step strong, into a failed one red (no dot). */
export function orchestraGraph(nodes: OrchNode[], runs: Record<string, NodeRun> | undefined, now: number): NodeGraphData {
  const ids = new Set(nodes.map((n) => n.id));
  const out: NgNode[] = nodes.map((n) => {
    const r = runs ? own(runs, n.id) : undefined;
    const secs = r?.startedAt ? (r.finishedAt ?? now) - r.startedAt : 0;
    const subtitle = r && r.state !== 'pending' ? `${STATE_L[r.state]}${secs && (r.state === 'running' || r.finishedAt) ? ` · ${fmtMs(secs)}` : ''}` : sub(n);
    // tip: the whole title on hover — a long one is cut on the card (review D5: the old card had it)
    return { id: n.id, title: n.title || n.id, tip: n.title || n.id, subtitle, icon: r?.state === 'done' ? 'check' : r?.state === 'failed' ? 'close' : kindIcon(n.kind), state: r ? RUN[r.state] : undefined, rows: [] };
  });
  const edges: NgEdge[] = [];
  for (const n of nodes) for (const dep of new Set(n.dependsOn ?? [])) {
    if (!ids.has(dep)) continue;
    const st = runs ? own(runs, n.id)?.state : undefined;
    edges.push({ id: `${dep}>${n.id}`, from: dep, to: n.id, style: st === 'running' ? 'strong' : st === 'failed' ? 'error' : 'normal', pulse: st === 'failed' ? false : undefined });
  }
  return { nodes: out, edges };
}
