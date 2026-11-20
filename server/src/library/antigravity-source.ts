// Antigravity (Google's agent IDE): a library source read from its own files. Nothing is written back and there is no
// official way to go on in Antigravity from here, so 接着聊 goes on in a new Claude conversation seeded with this
// history (`continueInClaude`, the same way as DeepSeek Harness and claude.ai).
//
// Where it keeps its conversations (seen on a real install, builds from 2026-05 to 2026-11):
//   ~/.gemini/antigravity/conversation_summaries.db   SQLite: `conversation_summaries` (title, preview, workspace_uris,
//                                                     last_modified_time, parent_conversation_id …) and an FTS5 table
//                                                     `conversations_fts` with each conversation's user / agent text
//   ~/.gemini/antigravity/conversations/<id>.db       SQLite per conversation: `steps` (one protobuf `step_payload` a
//                                                     step), `trajectory_metadata_blob` (the workspace folder)
//   ~/.gemini/antigravity-ide/conversations/<id>.db   an older build's folder: the same per-conversation db, no summaries
//   ~/.gemini/antigravity-ide/conversations/<id>.pb   older still: encrypted, not readable (skipped)
// The files are Antigravity's and may be open in it: none is ever opened in place. Each db is copied (with its -wal)
// into a temp folder and the copy is read, then removed.
//
// The step protobuf (no schema is published; these paths were read off real steps):
//   1 step type · 4 status · 5 metadata { 1 created { 1 seconds }, 4 tool call { 1 id, 2 name, 3 arguments (JSON) },
//   30 the tool's action, 31 its one-line summary }
//   type 14, what the user said: 19 { 2 text }
//   type 15, the agent's turn:   20 { 1 text, 3 thinking, 7 tool calls [{ 1 id, 2 name, 3 arguments }] }
//   a tool step (any step whose 5.4 names a tool, the id the agent's turn gave it): the result in the step's own field
//   (13 grep, 14 view_file, 15 list_dir, 28 run_command, 10 edits …)
//   trajectory_metadata_blob.data: 1 { 1 the workspace folder (file URI) }
import fs from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { AgentKind, SessionSummary, SourceCaps, SourceStatus } from '../protocol.js';
import type { SessionSource } from './types.js';
import { libraryId } from './ids.js';
import { tr } from '../i18n/index.js';

const CAPS: SourceCaps = { resume: true, rename: false, archive: false, delete: false, fork: false, continueInClaude: true };
/** A tool's result is cut to this much (a whole file read, a long build log). */
const RESULT_MAX = 4000;
/** How many conversations without a summary row (an older build's folder) get opened for their title and folder. */
const TITLED = 200;

// ---------------------------------------------------------------------------------------------------- where

/** The Antigravity folders under `~/.gemini` that hold conversations: `antigravity` first (current builds), then any
 *  other build's (`antigravity-ide` …). */
export function antigravityRoots(home = os.homedir()): string[] {
  const g = path.join(home, '.gemini');
  let names: string[];
  try { names = readdirSync(g); } catch { return []; }
  return names
    .filter((n) => /^antigravity/i.test(n) && existsSync(path.join(g, n, 'conversations')))
    .sort((a, b) => (a === 'antigravity' ? -1 : b === 'antigravity' ? 1 : a.localeCompare(b)))
    .map((n) => path.join(g, n));
}

/** The folders whose existence counts as "Antigravity is here" (the library's detection). */
export function antigravityDataDirs(home = os.homedir()): string[] {
  return ['antigravity', 'antigravity-ide'].map((n) => path.join(home, '.gemini', n, 'conversations'));
}

// ---------------------------------------------------------------------------------------------------- protobuf

type Field = bigint | Uint8Array;
type Msg = Map<number, Field[]>;

