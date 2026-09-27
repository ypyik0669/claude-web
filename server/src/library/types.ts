// Session library (Task 3+): the read/write surface every non-Claude session source implements.
// Claude itself doesn't go through this — it already has SessionsService — but every foreign
// source (Codex, OpenCode, …) is adapted to this shape so LibraryService (Task 8) can treat them
// uniformly. Optional methods reflect a source's own official API surface: only implement what the
// source truly supports (see constraints.md — never write to an agent's data files directly).
import type { AgentKind, SessionSummary, SourceCaps, SourceStatus } from '../protocol.js';

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
  close(): Promise<void>;
}
