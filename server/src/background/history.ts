// 跑过的 (2026-11-19, docs/notes/background.md): the background work every conversation ran, read back from Claude
// Code's own records when someone looks — never part of the live snapshot (2026-11-05: finished tasks leave it after a
// minute, a day of them made the page and the cafe slow). Sub-agents and background commands come from the
// transcript: an Agent (old name Task) call and its result (a background one ends with the CLI's
// <task-notification>), a Bash / PowerShell call whose result names a backgroundTaskId (and its notification).
// Workflows come from `<conversation>/workflows/<runId>.json`. Nothing is stored: a small index per transcript in
// memory, read on from where it was when the file grows (a long conversation is 100+ MB; this machine had 4.4 GB of
// them), pages by start time across conversations.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { transcriptRoots } from '../runtime/transcript-file.js';
import { RUN_ID } from './disk.js';
import type { BgHistoryItem, BgHistoryKind, BgHistoryPage, BgHistoryQuery, BgStatus } from './types.js';

export const PAGE_DEFAULT = 50;
export const PAGE_MAX = 200;
const TITLE_MAX = 200;
const COMMAND_MAX = 500;
/** a line longer than this (a pasted file, an image as base64) is stepped over */
const LINE_MAX = 64 << 20;
/** tool calls waiting for their result, per transcript: a few at a time (parallel calls); one whose result never
 *  came (its process went mid-call) is let go when more come */
const CALLS_MAX = 32;
/** A transcript's rows started before it was last written; this much room for clocks that disagree (a WSL distro). */
const SLACK_MS = 5 * 60_000;
/** A conversation's own transcript (`<uuid>.jsonl`); an old CLI also left sub-agents' `agent-<id>.jsonl` beside them. */
const SESSION_FILE = /^(?!agent-)[\w-]{8,80}\.jsonl$/;
const CALL_NAMES = ['"name":"Agent"', '"name":"Task"', '"name":"Bash"', '"name":"PowerShell"'];

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
/** A string of its own: a slice keeps the whole string it was cut from alive (a 100 KB heredoc for a 200-char title). */
const flat = (s: string) => (s.length > 12 ? (JSON.parse(JSON.stringify(s)) as string) : s);
const clip = (s: string, n: number) => flat(s.length > n ? `${s.slice(0, n - 1)}…` : s);
const firstLine = (s: string) => s.split('\n').find((l) => l.trim())?.trim() ?? '';
const timeOf = (v: unknown) => { const t = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : undefined; };

/** How a notification / a run file says it ended (the registry's words: killed is stopped). */
function endStatus(s: unknown): BgStatus {
  return s === 'failed' || s === 'error' ? 'failed' : s === 'killed' || s === 'stopped' || s === 'interrupted' ? 'stopped' : 'completed';
}

/** Newest first; the same start: by id, so a cursor is exact. */
export function historyOrder(a: BgHistoryItem, b: BgHistoryItem): number {
  return b.startedAt - a.startedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

const cursorOf = (it: BgHistoryItem) => `${it.startedAt}:${it.id}`;
function parseCursor(c: string | undefined): { at: number; id: string } | undefined {
  if (!c) return undefined;
  const i = c.indexOf(':');
  const at = Number(c.slice(0, i));
  return i > 0 && Number.isFinite(at) ? { at, id: c.slice(i + 1) } : undefined;
}
const olderThan = (it: BgHistoryItem, b: { at: number; id: string } | undefined) => !b || it.startedAt < b.at || (it.startedAt === b.at && it.id < b.id);

// ---- one transcript ----

interface Call { kind: 'agent' | 'shell'; at: number; title: string; command?: string; agentType?: string; model?: string }

export interface TranscriptScan {
  sessionId: string;
  cwd?: string;
  /** the latest time a line was written: a task that never said it ended ended about then (its process went) */
  lastAt: number;
  /** Agent / Bash calls waiting for their result, by tool use id */
  calls: Map<string, Call>;
  /** what was found, by item id; a background one is `running` until its notification */
  items: Map<string, BgHistoryItem>;
  /** a background task's id (the agent id / the command's backgroundTaskId) → its item; and the item → the task */
  byTask: Map<string, string>;
  taskOf: Map<string, string>;
  /** its tool call → the task (a notification names both) */
  byToolUse: Map<string, string>;
  /** the notifications seen per item: `status\0summary` → when first seen; the latest distinct one is how it ended
   *  (one is written to the queue, handed to the model in a later turn, dequeued — the same, later; an agent that
   *  waited on its own background work notifies again when it really ends) */
  ends: Map<string, Map<string, { at: number; status: BgStatus }>>;
}

export function createScan(sessionId: string): TranscriptScan {
  return { sessionId, lastAt: 0, calls: new Map(), items: new Map(), byTask: new Map(), taskOf: new Map(), byToolUse: new Map(), ends: new Map() };
}

function textOf(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b: any) => (typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : '')).join('\n');
  return '';
}

