import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { dataDir } from '../files/service.js';

/**
 * Shared memory for every agent.
 *
 * One store, reachable three ways: an agent calls the MCP tools (see mcp.ts), the server harvests
 * facts from a finished session, or the user writes one by hand in the panel. That is the point —
 * a decision Codex made in the morning has to be findable by Claude in the afternoon, and neither
 * of them owns the file.
 *
 * Storage is Node's built-in SQLite (FTS5 is compiled in — checked, no extra dependency) with a
 * plain LIKE fallback if a build ever ships without it. Scope decides visibility: `session` is
 * scratch, `project` is keyed by cwd and is where almost everything lands, `global` follows the
 * user everywhere. Retrieval is recency- and hit-weighted rather than pure relevance, because a
 * fact that keeps getting used is usually the one that still holds.
 */

export type MemoryScope = 'global' | 'project' | 'session';
export type MemoryKind = 'decision' | 'constraint' | 'fact' | 'deadend' | 'preference' | 'note';

export interface Memory {
  id: string;
  scope: MemoryScope;
  /** cwd for `project`, sessionId for `session`, empty for `global` */
  key: string;
  kind: MemoryKind;
  text: string;
  tags: string[];
  sourceSession?: string;
  sourceAgent?: string;
  pinned: boolean;
  hits: number;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryQuery {
  q?: string;
  scope?: MemoryScope;
  cwd?: string;
  sessionId?: string;
  kind?: MemoryKind;
  tags?: string[];
  limit?: number;
}

const KINDS: MemoryKind[] = ['decision', 'constraint', 'fact', 'deadend', 'preference', 'note'];
const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/**
 * FTS5's default tokenizer splits on ASCII word boundaries, so a whole Chinese sentence becomes one
 * token and `"最小化"*` never matches it mid-string. Substring LIKE is the correct tool there, and
 * for a personal-scale store it is fast enough. Latin queries still go through FTS for ranking.
 */
const hasCjk = (s: string) => /[㐀-鿿豈-﫿぀-ヿ가-힯]/.test(s);

/** FTS5 treats a lot of punctuation as syntax; quote every term so user text can't be a query error. */
function ftsQuery(q: string): string {
  const terms = q.split(/\s+/).map((t) => t.replace(/"/g, '')).filter(Boolean);
  if (!terms.length) return '';
  return terms.map((t) => `"${t}"*`).join(' OR ');
}

export class MemoryService extends EventEmitter {
  private db: DatabaseSync;
  private fts = true;
  readonly file: string;

  constructor(file?: string) {
    super();
    this.file = file ?? path.join(dataDir(), 'memory.db');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.db = new DatabaseSync(this.file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        key TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL DEFAULT 'note',
        text TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '',
        sourceSession TEXT,
        sourceAgent TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        hits INTEGER NOT NULL DEFAULT 0,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mem_scope_key ON memories(scope, key);
    `);
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(text, tags, content='memories', content_rowid='rowid');
        CREATE TRIGGER IF NOT EXISTS mem_ai AFTER INSERT ON memories BEGIN
          INSERT INTO mem_fts(rowid, text, tags) VALUES (new.rowid, new.text, new.tags);
        END;
        CREATE TRIGGER IF NOT EXISTS mem_ad AFTER DELETE ON memories BEGIN
          INSERT INTO mem_fts(mem_fts, rowid, text, tags) VALUES('delete', old.rowid, old.text, old.tags);
        END;
        CREATE TRIGGER IF NOT EXISTS mem_au AFTER UPDATE ON memories BEGIN
          INSERT INTO mem_fts(mem_fts, rowid, text, tags) VALUES('delete', old.rowid, old.text, old.tags);
          INSERT INTO mem_fts(rowid, text, tags) VALUES (new.rowid, new.text, new.tags);
        END;
      `);
    } catch {
      this.fts = false; // a build without FTS5 still works, just with LIKE matching
    }
  }

  close() {
    try { this.db.close(); } catch { /* already closed */ }
  }

  private row(r: Record<string, unknown>): Memory {
    return {
      id: String(r.id),
      scope: r.scope as MemoryScope,
      key: String(r.key ?? ''),
      kind: (KINDS.includes(r.kind as MemoryKind) ? r.kind : 'note') as MemoryKind,
      text: String(r.text),
      tags: String(r.tags ?? '').split(',').filter(Boolean),
      sourceSession: (r.sourceSession as string) || undefined,
      sourceAgent: (r.sourceAgent as string) || undefined,
      pinned: !!Number(r.pinned),
      hits: Number(r.hits ?? 0),
      createdAt: Number(r.createdAt),
      updatedAt: Number(r.updatedAt),
    };
  }

  /**
   * Write a memory. Near-identical text in the same scope is treated as the same fact and bumped
   * rather than duplicated — agents restate their conclusions constantly, and a store full of
   * paraphrases is worse than no store.
   */
  write(m: { scope?: MemoryScope; key?: string; kind?: MemoryKind; text: string; tags?: string[]; sourceSession?: string; sourceAgent?: string; pinned?: boolean }): Memory {
    const text = m.text.trim();
    if (!text) throw new Error('记忆内容不能为空');
    const scope = m.scope ?? 'project';
    const key = scope === 'global' ? '' : norm(m.key ?? '');
    const now = Date.now();
    const dupe = this.db.prepare('SELECT * FROM memories WHERE scope = ? AND key = ? AND lower(text) = lower(?) LIMIT 1').get(scope, key, text) as Record<string, unknown> | undefined;
    if (dupe) {
      this.db.prepare('UPDATE memories SET updatedAt = ?, hits = hits + 1, kind = ?, tags = ? WHERE id = ?').run(now, m.kind ?? String(dupe.kind), (m.tags ?? []).join(','), String(dupe.id));
      this.emit('changed');
      return this.row({ ...dupe, updatedAt: now, hits: Number(dupe.hits) + 1 });
    }
    const mem: Memory = {
      id: randomUUID(),
      scope,
      key,
      kind: m.kind ?? 'note',
      text,
      tags: m.tags ?? [],
      sourceSession: m.sourceSession,
      sourceAgent: m.sourceAgent,
      pinned: !!m.pinned,
      hits: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare('INSERT INTO memories (id, scope, key, kind, text, tags, sourceSession, sourceAgent, pinned, hits, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(mem.id, mem.scope, mem.key, mem.kind, mem.text, mem.tags.join(','), mem.sourceSession ?? null, mem.sourceAgent ?? null, mem.pinned ? 1 : 0, 0, mem.createdAt, mem.updatedAt);
    this.emit('changed');
    return mem;
  }

  /**
   * Search. Pinned first, then hits and recency — a fact that keeps getting recalled outranks a
   * fresher one nobody used. Scope filtering is inclusive by design: a project search also returns
   * global memories, because "always run tests with --run" is true in every project.
   */
  search(q: MemoryQuery): Memory[] {
    const limit = Math.min(q.limit ?? 20, 200);
    const where: string[] = [];
    const args: (string | number)[] = [];

    if (q.scope) {
      where.push('m.scope = ?');
      args.push(q.scope);
      if (q.scope !== 'global') {
        where.push('m.key = ?');
        args.push(norm(q.scope === 'session' ? q.sessionId ?? '' : q.cwd ?? ''));
      }
    } else {
      // default view: global + this project + this session
      const parts = ["m.scope = 'global'"];
      if (q.cwd) { parts.push("(m.scope = 'project' AND m.key = ?)"); args.push(norm(q.cwd)); }
      if (q.sessionId) { parts.push("(m.scope = 'session' AND m.key = ?)"); args.push(norm(q.sessionId)); }
      where.push(`(${parts.join(' OR ')})`);
    }
    if (q.kind) { where.push('m.kind = ?'); args.push(q.kind); }
    for (const t of q.tags ?? []) { where.push("(',' || m.tags || ',') LIKE ?"); args.push(`%,${t},%`); }

    const term = q.q?.trim();
    let sql: string;
    if (term && this.fts && !hasCjk(term)) {
      const fq = ftsQuery(term);
      sql = `SELECT m.* FROM memories m JOIN mem_fts f ON f.rowid = m.rowid WHERE f.mem_fts MATCH ?${where.length ? ` AND ${where.join(' AND ')}` : ''}
             ORDER BY m.pinned DESC, bm25(mem_fts) ASC, m.hits DESC, m.updatedAt DESC LIMIT ?`;
      args.unshift(fq);
    } else if (term) {
      where.push('(m.text LIKE ? OR m.tags LIKE ?)');
      args.push(`%${term}%`, `%${term}%`);
      sql = `SELECT m.* FROM memories m${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY m.pinned DESC, m.hits DESC, m.updatedAt DESC LIMIT ?`;
    } else {
      sql = `SELECT m.* FROM memories m${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY m.pinned DESC, m.updatedAt DESC LIMIT ?`;
    }
    args.push(limit);

    let rows: Record<string, unknown>[];
    try {
      rows = this.db.prepare(sql).all(...args) as Record<string, unknown>[];
    } catch {
      // a malformed FTS expression must degrade to "no results", never take the request down
      return [];
    }
    const out = rows.map((r) => this.row(r));
    if (term && out.length) {
      const stmt = this.db.prepare('UPDATE memories SET hits = hits + 1 WHERE id = ?');
      for (const m of out) stmt.run(m.id);
    }
    return out;
  }

  get(id: string): Memory | undefined {
    const r = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? this.row(r) : undefined;
  }

  update(id: string, patch: Partial<Pick<Memory, 'text' | 'kind' | 'tags' | 'pinned' | 'scope'>>): Memory | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch, tags: patch.tags ?? cur.tags, updatedAt: Date.now() };
    this.db
      .prepare('UPDATE memories SET scope = ?, kind = ?, text = ?, tags = ?, pinned = ?, updatedAt = ? WHERE id = ?')
      .run(next.scope, next.kind, next.text, next.tags.join(','), next.pinned ? 1 : 0, next.updatedAt, id);
    this.emit('changed');
    return next;
  }

  remove(id: string): boolean {
    const n = this.db.prepare('DELETE FROM memories WHERE id = ?').run(id).changes;
    if (n) this.emit('changed');
    return !!n;
  }

  stats() {
    const rows = this.db.prepare('SELECT scope, COUNT(*) as n FROM memories GROUP BY scope').all() as { scope: string; n: number }[];
    const total = rows.reduce((a, r) => a + Number(r.n), 0);
    return { total, byScope: Object.fromEntries(rows.map((r) => [r.scope, Number(r.n)])), fts: this.fts, file: this.file };
  }

  /** Everything an agent should see when it starts working in `cwd`, as a compact block. */
  brief(cwd: string, sessionId?: string, limit = 12): string {
    const rows = this.search({ cwd, sessionId, limit });
    if (!rows.length) return '';
    const label: Record<MemoryKind, string> = { decision: '决定', constraint: '约束', fact: '事实', deadend: '死路', preference: '偏好', note: '备注' };
    return rows.map((m) => `- [${label[m.kind]}] ${m.text}`).join('\n');
  }
}
