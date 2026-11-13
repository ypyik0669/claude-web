import { listSessions, getSessionMessages, getSubagentMessages, listSubagents, renameSession, deleteSession, getSessionInfo, forkSession, type SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { SessionSummary } from '../protocol.js';
import { watchTree, type TreeWatcher } from '../runtime/watch-tree.js';
import { findClaudeTranscript, hasClaudeTranscript, transcriptRoots } from '../runtime/transcript-file.js';
import { forkAnchor } from './fork-anchor.js';
import { closeSync, openSync, readFileSync, readSync, readdirSync, type Dirent } from 'node:fs';
import { TranscriptTitles, type Titles } from './titles.js';
import { BRIEFING_HEAD } from '../session/handoff.js';
import { tr } from '../i18n/index.js';
import { summaryFromFile, unlistedTranscripts } from './unlisted.js';
import { wslToWin } from '../wsl/paths.js';
import { unalias } from '../models/subagent.js';

export const claudeDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
export const projectsDir = path.join(claudeDir, 'projects');

/** Titles derive from the first prompt, which may carry attachment markers and pasted blobs — keep the human part. */
export function cleanTitle(t: string | undefined): string {
  if (!t) return '';
  return t.replace(/<attached\b[^>]*>[\s\S]*?<\/attached>/g, '').replace(/<attached\b[^>]*\/?>/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * The SDK's `summary` is the conversation's LAST prompt when nothing better exists, so right after a hand-over back to
 * Claude on ccb (the briefing goes in as a message) the list said 「# 会话交接 这个会话之前由 Codex 在跑…」 (real relay
 * retest, 2026-10-02). A briefing is never the title: the first prompt that is not one, else 「交接的对话」.
 */
export function listTitle(s: Pick<SDKSessionInfo, 'sessionId' | 'customTitle' | 'summary' | 'firstPrompt'>): string {
  if (s.customTitle) return s.customTitle;
  const said = [s.summary, s.firstPrompt].map(cleanTitle).filter(Boolean);
  const real = said.find((t) => !t.startsWith(BRIEFING_HEAD));
  return real || (said.length ? tr('交接的对话') : s.sessionId.slice(0, 8));
}

/**
 * The folder a transcript ran in, read past the SDK's head: our engine writes a user line's `message` before its `cwd`
 * and the queue-operation line before it carries the whole prompt, so a long first prompt (pasted text, an image) puts
 * the first `"cwd"` beyond the 64 KB the SDK reads — the list said 「(未知目录)」 (GitHub issue #9).
 */
export function cwdFromTranscript(file: string | null, maxBytes = 16 * 1024 * 1024): string {
  if (!file) return '';
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const chunk = Buffer.alloc(1 << 20);
    let carry = '';
    for (let pos = 0; pos < maxBytes; ) {
      const n = readSync(fd, chunk, 0, chunk.length, pos);
      if (n <= 0) break;
      pos += n;
      const text = carry + chunk.toString('utf8', 0, n);
      const m = /"cwd":("(?:[^"\\]|\\.)*")/.exec(text);
      if (m) return JSON.parse(m[1]) as string;
      carry = text.slice(-4096); // a key split across two reads
    }
  } catch { /* unreadable: unknown */ } finally { if (fd !== undefined) closeSync(fd); }
  return '';
}

/** A row's name once the whole transcript was read: a rename, the AI title, the first prompt (not a briefing). */
export function rowTitle(r: Pick<SessionSummary, 'sessionId' | 'title' | 'firstPrompt'>, t: Titles): string {
  if (t.custom) return t.custom;
  if (t.ai) return cleanTitle(t.ai) || r.title;
  const first = cleanTitle(r.firstPrompt);
  return first && !first.startsWith(BRIEFING_HEAD) ? first : r.title;
}

/** `<projects>/<dir>/<id>.jsonl` by id. */
function transcriptFiles(root: string): Map<string, string> {
  const out = new Map<string, string>();
  let dirs: Dirent[] = [];
  try { dirs = readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let files: string[] = [];
    try { files = readdirSync(path.join(root, d.name)); } catch { continue; }
    for (const f of files) if (f.endsWith('.jsonl')) out.set(f.slice(0, -6), path.join(root, d.name, f));
  }
  return out;
}

function toSummary(s: SDKSessionInfo): SessionSummary {
  return {
    sessionId: s.sessionId,
    title: listTitle(s),
    cwd: s.cwd || cwdFromTranscript(findClaudeTranscript(s.sessionId)),
    lastModified: s.lastModified,
    createdAt: s.createdAt,
    gitBranch: s.gitBranch,
    firstPrompt: s.firstPrompt,
    customTitle: s.customTitle,
  };
}

