// 后台 (spec 2026-10-12-background-office-design.md §2): every conversation's background — workflows and their agents,
// sub-agents, background commands — kept from the SDK stream of the conversation pool, pushed to the windows at most
// once a second per conversation, and what is on disk about it (finished runs, sub-agent transcripts) on request.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { applyBg, createBgState, endRunning, snapshotBg, type BgState } from './registry.js';
import { listRuns, readAgentTranscript, readRun, sessionDirOf } from './disk.js';
import type { BackgroundRequest, BgRunSummary, BgSession, BgTask } from './types.js';
import { tr } from '../i18n/index.js';

/** A conversation whose background has all ended is kept this long (the page's 「结束了」). */
export const KEEP_ENDED_MS = 24 * 3600_000;
export const MAX_SESSIONS = 50;
/**
 * A task that ended (done / failed / stopped) leaves the picture after this: long enough for the 网吧's checkout walk
 * and to read 完成 / 失败 on its card, then it goes — a day of finished cards and seated customers made the page and
 * the 3D cafe slow (2026-11-05 user report). A conversation left with nothing goes with it.
 */
export const KEEP_TASK_MS = 60_000;

/**
 * The ends the CLI wrote into the transcript, as task_notification messages. A background command (or sub-agent) that
 * ends while a turn runs is handed to the model in that turn, and neither engine then emits its task_notification on
 * the stream (only one that waits for the next turn does) — the task stayed 「在跑」 for ever: 「后台 · 19 条命令」 with
 * nothing running, and the pool kept the process for it (2026-10-17 user report). The notification itself is in the
 * transcript (a queue-operation line with `<task-notification>…<task-id>…<status>…`).
 */
export function noticesIn(text: string): { task_id: string; status: string; summary?: string }[] {
  const out: { task_id: string; status: string; summary?: string }[] = [];
  const re = /<task-notification>([\s\S]*?)<\/task-notification>/g;
  for (const m of text.matchAll(re)) {
    const body = m[1];
    const id = /<task-id>([^<]+)<\/task-id>/.exec(body)?.[1]?.trim();
    const status = /<status>([^<]+)<\/status>/.exec(body)?.[1]?.trim();
    if (!id || !status) continue;
    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(body)?.[1];
    out.push({ task_id: id, status, ...(summary ? { summary: unescapeJson(summary) } : {}) });
  }
  return out;
}

/** A transcript line that is the CLI's own queue operation (not a tool call or output that mentions one). */
function isQueueLine(line: string): boolean {
  try { return (JSON.parse(line) as { type?: unknown })?.type === 'queue-operation'; } catch { return false; }
}

/** The text as written inside a JSON string (\n, \", \\, \uXXXX), back to itself. */
function unescapeJson(t: string): string {
  try { return JSON.parse(`"${t.replace(/(^|[^\\])"/g, '$1\\"')}"`) as string; } catch { return t; }
}

export interface BgPool {
  on(e: 'message', f: (sessionId: string, m: unknown) => void): unknown;
  on(e: 'state', f: (sessionId: string, state: string, error?: string) => void): unknown;
}

export class BackgroundService extends EventEmitter {
  private states = new Map<string, BgState>();
  private timers = new Map<string, NodeJS.Timeout>();
  private lastPush = new Map<string, number>();
  private readonly now: () => number;
  private readonly flushMs: number;

  /** the transcript of a conversation (for the ends the stream did not carry); none → only the stream counts */
  private readonly transcriptOf?: (sessionId: string) => string | null;
  /** how far each transcript was read: its path and the byte read up to */
  private readAt = new Map<string, { file: string; pos: number }>();
  private sweep?: NodeJS.Timeout;

  private pruner?: NodeJS.Timeout;

  constructor(o: { pool: BgPool; now?: () => number; flushMs?: number; transcriptOf?: (sessionId: string) => string | null; sweepMs?: number; pruneMs?: number }) {
    super();
    this.now = o.now ?? Date.now;
    this.flushMs = o.flushMs ?? 1000;
    this.transcriptOf = o.transcriptOf;
    if (o.transcriptOf) {
      this.sweep = setInterval(() => { for (const id of this.states.keys()) this.reconcile(id); }, o.sweepMs ?? 5000);
      this.sweep.unref?.();
    }
    this.pruner = setInterval(() => this.pruneEnded(), o.pruneMs ?? 5000);
    this.pruner.unref?.();
    o.pool.on('message', (sid, m) => this.observe(sid, m));
    // the CLI process ended or is being replaced (a provider switch, a forced stop): its background went with it
    o.pool.on('state', (sid, state) => {
      if (state !== 'closed' && state !== 'error' && state !== 'starting') return;
      const s = this.states.get(sid);
      if (s && endRunning(s, tr('进程结束了'), this.now())) this.schedule(sid);
    });
  }

  observe(sessionId: string, m: unknown): void {
    const t = (m as any)?.type === 'system' ? (m as any).subtype : undefined;
    if (typeof t !== 'string' || !t.startsWith('task_')) return;
    let s = this.states.get(sessionId);
    const fresh = !s;
    if (!s) s = createBgState(sessionId);
    if (!applyBg(s, m, this.now())) return;
    if (fresh) { this.states.set(sessionId, s); this.trim(); this.markRead(sessionId); }
    this.schedule(sessionId);
  }

  /** Start reading the transcript where it ends now: ends written before this conversation had background work are not ours. */
  private markRead(sessionId: string): void {
    const file = this.transcriptOf?.(sessionId);
    if (!file) return;
    try { this.readAt.set(sessionId, { file, pos: fs.statSync(file).size }); } catch { this.readAt.set(sessionId, { file, pos: 0 }); }
  }

