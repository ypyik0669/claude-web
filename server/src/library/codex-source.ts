// Codex session source: lists/reads/manages `codex app-server` threads over its official JSON-RPC
// API (no direct file access — constraints.md). See task-3-brief.md for the wire shapes.
import { existsSync, readdirSync, statSync, promises as fsp } from 'node:fs';
import path from 'node:path';
import { codexTurnsToMessages } from '../agents/codex-items.js';
import { JsonRpcProcess } from '../agents/jsonrpc.js';
import type { AgentKind, SessionSummary, SourceCaps, SourceStatus } from '../protocol.js';
import { libraryId } from './ids.js';
import { LazyRpc } from './lazy-rpc.js';
import { isNotInstalled, type SessionSource } from './types.js';
import { tr } from '../i18n/index.js';

const SOURCE_KINDS = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther'];
// Shared by status() and list(). Real machine (codex 0.155): thread/list without `modelProviders`
// returns only the *current* provider's threads (399 of 690 here — everything recorded under an older
// relay was missing); `[]` means every provider (ThreadListParams in generate-ts).
const LIST_PARAMS = { sortKey: 'updated_at', sortDirection: 'desc', sourceKinds: SOURCE_KINDS, modelProviders: [] as string[] };

const CAPS: SourceCaps = { resume: true, rename: true, archive: true, delete: true, fork: true };

/**
 * What the app-server answers for a thread it has no stored history for (codex 0.158, reproduced: an unknown id,
 * and a thread started in another process that has not had its first user message yet): nothing to show. Also the
 * paged read's own "before first user message" and "ephemeral threads" refusals.
 */
const GONE = /thread not loaded|before first user message|ephemeral thread/i;
/** Older app-servers page nothing (0.130: `thread/turns/list requires experimentalApi capability`); thread/read has it all. */
const NO_PAGING = /experimentalApi|not supported|unknown method|method not found/i;
/**
 * A thread in the storage newer Codex writes ("paginated"), refused by an older one (user report 2026-10-16:
 * 「paginated_threads is not supported yet」 — the desktop app updates itself, a `codex` on PATH does not). Its
 * whole-thread read is refused too, so this is not a NO_PAGING case.
 */
export const PAGINATED = /paginated/i;

/**
 * The Codex desktop app's own CLI — as new as the app that wrote the threads. Windows:
 * %LOCALAPPDATA%\OpenAI\Codex\bin\<build>\codex.exe (the newest build); macOS: inside Codex.app.
 */
export function desktopCodexBin(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string | undefined {
  if (platform === 'darwin') {
    const app = '/Applications/Codex.app/Contents/Resources/codex';
    return existsSync(app) ? app : undefined;
  }
  if (platform !== 'win32' || !env.LOCALAPPDATA) return undefined;
  const root = path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
  let best: { file: string; at: number } | undefined;
  try {
    for (const d of readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const file = path.join(root, d.name, 'codex.exe');
      try { const at = statSync(file).mtimeMs; if (!best || at > best.at) best = { file, at }; } catch { /* not a build */ }
    }
  } catch { return undefined; }
  return best?.file;
}
/** How long a thread that could not be read stays out of the list (a thread that was about to get its first message comes back). */
export const GONE_HIDE_MS = 10 * 60_000;
/** a list page from the desktop app's CLI: its cursor goes back to it */
const NEWER_CURSOR = 'desktop:';
export const THREAD_GONE = 'THREAD_GONE';
/** A rollout whose last turn started this long ago without an end is a Codex that died mid-turn, not one still going. */
export const ROLLOUT_STALE_MS = 30 * 60_000;
/** How much of a rollout's end is looked at for the last turn's start and end. */
const ROLLOUT_TAIL = 256 * 1024;

/**
 * Whether the rollout's last turn has started and not ended (`task_started` after the last `task_complete` /
 * `turn_aborted`): Codex's desktop app or CLI is in the middle of it (user report: the view showed half a turn as
 * done while Codex was still thinking). Only the tail of the file is given.
 */
export function rolloutTurnOpen(tail: string): boolean {
  const start = tail.lastIndexOf('"type":"task_started"');
  return start >= 0 && Math.max(tail.lastIndexOf('"type":"task_complete"'), tail.lastIndexOf('"type":"turn_aborted"')) < start;
}

async function rolloutOpen(file: string | undefined, now = Date.now()): Promise<boolean> {
  if (!file) return false;
  let fh: Awaited<ReturnType<typeof fsp.open>> | undefined;
  try {
    fh = await fsp.open(file, 'r');
    const st = await fh.stat();
    if (now - st.mtimeMs > ROLLOUT_STALE_MS) return false;
    const len = Math.min(st.size, ROLLOUT_TAIL);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, st.size - len);
    return rolloutTurnOpen(buf.toString('utf8'));
  } catch {
    return false;
  } finally {
    await fh?.close().catch(() => {});
  }
}

