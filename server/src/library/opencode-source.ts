// OpenCode session source: lists/reads via `opencode serve`'s official HTTP API, deletes via the
// official `opencode session delete` CLI subcommand (no direct file access — constraints.md).
// See task-4-brief.md for the wire shapes.
//
// Real-machine checks (opencode 1.14.33, Windows, 2026-09-27):
// - `opencode serve --port 0 --hostname 127.0.0.1` prints to stdout:
//     Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.
//     opencode server listening on http://127.0.0.1:<port>
//   `PORT_RE` below is pinned to that second line; port 0 works (the OS picks a free port), so we
//   never need to pick one ourselves.
// - **Fix round 1**: `GET /doc`'s OpenAPI `paths` on this build only lists `/auth/{providerID}` and
//   `/log` — no `/session*` path at all, so a `/doc`-based capability probe (the original approach)
//   can never find a session delete/rename operation and always reports both as unsupported. Dropped
//   that probe entirely. Capability detection now runs `<command> session --help`, whose real output
//   is:
//     opencode session
//     manage sessions
//     Commands:
//       opencode session list                list sessions
//       opencode session delete <sessionID>  delete a session
//   i.e. a real, working `delete` subcommand exists and is what `remove()` below actually calls.
//   There is no `rename`/`update` subcommand anywhere in the CLI, so `caps.rename` is hardcoded
//   `false` and there is no `rename()` method (no official interface to rename a session).
// - `opencode acp`'s `initialize` response reports `agentCapabilities.loadSession: true`, so
//   `caps.resume` stays `true` (continuing a session via the ACP driver is supported).
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentKind, SessionSummary, SourceCaps, SourceStatus } from '../protocol.js';
import { resolveSpawn } from '../agents/resolve.js';
import { libraryId } from './ids.js';
import { opencodeToMessages } from './opencode-convert.js';
import { isNotInstalled, type SessionSource } from './types.js';

const execFileAsync = promisify(execFile);

const PORT_RE = /https?:\/\/127\.0\.0\.1:(\d+)/;
const IDLE_MS = 300_000; // 5 min — library-only process, never shared with a live chat session
const START_TIMEOUT_MS = 30_000;
const HELP_TIMEOUT_MS = 60_000;
const CAPS_RETRY_MS = 300_000; // no new `session --help` probe within 5 min of a failed one
const DELETE_TIMEOUT_MS = 30_000;

interface Proc {
  baseUrl: string;
  child: ChildProcess | null; // null when opts.baseUrl was injected by a test
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
  /** The in-flight `session --help` probe (never awaited by list/read/status). */
  private capsProbe: Promise<void> | null = null;
  private capsKnown = false;
  private capsFailedAt = 0;
  private probeChild: ChildProcess | null = null;
  private gen = 0; // bumped by close() to invalidate any spawnProc() still in flight

  constructor(
    private readonly getLaunch: () => { command: string; env: Record<string, string> },
    private readonly opts: { baseUrl?: string; capsRetryMs?: number } = {},
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
    if (this.opts.baseUrl) return Promise.resolve({ baseUrl: this.opts.baseUrl, child: null });
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
        if (m) finish(() => resolve({ baseUrl: `http://127.0.0.1:${m[1]}`, child }));
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
    // Generation token: if close() runs while spawnProc() is still in flight, it bumps `gen` so this
    // continuation — which only runs once the process has actually spawned — notices it was closed
    // out from under it, kills the process it just got, and rejects instead of silently adopting a
    // process nobody asked for any more (which would otherwise leak: no idle timer gets armed for a
    // process assigned after close() already cleared `this.proc`/`this.starting`).
    const gen = this.gen;
    this.starting = this.spawnProc()
      .then((p) => {
        if (gen !== this.gen) {
          p.child?.kill();
          throw new Error('OpenCodeSource：启动完成前已被 close()');
        }
        this.proc = p;
        return p;
      })
      .finally(() => { this.starting = null; });
    return this.starting;
  }

  /** `<command> session --help` lists every session subcommand; `delete` is real iff it's in there. */
  // Real machine: `opencode session --help` takes ~10 s cold on Windows (cmd shim → node → opencode.exe)
  // and longer while `opencode serve` is starting next to it, so a 15 s one-shot probe timed out and
  // pinned delete:false for the life of the process. So: started in the background and never awaited
  // (list/read/status use the caps known so far — delete:false until proven), a 60 s timeout, one
  // probe at a time, and after a failure no retry for `capsRetryMs` (5 min).
  private probeCaps(): void {
    if (this.capsKnown || this.capsProbe) return;
    if (this.capsFailedAt && Date.now() - this.capsFailedAt < (this.opts.capsRetryMs ?? CAPS_RETRY_MS)) return;
    this.capsProbe = this.runCapsProbe().finally(() => { this.capsProbe = null; });
  }

  /** Settles when the probe in flight (if any) does — for tests and callers that want settled caps. */
  whenCapsProbed(): Promise<void> {
    return this.capsProbe ?? Promise.resolve();
  }

  private async runCapsProbe(): Promise<void> {
    const gen = this.gen;
    try {
      const l = this.getLaunch();
      const r = resolveSpawn(l.command, ['session', '--help']);
      const run = execFileAsync(r.command, r.args, { windowsHide: true, timeout: HELP_TIMEOUT_MS, env: { ...process.env, ...l.env, ...r.env }, windowsVerbatimArguments: r.via === 'cmd' });
      this.probeChild = run.child;
      const { stdout, stderr } = await run;
      const text = `${stdout}${stderr}`;
      this.caps = { ...this.caps, delete: /\bdelete\b/.test(text) };
      this.capsKnown = true;
    } catch {
      // killed by close(): not a verdict on the CLI, so no back-off for the next join
      if (gen === this.gen) this.capsFailedAt = Date.now(); // keep delete:false; back off
    } finally {
      this.probeChild = null;
    }
  }

