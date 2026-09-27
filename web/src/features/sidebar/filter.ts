import type { AgentKind, SessionMeta, SessionSummary } from '@shared';

export interface SessionFilter {
  source: AgentKind | 'all';
  query: string;
  showArchived: boolean;
  meta: Record<string, SessionMeta>;
}

/** Sessions with no `agent` are Claude Code's. */
export const agentOf = (s: SessionSummary): AgentKind => s.agent ?? 'claude';

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
