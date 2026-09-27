// OpenCode session source: lists/reads/manages `opencode serve`'s sessions over its official HTTP
// API (no direct file access — constraints.md). See task-4-brief.md for the wire shapes.
//
// Real-machine checks (opencode 1.14.33, Windows, 2026-09-27):
// - `opencode serve --port 0 --hostname 127.0.0.1` prints to stdout:
//     Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.
//     opencode server listening on http://127.0.0.1:<port>
//   `PORT_RE` below is pinned to that second line; port 0 works (the OS picks a free port), so we
//   never need to pick one ourselves.
// - `GET /doc` on this build only documents `/auth/{providerID}` and `/log` — `paths['/session/{id}']`
//   is absent entirely, even though `PATCH`/`DELETE /session/{id}` are real, working endpoints (per
//   the brief). That means `probeCaps()` below, which follows the brief's algorithm literally
//   (rename/delete = presence of patch/delete under `paths['/session/{id}']`), currently reports
//   `caps.rename` and `caps.delete` as `false` on real machines running this opencode version — a
//   known limitation of opencode's own (incomplete) OpenAPI doc, not of this adapter. See the task
//   report for detail; flagged as a concern rather than silently working around the documented
//   algorithm.
// - `opencode acp`'s `initialize` response reports `agentCapabilities.loadSession: true`, so
//   `caps.resume` stays `true` (continuing a session via the ACP driver is supported).
import { spawn, type ChildProcess } from 'node:child_process';
import type { AgentKind, SessionSummary, SourceCaps, SourceStatus } from '../protocol.js';
import { resolveSpawn } from '../agents/resolve.js';
import { libraryId } from './ids.js';
import { opencodeToMessages } from './opencode-convert.js';
import type { SessionSource } from './types.js';

const PORT_RE = /https?:\/\/127\.0\.0\.1:(\d+)/;
const IDLE_MS = 300_000; // 5 min — library-only process, never shared with a live chat session
const START_TIMEOUT_MS = 30_000;

interface Proc {
  baseUrl: string;
  child: ChildProcess | null; // null when opts.baseUrl was injected by a test
  capsProbed: boolean;
}

function mapSession(s: any, caps: SourceCaps): SessionSummary {
  return {
    sessionId: libraryId('opencode', s.id),
    title: s.title,
    cwd: s.directory,
    lastModified: s.time?.updated ?? 0,
    createdAt: s.time?.created,
    agent: 'opencode' as AgentKind,
    source: 'opencode',
    parentId: s.parentID ? libraryId('opencode', s.parentID) : undefined,
    caps,
  };
}