const goneError = () => Object.assign(new Error(tr('Codex 里读不到这个对话：它可能已经在 Codex 里删除了，或者刚创建、还没保存第一条消息。')), { code: THREAD_GONE });

// Thread.source (per `codex app-server generate-ts`) is `"cli"|"vscode"|"exec"|"appServer"|
// {custom:string}|{subAgent:SubAgentSource}|"unknown"` — a bare string for the built-in surfaces,
// or a single-key object for the two variant ones.
function sourceTypeName(source: unknown): string {
  if (typeof source === 'string') return source;
  if (source && typeof source === 'object') {
    const o = source as any;
    if ('subAgent' in o) return 'subAgent';
    if ('custom' in o) return typeof o.custom === 'string' && o.custom.length > 0 ? o.custom : 'custom';
  }
  return 'unknown';
}

// Real machine: with `modelProviders: []` the app-server leaves `parentThreadId` null even on spawned
// sub-agent threads; the parent is still in `source.subAgent.thread_spawn.parent_thread_id`
// (SubAgentSource in generate-ts), so fall back to it or 277 sub-agent threads would list top-level.
function parentOf(t: any): string | undefined {
  if (typeof t.parentThreadId === 'string' && t.parentThreadId) return t.parentThreadId;
  const p = t.source?.subAgent?.thread_spawn?.parent_thread_id;
  return typeof p === 'string' && p ? p : undefined;
}

function mapThread(t: any): SessionSummary {
  const parent = parentOf(t);
  return {
    sessionId: libraryId('codex', t.id),
    title: t.name || (t.preview ?? '').slice(0, 80),
    firstPrompt: t.preview,
    cwd: t.cwd,
    lastModified: (t.updatedAt ?? 0) * 1000,
    createdAt: (t.createdAt ?? 0) * 1000,
    source: sourceTypeName(t.source),
    parentId: parent ? libraryId('codex', parent) : undefined,
    gitBranch: t.gitInfo?.branch,
    agent: 'codex' as AgentKind,
    caps: CAPS,
  };
}

export class CodexSource implements SessionSource {
  readonly kind: AgentKind = 'codex';
  readonly caps: SourceCaps = CAPS;
  private readonly rpc: LazyRpc;
  private version: string | undefined;
  /** the desktop app's Codex, only started for threads the configured one cannot read (PAGINATED) */
  private newer: { rpc: LazyRpc; command: string } | undefined;

  constructor(
    private readonly getLaunch: () => { command: string; args: string[]; env: Record<string, string> },
    private readonly getNewer: () => { command: string; args: string[]; env: Record<string, string> } | undefined = () => {
      const bin = desktopCodexBin();
      return bin ? { command: bin, args: ['app-server'], env: this.getLaunch().env } : undefined;
    },
  ) {
    this.rpc = this.lazy(() => this.getLaunch(), (v) => { this.version = v ?? this.version; });
  }

  private lazy(launch: () => { command: string; args: string[]; env: Record<string, string> }, onVersion?: (v: string | undefined) => void): LazyRpc {
    return new LazyRpc(
      () => {
        const l = launch();
        return new JsonRpcProcess(l.command, l.args, { env: l.env });
      },
      async (rpc) => {
        const r = await rpc.request<any>('initialize', { clientInfo: { name: 'claude-web', title: 'Claude Web', version: '0.1.0' }, capabilities: null }, 30_000);
        onVersion?.(r?.userAgent ?? r?.version);
        rpc.notify('initialized', {});
      },
      300_000,
    );
  }

  /** The newer Codex to read a PAGINATED thread with — none, or the very launch that just failed: undefined. */
  private newerRpc(): LazyRpc | undefined {
    const l = this.getNewer();
    const key = (x: { command: string; args: string[]; env: Record<string, string> }) => JSON.stringify([x.command, x.args, x.env]);
    if (!l || key(l) === key(this.getLaunch())) return undefined;
    if (this.newer?.command !== key(l)) {
      void this.newer?.rpc.close().catch(() => {});
      this.newer = { rpc: this.lazy(() => l), command: key(l) };
    }
    return this.newer.rpc;
  }

  private tooOld(): Error {
    return new Error(tr('这个对话是新版 Codex 存的，本机的 codex 命令（{version}）太旧、读不了。把 Codex 命令行更新到最新（npm i -g @openai/codex@latest），或在 设置 → Agents 里把 Codex 的命令换成 Codex 应用自带的那个。', { version: this.version ?? 'codex' }));
  }

