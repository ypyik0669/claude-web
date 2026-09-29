// FTS5 search index for the unified session library (Task 7). One row per session summary plus a
// text excerpt (capped at 20 000 chars) so the library can search across every joined source without
// re-reading each agent's native transcript. See server/src/memory/service.ts for the DatabaseSync /
// FTS5 setup this mirrors, and server/src/meta/store.ts for the dataDir()/`.corrupt-<ts>` pattern.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from '../files/service.js';
import { hasCjk, ftsQuery } from '../memory/service.js';
import type { AgentKind, SessionSummary } from '../protocol.js';

/** Per-session text excerpt cap (constraints.md); indexing stops reading history once it has this much. */
export const INDEX_TEXT_MAX = 20_000;
const TEXT_MAX = INDEX_TEXT_MAX;
const SNIPPET_RADIUS = 40;

export interface LibrarySearchOptions {
  limit: number;
  agent?: AgentKind;
  cwdLike?: string;
}

export interface LibraryParsedQuery {
  q: string;
  agent?: AgentKind;
  cwdLike?: string;
}

export class LibraryIndex {
  private db!: DatabaseSync;
  private fts = true;
  readonly file: string;

  constructor(file: string = path.join(dataDir(), 'library.db')) {
    this.file = file;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.open();
  }

  private open() {
    try {
      this.openOnce();
    } catch {
      try { this.db?.close(); } catch { /* not open */ }
      this.recoverCorrupt();
      this.openOnce();
    }
  }