function onCalls(s: TranscriptScan, e: any): void {
  if (e?.type !== 'assistant' || e.isSidechain === true || !Array.isArray(e.message?.content)) return;
  const at = timeOf(e.timestamp);
  if (at === undefined) return;
  for (const b of e.message.content) {
    if (b?.type !== 'tool_use' || typeof b.id !== 'string') continue;
    const input = b.input && typeof b.input === 'object' ? b.input : {};
    if (b.name === 'Agent' || b.name === 'Task') {
      s.calls.set(b.id, { kind: 'agent', at, title: clip(firstLine(str(input.description) ?? str(input.subagent_type) ?? ''), TITLE_MAX), agentType: str(input.subagent_type), model: str(input.model) });
    } else if (b.name === 'Bash' || b.name === 'PowerShell') {
      const command = str(input.command) ?? '';
      s.calls.set(b.id, { kind: 'shell', at, title: clip(firstLine(str(input.description) ?? command), TITLE_MAX), command: clip(command, COMMAND_MAX) });
    }
  }
  while (s.calls.size > CALLS_MAX) s.calls.delete(s.calls.keys().next().value!);
}

function put(s: TranscriptScan, item: BgHistoryItem, taskId?: string, toolUseId?: string): void {
  // strip what is not there, so a row is just its facts
  for (const k of Object.keys(item) as (keyof BgHistoryItem)[]) if (item[k] === undefined) delete item[k];
  s.items.set(item.id, item);
  if (taskId) {
    s.byTask.set(taskId, item.id);
    s.taskOf.set(item.id, taskId);
    if (toolUseId) s.byToolUse.set(toolUseId, taskId);
  }
}