export class OpenCodeSource implements SessionSource {
  readonly kind: AgentKind = 'opencode';
  caps: SourceCaps = { resume: true, rename: false, archive: false, delete: false, fork: false };
  private proc: Proc | null = null;
  private starting: Promise<Proc> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly getLaunch: () => { command: string; env: Record<string, string> },
    private readonly opts: { baseUrl?: string } = {},
  ) {}

  private clearIdle() {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
  }

  private armIdle() {
    this.clearIdle();
    if (this.opts.baseUrl) return; // test-injected server: nothing of ours to kill
    this.idleTimer = setTimeout(() => {
      const p = this.proc;
      this.proc = null;
      p?.child?.kill();
    }, IDLE_MS);
  }

  private spawnProc(): Promise<Proc> {
    if (this.opts.baseUrl) return Promise.resolve({ baseUrl: this.opts.baseUrl, child: null, capsProbed: false });
    const l = this.getLaunch();
    const r = resolveSpawn(l.command, ['serve', '--port', '0', '--hostname', '127.0.0.1']);
    let child: ChildProcess;
    try {
      child = spawn(r.command, r.args, { env: { ...process.env, ...l.env, ...r.env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: r.via === 'cmd' });
    } catch (e: any) {
      return Promise.reject(e);
    }
    return new Promise<Proc>((resolve, reject) => {
      let buf = '';
      let settled = false;
      const finish = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); fn(); };
      const timer = setTimeout(() => finish(() => { child.kill(); reject(new Error('opencode serve：等待端口超时')); }), START_TIMEOUT_MS);
      const onData = (d: Buffer) => {
        buf += d.toString('utf8');
        const m = PORT_RE.exec(buf);
        if (m) finish(() => resolve({ baseUrl: `http://127.0.0.1:${m[1]}`, child, capsProbed: false }));
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.on('error', (e) => finish(() => reject(e)));
      child.on('exit', (code) => finish(() => reject(new Error(`opencode serve 退出，code=${code}`))));
    });
  }

  private async ensure(): Promise<Proc> {
    if (this.proc) return this.proc;
    if (this.starting) return this.starting;
    this.starting = this.spawnProc()
      .then((p) => { this.proc = p; return p; })
      .finally(() => { this.starting = null; });
    return this.starting;
  }

  private async probeCaps(p: Proc): Promise<void> {
    if (p.capsProbed) return;
    p.capsProbed = true;
    try {
      const res = await fetch(`${p.baseUrl}/doc`);
      if (!res.ok) return;
      const doc: any = await res.json();
      const methods = doc?.paths?.['/session/{id}'] ?? {};
      this.caps = { resume: true, rename: !!methods.patch, archive: false, delete: !!methods.delete, fork: false };
    } catch { /* leave the conservative defaults */ }
  }

  async status(): Promise<SourceStatus> {
    const base = { kind: this.kind, name: 'OpenCode', joined: false, dismissed: false };
    try {
      const p = await this.ensure();
      await this.probeCaps(p);
      this.armIdle();
      return { ...base, installed: true, detected: true, enabled: true };
    } catch (e: any) {
      const message = e?.message ?? String(e);
      return { ...base, installed: false, detected: false, enabled: false, error: message, disabledReason: message };
    }
  }

  async list(o: { cursor?: string; limit: number; archived?: boolean }): Promise<{ items: SessionSummary[]; next?: string }> {
    try {
      const p = await this.ensure();
      await this.probeCaps(p);
      this.armIdle();
      const res = await fetch(`${p.baseUrl}/session`);
      if (!res.ok) return { items: [] };
      const all: any[] = await res.json();
      all.sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
      const offset = o.cursor ? Number(o.cursor) : 0;
      const limit = o.limit ?? 20;
      const page = all.slice(offset, offset + limit);
      const items = page.map((s) => mapSession(s, this.caps));
      const next = offset + limit < all.length ? String(offset + limit) : undefined;
      return { items, next };
    } catch {
      return { items: [] };
    }
  }

  async read(nativeId: string, o: { cursor?: string; limit: number }): Promise<{ messages: any[]; next?: string }> {
    try {
      const p = await this.ensure();
      await this.probeCaps(p);
      this.armIdle();
      const res = await fetch(`${p.baseUrl}/session/${nativeId}/message`);
      if (!res.ok) return { messages: [] };
      const all: { info: any; parts: any[] }[] = await res.json();
      // Turn boundaries: index of every user message. Page from the tail: the newest `limit` turns
      // first, older ones reachable via `next` (an offset from the end, as a string cursor).
      const starts: number[] = [];
      all.forEach((m, i) => { if (m.info?.role === 'user') starts.push(i); });
      const totalTurns = starts.length;
      const limit = o.limit ?? 20;
      const offset = o.cursor ? Number(o.cursor) : 0;
      const endTurn = Math.max(0, totalTurns - offset);
      const startTurn = Math.max(0, endTurn - limit);
      if (startTurn >= endTurn) return { messages: [] };
      const sliceStart = starts[startTurn];
      const sliceEnd = endTurn < totalTurns ? starts[endTurn] : all.length;
      const slice = all.slice(sliceStart, sliceEnd);
      const messages = opencodeToMessages(libraryId('opencode', nativeId), slice);
      const next = startTurn > 0 ? String(offset + limit) : undefined;
      return { messages, next };
    } catch {
      return { messages: [] };
    }
  }

  async rename(nativeId: string, title: string): Promise<void> {
    const p = await this.ensure();
    this.armIdle();
    const res = await fetch(`${p.baseUrl}/session/${nativeId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }) });
    if (!res.ok) throw new Error(`PATCH /session/${nativeId} → ${res.status}`);
  }

  async remove(nativeId: string): Promise<void> {
    const p = await this.ensure();
    this.armIdle();
    const res = await fetch(`${p.baseUrl}/session/${nativeId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`DELETE /session/${nativeId} → ${res.status}`);
  }

  /** Full message history, oldest first — a backup before delete (constraints.md). */
  async exportAll(nativeId: string): Promise<unknown> {
    const p = await this.ensure();
    this.armIdle();
    const res = await fetch(`${p.baseUrl}/session/${nativeId}/message`);
    if (!res.ok) return [];
    return res.json();
  }

  async close(): Promise<void> {
    this.clearIdle();
    const p = this.proc;
    this.proc = null;
    this.starting = null;
    p?.child?.kill();
  }
}
