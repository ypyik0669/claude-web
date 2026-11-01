// Pure workflow logic: validation, layering, prompt templates. No I/O — unit tested.
import type { AgentKind } from '../protocol.js';
import type { NodeRun, OrchNode } from './types.js';
import { tr } from '../i18n/index.js';

/** Upstream outputs longer than this are cut and followed by a `<session-ref>` (expanded into a briefing). */
export const OUTPUT_LIMIT = 8000;

/** The node kinds a workflow may hold (`compare` was removed on 2026-11-01: only Claude is left). */
export const NODE_KINDS: readonly string[] = ['task', 'approval'];

/** Every agent a node would start (a task's agent). */
export function nodeAgents(n: OrchNode): AgentKind[] {
  return n.kind === 'task' ? [n.agent] : [];
}

/**
 * Save-time checks. Returns human-readable (Chinese) problems; empty = valid.
 * `available`, when given, is the list of installed + enabled agents — the only ones a run may start.
 */
export function validateWorkflow(w: { nodes: OrchNode[] }, o: { isGitRepo: boolean; available?: AgentKind[] }): string[] {
  const errs: string[] = [];
  if (!w.nodes.length) return [tr('工作流至少要有一个节点')];
  const ids = new Set<string>();
  for (const n of w.nodes) {
    if (!n.id || !/^[A-Za-z0-9_-]+$/.test(n.id)) errs.push(tr('节点 id「{id}」只能用字母、数字、_ 和 -', { id: n.id }));
    if (ids.has(n.id)) errs.push(tr('节点 id 重复：{id}', { id: n.id }));
    ids.add(n.id);
  }
  for (const n of w.nodes) {
    const label = n.title || n.id;
    if (!NODE_KINDS.includes((n as { kind: string }).kind)) { errs.push(tr('「{label}」的类型 {kind} 不认识（只能是 task / approval）', { label, kind: (n as { kind: string }).kind })); continue; }
    for (const d of n.dependsOn ?? []) if (!ids.has(d)) errs.push(tr('「{label}」依赖的节点 {d} 不存在', { label, d }));
    if (n.kind === 'task') {
      if (!n.prompt?.trim()) errs.push(tr('「{label}」没有提示词', { label }));
      if (!n.agent) errs.push(tr('「{label}」没有选 agent', { label }));
      if (n.workspace === 'worktree' && !o.isGitRepo) errs.push(tr('「{label}」要用独立 worktree，但工作目录不是 git 仓库', { label }));
    }
    if (o.available) for (const a of nodeAgents(n)) if (!o.available.includes(a)) errs.push(tr('「{label}」用到的 agent {a} 没有安装或没有启用', { label, a }));
  }
  const cyc = findCycle(w.nodes);
  if (cyc) errs.push(tr('依赖有环：{cyc}', { cyc: cyc.join(' → ') }));
  return errs;
}

/** One cycle (as a node-id path that returns to its start), or null. Dangling deps are ignored here. */
export function findCycle(nodes: OrchNode[]): string[] | null {
  const by = new Map(nodes.map((n) => [n.id, n]));
  const color = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    color.set(id, 1);
    stack.push(id);
    for (const d of by.get(id)?.dependsOn ?? []) {
      if (!by.has(d)) continue;
      const c = color.get(d) ?? 0;
      if (c === 1) return [...stack.slice(stack.indexOf(d)), d];
      if (c === 0) { const r = visit(d); if (r) return r; }
    }
    stack.pop();
    color.set(id, 2);
    return null;
  };
  for (const n of nodes) if (!color.get(n.id)) { const r = visit(n.id); if (r) return r.reverse(); }
  return null;
}

/**
 * Columns for the execution graph: a node sits one layer after its deepest dependency. Nodes on a
 * cycle (only possible in an unsaved draft) land in one trailing layer rather than hanging the loop.
 */
export function topoLayers<T extends { id: string; dependsOn: string[] }>(nodes: T[]): T[][] {
  const by = new Map(nodes.map((n) => [n.id, n]));
  const depth = new Map<string, number>();
  const onPath = new Set<string>();
  const cyclic = new Set<string>();
  const d = (id: string): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (onPath.has(id)) { cyclic.add(id); return 0; }
    onPath.add(id);
    let v = 0;
    for (const p of by.get(id)?.dependsOn ?? []) if (by.has(p)) v = Math.max(v, d(p) + 1);
    onPath.delete(id);
    depth.set(id, v);
    return v;
  };
  for (const n of nodes) d(n.id);
  const layers: T[][] = [];
  const tail: T[] = [];
  for (const n of nodes) {
    if (cyclic.has(n.id)) { tail.push(n); continue; }
    (layers[depth.get(n.id)!] ??= []).push(n);
  }
  const out = layers.filter(Boolean);
  if (tail.length) out.push(tail);
  return out;
}

/**
 * Text that came from the user's run input or an agent's reply must not be able to pull other sessions
 * into a prompt: `<session-ref` there is defused, so only the references renderPrompt itself writes (for
 * truncated outputs) reach `expandSessionRefs`.
 */
export const defuseRefs = (t: string) => t.replace(/<session-ref/gi, '&lt;session-ref');

export interface PromptContext { input: string; nodes: Record<string, Pick<Partial<NodeRun>, 'output' | 'approval' | 'sessionIds'>> }

/**
 * `{{input}}`, `{{nodes.<id>.output}}`, `{{nodes.<id>.approval}}`. Unknown references render empty.
 * An output over OUTPUT_LIMIT is cut and followed by a `<session-ref>` to the node's last session, which
 * the send path expands into a briefing (`expandSessionRefs`) — the full text never has to be inlined.
 */
export function renderPrompt(tpl: string, ctx: PromptContext): string {
  return tpl.replace(/\{\{\s*(input|nodes\.([A-Za-z0-9_-]+)\.(output|approval))\s*\}\}/g, (_m, all: string, id?: string, field?: string) => {
    if (all === 'input') return defuseRefs(ctx.input ?? '');
    const n = id ? ctx.nodes[id] : undefined;
    if (!n) return '';
    if (field === 'approval') {
      if (!n.approval) return '';
      const verdict = n.approval.decision === 'approve' ? tr('通过') : tr('驳回');
      return n.approval.comment ? `${verdict}：${defuseRefs(n.approval.comment)}` : verdict;
    }
    const out = defuseRefs(n.output ?? '');
    if (out.length <= OUTPUT_LIMIT) return out;
    const sid = n.sessionIds?.[n.sessionIds.length - 1];
    return tr("{out}\n…（上游输出过长，已截断{v}）{v2}", { out: out.slice(0, OUTPUT_LIMIT), v: sid ? tr('，完整内容见下面引用的对话') : '', v2: sid ? tr("\n<session-ref id=\"{sid}\" title=\"上游节点 {id}\" />", { sid, id }) : '' });
  });
}

/** Safe for a directory name and a git ref component (`acp:x` has a colon, custom names may have spaces). */
export function agentSlug(a: string): string {
  return a.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
}

/** The ids of every node downstream of `id` (transitively). */
export function downstreamOf(nodes: OrchNode[], id: string): Set<string> {
  const out = new Set<string>();
  const walk = (x: string) => { for (const n of nodes) if (n.dependsOn.includes(x) && !out.has(n.id)) { out.add(n.id); walk(n.id); } };
  walk(id);
  return out;
}