  /** Read what the transcript gained since last time and apply the ends in it (only while something is 在跑). */
  reconcile(sessionId: string): boolean {
    const s = this.states.get(sessionId);
    if (!s || !this.running(s) || !this.transcriptOf) return false;
    let at = this.readAt.get(sessionId);
    if (!at) { const file = this.transcriptOf(sessionId); if (!file) return false; at = { file, pos: 0 }; this.readAt.set(sessionId, at); }
    let text = '';
    try {
      const size = fs.statSync(at.file).size;
      if (size < at.pos) at.pos = 0; // rewritten
      if (size === at.pos) return false;
      const fd = fs.openSync(at.file, 'r');
      try {
        const n = Math.min(size - at.pos, 32 * 1024 * 1024);
        const buf = Buffer.alloc(n);
        fs.readSync(fd, buf, 0, n, at.pos);
        // up to the last whole line: a notification cut in half is read next time; a line longer than the whole window
        // (a pasted file as base64) is no queue operation — step over it instead of reading it again every sweep
        const end = buf.lastIndexOf(10);
        if (end < 0) { if (n === 32 * 1024 * 1024) at.pos += n; return false; }
        text = buf.toString('utf8', 0, end + 1);
        at.pos += end + 1;
      } finally { fs.closeSync(fd); }
    } catch { return false; }
    let changed = false;
    // only the CLI's own queue lines: a command's output or a reply that quotes a notification is not an end
    const queued = text.split('\n').filter((l) => l.includes('<task-notification>') && isQueueLine(l)).join('\n');
    for (const n of noticesIn(queued)) if (applyBg(s, { type: 'system', subtype: 'task_notification', ...n }, this.now())) changed = true;
    if (changed) this.schedule(sessionId);
    return changed;
  }

  /** The first change goes out at once; changes after it are gathered for `flushMs`. */
  private schedule(sessionId: string): void {
    if (this.timers.has(sessionId)) return;
    const wait = Math.max(0, (this.lastPush.get(sessionId) ?? 0) + this.flushMs - this.now());
    if (wait === 0) { this.push(sessionId); return; }
    const timer = setTimeout(() => { this.timers.delete(sessionId); this.push(sessionId); }, wait);
    timer.unref?.();
    this.timers.set(sessionId, timer);
  }

  private push(sessionId: string): void {
    const s = this.states.get(sessionId);
    if (!s) return;
    this.lastPush.set(sessionId, this.now());
    this.emit('changed', snapshotBg(s));
  }

  private running = (s: BgState) => s.tasks.some((t) => t.status === 'running');

  /**
   * Ended tasks past KEEP_TASK_MS leave the snapshot (their runs and transcripts stay on disk for 历史). A conversation
   * with none left is dropped and pushed once empty, so the windows forget it too.
   */
  pruneEnded(): void {
    const now = this.now();
    for (const [id, s] of this.states) {
      const keep = s.tasks.filter((t) => t.status === 'running' || now - (t.endedAt ?? s.updatedAt) < KEEP_TASK_MS);
      if (keep.length === s.tasks.length) continue;
      s.tasks = keep;
      if (!keep.length) {
        this.drop(id);
        this.emit('changed', { sessionId: id, updatedAt: now, tasks: [], events: [] } satisfies BgSession);
      } else this.schedule(id);
    }
  }

  /** Ended conversations past KEEP_ENDED_MS go; beyond MAX_SESSIONS the oldest ended ones go first. */
  private trim(): void {
    const now = this.now();
    for (const [id, s] of this.states) if (!this.running(s) && now - s.updatedAt > KEEP_ENDED_MS) this.drop(id);
    if (this.states.size <= MAX_SESSIONS) return;
    const ended = [...this.states.values()].filter((s) => !this.running(s)).sort((a, b) => a.updatedAt - b.updatedAt);
    for (const s of ended.slice(0, this.states.size - MAX_SESSIONS)) this.drop(s.sessionId);
  }

  private drop(id: string): void {
    this.states.delete(id);
    this.readAt.delete(id);
    this.lastPush.delete(id);
    const t = this.timers.get(id);
    if (t) { clearTimeout(t); this.timers.delete(id); }
  }

  list(): BgSession[] {
    this.pruneEnded();
    this.trim();
    return [...this.states.values()].map(snapshotBg);
  }

  /** Whether the conversation has background work running now (the pool keeps such a process, the composer shows the pill). */
  hasRunning(sessionId: string): boolean {
    const s = this.states.get(sessionId);
    return !!s && this.running(s);
  }

  async history(sessionId: string): Promise<BgRunSummary[]> {
    const dir = sessionDirOf(sessionId);
    return dir ? listRuns(dir) : [];
  }

  async run(sessionId: string, runId: string): Promise<BgTask | null> {
    const dir = sessionDirOf(sessionId);
    return dir ? readRun(dir, runId) : null;
  }

  async transcript(sessionId: string, agentId: string): Promise<unknown[]> {
    const dir = sessionDirOf(sessionId);
    return dir ? readAgentTranscript(dir, agentId) : [];
  }

  dispose(): void {
    if (this.sweep) clearInterval(this.sweep);
    if (this.pruner) clearInterval(this.pruner);
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}

const KINDS = new Set<string>(['background.list', 'background.history', 'background.run', 'background.transcript']);

export function isBackgroundRequest(req: { kind: string }): req is BackgroundRequest {
  return KINDS.has(req.kind);
}

export async function handleBackground(s: BackgroundService, req: BackgroundRequest): Promise<unknown> {
  switch (req.kind) {
    case 'background.list': return s.list();
    case 'background.history': return s.history(req.sessionId);
    case 'background.run': return s.run(req.sessionId, req.runId);
    case 'background.transcript': return s.transcript(req.sessionId, req.agentId);
  }
}
