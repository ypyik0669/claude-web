// Session library (Task 3+): the read/write surface every non-Claude session source implements.
// Claude itself doesn't go through this — it already has SessionsService — but every foreign
// source (Codex, OpenCode, …) is adapted to this shape so LibraryService (Task 8) can treat them
// uniformly. Optional methods reflect a source's own official API surface: only implement what the
// source truly supports (see constraints.md — never write to an agent's data files directly).
import type { AgentKind, SessionSummary, SourceCaps, SourceStatus } from '../protocol.js';

/**
 * The agent's executable isn't there at all (spawn ENOENT) — the one failure a source reports as
 * "nothing to list". Everything else (crash, RPC error, HTTP error, timeout) must throw, so the
 * library can tell a transient failure from an empty source and keep its last good list.
 */
export function isNotInstalled(e: unknown): boolean {
  const err = e as { code?: unknown; message?: unknown } | null;
  return err?.code === 'ENOENT' || /ENOENT/.test(String(err?.message ?? ''));
}

export interface SessionSource {
  kind: AgentKind;
  caps: SourceCaps;
  status(): Promise<SourceStatus>;
  list(o: { cursor?: string; limit: number; archived?: boolean }): Promise<{ items: SessionSummary[]; next?: string }>;
  read(nativeId: string, o: { cursor?: string; limit: number }): Promise<{ messages: any[]; next?: string }>;
  rename?(nativeId: string, title: string): Promise<void>;
  archive?(nativeId: string, archived: boolean): Promise<void>;
  remove?(nativeId: string): Promise<void>;
  fork?(nativeId: string): Promise<string>; // returns the new native id
  exportAll?(nativeId: string): Promise<unknown>; // full backup before delete
  /**
   * Raw backup before delete: a read-only copy of the agent's own files for this session into
   * `destDir` (preferred over exportAll when present — e.g. Claude, whose delete also removes the
   * `<id>/` side directory with sub-agent transcripts that no message API returns). Must throw if
   * nothing could be copied.
   */
  backupTo?(nativeId: string, destDir: string): Promise<void>;
  close(): Promise<void>;
}
