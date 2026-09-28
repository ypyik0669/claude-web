// Pure workflow logic: validation, layering, prompt templates, judge verdicts. No I/O — unit tested.
import type { AgentKind } from '../protocol.js';
import type { NodeRun, OrchNode } from './types.js';

/** Upstream outputs longer than this are cut and followed by a `<session-ref>` (expanded into a briefing). */
export const OUTPUT_LIMIT = 8000;

/** Every agent a node would start (task agent, compare candidates, judge). */
export function nodeAgents(n: OrchNode): AgentKind[] {
  if (n.kind === 'task') return [n.agent];
  if (n.kind === 'compare') return [...n.agents, ...(n.judge ? [n.judge] : [])];
  return [];
}

/**
 * Save-time checks. Returns human-readable (Chinese) problems; empty = valid.
 * `available`, when given, is the list of installed + enabled agents — the only ones a run may start.
 */
export function validateWorkflow(w: { nodes: OrchNode[] }, o: { isGitRepo: boolean; available?: AgentKind[] }): string[] {
  const errs: string[] = [];
  if (!w.nodes.length) return ['工作流至少要有一个节点'];
  const ids = new Set<string>();
  for (const n of w.nodes) {
    if (!n.id || !/^[A-Za-z0-9_-]+$/.test(n.id)) errs.push(`节点 id「${n.id}」只能用字母、数字、_ 和 -`);
    if (ids.has(n.id)) errs.push(`节点 id 重复：${n.id}`);
    ids.add(n.id);
  }
  for (const n of w.nodes) {
    const label = n.title || n.id;
    if (!['task', 'compare', 'approval'].includes((n as { kind: string }).kind)) { errs.push(`「${label}」的类型 ${(n as { kind: string }).kind} 不认识（只能是 task / compare / approval）`); continue; }
    for (const d of n.dependsOn ?? []) if (!ids.has(d)) errs.push(`「${label}」依赖的节点 ${d} 不存在`);
    if (n.kind === 'task') {
      if (!n.prompt?.trim()) errs.push(`「${label}」没有提示词`);
      if (!n.agent) errs.push(`「${label}」没有选 agent`);
      if (n.workspace === 'worktree' && !o.isGitRepo) errs.push(`「${label}」要用独立 worktree，但工作目录不是 git 仓库`);
    } else if (n.kind === 'compare') {
      if (!n.prompt?.trim()) errs.push(`「${label}」没有提示词`);
      if (new Set(n.agents ?? []).size < 2 || new Set(n.agents).size !== n.agents.length) errs.push(`「${label}」比选至少要 2 个不同的 agent`);
      if (!o.isGitRepo) errs.push(`「${label}」比选要在各自的 worktree 里做，但工作目录不是 git 仓库`);
    }
    if (o.available) for (const a of nodeAgents(n)) if (!o.available.includes(a)) errs.push(`「${label}」用到的 agent ${a} 没有安装或没有启用`);
  }
  const cyc = findCycle(w.nodes);
  if (cyc) errs.push(`依赖有环：${cyc.join(' → ')}`);
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
      const verdict = n.approval.decision === 'approve' ? '通过' : '驳回';
      return n.approval.comment ? `${verdict}：${defuseRefs(n.approval.comment)}` : verdict;
    }
    const out = defuseRefs(n.output ?? '');
    if (out.length <= OUTPUT_LIMIT) return out;
    const sid = n.sessionIds?.[n.sessionIds.length - 1];
    return `${out.slice(0, OUTPUT_LIMIT)}\n…（上游输出过长，已截断${sid ? '，完整内容见下面引用的对话' : ''}）${sid ? `\n<session-ref id="${sid}" title="上游节点 ${id}" />` : ''}`;
  });
}

/** The judge is asked to end with `WINNER: <agent>`; the last such line naming a real candidate wins. */
export function parseWinner(text: string, candidates: AgentKind[]): AgentKind | undefined {
  const hits = [...text.matchAll(/WINNER:\s*[`"'*]*([A-Za-z0-9:_.~ -]+?)[`"'*]*\s*$/gim)];
  for (let i = hits.length - 1; i >= 0; i--) {
    const v = hits[i][1].trim();
    const c = candidates.find((a) => a.toLowerCase() === v.toLowerCase());
    if (c) return c;
  }
  return undefined;
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