/** One level of a protobuf message (field number → values); throws on anything malformed. */
export function pbRead(b: Uint8Array): Msg {
  const m: Msg = new Map();
  let i = 0;
  const varint = (): bigint => {
    let x = 0n, s = 0n;
    for (;;) {
      if (i >= b.length || s > 63n) throw new Error('bad varint');
      const c = b[i++];
      x |= BigInt(c & 0x7f) << s;
      if (!(c & 0x80)) return x;
      s += 7n;
    }
  };
  const take = (n: number): Uint8Array => {
    if (n < 0 || i + n > b.length) throw new Error('past the end');
    const v = b.subarray(i, i + n);
    i += n;
    return v;
  };
  const fixed = (n: number): bigint => {
    const v = take(n);
    let x = 0n;
    for (let k = n - 1; k >= 0; k--) x = (x << 8n) | BigInt(v[k]);
    return x;
  };
  while (i < b.length) {
    const key = varint();
    const f = Number(key >> 3n), wt = Number(key & 7n);
    if (f <= 0) throw new Error('bad field');
    let v: Field;
    // only a length-delimited value is bytes (text or a nested message); the fixed-width ones are numbers
    if (wt === 0) v = varint();
    else if (wt === 1) v = fixed(8);
    else if (wt === 5) v = fixed(4);
    else if (wt === 2) v = take(Number(varint()));
    else throw new Error(`wire type ${wt}`);
    const list = m.get(f);
    if (list) list.push(v); else m.set(f, [v]);
  }
  return m;
}

const bytesOf = (m: Msg | undefined, f: number): Uint8Array | undefined => {
  const v = m?.get(f)?.[0];
  return v instanceof Uint8Array ? v : undefined;
};
const strOf = (m: Msg | undefined, f: number): string => {
  const v = bytesOf(m, f);
  return v ? Buffer.from(v).toString('utf8') : '';
};
const subOf = (m: Msg | undefined, f: number): Msg | undefined => {
  const v = bytesOf(m, f);
  if (!v) return undefined;
  try { return pbRead(v); } catch { return undefined; }
};
const subsOf = (m: Msg | undefined, f: number): Msg[] => {
  const out: Msg[] = [];
  for (const v of m?.get(f) ?? []) {
    if (!(v instanceof Uint8Array)) continue;
    try { out.push(pbRead(v)); } catch { /* not a message */ }
  }
  return out;
};
const numOf = (m: Msg | undefined, f: number): number | undefined => {
  const v = m?.get(f)?.[0];
  return typeof v === 'bigint' ? Number(v) : undefined;
};

const utf8 = new TextDecoder('utf-8', { fatal: true });
/** Text, not a nested message: valid UTF-8 with no control characters but tab / newline / CR. */
function asText(b: Uint8Array): string | null {
  let s: string;
  try { s = utf8.decode(b); } catch { return null; }
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s) ? null : s;
}
/** Parsed as a message and looks like one: small field numbers, something length-delimited inside. */
const plausible = (m: Msg) => m.size > 0 && [...m.keys()].every((f) => f < 200) && [...m.values()].some((vals) => vals.some((v) => v instanceof Uint8Array));
/** Starts like a message's first field (1–3, a number or bytes): a listing's entry `{1 name, 4 size}` is valid UTF-8
 *  too (`\n\r.dockerignore ]`), and only a newline among these is also how text may start. */
const TAG_START = new Set([0x08, 0x0a, 0x10, 0x12, 0x18, 0x1a]);
/** Every piece of text inside a value, nested messages walked (a tool's result: file contents, names, output lines). */
function texts(b: Uint8Array, out: string[], depth = 0): void {
  const t = asText(b);
  if ((t === null || (b.length > 1 && TAG_START.has(b[0]))) && depth <= 8) {
    let m: Msg | null = null;
    try { m = pbRead(b); } catch { m = null; }
    if (m && plausible(m)) {
      for (const vals of m.values()) for (const v of vals) if (v instanceof Uint8Array) texts(v, out, depth + 1);
      return;
    }
  }
  if (t !== null && t.trim()) out.push(t);
}

