// Claude session source: the trivial SessionSource wrapper around SessionService (the SDK-backed
// index over ~/.claude/projects). Unlike every other source, Claude keeps its native UUID session
// ids as-is (constraints.md) and is always joined — it isn't part of the opt-in join/dismiss flow.
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentKind, SessionSummary, SourceCaps, SourceStatus } from '../protocol.js';
import type { SessionService } from '../sessions/service.js';
import type { SessionSource } from './types.js';

// Archiving Claude sessions is handled via meta (LibraryService, task 8), not an official
// SessionsService API, so caps.archive stays false and there is no archive() method here.
const CAPS: SourceCaps = { resume: true, rename: true, archive: false, delete: true, fork: true };

// SessionsService.list() defaults to 500; the library wants everything in one page (no cursor).
const LIST_ALL = 100_000;

export class ClaudeSource implements SessionSource {
  readonly kind: AgentKind = 'claude';
  readonly caps: SourceCaps = CAPS;

  constructor(private readonly sessions: SessionService) {}

  async status(): Promise<SourceStatus> {
    return { kind: this.kind, name: 'Claude Code', installed: true, detected: true, joined: true, dismissed: false, enabled: true };
  }

  async list(_o: { cursor?: string; limit: number; archived?: boolean }): Promise<{ items: SessionSummary[]; next?: string }> {
    const all = await this.sessions.list(LIST_ALL);
    const items = all.map((s) => ({ ...s, agent: s.agent ?? ('claude' as AgentKind), caps: CAPS }));
    return { items }; // no cursor: this is everything
  }

  async read(nativeId: string, _o: { cursor?: string; limit: number }): Promise<{ messages: any[]; next?: string }> {
    const messages = await this.sessions.transcript(nativeId);
    return { messages }; // the whole transcript in one page, no next
  }

  async rename(nativeId: string, title: string): Promise<void> {
    await this.sessions.rename(nativeId, title);
  }

  async remove(nativeId: string): Promise<void> {
    await this.sessions.delete(nativeId);
  }

  async fork(nativeId: string): Promise<string> {
    return this.sessions.fork(nativeId);
  }

  /** Full transcript — a backup before delete (constraints.md). */
  async exportAll(nativeId: string): Promise<unknown> {
    return this.sessions.transcript(nativeId);
  }

  /**
   * Raw copy of what `deleteSession` removes: `<project>/<id>.jsonl` (every entry, sidechains and
   * non-message lines included) and the `<project>/<id>/` directory (subagents/…), per project
   * folder, into `destDir/<project folder>/`. Read-only on the source side.
   */
  async backupTo(nativeId: string, destDir: string): Promise<void> {
    const files = await this.sessions.locateAll(nativeId);
    if (!files.length) throw new Error(`找不到会话文件 ${nativeId}.jsonl，未删除`);
    for (const file of files) {
      const to = path.join(destDir, path.basename(path.dirname(file)));
      await fs.mkdir(to, { recursive: true });
      await fs.copyFile(file, path.join(to, path.basename(file)));
      const side = path.join(path.dirname(file), nativeId);
      if (await fs.stat(side).then((st) => st.isDirectory(), () => false)) await fs.cp(side, path.join(to, nativeId), { recursive: true });
    }
  }

  async close(): Promise<void> {
    // SessionService's chokidar watcher is shared/owned elsewhere (hub-level); nothing to tear down here.
  }
}
