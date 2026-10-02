import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { dataDir } from '../files/service.js';
import { hasClaudeTranscript } from '../runtime/transcript-file.js';
import type { AgentKind, SessionSummary } from '../protocol.js';

// `imported`: a pointer head created by LibraryService.prepareResume for a session that lives in the
// agent's own store (Codex / OpenCode / ACP) — its history is always read back from the agent.
export interface Head { type: 'cw.meta'; agent: AgentKind; cwd: string; title: string; createdAt: number; sessionId: string; model?: string; nativeSessionId?: string; imported?: boolean }

/**
 * Transcripts for non-Claude agents live under ~/.claude-web/agents/<sessionId>.jsonl in the same
 * SDK message shape as Claude's, first line = metadata. `SessionService.list()` merges them in.
 */
export class AgentTranscripts {
  private dir = path.join(dataDir(), 'agents');
  private writers = new Map<string, Promise<void>>();

  file(sessionId: string) { return path.join(this.dir, `${sessionId}.jsonl`); }

  async create(head: Omit<Head, 'type'>) {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.file(head.sessionId), JSON.stringify({ type: 'cw.meta', ...head }) + '\n', 'utf8');
  }

  append(sessionId: string, m: unknown) {
    const line = JSON.stringify({ ...(m as object), timestamp: (m as any).timestamp ?? new Date().toISOString() }) + '\n';
    const prev = this.writers.get(sessionId) ?? Promise.resolve();
    // never write before the head exists — a headless file would look like a session without cwd/agent
    const next = prev.then(async () => { if (await this.exists(sessionId)) await fs.appendFile(this.file(sessionId), line, 'utf8'); }).catch(() => {});
    this.writers.set(sessionId, next);
  }

  async head(sessionId: string): Promise<Head | null> {
    return headOf(this.file(sessionId));
  }

  /** Rewrites the whole file, so it queues behind (and ahead of) append() — otherwise a line appended between our read and write is lost. */
  async patchHead(sessionId: string, patch: Partial<Head>) {
    const f = this.file(sessionId);
    const prev = this.writers.get(sessionId) ?? Promise.resolve();
    const run = prev.then(async () => {
      const text = await fs.readFile(f, 'utf8');
      const i = text.indexOf('\n');
      const head = { ...JSON.parse(text.slice(0, i)), ...patch };
      await fs.writeFile(f, JSON.stringify(head) + text.slice(i), 'utf8');
    });
    this.writers.set(sessionId, run.catch(() => {}));
    return run;
  }

  async exists(sessionId: string) { return !!(await fs.stat(this.file(sessionId)).catch(() => null)); }

  async load(sessionId: string): Promise<any[]> {
    await this.writers.get(sessionId); // a turn's last lines may still be queued when the client asks right after `result`
    const out: any[] = [];
    const rl = readline.createInterface({ input: createReadStream(this.file(sessionId), 'utf8'), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      try { const m = JSON.parse(line); if (m.type !== 'cw.meta') out.push(m); } catch { /* skip */ }
    }
    return out;
  }

  async remove(sessionId: string) { await fs.rm(this.file(sessionId), { force: true }); }

  private parked(sessionId: string, agent: AgentKind) { return `${this.file(sessionId)}.parked-${agent.replace(/[^A-Za-z0-9_-]/g, '~')}`; }

  /**
   * Handed back to Claude: the other agent's mirror steps aside — out of the list and out of `session.open`'s agent
   * lookup, which kept reopening the conversation as that agent (Codex on Claude's provider, 503 ×28; 2026-10-01) —
   * and is kept, native thread pointer and all, for a later hand-over back to the same agent.
   */
  async park(sessionId: string): Promise<void> {
    await this.writers.get(sessionId);
    const h = await this.head(sessionId);
    if (!h || h.imported) return;
    await fs.rename(this.file(sessionId), this.parked(sessionId, h.agent)).catch(() => { /* gone already */ });
  }

  /** The mirror `park` set aside for `agent`, back in place (true) — unless one is already there. */
  async unpark(sessionId: string, agent: AgentKind): Promise<boolean> {
    if (await this.exists(sessionId)) return false;
    return fs.rename(this.parked(sessionId, agent), this.file(sessionId)).then(() => true, () => false);
  }

  async list(): Promise<SessionSummary[]> {
    return (await this.entries()).map((e) => e.summary);
  }

  /** Like list(), plus each file's head (the library needs `nativeSessionId` / `imported` to dedupe). */
  async entries(): Promise<{ summary: SessionSummary; head: Head }[]> {
    const out: { summary: SessionSummary; head: Head }[] = [];
    const entries = await fs.readdir(this.dir).catch(() => [] as string[]);
    const live = new Set(entries.filter((n) => n.endsWith('.jsonl')).map((n) => n.slice(0, -6)));
    const parked = new Map<string, { head: Head; mtime: number }>();
    for (const name of entries) {
      const p = /^(.+)\.jsonl\.parked-.+$/.exec(name);
      if (p) {
        // handed back to Claude, which has no transcript of its own yet (the official binary writes one with the
        // next prompt; ccb's briefing turn may not have run): the conversation stays listed, as Claude's, until it does
        const sessionId = p[1];
        if (live.has(sessionId) || hasClaudeTranscript(sessionId)) continue;
        const [head, st] = await Promise.all([headOf(path.join(this.dir, name)), fs.stat(path.join(this.dir, name))]);
        if (head && !head.imported && st.mtimeMs > (parked.get(sessionId)?.mtime ?? -1)) parked.set(sessionId, { head, mtime: st.mtimeMs });
        continue;
      }
      if (!name.endsWith('.jsonl')) continue;
      const sessionId = name.slice(0, -6);
      const [head, st] = await Promise.all([this.head(sessionId), fs.stat(path.join(this.dir, name))]);
      if (!head) continue;
      out.push({ head, summary: { sessionId, title: head.title || `${head.agent} 对话`, cwd: head.cwd, lastModified: st.mtimeMs, createdAt: head.createdAt, agent: head.agent, firstPrompt: head.title } });
    }
    for (const [sessionId, { head, mtime }] of parked) {
      const asClaude: Head = { ...head, agent: 'claude', nativeSessionId: undefined };
      out.push({ head: asClaude, summary: { sessionId, title: head.title || '交接的对话', cwd: head.cwd, lastModified: mtime, createdAt: head.createdAt, agent: 'claude', firstPrompt: head.title } });
    }
    return out;
  }
}

async function headOf(file: string): Promise<Head | null> {
  try {
    const rl = readline.createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
    for await (const line of rl) { rl.close(); const h = JSON.parse(line); return h?.type === 'cw.meta' ? h : null; }
  } catch { /* missing */ }
  return null;
}