// ---------------------------------------------------------------------------------------------------- steps → messages

const parseJson = (s: string): any => {
  if (!s) return {};
  try { const v = JSON.parse(s); return v && typeof v === 'object' ? v : { value: v }; } catch { return { arguments: s }; }
};
const listOf = (v: unknown): any[] => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch { return []; } }
  return [];
};

/**
 * Antigravity's tools as the ones the app draws cards for (a file read, a command, an edit with its diff); the rest
 * keep their own name and arguments (a plain card). `toolAction` / `toolSummary` are Antigravity's labels, not input.
 */
export function mapTool(name: string, argsJson: string): { name: string; input: Record<string, unknown> } {
  const { toolAction: _a, toolSummary: _s, ...a } = parseJson(argsJson);
  const n = (v: unknown) => (typeof v === 'number' ? v : Number(v) || undefined);
  switch (name) {
    case 'view_file': {
      const start = n(a.StartLine), end = n(a.EndLine);
      return { name: 'Read', input: { file_path: a.AbsolutePath ?? '', ...(start ? { offset: start, ...(end && end >= start ? { limit: end - start + 1 } : {}) } : {}) } };
    }
    case 'run_command':
      return { name: 'Bash', input: { command: a.CommandLine ?? '', ...(a.Cwd ? { cwd: a.Cwd } : {}) } };
    case 'grep_search':
      return { name: 'Grep', input: { pattern: a.Query ?? '', ...(a.SearchPath ? { path: a.SearchPath } : {}), ...(listOf(a.Includes).length ? { glob: listOf(a.Includes).join(',') } : {}), ...(a.CaseInsensitive ? { '-i': true } : {}) } };
    case 'find_by_name':
      return { name: 'Glob', input: { pattern: a.Pattern ?? '', ...(a.SearchDirectory ? { path: a.SearchDirectory } : {}) } };
    case 'list_dir':
      return { name: 'Glob', input: { pattern: '*', path: a.DirectoryPath ?? '' } };
    case 'write_to_file':
      return { name: 'Write', input: { file_path: a.TargetFile ?? '', content: a.CodeContent ?? '' } };
    case 'replace_file_content':
      return { name: 'Edit', input: { file_path: a.TargetFile ?? '', old_string: a.TargetContent ?? '', new_string: a.ReplacementContent ?? '' } };
    case 'multi_replace_file_content':
      return { name: 'MultiEdit', input: { file_path: a.TargetFile ?? '', edits: listOf(a.ReplacementChunks).map((c: any) => ({ old_string: c?.TargetContent ?? '', new_string: c?.ReplacementContent ?? '' })) } };
    case 'search_web':
      return { name: 'WebSearch', input: { query: a.query ?? a.Query ?? '' } };
    case 'read_url_content':
      return { name: 'WebFetch', input: { url: a.Url ?? a.url ?? '' } };
    default:
      return { name, input: a };
  }
}

/**
 * A tool step's result as text. Newer builds (step type 132) keep it ready-made, as the agent read it, in 140.2.1
 * (140.1 echoes the arguments, 140.2.6 embeds the typed step). Older ones only have the typed field (13 grep, 14 a
 * file, 15 a listing, 28 a command …): its texts, the arguments' own keys and values left out. Else the one-line summary.
 */
