import type { SessionSummary, SourceCaps } from '@shared';
import { isImportedSessionId, nativeSessionId } from '@/util';
import { agentOf } from './filter';

/**
 * What the session menus and the multi-select toolbar may offer for a session. Pure (no store), so it
 * is unit-tested. The session's `caps` come from its source's official APIs; Claude and claude-web's
 * own agent sessions archive in claude-web's meta, since Claude Code has no archive flag.
 */

export interface EffectiveCaps extends SourceCaps {
  /** where archive goes: the source's own API, or claude-web's meta */
  archiveVia: 'library' | 'meta' | null;
}

export function effectiveCaps(s: SessionSummary): EffectiveCaps {
  // a machine that is offline right now: its rows come from the last cached list and are read-only
  if (s.peer?.offline) return { resume: false, rename: false, archive: false, delete: false, fork: false, archiveVia: null };
  const imported = isImportedSessionId(s.sessionId);
  // claude-web's own sessions (Claude, or an agent it drove itself) predate caps: everything works
  const c: SourceCaps = s.caps ?? { resume: true, rename: true, archive: false, delete: !imported, fork: !imported };
  const archiveVia = c.archive ? 'library' : !imported ? 'meta' : null;
  return { ...c, archive: !!archiveVia, archiveVia };
}

/** Caps every selected session supports (the multi-select toolbar only offers these). */
export function capsIntersection(list: SessionSummary[]): { archive: boolean; delete: boolean } {
  return { archive: list.length > 0 && list.every((s) => effectiveCaps(s).archive), delete: list.length > 0 && list.every((s) => effectiveCaps(s).delete) };
}

/** Command that resumes this session in the agent's own CLI, or null when there is no such flag. */
export function nativeCliCommand(s: SessionSummary): string | null {
  const kind = agentOf(s);
  if (s.peer) return null; // lives on another machine: its CLI and files are there
  if (!isImportedSessionId(s.sessionId)) return kind === 'claude' ? `claude --resume ${s.sessionId}` : null; // an agent claude-web drove: its native id is not the session id
  if (kind === 'codex') return `codex resume ${nativeSessionId(s.sessionId)}`;
  if (kind === 'opencode') return `opencode --session ${nativeSessionId(s.sessionId)}`;
  return null;
}

/** 「将删除 12 个会话（Codex 8、Claude Code 4）」 — the count and where they are deleted from, biggest source first. */
export function deleteSummary(list: SessionSummary[], nameOf: (kind: string) => string): string {
  const by = new Map<string, number>();
  for (const s of list) by.set(agentOf(s), (by.get(agentOf(s)) ?? 0) + 1);
  const parts = [...by.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${nameOf(k)} ${n}`);
  return `将删除 ${list.length} 个会话（${parts.join('、')}）`;
}

/**
 * Where a delete actually removes things, for the second confirm: an imported session from its
 * source, a Claude session from Claude Code, claude-web's own agent session from Claude Web — and a
 * merged one (claude-web's session that continued a joined source's session, `mergedFrom`) ALSO
 * from that source when the source can delete (the server removes both).
 */
export function deleteTargets(list: SessionSummary[], nameOf: (kind: string) => string): string {
  const from = new Set<string>();
  const also = new Set<string>();
  for (const s of list) {
    const kind = agentOf(s);
    if (s.peer) from.add(`机器「${s.peer.name}」`);
    else if (isImportedSessionId(s.sessionId)) from.add(nameOf(kind));
    else if (kind === 'claude') from.add(nameOf('claude'));
    else {
      from.add('Claude Web');
      if (s.mergedFrom && s.caps?.delete) also.add(nameOf(kind));
    }
  }
  const head = `从 ${[...from].join('、')} 删除`;
  return also.size ? `${head}，并同时从 ${[...also].join('、')} 删除它的原始记录` : head;
}