/** Session index over ~/.claude/projects. Emits 'changed' (debounced) on any jsonl write. */
/** A change under ~/.claude/projects that can change the session list: `<project>`, `<project>/<id>.jsonl`, `<project>/<id>`. */
export function transcriptEvent(rel: string): boolean {
  const parts = rel.split(/[\\/]/).filter(Boolean);
  if (!parts.length || parts.includes('memory')) return false;
  if (parts.length === 1) return true;
  return parts.length === 2 && (parts[1].endsWith('.jsonl') || path.extname(parts[1]) === '');
}

/** The conversation a change under ~/.claude/projects wrote to: `<project>/<id>.jsonl` → id (anything else: none). */
export function transcriptIdOf(rel: string): string | null {
  const parts = rel.split(/[\\/]/).filter(Boolean);
  return parts.length === 2 && parts[1].endsWith('.jsonl') ? parts[1].slice(0, -'.jsonl'.length) : null;
}

/** A fork's title: one (分叉) mark however deep the fork of a fork goes (it stacked: 「… (分叉) (分叉)」). */
export function forkTitle(title: string): string {
  return tr('{replace} (分叉)', { replace: title.replace(/(?:\s*\((?:分叉|fork)\))+\s*$/, '').trim() }).trim();
}

export class SessionService extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private watcher: TreeWatcher;
  private cache: SessionSummary[] | null = null;
  // How many the cache was fetched with (the `limit` passed to the SDK's listSessions, not
  // cache.length) — a later list() asking for more than this must re-scan, since the cache may be
  // missing sessions beyond what was originally fetched.
  private cacheLimit = 0;
  private gen = 0;

  private titles: TranscriptTitles;

  constructor(titlesCache?: string) {
    super();
    this.titles = new TranscriptTitles(titlesCache);
    // one recursive handle for the whole tree (see watchTree) — only a project dir, a transcript or a session dir
    // directly in it counts (not sub-agent logs, tool results, memory)
    this.watcher = watchTree(projectsDir, (rel) => {
      if (rel !== null && !transcriptEvent(rel)) return;
      const id = rel === null ? null : transcriptIdOf(rel);
      if (id) this.written.add(id);
      this.bump();
    });
  }

  /** Conversations written since the last 'changed' (a CLI in a terminal, ourselves): 'transcripts' names them. */
  private written = new Set<string>();

  private bump() {
    this.cache = null;
    this.cacheLimit = 0;
    this.gen++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.emit('changed');
      if (this.written.size) { const ids = [...this.written]; this.written.clear(); this.emit('transcripts', ids); }
    }, 800);
  }

  async list(limit = 500): Promise<SessionSummary[]> {
    if (this.cache && this.cacheLimit >= limit) return this.cache.slice(0, limit);
    // listSessions() without dir lists across all projects. Always ask for at least 2000 (the old
    // hardcoded cap) so small requests still cache generously, but never cap below what the caller
    // actually asked for (library sources like ClaudeSource want everything in one page).
    const fetchLimit = Math.max(2000, limit);
    const gen = this.gen;
    const all = await listSessions({ limit: fetchLimit });
    // + what the SDK skipped (a long first prompt and no title at the end: sessions/unlisted.ts)
    const ids = new Set(all.map((s) => s.sessionId));
    const extra = unlistedTranscripts(path.join(claudeDir, 'projects'), ids).map(summaryFromFile).filter((x): x is SessionSummary => !!x);
    // stage E5: conversations that ran in a WSL distro (its own ~/.claude/projects), their folder as Windows reaches it
    for (const root of transcriptRoots()) {
      if (!root.distro) continue;
      for (const x of unlistedTranscripts(root.dir, ids).map(summaryFromFile)) {
        if (!x || ids.has(x.sessionId)) continue;
        ids.add(x.sessionId);
        extra.push(x.cwd && x.cwd.startsWith('/') ? { ...x, cwd: wslToWin(x.cwd, root.distro) } : x);
      }
    }
    const out = [...all.map(toSummary), ...extra].sort((a, b) => b.lastModified - a.lastModified);
    this.applyTitles(out);
    // a write landed while we were scanning: this result may predate it, so don't pin it as the cache
    if (gen === this.gen) { this.cache = out; this.cacheLimit = fetchLimit; }
    return out.slice(0, limit);
  }

  /**
   * Every row's name from the whole transcript (titles.ts): a rename, else the AI title, else the first prompt — never
   * the latest prompt the SDK falls back to. Files read before are brought up to date here (only what was appended);
   * files never read are read in the background, then the list is told it changed.
   */
  private applyTitles(rows: SessionSummary[]) {
    const files = transcriptFiles(projectsDir);
    for (const r of rows) {
      const file = files.get(r.sessionId);
      if (!file) continue;
      const t = this.titles.known(file) ? this.titles.update(file) : undefined;
      if (t) r.title = rowTitle(r, t);
    }
    const unread = this.titles.unread([...files.values()]).filter((f) => !this.tried.has(f));
    for (const f of unread) this.tried.add(f);
    if (unread.length && !this.reading) {
      this.reading = true;
      void (async () => {
        try {
          for (const f of unread) {
            this.titles.update(f);
            await new Promise((ok) => setImmediate(ok));
          }
          this.titles.flush();
        } finally { this.reading = false; }
        this.bump();
      })();
    }
  }
  private reading = false;
  /** files the background read already took on (one that cannot be read is not tried on every list) */
  private tried = new Set<string>();

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
    if (!s) return undefined;
    const row = toSummary(s);
    const file = findClaudeTranscript(sessionId);
    if (file) row.title = rowTitle(row, this.titles.update(file) ?? {});
    return row;
  }

  async transcript(sessionId: string) {
    const info = await getSessionInfo(sessionId);
    if (!info) {
      // stage E5: a WSL conversation's transcript is outside this machine's ~/.claude: read the file, in the SDK's shape
      const file = findClaudeTranscript(sessionId);
      if (file && transcriptRoots().some((r) => r.distro && file.toLowerCase().startsWith(r.dir.toLowerCase()))) return readTranscriptFile(file, sessionId);
    }
    const dir = info?.cwd;
    return getSessionMessages(sessionId, { dir, includeSystemMessages: true });
  }

  async subagents(sessionId: string) {
    const info = await getSessionInfo(sessionId);
    return listSubagents(sessionId, { dir: info?.cwd });
  }

  async subagent(sessionId: string, agentId: string) {
    const info = await getSessionInfo(sessionId);
    const msgs = await getSubagentMessages(sessionId, agentId, { dir: info?.cwd });
    // through the subagent split route the engine recorded the alias it asked with: show the real model
    for (const m of msgs as any[]) if (m?.type === 'assistant' && typeof m.message?.model === 'string') m.message.model = unalias(m.message.model);
    return msgs;
  }

  /** Copy a transcript into a new session (optionally only up to a message), returning the new id. */
  async fork(sessionId: string, upToMessageId?: string): Promise<string> {
    const info = await getSessionInfo(sessionId);
    const named = info && (await this.info(sessionId));
    // a live conversation names a multi-block message by a per-block uuid the transcript does not have (fork-anchor.ts)
    const r = await forkSession(sessionId, { dir: info?.cwd, upToMessageId: forkAnchor(findClaudeTranscript(sessionId), upToMessageId), title: named ? forkTitle(named.title) : undefined });
    this.bump();
    return r.sessionId;
  }

  async rename(sessionId: string, title: string) {
    const info = await getSessionInfo(sessionId);
    // the title lives in the CLI's transcript, which only exists once the first message went out
    if (!info && !hasClaudeTranscript(sessionId)) throw new Error(tr('这个对话还没发过消息，发出第一条消息之后才能改名'));
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

  /** Every project folder's `<id>.jsonl` for a session (normally one) — the delete backup copies them all. */
  async locateAll(sessionId: string): Promise<string[]> {
    const dirs = await fs.readdir(projectsDir).catch(() => [] as string[]);
    const out: string[] = [];
    for (const d of dirs) {
      const p = path.join(projectsDir, d, `${sessionId}.jsonl`);
      if (await fs.access(p).then(() => true, () => false)) out.push(p);
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

/** A transcript file's user / assistant / system lines as getSessionMessages gives them (WSL conversations). */
function readTranscriptFile(file: string, sessionId: string): Awaited<ReturnType<typeof getSessionMessages>> {
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return []; }
  const out: any[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (e?.type !== 'user' && e?.type !== 'assistant' && e?.type !== 'system') continue;
    if (e.isSidechain) continue;
    out.push({ type: e.type, uuid: e.uuid, session_id: sessionId, message: e.message ?? { content: e.content }, parent_tool_use_id: null });
  }
  return out;
}