function resultOf(step: Msg, meta: Msg | undefined, args: Record<string, unknown>): string {
  let text = strOf(subOf(subOf(step, 140), 2), 1);
  if (!text.trim()) {
    const echo = new Set<string>(['toolAction', 'toolSummary', strOf(meta, 30), strOf(meta, 31)]);
    for (const [k, v] of Object.entries(args)) { echo.add(k); if (v != null && typeof v !== 'object') echo.add(String(v)); }
    const parts: string[] = [];
    for (const [f, vals] of step) {
      // 1 type, 4 status, 5 metadata; 148 points at a background task's log file
      if (f === 1 || f === 4 || f === 5 || f === 140 || f === 148) continue;
      for (const v of vals) if (v instanceof Uint8Array) texts(v, parts);
    }
    const useful = parts.filter((p) => !echo.has(p) && !/^file:\/\//.test(p));
    // a file's contents or a command's output is the one long text; a listing or matches are many short ones
    const longest = useful.reduce((a, b) => (b.length > a.length ? b : a), '');
    text = longest.length >= 200 ? longest : [...new Set(useful)].join('\n');
  }
  if (!text.trim()) text = strOf(meta, 31) || strOf(meta, 30);
  return text.length > RESULT_MAX ? `${text.slice(0, RESULT_MAX)}\n…` : text;
}

export interface StepRow { idx: number; step_type: number; step_payload: Uint8Array | null }

/** The `steps` rows of one conversation (in order) → the SDK-shaped messages the app renders. */
export function stepsToMessages(rows: StepRow[], sessionId: string): any[] {
  const out: any[] = [];
  const called = new Set<string>();
  for (const r of rows) {
    if (!r.step_payload) continue;
    let p: Msg;
    try { p = pbRead(r.step_payload); } catch { continue; }
    const meta = subOf(p, 5);
    const secs = numOf(subOf(meta, 1), 1);
    const at = secs ? { timestamp: new Date(secs * 1000).toISOString() } : {};
    const uuid = `${sessionId}-${r.idx}`;
    const type = r.step_type || numOf(p, 1);
    if (type === 14) {
      const said = subOf(p, 19);
      const text = strOf(said, 2) || strOf(subOf(said, 3), 1);
      if (text.trim()) out.push({ type: 'user', uuid, session_id: sessionId, ...at, message: { role: 'user', content: [{ type: 'text', text }] } });
      continue;
    }
    if (type === 15) {
      const turn = subOf(p, 20);
      const content: any[] = [];
      const thinking = strOf(turn, 3);
      if (thinking.trim()) content.push({ type: 'thinking', thinking });
      const text = strOf(turn, 1) || strOf(turn, 8);
      if (text.trim()) content.push({ type: 'text', text });
      subsOf(turn, 7).forEach((c, k) => {
        const name = strOf(c, 2);
        if (!name) return;
        const id = strOf(c, 1) || `${r.idx}-${k}`;
        called.add(id);
        content.push({ type: 'tool_use', id, ...mapTool(name, strOf(c, 3)) });
      });
      if (content.length) out.push({ type: 'assistant', uuid, session_id: sessionId, ...at, message: { role: 'assistant', content } });
      continue;
    }
    const call = subOf(meta, 4);
    const name = strOf(call, 2) || strOf(call, 9);
    if (!name) continue; // bookkeeping steps (checkpoints, task notices, …)
    const id = strOf(call, 1) || `${r.idx}`;
    if (!called.has(id)) {
      // the agent's turn that asked for it was not recorded (or not readable): the call itself, from the tool step
      called.add(id);
      out.push({ type: 'assistant', uuid: `${uuid}-c`, session_id: sessionId, ...at, message: { role: 'assistant', content: [{ type: 'tool_use', id, ...mapTool(name, strOf(call, 3)) }] } });
    }
    out.push({ type: 'user', uuid: `${uuid}-r`, session_id: sessionId, ...at, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: resultOf(p, meta, parseJson(strOf(call, 3))) }] } });
  }
  return out;
}

/**
 * The summaries db's search rows for one conversation → user / agent text messages: the fallback when its own db
 * cannot be read. Each chunk keeps the user's and the agent's texts back to back, with `[[step, byte offset], …]`.
 */