  private openOnce() {
    this.db = new DatabaseSync(this.file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL DEFAULT 'claude',
        source TEXT,
        cwd TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        firstPrompt TEXT,
        lastModified INTEGER NOT NULL DEFAULT 0,
        text TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS lib_agent ON sessions(agent);
      CREATE INDEX IF NOT EXISTS lib_cwd ON sessions(cwd);
    `);
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS lib_fts USING fts5(text, title, content='sessions', content_rowid='rowid');
        CREATE TRIGGER IF NOT EXISTS lib_ai AFTER INSERT ON sessions BEGIN
          INSERT INTO lib_fts(rowid, text, title) VALUES (new.rowid, new.text, new.title);
        END;
        CREATE TRIGGER IF NOT EXISTS lib_ad AFTER DELETE ON sessions BEGIN
          INSERT INTO lib_fts(lib_fts, rowid, text, title) VALUES('delete', old.rowid, old.text, old.title);
        END;
        CREATE TRIGGER IF NOT EXISTS lib_au AFTER UPDATE ON sessions BEGIN
          INSERT INTO lib_fts(lib_fts, rowid, text, title) VALUES('delete', old.rowid, old.text, old.title);
          INSERT INTO lib_fts(rowid, text, title) VALUES (new.rowid, new.text, new.title);
        END;
      `);
    } catch {
      this.fts = false; // a build without FTS5 still works, just with LIKE matching
    }
  }

  /** Same recovery shape as MetaStore.load(): rename the unreadable file aside, then start fresh. */
  private recoverCorrupt() {
    try {
      if (fs.existsSync(this.file)) fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
    } catch {
      // best effort; if even the rename fails, DatabaseSync will just throw again on the retry
    }
  }

  close() {
    try { this.db.close(); } catch { /* already closed */ }
  }

  /** Persist (or update) a session's summary + searchable text. `text` is capped at 20 000 chars. */
  upsert(s: SessionSummary, text: string): void {
    const clipped = text.slice(0, TEXT_MAX);
    const agent = s.agent ?? 'claude';
    this.db
      .prepare(
        `INSERT INTO sessions (id, agent, source, cwd, title, firstPrompt, lastModified, text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET agent=excluded.agent, source=excluded.source, cwd=excluded.cwd,
           title=excluded.title, firstPrompt=excluded.firstPrompt, lastModified=excluded.lastModified, text=excluded.text`,
      )
      .run(s.sessionId, agent, s.source ?? null, s.cwd ?? '', s.title ?? '', s.firstPrompt ?? null, s.lastModified ?? 0, clipped);
  }

  /** Update a session's summary fields only, keeping its indexed text (no-op when it isn't indexed). */
  touch(s: SessionSummary): void {
    this.db
      .prepare('UPDATE sessions SET agent = ?, source = ?, cwd = ?, title = ?, firstPrompt = ?, lastModified = ? WHERE id = ?')
      .run(s.agent ?? 'claude', s.source ?? null, s.cwd ?? '', s.title ?? '', s.firstPrompt ?? null, s.lastModified ?? 0, s.sessionId);
  }

  /** Length of a session's indexed text, or undefined if it isn't in the index. */
  textLength(id: string): number | undefined {
    const row = this.db.prepare('SELECT LENGTH(text) AS n FROM sessions WHERE id = ?').get(id) as { n: number | null } | undefined;
    return row ? Number(row.n ?? 0) : undefined;
  }

  /** How many sessions are indexed (0 → the library falls back to the old transcript scan). */
  count(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n);
  }

  /** Every indexed session id (the library prunes ids that no longer exist). */
  ids(): string[] {
    return (this.db.prepare('SELECT id FROM sessions').all() as { id: string }[]).map((r) => r.id);
  }

  /** Last-indexed `lastModified` for a session, or undefined if it isn't in the index. */
  indexedAt(id: string): number | undefined {
    const row = this.db.prepare('SELECT lastModified FROM sessions WHERE id = ?').get(id) as { lastModified: number } | undefined;
    return row ? Number(row.lastModified) : undefined;
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  /** Drop every indexed session belonging to one agent/source — used when the user leaves a source. */
  removeAgent(agent: AgentKind): void {
    this.db.prepare('DELETE FROM sessions WHERE agent = ?').run(agent);
  }

  /** `agent:<kind>` and `in:<snippet>` prefixes anywhere in the raw query are pulled out; whatever's
   *  left (trimmed) is the free-text query. */
  static parseQuery(raw: string): LibraryParsedQuery {
    let agent: AgentKind | undefined;
    let cwdLike: string | undefined;
    const q = raw
      .replace(/\bagent:(\S+)/gi, (_, v) => { agent = v as AgentKind; return ''; })
      .replace(/\bin:(\S+)/gi, (_, v) => { cwdLike = v; return ''; })
      .replace(/\s+/g, ' ')
      .trim();
    const out: LibraryParsedQuery = { q };
    if (agent) out.agent = agent;
    if (cwdLike) out.cwdLike = cwdLike;
    return out;
  }

  search(q: string, o: LibrarySearchOptions): { id: string; snippet: string }[] {
    const limit = Math.max(1, Math.min(o.limit, 200));
    const term = q.trim();
    if (!term) return [];

    const where: string[] = [];
    const args: (string | number)[] = [];
    if (o.agent) { where.push('s.agent = ?'); args.push(o.agent); }
    if (o.cwdLike) { where.push(`lower(s.cwd) LIKE ? ESCAPE '!'`); args.push(`%${likeEscape(o.cwdLike.toLowerCase())}%`); }

    if (this.fts && !hasCjk(term)) {
      const fq = ftsQuery(term);
      if (!fq) return [];
      const sql = `SELECT s.id, snippet(lib_fts, 0, '‹', '›', '…', 12) AS snip
                   FROM sessions s JOIN lib_fts f ON f.rowid = s.rowid
                   WHERE f.lib_fts MATCH ?${where.length ? ` AND ${where.join(' AND ')}` : ''}
                   ORDER BY bm25(lib_fts) ASC LIMIT ?`;
      let rows: { id: string; snip: string }[];
      try {
        rows = this.db.prepare(sql).all(fq, ...args, limit) as { id: string; snip: string }[];
      } catch {
        return []; // a malformed FTS expression must degrade to "no results", never take the request down
      }
      return rows.map((r) => ({ id: r.id, snippet: r.snip }));
    }

    // CJK (or no-FTS fallback): substring LIKE over text, title and first prompt (FTS covers the
    // title too), `%` / `_` in the query escaped; ordered by recency, snippet cut by hand.
    const pat = `%${likeEscape(term)}%`;
    where.push(`(s.text LIKE ? ESCAPE '!' OR s.title LIKE ? ESCAPE '!' OR coalesce(s.firstPrompt, '') LIKE ? ESCAPE '!')`);
    args.push(pat, pat, pat);
    const sql = `SELECT s.id, s.text, s.title, s.firstPrompt FROM sessions s WHERE ${where.join(' AND ')} ORDER BY s.lastModified DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...args, limit) as { id: string; text: string; title: string; firstPrompt: string | null }[];
    const lc = term.toLowerCase();
    return rows.map((r) => {
      const where = [r.text, r.title, r.firstPrompt ?? ''].find((t) => t.toLowerCase().includes(lc)) ?? r.text;
      return { id: r.id, snippet: likeSnippet(where, term) };
    });
  }
}

/** Escape LIKE wildcards (`%`, `_`) and the escape char itself, for `LIKE ? ESCAPE '!'`. */
function likeEscape(s: string): string {
  return s.replace(/[!%_]/g, (c) => `!${c}`);
}

function likeSnippet(text: string, term: string): string {
  const i = text.toLowerCase().indexOf(term.toLowerCase());
  if (i < 0) return text.slice(0, SNIPPET_RADIUS * 2);
  const start = Math.max(0, i - SNIPPET_RADIUS);
  const end = Math.min(text.length, i + term.length + SNIPPET_RADIUS);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return `${prefix}${text.slice(start, end)}${suffix}`;
}
