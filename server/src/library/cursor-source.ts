// Cursor (the editor's agent transcripts): a READ-ONLY local history source.
//
// Cursor writes one JSONL per agent conversation under
//   <user>/.cursor/projects/<project>/agent-transcripts/<uuid>/<uuid>.jsonl
// with Anthropic-shaped rows (`{ role, message: { content } }`). There is no public API for this, so nothing here
// writes, renames, deletes or resumes — the library shows and searches the history and stops there.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { AgentKind, SessionSummary, SourceCaps, SourceStatus } from '../protocol.js';
import type { SessionSource } from './types.js';
import { libraryId } from './ids.js';
import { tr } from '../i18n/index.js';

const CAPS: SourceCaps = { resume: false, rename: false, archive: false, delete: false, fork: false };
/** Enough for an agent transcript; a larger file is read up to this and then shown truncated. */
const MAX_FILE = 32 * 1024 * 1024;
const MAX_SESSIONS = 5_000;
/** How many of the newest transcripts get their first prompt read for a title. */
const TITLED = 200;

export function cursorRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = os.homedir();
  const out = [path.join(home, '.cursor', 'projects')];
  if (env.APPDATA) out.push(path.join(env.APPDATA, 'Cursor', 'projects'));
  return [...new Set(out)];
}

/** Cursor's project folder name → a readable path (`c-Users-me-code-x` → `C:\Users\me\code\x`). Best effort only. */
export function cursorCwd(folder: string): string {
  const m = /^c-(.*)$/i.exec(folder);
  if (!m) return folder;
  return `C:\\${m[1].replace(/-/g, '\\')}`;
}

interface Found { id: string; file: string; folder: string }

async function findTranscripts(roots: string[]): Promise<Found[]> {
  const out: Found[] = [];
  for (const root of roots) {
    let projects: string[];
    try { projects = await fs.readdir(root); } catch { continue; }
    for (const p of projects) {
      const dir = path.join(root, p, 'agent-transcripts');
      let ids: string[];
      try { ids = await fs.readdir(dir); } catch { continue; }
      for (const id of ids) {
        const file = path.join(dir, id, `${id}.jsonl`);
        try { const st = await fs.stat(file); if (!st.isFile()) continue; } catch { continue; }
        out.push({ id, file, folder: p });
        if (out.length >= MAX_SESSIONS) return out;
      }
    }
  }
  return out;
}

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b: any) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('');
};

/** Rows of Cursor's transcript → the SDK-shaped messages the app renders. */
export function cursorMessages(rows: unknown[], sessionId: string, offset = 0): any[] {
  const out: any[] = [];
  rows.forEach((raw, i) => {
    const r = raw as { role?: string; message?: { content?: unknown } };
    const role = r?.role;
    if (role !== 'user' && role !== 'assistant') return;
    out.push({ type: role, uuid: `${sessionId}-${offset + i}`, session_id: sessionId, message: { role, content: r.message?.content ?? [] } });
  });
  return out;
}

export class CursorSource implements SessionSource {
  readonly kind: AgentKind = 'cursor';
  readonly name = 'Cursor';
  readonly caps: SourceCaps = CAPS;
  private cache: { at: number; found: Found[] } | null = null;

  constructor(private readonly roots: string[] = cursorRoots()) {}

  private async found(): Promise<Found[]> {
    if (this.cache && Date.now() - this.cache.at < 30_000) return this.cache.found;
    const found = await findTranscripts(this.roots);
    this.cache = { at: Date.now(), found };
    return found;
  }

  async status(): Promise<SourceStatus> {
    const found = await this.found();
    return { kind: this.kind, name: 'Cursor', installed: found.length > 0, detected: found.length > 0, joined: false, dismissed: false, enabled: found.length > 0, count: found.length };
  }

  async list(_o: { cursor?: string; limit: number; archived?: boolean }): Promise<{ items: SessionSummary[] }> {
    const found = await this.found();
    // newest first needs every stat; the first prompt is only read for the newest ones (a title is a nicety,
    // opening thousands of files to build a list is not)
    const dated: { f: Found; mtime: number; birth: number }[] = [];
    for (const f of found) {
      const st = await fs.stat(f.file).catch(() => null);
      if (st) dated.push({ f, mtime: st.mtimeMs, birth: st.birthtimeMs || st.mtimeMs });
    }
    dated.sort((a, b) => b.mtime - a.mtime);
    const items: SessionSummary[] = [];
    for (let i = 0; i < dated.length; i++) {
      const { f, mtime, birth } = dated[i];
      const firstPrompt = i < TITLED ? await this.firstPrompt(f.file).catch(() => '') : '';
      items.push({
        sessionId: libraryId('cursor', f.id),
        title: firstPrompt.slice(0, 80) || tr('Cursor 对话 {id}', { id: f.id.slice(0, 8) }),
        cwd: cursorCwd(f.folder),
        lastModified: mtime,
        createdAt: birth,
        ...(firstPrompt ? { firstPrompt } : {}),
        agent: this.kind,
        caps: CAPS,
      });
    }
    return { items };
  }

  private async firstPrompt(file: string): Promise<string> {
    // listing must be cheap: the first prompt is in the head of the file, not all of it
    const text = await readHead(file);
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as { role?: string; message?: { content?: unknown } };
        if (o.role === 'user') { const t = textOf(o.message?.content).trim(); if (t) return t; }
      } catch { /* a line still being written */ }
    }
    return '';
  }

  /** Pages are slices of the file's lines (`cursor` = the next line index), so a big transcript is not re-sent whole. */
  async read(nativeId: string, o: { cursor?: string; limit: number } = { limit: 50 }): Promise<{ messages: any[]; next?: string }> {
    const found = (await this.found()).find((f) => f.id === nativeId);
    if (!found) throw new Error(tr('Cursor 里找不到这个对话（可能在 Cursor 里删掉了）'));
    const text = await readCapped(found.file);
    const lines = text.split('\n').filter((l) => l.trim());
    const start = Math.max(0, Number(o.cursor ?? 0) || 0);
    const size = Math.max(1, o.limit || 50);
    const rows: unknown[] = [];
    for (const line of lines.slice(start, start + size)) {
      try { rows.push(JSON.parse(line)); } catch { /* a half-written last line */ }
    }
    const next = start + size < lines.length ? String(start + size) : undefined;
    return { messages: cursorMessages(rows, libraryId('cursor', nativeId), start), ...(next ? { next } : {}) };
  }

  async close(): Promise<void> { /* files only */ }
}

const HEAD = 64 * 1024;

async function readHead(file: string): Promise<string> {
  const fh = await fs.open(file, 'r');
  try {
    const st = await fh.stat();
    const len = Math.min(st.size, HEAD);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 0);
    return buf.toString('utf8');
  } finally {
    await fh.close().catch(() => {});
  }
}

async function readCapped(file: string): Promise<string> {
  const fh = await fs.open(file, 'r');
  try {
    const st = await fh.stat();
    const len = Math.min(st.size, MAX_FILE);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 0);
    return buf.toString('utf8');
  } finally {
    await fh.close().catch(() => {});
  }
}