export function searchRowsToMessages(rows: { uo: unknown; ao: unknown; user_body: unknown; agent_body: unknown }[], sessionId: string): any[] {
  const pieces: { step: number; who: 'user' | 'assistant'; text: string }[] = [];
  const asStr = (v: unknown) => (v instanceof Uint8Array ? Buffer.from(v).toString('utf8') : typeof v === 'string' ? v : '');
  const split = (body: unknown, offsets: unknown, who: 'user' | 'assistant') => {
    let offs: [number, number][];
    try { offs = JSON.parse(asStr(offsets) || '[]'); } catch { return; }
    if (!Array.isArray(offs)) return;
    const buf = Buffer.from(asStr(body), 'utf8');
    offs.forEach(([step, at], i) => {
      const end = i + 1 < offs.length ? offs[i + 1][1] : buf.length;
      const text = buf.subarray(at, end).toString('utf8').trim();
      if (text) pieces.push({ step: Number(step), who, text });
    });
  };
  for (const r of rows) { split(r.user_body, r.uo, 'user'); split(r.agent_body, r.ao, 'assistant'); }
  pieces.sort((a, b) => a.step - b.step || (a.who === 'user' ? -1 : 1));
  return pieces.map((x) => ({ type: x.who, uuid: `${sessionId}-${x.step}${x.who === 'user' ? 'u' : 'a'}`, session_id: sessionId, message: { role: x.who, content: [{ type: 'text', text: x.text }] } }));
}

// ---------------------------------------------------------------------------------------------------- files