  async status(): Promise<SourceStatus> {
    const base = { kind: this.kind, name: 'Codex', joined: false, dismissed: false };
    try {
      await this.rpc.request('thread/list', { ...LIST_PARAMS, limit: 1, archived: false }, 15_000);
      return { ...base, installed: true, detected: true, enabled: true, version: this.version };
    } catch (e: any) {
      if (e?.code === -32601) {
        return { ...base, installed: true, detected: true, enabled: false, version: this.version, disabledReason: tr('Codex 版本不支持 thread/list，请升级') };
      }
      const installed = !!this.version; // initialize succeeded at least once — the executable itself resolved and ran
      const message = e?.message ?? String(e);
      return { ...base, installed, detected: installed, enabled: false, error: message, disabledReason: message };
    }
  }

  async list(o: { cursor?: string; limit: number; archived?: boolean }): Promise<{ items: SessionSummary[]; next?: string }> {
    // the desktop app's own CLI first: it is as new as the app that wrote the threads. An older `codex` on PATH leaves
    // out what a newer one stored (user report 2026-11-02: after Codex desktop 0.166 its new conversations stopped
    // showing up). Its cursors are its own, so a page goes on with the CLI that gave it.
    const newer = this.newerRpc();
    if (newer && (!o.cursor || o.cursor.startsWith(NEWER_CURSOR))) {
      try {
        const r = await newer.request<any>('thread/list', { ...LIST_PARAMS, limit: o.limit, cursor: o.cursor?.slice(NEWER_CURSOR.length), archived: o.archived ?? false }, 30_000);
        const now = Date.now();
        const items = (r?.data ?? []).filter((t: any) => !(typeof t.path === 'string' && t.path && !existsSync(t.path)) && !((this.gone.get(t.id) ?? 0) > now - GONE_HIDE_MS)).map(mapThread);
        return { items, next: r?.nextCursor ? NEWER_CURSOR + r.nextCursor : undefined };
      } catch (e) {
        if (o.cursor) throw e;
        console.warn('[codex] the desktop app\'s CLI could not list, the configured one does:', (e as Error)?.message ?? e);
      }
    }
    try {
      const r = await this.rpc.request<any>('thread/list', { ...LIST_PARAMS, limit: o.limit, cursor: o.cursor, archived: o.archived ?? false }, 30_000);
      // ThreadListResponse / ThreadTurnsListResponse (generate-ts) are `{ data, nextCursor, backwardsCursor }`.
      // Left out: a thread whose file on disk is gone (deleted, while Codex's index still lists it — user report:
      // deleted conversations were listed), and one that just failed to read as gone (see read)
      const now = Date.now();
      const items = (r?.data ?? []).filter((t: any) => !(typeof t.path === 'string' && t.path && !existsSync(t.path)) && !((this.gone.get(t.id) ?? 0) > now - GONE_HIDE_MS)).map(mapThread);
      return { items, next: r?.nextCursor ?? undefined };
    } catch (e: any) {
      // not installed / too old for thread/list (status() reports both as disabled): nothing to list
      if (isNotInstalled(e) || e?.code === -32601) return { items: [] };
      throw e;
    }
  }

  async read(nativeId: string, o: { cursor?: string; limit: number }): Promise<{ messages: any[]; next?: string }> {
    // the desktop app's Codex first, as for the list: what it lists, an older `codex` may not find at all
    const first = this.newerRpc();
    if (first) {
      try { return await this.readVia(first, nativeId, o, true); } catch { /* the configured one, below */ }
    }
    try {
      return await this.readVia(this.rpc, nativeId, o);
    } catch (e: any) {
      if (!PAGINATED.test(String(e?.message ?? ''))) throw e;
      // stored by a newer Codex than the configured one: read it with the desktop app's own, else say what to do
      const newer = this.newerRpc();
      if (!newer) throw this.tooOld();
      // the desktop app's Codex gone since, or too old as well: the same advice, never an empty history
      return this.readVia(newer, nativeId, o, true).catch((e2: any) => { throw isNotInstalled(e2) || PAGINATED.test(String(e2?.message ?? '')) ? this.tooOld() : e2; });
    }
  }

