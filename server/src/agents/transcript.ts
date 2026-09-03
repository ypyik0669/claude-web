import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { dataDir } from '../files/service.js';
import type { AgentKind, SessionSummary } from '../protocol.js';

interface Head { type: 'cw.meta'; agent: AgentKind; cwd: string; title: string; createdAt: number; sessionId: string; model?: string; nativeSessionId?: string }

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
    try {
      const rl = readline.createInterface({ input: createReadStream(this.file(sessionId), 'utf8'), crlfDelay: Infinity });
      for await (const line of rl) { rl.close(); const h = JSON.parse(line); return h?.type === 'cw.meta' ? h : null; }
    } catch { /* missing */ }
    return null;
  }

  async patchHead(sessionId: string, patch: Partial<Head>) {
    const f = this.file(sessionId);
    const text = await fs.readFile(f, 'utf8');
    const i = text.indexOf('\n');
    const head = { ...JSON.parse(text.slice(0, i)), ...patch };
    await fs.writeFile(f, JSON.stringify(head) + text.slice(i), 'utf8');
  }

  async exists(sessionId: string) { return !!(await fs.stat(this.file(sessionId)).catch(() => null)); }

  async load(sessionId: string): Promise<any[]> {
    const out: any[] = [];
    const rl = readline.createInterface({ input: createReadStream(this.file(sessionId), 'utf8'), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      try { const m = JSON.parse(line); if (m.type !== 'cw.meta') out.push(m); } catch { /* skip */ }
    }
    return out;
  }

  async remove(sessionId: string) { await fs.rm(this.file(sessionId), { force: true }); }

  async list(): Promise<SessionSummary[]> {
    const out: SessionSummary[] = [];
    const entries = await fs.readdir(this.dir).catch(() => [] as string[]);
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const sessionId = name.slice(0, -6);
      const [head, st] = await Promise.all([this.head(sessionId), fs.stat(path.join(this.dir, name))]);
      if (!head) continue;
      out.push({ sessionId, title: head.title || `${head.agent} 会话`, cwd: head.cwd, lastModified: st.mtimeMs, createdAt: head.createdAt, agent: head.agent, firstPrompt: head.title });
    }
    return out;
  }
}