  async status(): Promise<SourceStatus> {
    const base = { kind: this.kind, name: 'OpenCode', joined: false, dismissed: false };
    try {
      await this.ensure();
      this.probeCaps();
      this.armIdle();
      return { ...base, installed: true, detected: true, enabled: true };
    } catch (e: any) {
      const message = e?.message ?? String(e);
      return { ...base, installed: false, detected: false, enabled: false, error: message, disabledReason: message };
    }
  }

  /**
   * Every session of every project. `GET /session` alone only answers for the project that serve's own
   * cwd resolves to (a git repo is its own project, anything else is "global") — run from the
   * claude-web repo it returned 0 of the 11 real sessions. So enumerate `GET /project` and ask each one
   * via the `x-opencode-directory` header (what the official SDK's `directory` option sends; the value
   * is URI-decoded server-side, so non-ASCII paths go encoded). `/project` missing → the plain call.
   */
  private async fetchSessions(baseUrl: string): Promise<any[]> {
    const one = async (dir?: string) => {
      const res = await fetch(`${baseUrl}/session`, dir === undefined ? undefined : { headers: { 'x-opencode-directory': encodeURIComponent(dir) } });
      if (!res.ok) throw new Error(`opencode serve GET /session：HTTP ${res.status}`);
      const arr = await res.json();
      return Array.isArray(arr) ? arr : [];
    };
    const pr = await fetch(`${baseUrl}/project`);
    const projects: any[] = pr.ok ? await pr.json().catch(() => []) : [];
    const dirs = Array.isArray(projects) ? projects.map((x) => x?.worktree).filter((d): d is string => typeof d === 'string' && d.length > 0) : [];
    if (!dirs.length) return one();
    // one project's failure (e.g. a worktree that no longer exists) must not hide every other project;
    // only when every directory fails is it a source failure
    const byId = new Map<string, any>();
    let lastErr: unknown;
    let ok = 0;
    for (const d of dirs) {
      let got: any[];
      try { got = await one(d); ok++; } catch (e) { lastErr = e; continue; }
      for (const s of got) if (s?.id && !byId.has(s.id)) byId.set(s.id, s);
    }
    if (!ok) throw lastErr;
    return [...byId.values()];
  }

  async list(o: { cursor?: string; limit: number; archived?: boolean }): Promise<{ items: SessionSummary[]; next?: string }> {
    try {
      const p = await this.ensure();
      this.probeCaps();
      this.armIdle();
      const all = await this.fetchSessions(p.baseUrl);
      all.sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
      const offset = o.cursor ? Number(o.cursor) : 0;
      const limit = o.limit ?? 20;
      const page = all.slice(offset, offset + limit);
      const items = page.map((s) => mapSession(s, this.caps));
      const next = offset + limit < all.length ? String(offset + limit) : undefined;
      return { items, next };
    } catch (e) {
      if (isNotInstalled(e)) return { items: [] };
      throw e;
    }
  }

  async read(nativeId: string, o: { cursor?: string; limit: number }): Promise<{ messages: any[]; next?: string }> {
    try {
      const p = await this.ensure();
      this.probeCaps();
      this.armIdle();
      const res = await fetch(`${p.baseUrl}/session/${nativeId}/message`);
      if (!res.ok) throw new Error(`opencode serve GET /session/${nativeId}/message：HTTP ${res.status}`);
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
    } catch (e) {
      if (isNotInstalled(e)) return { messages: [] };
      throw e;
    }
  }

  /** No official rename interface exists (no CLI subcommand, no documented REST op) — not implemented. */

  /** Official CLI delete: `<command> session delete <nativeId>`. Non-zero exit → throw with stderr tail. */
  async remove(nativeId: string): Promise<void> {
    const l = this.getLaunch();
    const r = resolveSpawn(l.command, ['session', 'delete', nativeId]);
    try {
      await execFileAsync(r.command, r.args, { windowsHide: true, timeout: DELETE_TIMEOUT_MS, env: { ...process.env, ...l.env, ...r.env }, windowsVerbatimArguments: r.via === 'cmd' });
    } catch (e: any) {
      const tail = (e?.stderr ?? e?.message ?? String(e)).toString().slice(-2000);
      throw new Error(`opencode session delete ${nativeId} 失败：${tail}`);
    }
  }

  /** Full message history, oldest first — a backup before delete (constraints.md). */
  async exportAll(nativeId: string): Promise<unknown> {
    const p = await this.ensure();
    this.armIdle();
    const res = await fetch(`${p.baseUrl}/session/${nativeId}/message`);
    // a failed export must fail the delete (constraints.md: no backup, no delete)
    if (!res.ok) throw new Error(`opencode serve GET /session/${nativeId}/message：HTTP ${res.status}`);
    return res.json();
  }

  async close(): Promise<void> {
    this.gen++;
    this.clearIdle();
    const p = this.proc;
    this.proc = null;
    this.starting = null;
    p?.child?.kill();
    // an in-flight `session --help` goes too (via cmd.exe on Windows: kill the whole tree)
    const probe = this.probeChild;
    this.probeChild = null;
    if (probe?.pid && process.platform === 'win32') execFile('taskkill', ['/pid', String(probe.pid), '/t', '/f'], { windowsHide: true }, () => {});
    else probe?.kill();
  }
}