  /** `strict`: a Codex that is not there is an error, not an empty history (the fallback reader). */
  private async readVia(rpc: LazyRpc, nativeId: string, o: { cursor?: string; limit: number }, strict = false): Promise<{ messages: any[]; next?: string }> {
    const id = libraryId('codex', nativeId);
    try {
      const limit = o.limit ?? 20;
      const r = await rpc.request<any>('thread/turns/list', { threadId: nativeId, itemsView: 'full', sortDirection: 'desc', limit, cursor: o.cursor }, 30_000);
      const turns = (r?.data ?? []).slice().reverse();
      // the newest page: is its last turn still going in Codex's own app / CLI?
      const running = !o.cursor && await this.threadPath(nativeId, rpc).then(rolloutOpen);
      return { messages: codexTurnsToMessages(id, turns, undefined, running), next: r?.nextCursor ?? undefined };
    } catch (e: any) {
      if (isNotInstalled(e)) { if (strict) throw e; return { messages: [] }; }
      const msg = String(e?.message ?? e);
      if (PAGINATED.test(msg)) throw e;
      // the first page: the whole thread in one read when the paged one is unavailable or says "not loaded"
      if (!o.cursor && (e?.code === -32601 || NO_PAGING.test(msg) || GONE.test(msg))) {
        try {
          const r = await rpc.request<any>('thread/read', { threadId: nativeId, includeTurns: true }, 60_000);
          return { messages: codexTurnsToMessages(id, r?.thread?.turns ?? [], undefined, await rolloutOpen(r?.thread?.path)) };
        } catch (e2: any) {
          if (GONE.test(msg) || GONE.test(String(e2?.message ?? ''))) throw this.markGone(nativeId);
          if (e?.code === -32601 && e2?.code === -32601) return { messages: [] }; // too old for either: nothing to show
          throw e2;
        }
      }
      if (GONE.test(msg)) throw this.markGone(nativeId);
      throw e;
    }
  }

  /** The thread's rollout file (undefined when the app-server does not say). */
  private async threadPath(nativeId: string, rpc: LazyRpc = this.rpc): Promise<string | undefined> {
    try {
      const r = await rpc.request<any>('thread/read', { threadId: nativeId, includeTurns: false }, 15_000);
      const p = r?.thread?.path;
      return typeof p === 'string' && p ? p : undefined;
    } catch {
      return undefined;
    }
  }

  /** Threads that failed to read as gone, and when (list() leaves them out for GONE_HIDE_MS). */
  private gone = new Map<string, number>();
  private markGone(nativeId: string): Error {
    this.gone.set(nativeId, Date.now());
    return goneError();
  }

  async rename(nativeId: string, title: string): Promise<void> {
    await this.rpc.request('thread/name/set', { threadId: nativeId, name: title }, 15_000);
  }

  async archive(nativeId: string, archived: boolean): Promise<void> {
    await this.rpc.request(archived ? 'thread/archive' : 'thread/unarchive', { threadId: nativeId }, 15_000);
  }

  async remove(nativeId: string): Promise<void> {
    await this.rpc.request('thread/delete', { threadId: nativeId }, 15_000);
  }

  async fork(nativeId: string): Promise<string> {
    const r = await this.rpc.request<any>('thread/fork', { threadId: nativeId, excludeTurns: true }, 30_000);
    return r.thread.id;
  }

  /** All turns, oldest first — a full backup before delete (constraints.md). */
  async exportAll(nativeId: string): Promise<unknown> {
    try {
      return await this.exportVia(this.rpc, nativeId);
    } catch (e: any) {
      if (!PAGINATED.test(String(e?.message ?? ''))) throw e;
      const newer = this.newerRpc();
      if (!newer) throw this.tooOld();
      return this.exportVia(newer, nativeId).catch((e2: any) => { throw isNotInstalled(e2) || PAGINATED.test(String(e2?.message ?? '')) ? this.tooOld() : e2; });
    }
  }

  private async exportVia(rpc: LazyRpc, nativeId: string): Promise<unknown> {
    const out: any[] = [];
    let cursor: string | undefined;
    try {
      do {
        const r = await rpc.request<any>('thread/turns/list', { threadId: nativeId, itemsView: 'full', sortDirection: 'desc', limit: 100, cursor }, 30_000);
        out.push(...(r?.data ?? []));
        cursor = r?.nextCursor ?? undefined;
      } while (cursor);
    } catch (e: any) {
      // an app-server without the paged read: the whole thread (a failure here keeps the delete from happening)
      const msg = String(e?.message ?? '');
      if (cursor || PAGINATED.test(msg) || !(e?.code === -32601 || NO_PAGING.test(msg))) throw e;
      return (await rpc.request<any>('thread/read', { threadId: nativeId, includeTurns: true }, 60_000))?.thread?.turns ?? [];
    }
    return out.reverse();
  }

  async close(): Promise<void> {
    await Promise.all([this.rpc.close(), this.newer?.rpc.close()]);
  }
}
