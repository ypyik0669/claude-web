import type { AgentKind, SessionMeta, SessionSummary } from '@shared';
import { tr } from '@/i18n';

export interface SessionFilter {
  source: AgentKind | 'all';
  query: string;
  showArchived: boolean;
  meta: Record<string, SessionMeta>;
  /** federation: 'local' = this machine, a peer id = that machine; omitted / 'all' = every machine */
  machine?: string;
  /** 显示 → 其它 agent 的对话 (off: Claude's only, unless a source is picked) */
  otherAgents?: boolean;
}

/** Sessions with no `agent` are Claude Code's. */
export const agentOf = (s: SessionSummary): AgentKind => s.agent ?? 'claude';

/** 'local' for this machine's sessions, else the peer id of the machine they live on. */
export const machineOf = (s: SessionSummary): string => s.peer?.id ?? 'local';

export interface MachineCount { id: string; name: string; n: number; offline?: boolean }

/** 「本机」 first, then every machine that has sessions in the list (children excluded), for the machine chips. */
export function machineCounts(all: SessionSummary[]): MachineCount[] {
  const out = new Map<string, MachineCount>([['local', { id: 'local', name: tr('本机'), n: 0 }]]);
  for (const s of all) {
    if (s.parentId) continue;
    const id = machineOf(s);
    const cur = out.get(id) ?? { id, name: s.peer?.name ?? id, n: 0, ...(s.peer?.offline ? { offline: true } : {}) };
    cur.n++;
    out.set(id, cur);
  }
  return [...out.values()];
}

/** Archived either natively (the source's own flag) or in claude-web's meta (Claude has no archive flag). */
export const isArchived = (s: SessionSummary, meta: Record<string, SessionMeta>) => !!(s.archived || meta[s.sessionId]?.archived);

/**
 * What the sidebar lists. Children (`parentId`) never show on their own — their parent carries
 * `childCount`. The query matches the title and the folder's own name, case-insensitively — not the whole first prompt
 * (a long plan mentions everything) nor the path's parents (GitHub issue #7: 「测试」 listed every conversation under a
 * 测试 folder's parent and every plan that said 测试).
 */
export function filterSessions(all: SessionSummary[], o: SessionFilter): SessionSummary[] {
  return all.filter((s) => !s.parentId && passes(s, o));
}

/** `filterSessions`' test of one conversation, its parent link aside (a fork shown under its root is tested by it too). */
export function passes(s: SessionSummary, o: SessionFilter): boolean {
  const q = o.query.trim().toLowerCase();
  if (o.source !== 'all' && agentOf(s) !== o.source) return false;
  if (o.source === 'all' && o.otherAgents === false && agentOf(s) !== 'claude') return false;
  if (o.machine && o.machine !== 'all' && machineOf(s) !== o.machine) return false;
  if (!o.showArchived && isArchived(s, o.meta)) return false;
  return !q || s.title.toLowerCase().includes(q) || folderName(s.cwd).toLowerCase().includes(q);
}

/** A root with more forks / side conversations than this starts with them folded (Codex threads can spawn dozens). */
export const KIDS_SHOWN = 3;

export interface Families {
  /** a root's forks / side conversations (one level, however deep they were made), newest first */
  kids: Map<string, SessionSummary[]>;
  /** each of those → its root */
  rootOf: Map<string, string>;
}

/**
 * Forks and side conversations sit one level under the conversation they came from (redesign 2026-11 stage 3). A
 * conversation's root is the top of its chain: its `parentId` (Codex / OpenCode sub-agent threads, forks a source
 * reports — the server sends those with the list) or, for a Claude conversation forked here, the conversation its
 * prompt-cache key names (`SessionMeta.cacheKey`: a fork keeps its root's key so it routes like it). Only a root that
 * the list shows (`tops`, already filtered) takes kids, and a kid must pass the same filter itself (`o`, its parent
 * link aside): one that does while its root does not stays a row of its own (a Claude fork) or is not listed (a
 * `parentId` child never shows alone). A pinned conversation stays a row of its own (in 置顶); a cycle stops where it
 * started.
 */
export function families(all: SessionSummary[], tops: SessionSummary[], o: SessionFilter): Families {
  const byId = new Map(all.map((s) => [s.sessionId, s]));
  const shown = new Set(tops.map((s) => s.sessionId));
  const up = (s: SessionSummary): SessionSummary | undefined => {
    const k = s.parentId ?? o.meta[s.sessionId]?.cacheKey;
    return k && k !== s.sessionId ? byId.get(k) : undefined;
  };
  const kids = new Map<string, SessionSummary[]>();
  const rootOf = new Map<string, string>();
  for (const s of all) {
    if (o.meta[s.sessionId]?.pinned) continue;
    let root = s;
    const seen = new Set([s.sessionId]);
    for (let p = up(s); p && !seen.has(p.sessionId); p = up(p)) { seen.add(p.sessionId); root = p; }
    if (root === s || !shown.has(root.sessionId) || !passes(s, o)) continue;
    const list = kids.get(root.sessionId);
    if (list) list.push(s); else kids.set(root.sessionId, [s]);
    rootOf.set(s.sessionId, root.sessionId);
  }
  for (const list of kids.values()) list.sort((a, b) => b.lastModified - a.lastModified);
  return { kids, rootOf };
}

const folderName = (cwd: string) => cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';

/** Sessions per agent kind (children excluded), for the source filter chips. */
export function sourceCounts(all: SessionSummary[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of all) {
    if (s.parentId) continue;
    const k = agentOf(s);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

export interface RowGroup { key: string; items: SessionSummary[]; collapsed: boolean }

export interface RowOptions {
  /** rows that stay on screen past the group's cut (the active one, a running one) */
  keep?: (s: SessionSummary) => boolean;
  /** an expanded parent's child sessions, drawn right under it */
  kids?: (s: SessionSummary) => SessionSummary[];
}

/**
 * The session rows the sidebar actually renders: expanded groups only, each cut at its page limit
 * (`shown[key]`, default `first`) plus the rows `keep` holds in view, with expanded children after their parent.
 * Multi-select (全选, Shift ranges) acts on exactly these — never on rows the user can't see.
 */
export function renderedRows(groups: RowGroup[], shown: Record<string, number>, first = 25, o: RowOptions = {}): SessionSummary[] {
  const out: SessionSummary[] = [];
  const seen = new Set<string>();
  const add = (s: SessionSummary) => { if (seen.has(s.sessionId)) return; seen.add(s.sessionId); out.push(s); };
  for (const g of groups) {
    if (g.collapsed) continue;
    const limit = shown[g.key] ?? first;
    const rows = g.items.slice(0, limit);
    if (o.keep) for (const s of g.items.slice(limit)) if (o.keep(s)) rows.push(s);
    for (const s of rows) {
      add(s);
      for (const k of o.kids?.(s) ?? []) add(k);
    }
  }
  return out;
}

/**
 * What narrows the list, as short words (「Codex · Box B · “login”」); empty = nothing is hidden by a filter.
 * 显示已归档 is not in it: it adds conversations, it hides none (empty projects stay, 清除 leaves it alone).
 */
export function filterSummary(
  f: { source: AgentKind | 'all'; machine: string; query: string },
  sourceName: (kind: string) => string,
  machineName: (id: string) => string,
): string[] {
  const out: string[] = [];
  if (f.source !== 'all') out.push(sourceName(f.source));
  if (f.machine !== 'all') out.push(machineName(f.machine));
  const q = f.query.trim();
  if (q) out.push(`“${q}”`);
  return out;
}