/** Read a db through a private copy (with its -wal): Antigravity's own files are never opened. */
async function withCopy<T>(file: string, fn: (db: DatabaseSync) => T): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cw-antigravity-'));
  try {
    const copy = path.join(dir, 'c.db');
    await fs.copyFile(file, copy);
    await fs.copyFile(`${file}-wal`, `${copy}-wal`).catch(() => { /* no write-ahead log */ });
    // our own copy: opened read-write so SQLite can fold the copied log in
    const db = new DatabaseSync(copy);
    try { return fn(db); } finally { db.close(); }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** `2026-05-20 11:27:17.7348638+00:00` (Go's time format) → epoch ms. */
export function parseTime(s: unknown): number | undefined {
  if (typeof s !== 'string' || !s) return undefined;
  const t = Date.parse(s.trim().replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1').replace(/ ([+-]\d)/, '$1'));
  return Number.isFinite(t) ? t : undefined;
}

/** `file:///c%3A/Users/me/x` → `C:\Users\me\x` (the folder as the rest of the app writes it). */
export function uriToPath(uri: unknown): string | undefined {
  if (typeof uri !== 'string' || !uri.startsWith('file:')) return undefined;
  try {
    const p = fileURLToPath(uri);
    return /^[a-z]:/.test(p) ? p[0].toUpperCase() + p.slice(1) : p;
  } catch { return undefined; }
}

interface Summary { id: string; title: string; preview: string; modified?: number; cwd?: string; child: boolean }

function readSummaries(db: DatabaseSync): Summary[] {
  const cols = new Set((db.prepare('pragma table_info(conversation_summaries)').all() as { name: string }[]).map((c) => c.name));
  if (!cols.has('conversation_id')) return [];
  const col = (c: string) => (cols.has(c) ? `cast(${c} as text) as ${c}` : `'' as ${c}`);
  const rows = db.prepare(`select conversation_id, ${['title', 'preview', 'last_modified_time', 'workspace_uris', 'parent_conversation_id'].map(col).join(', ')} from conversation_summaries`).all() as Record<string, string | null>[];
  return rows.filter((r) => r.conversation_id).map((r) => {
    let cwd: string | undefined;
    try { cwd = uriToPath((JSON.parse(r.workspace_uris || '[]') as unknown[])[0]); } catch { /* not a list */ }
    return { id: String(r.conversation_id), title: (r.title ?? '').trim(), preview: (r.preview ?? '').trim(), modified: parseTime(r.last_modified_time), cwd, child: !!(r.parent_conversation_id ?? '').trim() };
  });
}

/** A conversation db without a summary row: its folder (metadata) and what the user said first (the title). */
function readInfo(db: DatabaseSync): { cwd?: string; first?: string; createdAt?: number } {
  let cwd: string | undefined;
  try {
    const row = db.prepare("select data from trajectory_metadata_blob where id = 'main'").get() as { data?: Uint8Array } | undefined;
    const m = row?.data ? pbRead(row.data) : undefined;
    cwd = uriToPath(strOf(subOf(m, 1), 1)) ?? uriToPath(strOf(m, 7));
  } catch { /* no metadata */ }
  const row = db.prepare('select idx, step_type, step_payload from steps where step_type = 14 order by idx limit 1').get() as StepRow | undefined;
  const msgs = row ? stepsToMessages([row], 'x') : [];
  const first = msgs[0]?.message?.content?.[0]?.text as string | undefined;
  const ts = msgs[0]?.timestamp ? Date.parse(msgs[0].timestamp) : undefined;
  return { cwd, first: first?.trim(), createdAt: ts };
}

interface Found { id: string; db: string; root: string; mtimeMs: number; size: number; birth: number }

async function findDbs(roots: string[]): Promise<Found[]> {
  const out: Found[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    let names: string[] = [];
    try { names = await fs.readdir(path.join(root, 'conversations')); } catch { continue; }
    for (const n of names) {
      const m = /^([0-9a-f-]{8,})\.db$/i.exec(n);
      if (!m || seen.has(m[1])) continue; // the first root (current builds) wins
      const db = path.join(root, 'conversations', n);
      const st = await fs.stat(db).catch(() => null);
      if (!st?.isFile()) continue;
      // the log holds what was written since the last checkpoint: it moves, the db may not
      const wal = await fs.stat(`${db}-wal`).catch(() => null);
      seen.add(m[1]);
      out.push({ id: m[1], db, root, mtimeMs: Math.max(st.mtimeMs, wal?.mtimeMs ?? 0), size: st.size + (wal?.size ?? 0), birth: st.birthtimeMs || st.mtimeMs });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------- the source

export class AntigravitySource implements SessionSource {
  readonly kind: AgentKind = 'antigravity';
  readonly name = 'Antigravity';
  readonly caps: SourceCaps = CAPS;
  private listed: { at: number; items: SessionSummary[]; found: Map<string, Found> } | null = null;
  /** per db without a summary row: its title / folder, until the file changes */
  private infos = new Map<string, { key: string; cwd?: string; first?: string; createdAt?: number; failed?: boolean }>();
  /** the last conversations read, until their files change (a long one is paged several times) */
  private reads = new Map<string, { key: string; messages: any[] }>();

  constructor(private readonly roots: () => string[] = () => antigravityRoots()) {}

  private async scan(): Promise<{ items: SessionSummary[]; found: Map<string, Found> }> {
    if (this.listed && Date.now() - this.listed.at < 30_000) return this.listed;
    const roots = this.roots();
    const found = await findDbs(roots);
    const byId = new Map(found.map((f) => [f.id, f]));
    // the summaries: every root that has one (the current builds)
    const summaries = new Map<string, Summary>();
    for (const root of roots) {
      const file = path.join(root, 'conversation_summaries.db');
      if (!existsSync(file)) continue;
      for (const s of await withCopy(file, readSummaries)) if (!summaries.has(s.id)) summaries.set(s.id, s);
    }
    const items: SessionSummary[] = [];
    const unsummarized: Found[] = [];
    for (const f of found) {
      const s = summaries.get(f.id);
      if (!s) { unsummarized.push(f); continue; }
      if (s.child) continue; // a sub-agent's conversation: part of its parent's
      items.push(this.summary(f, { title: s.title || s.preview, cwd: s.cwd, modified: s.modified }));
    }
    // an older build's folder has no summaries: what the user said first is the title; the newest ones are opened
    unsummarized.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (let i = 0; i < unsummarized.length; i++) {
      const f = unsummarized[i];
      const key = `${f.mtimeMs}:${f.size}`;
      let info = this.infos.get(f.id);
      if (i < TITLED && info?.key !== key) {
        info = { key, ...(await withCopy(f.db, readInfo).catch(() => ({ failed: true }))) };
        this.infos.set(f.id, info);
      }
      if (info && info.key === key && !info.first && !info.failed) continue; // nothing was ever said in it
      items.push(this.summary(f, { title: info?.first?.slice(0, 80) ?? '', cwd: info?.cwd, firstPrompt: info?.first, createdAt: info?.createdAt }));
    }
    items.sort((a, b) => b.lastModified - a.lastModified);
    this.listed = { at: Date.now(), items, found: byId };
    return this.listed;
  }

  private summary(f: Found, o: { title: string; cwd?: string; modified?: number; firstPrompt?: string; createdAt?: number }): SessionSummary {
    return {
      sessionId: libraryId('antigravity', f.id),
      title: o.title || tr('Antigravity 对话 {id}', { id: f.id.slice(0, 8) }),
      cwd: o.cwd || os.homedir(),
      lastModified: Math.max(o.modified ?? 0, f.mtimeMs),
      createdAt: o.createdAt ?? f.birth,
      ...(o.firstPrompt ? { firstPrompt: o.firstPrompt.slice(0, 500) } : {}),
      agent: this.kind,
      source: 'Antigravity',
      caps: CAPS,
    };
  }

  async status(): Promise<SourceStatus> {
    const n = (await this.scan()).items.length;
    return { kind: this.kind, name: this.name, installed: n > 0, detected: n > 0, joined: false, dismissed: false, enabled: n > 0, count: n };
  }

  async list(_o: { cursor?: string; limit: number; archived?: boolean }): Promise<{ items: SessionSummary[] }> {
    return { items: (await this.scan()).items };
  }

  /** Every message of one conversation, oldest first: its own db; the summaries' search text when that gives nothing. */
  private async messages(nativeId: string): Promise<any[]> {
    let f = this.listed?.found.get(nativeId);
    if (!f) f = (await this.scan()).found.get(nativeId);
    if (!f) throw new Error(tr('Antigravity 里找不到这个对话（可能在 Antigravity 里删掉了）'));
    const key = `${f.mtimeMs}:${f.size}`;
    const hit = this.reads.get(nativeId);
    if (hit?.key === key) return hit.messages;
    const sid = libraryId('antigravity', nativeId);
    let messages = await withCopy(f.db, (db) => stepsToMessages(db.prepare('select idx, step_type, step_payload from steps order by idx').all() as unknown as StepRow[], sid)).catch(() => [] as any[]);
    if (!messages.length) messages = await this.fromSearch(f.root, nativeId, sid);
    this.reads.set(nativeId, { key, messages });
    while (this.reads.size > 4) this.reads.delete(this.reads.keys().next().value!);
    return messages;
  }

  private async fromSearch(root: string, nativeId: string, sid: string): Promise<any[]> {
    const file = path.join(root, 'conversation_summaries.db');
    if (!existsSync(file)) return [];
    return withCopy(file, (db) => searchRowsToMessages(db.prepare('select user_step_byte_offsets uo, agent_step_byte_offsets ao, user_body, agent_body from conversations_fts where conversation_id = ? and chunk_index >= 0 order by chunk_index').all(nativeId) as any[], sid)).catch(() => []);
  }

  /** Newest page first (`cursor` = where the next, older page ends), each page in order. */
  async read(nativeId: string, o: { cursor?: string; limit: number } = { limit: 50 }): Promise<{ messages: any[]; next?: string }> {
    const rows = await this.messages(nativeId);
    const end = o.cursor !== undefined ? Math.min(rows.length, Math.max(0, Number(o.cursor) || 0)) : rows.length;
    const start = Math.max(0, end - Math.max(1, o.limit || 50));
    return { messages: rows.slice(start, end), ...(start > 0 ? { next: String(start) } : {}) };
  }

  async close(): Promise<void> { /* files only */ }
}