function onResults(s: TranscriptScan, e: any): void {
  if (e?.type !== 'user' || e.isSidechain === true || !Array.isArray(e.message?.content)) return;
  const at = timeOf(e.timestamp);
  if (at === undefined) return;
  const r = e.toolUseResult;
  const res = r && typeof r === 'object' ? r : undefined;
  for (const b of e.message.content) {
    if (b?.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
    const c = s.calls.get(b.tool_use_id);
    if (!c) continue;
    s.calls.delete(b.tool_use_id);
    if (c.kind === 'shell') {
      // the turn waited for it: not background work
      const tid = str(res?.backgroundTaskId);
      if (!tid) continue;
      put(s, { id: `${s.sessionId}|shell|${tid}`, sessionId: s.sessionId, kind: 'shell', title: c.title, command: c.command, status: 'running', startedAt: c.at }, tid, b.tool_use_id);
      continue;
    }
    const agentId = str(res?.agentId);
    const item: BgHistoryItem = {
      id: `${s.sessionId}|agent|${agentId ?? b.tool_use_id}`, sessionId: s.sessionId, kind: 'agent', title: c.title, status: 'running', startedAt: c.at,
      agentId, agentType: str(res?.agentType) ?? c.agentType, model: str(res?.resolvedModel) ?? c.model,
    };
    if (res?.isAsync === true || res?.status === 'async_launched') {
      // sent to the background: it ends with its notification
      put(s, item, agentId, b.tool_use_id);
      continue;
    }
    const failedText = b.is_error === true || (typeof r === 'string' && /^error\b/i.test(r)) ? `${textOf(b.content)}\n${typeof r === 'string' ? r : ''}` : '';
    item.status = failedText ? (/interrupt/i.test(failedText) ? 'stopped' : 'failed') : endStatus(res?.status);
    item.endedAt = at;
    item.tokens = num(res?.totalTokens);
    item.toolUses = num(res?.totalToolUseCount);
    put(s, item);
  }
}

const NOTICE = /<task-notification>([\s\S]*?)<\/task-notification>/g;
const tag = (body: string, name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body)?.[1]?.trim();

function onNotices(s: TranscriptScan, line: string): void {
  let e: any;
  try { e = JSON.parse(line); } catch { return; }
  // the CLI's own lines with a time: the queue operation, the turn it was handed to the model in, the queued command
  // attached to a turn (not a snapshot of the whole prompt, which quotes old ones)
  if (e?.isSidechain === true) return;
  if (e?.type !== 'queue-operation' && e?.type !== 'user' && !(e?.type === 'attachment' && e.attachment?.type === 'queued_command')) return;
  const at = timeOf(e.timestamp);
  if (at === undefined) return;
  for (const m of line.matchAll(NOTICE)) {
    const body = m[1];
    const status = tag(body, 'status');
    if (!status) continue;
    const taskId = tag(body, 'task-id');
    const toolUse = tag(body, 'tool-use-id');
    const itemId = (taskId && s.byTask.get(taskId)) || (toolUse && s.byTask.get(s.byToolUse.get(toolUse) ?? '')) || undefined;
    const item = itemId ? s.items.get(itemId) : undefined;
    if (!item) continue;
    let seen = s.ends.get(item.id);
    if (!seen) s.ends.set(item.id, (seen = new Map()));
    // nothing kept may point into the piece read (a slice of it would keep all 4 MB alive): our own status word, a
    // number for the summary
    const st = endStatus(status);
    const key = `${st}:${hash(tag(body, 'summary') ?? '')}`;
    if (!seen.has(key)) seen.set(key, { at, status: st });
    let last: { at: number; status: BgStatus } = { at: -Infinity, status: st };
    for (const v of seen.values()) if (v.at >= last.at) last = v;
    item.status = last.status;
    item.endedAt = Math.max(item.startedAt, last.at);
    const usage = tag(body, 'usage');
    if (usage) {
      const tokens = tag(usage, 'total_tokens'), tools = tag(usage, 'tool_uses');
      if (tokens && Number.isFinite(+tokens)) item.tokens = +tokens;
      if (tools && Number.isFinite(+tools)) item.toolUses = +tools;
    }
  }
}

/** A line's own time: its last `"timestamp"` (the CLI writes it after the message). */
function lineTime(line: string): number | undefined {
  const i = line.lastIndexOf('"timestamp":"');
  if (i < 0) return undefined;
  const j = line.indexOf('"', i + 13);
  return j > 0 ? timeOf(line.slice(i + 13, j)) : undefined;
}

/** FNV-1a, for telling notifications apart without keeping their text */
function hash(t: string): number {
  let h = 2166136261;
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const B_RESULT = Buffer.from('"tool_result"');
const B_RESULT_ID = Buffer.from('"tool_use_id":"');
const B_BG_TASK = Buffer.from('"backgroundTaskId"');
const B_NOTICE = Buffer.from('<task-notification>');
const B_CWD = Buffer.from('"cwd":"');
const B_NAMES = CALL_NAMES.map((n) => Buffer.from(n));
/** where in a line its markers are (measured on a 131 MB transcript, 2026-11-19): a call's tool name within its first
 *  250 bytes, a result's "tool_result" within 230 and its tool_use_id within 5 KB, a notification within 10 KB — most
 *  of a long line is a file's contents or a reply, and searching all of it for each marker was most of the time */
const HEAD = 64 << 10;
/** Lines that are not a message: the CLI's own bookkeeping (and an engine's request dumps, which quote whole
 *  conversations — tool calls, results, old notifications — and are megabytes long). Only these kinds are read. */
const LINE_KINDS = new Set(['user', 'assistant', 'attachment', 'queue-operation', 'system']);

function lineKind(line: Buffer): string | undefined {
  // `{"type":"…"` first (queue lines, the bookkeeping, a transcript we wrote ourselves); a message's comes later
  if (line.length < 10 || line[2] !== 0x74 /* t */) return undefined;
  const m = /^\{"type":"([\w-]{1,40})"/.exec(line.toString('latin1', 0, 56));
  return m?.[1];
}

/** The tool use ids a result line answers (the first ones, near its start; one far into the line is found too). */
function resultIds(line: Buffer): string[] {
  const out: string[] = [];
  let from = 0;
  for (let i = 0; i < 8; i++) {
    const at = line.indexOf(B_RESULT_ID, from);
    if (at < 0) break;
    const a = at + B_RESULT_ID.length;
    const b = line.indexOf(0x22, a);
    if (b < 0 || b - a > 200) break;
    out.push(line.toString('latin1', a, b));
    from = b;
    if (from > HEAD) break;
  }
  return out;
}

/**
 * One line (its bytes): only a line that can matter is decoded — an Agent / Bash call, the result of a call waiting
 * for one, a notification of a task we know — most of a transcript (file contents, replies) is never turned into text.
 */
function scanLine(s: TranscriptScan, line: Buffer): void {
  const kind = lineKind(line);
  if (kind !== undefined && !LINE_KINDS.has(kind)) return;
  if (!s.cwd && line.indexOf(B_CWD) >= 0) {
    const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(line.toString('utf8'));
    if (m) { try { s.cwd = JSON.parse(`"${m[1]}"`) as string; } catch { /* keep looking */ } }
  }
  const head = line.length > HEAD ? line.subarray(0, HEAD) : line;
  const notice = s.byTask.size > 0 && head.indexOf(B_NOTICE) >= 0;
  const calls = kind !== 'queue-operation' && B_NAMES.some((n) => head.indexOf(n) >= 0);
  let results = false;
  if (s.calls.size && head.indexOf(B_RESULT) >= 0) {
    for (const id of resultIds(line)) {
      const c = s.calls.get(id);
      if (!c) continue;
      // a command's result matters only when it went to the background; else the call is just done
      if (c.kind === 'shell' && line.indexOf(B_BG_TASK) < 0) { s.calls.delete(id); continue; }
      results = true;
    }
  }
  if (!notice && !calls && !results) return;
  const text = line.toString('utf8');
  if (notice) onNotices(s, text);
  if (!calls && !results) return;
  let e: any;
  try { e = JSON.parse(text); } catch { return; }
  if (calls) onCalls(s, e);
  if (results) onResults(s, e);
}

/** Whole lines of the transcript, in order (a read ends at a line end). */
export function scanBuffer(s: TranscriptScan, buf: Buffer): void {
  let start = 0;
  let last: [number, number] | undefined;
  const ends: [number, number][] = [];
  while (start < buf.length) {
    let end = buf.indexOf(10, start);
    if (end < 0) end = buf.length;
    let stop = end;
    if (stop > start && buf[stop - 1] === 13) stop--;
    if (stop > start) {
      scanLine(s, buf.subarray(start, stop));
      last = [start, stop];
      ends.push(last);
      if (ends.length > 50) ends.shift();
    }
    start = end + 1;
  }
  if (!last) return;
  // the time of the latest line that has one (the very last may be a summary line without)
  let t: number | undefined;
  for (let k = ends.length - 1; k >= 0 && t === undefined; k--) t = bufTime(buf, ends[k][0], ends[k][1]);
  if (t !== undefined && t > s.lastAt) s.lastAt = t;
}

/** A line's time without decoding all of a long one: a message line has it at its end, a queue line near its start. */
function bufTime(buf: Buffer, a: number, b: number): number | undefined {
  if (b - a <= 65536) return lineTime(buf.toString('utf8', a, b));
  return lineTime(buf.toString('utf8', b - 4096, b)) ?? lineTime(buf.toString('utf8', a, a + 4096));
}

/** The same, from text (tests). */
export function scanLines(s: TranscriptScan, text: string): void {
  scanBuffer(s, Buffer.from(text, 'utf8'));
}

/** The rows found, newest first. A background task with no end yet is left out while it runs (it is 在跑), else it
 *  stopped when its conversation's process went — about the transcript's last line. */
export function scanItems(s: TranscriptScan, o: { isRunning?: (taskId: string) => boolean } = {}): BgHistoryItem[] {
  const out: BgHistoryItem[] = [];
  for (const it of s.items.values()) {
    let x = it;
    if (it.status === 'running') {
      const task = s.taskOf.get(it.id);
      if (task && o.isRunning?.(task)) continue;
      x = { ...it, status: 'stopped', endedAt: Math.max(it.startedAt, s.lastAt) };
    }
    if (s.cwd && !x.cwd) x = { ...x, cwd: s.cwd };
    out.push(x);
  }
  return out.sort(historyOrder);
}

// ---- workflow runs ----

interface RunRec { mtimeMs: number; size: number; item: BgHistoryItem | null; taskId?: string }

/** A finished workflow run file as a row (the same file background.run reads). */
export function runItem(sessionId: string, runId: string, j: any): { item: BgHistoryItem; taskId?: string } {
  const startedAt = num(j?.startTime) ?? timeOf(j?.timestamp) ?? 0;
  const progress: any[] = Array.isArray(j?.workflowProgress) ? j.workflowProgress : [];
  const agents = progress.filter((e) => e?.type === 'workflow_agent');
  const title = clip(firstLine(str(j?.workflowName) ?? str(j?.summary) ?? runId), TITLE_MAX);
  const summary = str(j?.summary) && firstLine(j.summary) !== title ? clip(firstLine(j.summary), TITLE_MAX) : undefined;
  // disk.ts's reading of the same file: anything but completed / running / failed (killed, aborted…) was stopped
  const st = j?.status;
  const item: BgHistoryItem = {
    id: `${sessionId}|workflow|${runId}`, sessionId, kind: 'workflow', title, status: st === 'completed' ? 'completed' : st === 'running' ? 'running' : st === 'failed' ? 'failed' : 'stopped',
    startedAt, runId, agentCount: num(j?.agentCount) ?? agents.length, failed: agents.filter((a) => a?.state === 'error').length,
  };
  const dur = num(j?.durationMs);
  if (dur !== undefined) item.endedAt = startedAt + dur;
  if (summary) item.summary = summary;
  const tokens = num(j?.totalTokens), tools = num(j?.totalToolCalls);
  if (tokens !== undefined) item.tokens = tokens;
  if (tools !== undefined) item.toolUses = tools;
  return { item, ...(str(j?.taskId) ? { taskId: j.taskId } : {}) };
}

// ---- every conversation ----

interface FileRec { file: string; sessionId: string; dir: string; size: number; mtimeMs: number }
interface Indexed { size: number; mtimeMs: number; pos: number; skipping: boolean; scan: TranscriptScan; runs: Map<string, RunRec>; wfMtime?: number; runsStale: boolean }

export interface HistoryOptions {
  /** where the projects folders are (default: this computer's and its WSL distros', transcript-file.ts) */
  roots?: () => { dir: string }[];
  /** a task still running now (the live registry): left out */
  isRunning?: (sessionId: string, taskId: string) => boolean;
  /** how long the list of transcripts is reused (scrolling asks for pages a second apart) */
  filesTtlMs?: number;
  /** bytes per read (tests read in tiny pieces) */
  chunkBytes?: number;
}

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? '';

export class BgHistory {
  private files?: { at: number; list: FileRec[] };
  private listing?: Promise<FileRec[]>;
  private idx = new Map<string, Indexed>();
  private busy = new Map<string, Promise<Indexed>>();

  constructor(private readonly o: HistoryOptions = {}) {}

  async page(q: BgHistoryQuery = {}): Promise<BgHistoryPage> {
    const limit = Math.max(1, Math.min(PAGE_MAX, Math.floor(num(q.limit) ?? PAGE_DEFAULT)));
    const before = parseCursor(q.before);
    const words = (q.q ?? '').trim().toLowerCase();
    const also = new Set(Array.isArray(q.also) ? q.also.filter((x) => typeof x === 'string') : []);
    const only: BgHistoryKind | undefined = q.only === 'workflow' || q.only === 'agent' || q.only === 'shell' ? q.only : undefined;
    let files = await this.listFiles();
    if (q.sessionId) files = files.filter((f) => f.sessionId === q.sessionId);
    const found: BgHistoryItem[] = [];
    let more = false;
    for (const f of files) {
      if (found.length >= limit) {
        found.sort(historyOrder);
        if (found.length > limit) { found.length = limit; more = true; }
        // every row of this transcript and the ones after it started before it was last written: none can be newer
        if (f.mtimeMs + SLACK_MS < found[limit - 1].startedAt) { more = true; break; }
      }
      for (const it of await this.itemsOf(f)) if (olderThan(it, before) && matches(it, only, words, also)) found.push(it);
    }
    found.sort(historyOrder);
    if (found.length > limit) more = true;
    const items = found.slice(0, limit);
    return { items, ...(more && items.length ? { next: cursorOf(items[items.length - 1]) } : {}) };
  }

  /** Every conversation's transcript, newest first (reused for filesTtlMs). */
  private async listFiles(): Promise<FileRec[]> {
    const ttl = this.o.filesTtlMs ?? 5000;
    if (this.files && Date.now() - this.files.at < ttl) return this.files.list;
    if (this.listing) return this.listing;
    this.listing = (async () => {
      const out: FileRec[] = [];
      for (const root of (this.o.roots ?? transcriptRoots)()) {
        const projects = await fs.readdir(root.dir, { withFileTypes: true }).catch(() => []);
        for (const p of projects) {
          if (!p.isDirectory()) continue;
          const pdir = path.join(root.dir, p.name);
          const names = await fs.readdir(pdir).catch(() => [] as string[]);
          await Promise.all(names.filter((n) => SESSION_FILE.test(n)).map(async (n) => {
            const file = path.join(pdir, n);
            try {
              const st = await fs.stat(file);
              if (st.isFile()) out.push({ file, sessionId: n.slice(0, -6), dir: file.slice(0, -6), size: st.size, mtimeMs: st.mtimeMs });
            } catch { /* gone */ }
          }));
        }
      }
      out.sort((a, b) => b.mtimeMs - a.mtimeMs);
      this.files = { at: Date.now(), list: out };
      return out;
    })().finally(() => { this.listing = undefined; });
    return this.listing;
  }

  private async itemsOf(f: FileRec): Promise<BgHistoryItem[]> {
    const rec = await this.index(f);
    const running = this.o.isRunning;
    const items = scanItems(rec.scan, running ? { isRunning: (id) => running(f.sessionId, id) } : {});
    for (const r of await this.runsOf(f, rec)) {
      if (!r.item) continue;
      let it = r.item;
      if (it.status === 'running') {
        if (r.taskId && running?.(f.sessionId, r.taskId)) continue;
        it = { ...it, status: 'stopped', endedAt: it.endedAt ?? Math.max(it.startedAt, r.mtimeMs) };
      }
      items.push(rec.scan.cwd && !it.cwd ? { ...it, cwd: rec.scan.cwd } : it);
    }
    return items;
  }

  /** The transcript read up to its end: on from where it was when it grew, from the start when it was rewritten. */
  private index(f: FileRec): Promise<Indexed> {
    const have = this.idx.get(f.file);
    if (have && have.size === f.size && have.mtimeMs === f.mtimeMs) return Promise.resolve(have);
    const going = this.busy.get(f.file);
    if (going) return going;
    const p = (async () => {
      const rec: Indexed = have && f.size >= have.pos ? have : { size: 0, mtimeMs: 0, pos: 0, skipping: false, scan: createScan(f.sessionId), runs: have?.runs ?? new Map(), runsStale: true };
      await this.readOn(f.file, rec, f.size);
      rec.size = f.size;
      rec.mtimeMs = f.mtimeMs;
      rec.runsStale = true;
      this.idx.set(f.file, rec);
      return rec;
    })().finally(() => this.busy.delete(f.file));
    this.busy.set(f.file, p);
    return p;
  }

  private async readOn(file: string, rec: Indexed, size: number): Promise<void> {
    const chunk = Math.max(16, this.o.chunkBytes ?? 4 << 20);
    let fh: Awaited<ReturnType<typeof fs.open>> | undefined;
    try { fh = await fs.open(file, 'r'); } catch { return; }
    try {
      let pos = rec.pos;
      /** the start of a line read in an earlier piece */
      let tail: Buffer | null = null;
      while (pos < size) {
        const buf = Buffer.allocUnsafe(Math.min(chunk, size - pos));
        const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
        if (!bytesRead) break;
        pos += bytesRead;
        const got = buf.subarray(0, bytesRead);
        const nl = got.lastIndexOf(10);
        if (nl < 0) {
          if (rec.skipping) continue;
          tail = tail ? Buffer.concat([tail, got]) : Buffer.from(got);
          if (tail.length > LINE_MAX) { tail = null; rec.skipping = true; }
          continue;
        }
        let whole = tail ? Buffer.concat([tail, got.subarray(0, nl + 1)]) : got.subarray(0, nl + 1);
        tail = null;
        if (rec.skipping) {
          // the rest of a line too long to read: drop it up to its end
          whole = whole.subarray(whole.indexOf(10) + 1);
          rec.skipping = false;
        }
        if (whole.length) scanBuffer(rec.scan, whole);
        if (nl + 1 < bytesRead) tail = Buffer.from(got.subarray(nl + 1));
      }
      // a line not finished yet is read again next time (rec.pos stops before it)
      rec.pos = pos - (tail?.length ?? 0);
    } finally {
      await fh.close();
    }
  }

  /** The conversation's finished workflow runs (`workflows/<runId>.json`), re-read when the folder or the transcript changed. */
  private async runsOf(f: FileRec, rec: Indexed): Promise<RunRec[]> {
    const wf = path.join(f.dir, 'workflows');
    let st: Awaited<ReturnType<typeof fs.stat>>;
    try { st = await fs.stat(wf); } catch { rec.runs.clear(); rec.wfMtime = undefined; return []; }
    if (rec.wfMtime !== st.mtimeMs || rec.runsStale) {
      rec.wfMtime = st.mtimeMs;
      rec.runsStale = false;
      const names = (await fs.readdir(wf).catch(() => [] as string[])).filter((n) => n.endsWith('.json') && RUN_ID.test(n.slice(0, -5)));
      const next = new Map<string, RunRec>();
      for (const n of names) {
        const file = path.join(wf, n);
        let s2: Awaited<ReturnType<typeof fs.stat>>;
        try { s2 = await fs.stat(file); } catch { continue; }
        const old = rec.runs.get(n);
        if (old && old.mtimeMs === s2.mtimeMs && old.size === s2.size) { next.set(n, old); continue; }
        let j: unknown;
        try { j = JSON.parse(await fs.readFile(file, 'utf8')); } catch { next.set(n, { mtimeMs: s2.mtimeMs, size: s2.size, item: null }); continue; }
        next.set(n, { mtimeMs: s2.mtimeMs, size: s2.size, ...runItem(f.sessionId, n.slice(0, -5), j) });
      }
      rec.runs = next;
    }
    return [...rec.runs.values()];
  }
}

function matches(it: BgHistoryItem, only: BgHistoryKind | undefined, words: string, also: Set<string>): boolean {
  if (only && it.kind !== only) return false;
  if (!words || also.has(it.sessionId)) return true;
  return [it.title, it.summary, it.command, it.agentType, it.cwd ? baseName(it.cwd) : ''].some((x) => !!x && x.toLowerCase().includes(words));
}
