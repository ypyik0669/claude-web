import { listSessions, getSessionMessages, getSubagentMessages, listSubagents, renameSession, deleteSession, getSessionInfo, forkSession, type SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import chokidar from 'chokidar';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { SessionSummary } from '../protocol.js';

export const claudeDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
export const projectsDir = path.join(claudeDir, 'projects');

function toSummary(s: SDKSessionInfo): SessionSummary {
  return {
    sessionId: s.sessionId,
    title: s.customTitle || s.summary || s.firstPrompt || s.sessionId.slice(0, 8),
    cwd: s.cwd ?? '',
    lastModified: s.lastModified,
    createdAt: s.createdAt,
    gitBranch: s.gitBranch,
    firstPrompt: s.firstPrompt,
    customTitle: s.customTitle,
  };
}

/** Session index over ~/.claude/projects. Emits 'changed' (debounced) on any jsonl write. */
export class SessionService extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private cache: SessionSummary[] | null = null;

  constructor() {
    super();
    const w = chokidar.watch(projectsDir, { ignoreInitial: true, depth: 1, ignored: (p: string) => p.includes(`${path.sep}memory`) || (!p.endsWith('.jsonl') && path.extname(p) !== '') });
    w.on('all', () => this.bump());
  }

  private bump() {
    this.cache = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.emit('changed'), 800);
  }

  async list(limit = 500): Promise<SessionSummary[]> {
    if (this.cache) return this.cache.slice(0, limit);
    // listSessions() without dir lists across all projects
    const all = await listSessions({ limit: 2000 });
    const out = all.map(toSummary).sort((a, b) => b.lastModified - a.lastModified);
    this.cache = out;
    return out.slice(0, limit);
  }

  async projects(): Promise<{ cwd: string; slug: string; count: number; lastModified: number }[]> {
    const sessions = await this.list(5000);
    const m = new Map<string, { cwd: string; slug: string; count: number; lastModified: number }>();
    for (const s of sessions) {
      const key = s.cwd || '(unknown)';
      const e = m.get(key) ?? { cwd: key, slug: key.replace(/[^a-zA-Z0-9]/g, '-'), count: 0, lastModified: 0 };
      e.count++;
      e.lastModified = Math.max(e.lastModified, s.lastModified);
      m.set(key, e);
    }
    return [...m.values()].sort((a, b) => b.lastModified - a.lastModified);
  }

  async info(sessionId: string) {
    const s = await getSessionInfo(sessionId);
    return s ? toSummary(s) : undefined;
  }

  async transcript(sessionId: string) {
    const info = await getSessionInfo(sessionId);
    const dir = info?.cwd;
    return getSessionMessages(sessionId, { dir, includeSystemMessages: true });
  }

  async subagents(sessionId: string) {
    const info = await getSessionInfo(sessionId);
    return listSubagents(sessionId, { dir: info?.cwd });
  }

  async subagent(sessionId: string, agentId: string) {
    const info = await getSessionInfo(sessionId);
    return getSubagentMessages(sessionId, agentId, { dir: info?.cwd });
  }

  /** Copy a transcript into a new session (optionally only up to a message), returning the new id. */
  async fork(sessionId: string, upToMessageId?: string): Promise<string> {
    const info = await getSessionInfo(sessionId);
    const r = await forkSession(sessionId, { dir: info?.cwd, upToMessageId, title: info ? `${info.customTitle || info.summary || info.firstPrompt || ''} (分叉)`.trim() : undefined });
    this.bump();
    return r.sessionId;
  }

  async rename(sessionId: string, title: string) {
    const info = await getSessionInfo(sessionId);
    await renameSession(sessionId, title, { dir: info?.cwd });
    this.bump();
  }

  async delete(sessionId: string) {
    const info = await getSessionInfo(sessionId);
    await deleteSession(sessionId, { dir: info?.cwd });
    this.bump();
  }

  /** Title/first-prompt match first, then a bounded full-text scan of recent transcripts. */
  async search(query: string, limit = 30): Promise<{ session: SessionSummary; snippet?: string }[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const all = await this.list(5000);
    const out: { session: SessionSummary; snippet?: string }[] = [];
    const seen = new Set<string>();
    for (const s of all) {
      if (`${s.title} ${s.firstPrompt ?? ''} ${s.cwd}`.toLowerCase().includes(q)) {
        out.push({ session: s });
        seen.add(s.sessionId);
        if (out.length >= limit) return out;
      }
    }
    // full text over the 150 most recent transcripts, user/assistant text only
    for (const s of all.slice(0, 150)) {
      if (seen.has(s.sessionId)) continue;
      const file = await this.locate(s.sessionId);
      if (!file) continue;
      let txt: string;
      try {
        txt = await fs.readFile(file, 'utf8');
      } catch {
        continue;
      }
      if (!txt.toLowerCase().includes(q)) continue;
      // only real user/assistant text — not system reminders, tool schemas or hook output
      let snippet: string | undefined;
      for (const line of txt.split('\n')) {
        if (!line.toLowerCase().includes(q) || line.includes('"isMeta":true')) continue;
        let rec: any;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        if (rec.type !== 'user' && rec.type !== 'assistant') continue;
        const content = rec.message?.content;
        const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n') : '';
        if (/^<(command-name|local-command|system-reminder|task-notification)/.test(text.trim())) continue;
        const i = text.toLowerCase().indexOf(q);
        if (i < 0) continue;
        snippet = text.slice(Math.max(0, i - 50), i + 70).replace(/\s+/g, ' ');
        break;
      }
      if (!snippet) continue;
      out.push({ session: s, snippet });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Locate the jsonl file for a session (for usage aggregation / file history). */
  async locate(sessionId: string): Promise<string | undefined> {
    const dirs = await fs.readdir(projectsDir).catch(() => []);
    for (const d of dirs) {
      const p = path.join(projectsDir, d, `${sessionId}.jsonl`);
      try {
        await fs.access(p);
        return p;
      } catch {
        /* next */
      }
    }
    return undefined;
  }
}
