import type { AgentKind, SessionMeta, SessionSummary } from '@shared';

export interface SessionFilter {
  source: AgentKind | 'all';
  query: string;
  showArchived: boolean;
  meta: Record<string, SessionMeta>;
  /** federation: 'local' = this machine, a peer id = that machine; omitted / 'all' = every machine */
  machine?: string;
}

/** Sessions with no `agent` are Claude Code's. */
export const agentOf = (s: SessionSummary): AgentKind => s.agent ?? 'claude';

/** 'local' for this machine's sessions, else the peer id of the machine they live on. */
export const machineOf = (s: SessionSummary): string => s.peer?.id ?? 'local';

export interface MachineCount { id: string; name: string; n: number; offline?: boolean }

/** 「本机」 first, then every machine that has sessions in the list (children excluded), for the machine chips. */
export function machineCounts(all: SessionSummary[]): MachineCount[] {
  const out = new Map<string, MachineCount>([['local', { id: 'local', name: '本机', n: 0 }]]);
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
 * `childCount`. The query matches title, first prompt and directory, case-insensitively.
 */
export function filterSessions(all: SessionSummary[], o: SessionFilter): SessionSummary[] {
  const q = o.query.trim().toLowerCase();
  return all.filter((s) => {
    if (s.parentId) return false;
    if (o.source !== 'all' && agentOf(s) !== o.source) return false;
    if (o.machine && o.machine !== 'all' && machineOf(s) !== o.machine) return false;
    if (!o.showArchived && isArchived(s, o.meta)) return false;
    return !q || `${s.title} ${s.firstPrompt ?? ''} ${s.cwd}`.toLowerCase().includes(q);
  });
}

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

/** A parent's child sessions (forks / sub-agent threads), newest first, following the archive toggle. */
export function childrenOf(all: SessionSummary[], parentId: string, o: Pick<SessionFilter, 'showArchived' | 'meta'>): SessionSummary[] {
  return all.filter((s) => s.parentId === parentId && (o.showArchived || !isArchived(s, o.meta))).sort((a, b) => b.lastModified - a.lastModified);
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
