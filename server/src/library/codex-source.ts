// Codex session source: lists/reads/manages `codex app-server` threads over its official JSON-RPC
// API (no direct file access — constraints.md). See task-3-brief.md for the wire shapes.
import { existsSync } from 'node:fs';
import { codexTurnsToMessages } from '../agents/codex-items.js';
import { JsonRpcProcess } from '../agents/jsonrpc.js';
import type { AgentKind, SessionSummary, SourceCaps, SourceStatus } from '../protocol.js';
import { libraryId } from './ids.js';
import { LazyRpc } from './lazy-rpc.js';
import { isNotInstalled, type SessionSource } from './types.js';

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
/** How long a thread that could not be read stays out of the list (a thread that was about to get its first message comes back). */
export const GONE_HIDE_MS = 10 * 60_000;
export const THREAD_GONE = 'THREAD_GONE';
const goneError = () => Object.assign(new Error('Codex 里读不到这个对话：它可能已经在 Codex 里删除了，或者刚创建、还没保存第一条消息。'), { code: THREAD_GONE });

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

  constructor(private readonly getLaunch: () => { command: string; args: string[]; env: Record<string, string> }) {
    this.rpc = new LazyRpc(
      () => {
        const l = this.getLaunch();
        return new JsonRpcProcess(l.command, l.args, { env: l.env });
      },
      async (rpc) => {
        const r = await rpc.request<any>('initialize', { clientInfo: { name: 'claude-web', title: 'Claude Web', version: '0.1.0' }, capabilities: null }, 30_000);
        this.version = r?.userAgent ?? r?.version ?? this.version;
        rpc.notify('initialized', {});
      },
      300_000,
    );
  }

  async status(): Promise<SourceStatus> {
    const base = { kind: this.kind, name: 'Codex', joined: false, dismissed: false };
    try {
      await this.rpc.request('thread/list', { ...LIST_PARAMS, limit: 1, archived: false }, 15_000);
      return { ...base, installed: true, detected: true, enabled: true, version: this.version };
    } catch (e: any) {
      if (e?.code === -32601) {
        return { ...base, installed: true, detected: true, enabled: false, version: this.version, disabledReason: 'Codex 版本不支持 thread/list，请升级' };
      }
      const installed = !!this.version; // initialize succeeded at least once — the executable itself resolved and ran
      const message = e?.message ?? String(e);
      return { ...base, installed, detected: installed, enabled: false, error: message, disabledReason: message };
    }
  }

  async list(o: { cursor?: string; limit: number; archived?: boolean }): Promise<{ items: SessionSummary[]; next?: string }> {
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
    const id = libraryId('codex', nativeId);
    try {
      const limit = o.limit ?? 20;
      const r = await this.rpc.request<any>('thread/turns/list', { threadId: nativeId, itemsView: 'full', sortDirection: 'desc', limit, cursor: o.cursor }, 30_000);
      const turns = (r?.data ?? []).slice().reverse();
      return { messages: codexTurnsToMessages(id, turns), next: r?.nextCursor ?? undefined };
    } catch (e: any) {
      if (isNotInstalled(e)) return { messages: [] };
      const msg = String(e?.message ?? e);
      // the first page: the whole thread in one read when the paged one is unavailable or says "not loaded"
      if (!o.cursor && (e?.code === -32601 || NO_PAGING.test(msg) || GONE.test(msg))) {
        try {
          const r = await this.rpc.request<any>('thread/read', { threadId: nativeId, includeTurns: true }, 60_000);
          return { messages: codexTurnsToMessages(id, r?.thread?.turns ?? []) };
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
    const out: any[] = [];
    let cursor: string | undefined;
    try {
      do {
        const r = await this.rpc.request<any>('thread/turns/list', { threadId: nativeId, itemsView: 'full', sortDirection: 'desc', limit: 100, cursor }, 30_000);
        out.push(...(r?.data ?? []));
        cursor = r?.nextCursor ?? undefined;
      } while (cursor);
    } catch (e: any) {
      // an app-server without the paged read: the whole thread (a failure here keeps the delete from happening)
      if (cursor || !(e?.code === -32601 || NO_PAGING.test(String(e?.message ?? '')))) throw e;
      return (await this.rpc.request<any>('thread/read', { threadId: nativeId, includeTurns: true }, 60_000))?.thread?.turns ?? [];
    }
    return out.reverse();
  }

  async close(): Promise<void> {
    await this.rpc.close();
  }
}
