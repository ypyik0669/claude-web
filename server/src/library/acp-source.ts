// ACP session-list source: for ACP agents that advertise `agentCapabilities.sessionCapabilities.list`
// (see task-5-brief.md / CLAUDE.md 阶段 5). Read-only: `session/list` is all the protocol offers —
// there is no official read/rename/archive/delete op, so those stay unimplemented (constraints.md:
// never write to an agent's data files directly, only via its own official interface).
import type { AgentKind, SessionSummary, SourceCaps, SourceStatus } from '../protocol.js';
import { JsonRpcProcess } from '../agents/jsonrpc.js';
import { libraryId } from './ids.js';
import { isNotInstalled, type SessionSource } from './types.js';

const IDLE_MS = 300_000; // library-only process, never shared with a live chat session
const INIT_TIMEOUT_MS = 30_000;
const LIST_TIMEOUT_MS = 30_000;

interface Probed { hasList: boolean; loadSession: boolean; version?: string }

function toMs(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}

export class AcpListSource implements SessionSource {
  readonly kind: AgentKind;
  // Conservative until the first successful probe fills it in from the agent's real capabilities.
  caps: SourceCaps = { resume: false, rename: false, archive: false, delete: false, fork: false };
  private rpc: JsonRpcProcess | null = null;
  private starting: Promise<JsonRpcProcess> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  // Cached until close() (per the controller ruling: "status() 探测一次并缓存能力直到 close()").
  private probed: Probed | null = null;
  // Generation token (same pattern as OpenCodeSource): bumped by close() so an ensure() whose
  // spawn+initialize is still in flight notices, on the far side of that await, that it was closed
  // out from under it — and kills the process it just got instead of adopting it (which would
  // otherwise leak: nothing else references that process once close() has already cleared
  // this.rpc/this.starting).
  private gen = 0;

  constructor(kind: AgentKind, private readonly getLaunch: () => { command: string; args: string[]; env: Record<string, string> }) {
    this.kind = kind;
  }

  private clearIdle() { if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; } }

  private armIdle() {
    this.clearIdle();
    this.idleTimer = setTimeout(() => { this.killRpc(); }, IDLE_MS);
  }

  /** Kills the live process (if any) without forgetting the cached probed capability. */
  private killRpc() {
    this.clearIdle();
    const rpc = this.rpc;
    this.rpc = null;
    this.starting = null;
    rpc?.kill();
  }

  private async ensure(): Promise<JsonRpcProcess> {
    if (this.rpc && !this.rpc.exited) return this.rpc;
    if (this.starting) return this.starting;
    const gen = this.gen;
    this.starting = (async () => {
      const l = this.getLaunch();
      const rpc = new JsonRpcProcess(l.command, l.args, { env: l.env });
      rpc.on('exit', () => { if (this.rpc === rpc) this.rpc = null; });
      try {
        const r = await rpc.request<any>('initialize', {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: 'claude-web', version: '0.1.0' },
        }, INIT_TIMEOUT_MS);
        // close() ran while initialize was in flight: this process belongs to nobody now — kill it
        // and refuse to adopt it, rather than silently leaving it running past close().
        if (gen !== this.gen) { rpc.kill(); throw new Error('AcpListSource：启动完成前已被 close()'); }
        const agentCaps = r?.agentCapabilities ?? {};
        this.probed = {
          hasList: !!agentCaps.sessionCapabilities?.list,
          loadSession: !!agentCaps.loadSession,
          version: r?.agentInfo?.version,
        };
        this.caps = { resume: this.probed.loadSession, rename: false, archive: false, delete: false, fork: false };
        rpc.notify('initialized', {});
      } catch (e) {
        rpc.kill();
        throw e;
      }
      this.rpc = rpc;
      return rpc;
    })();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  // Reading through a method (rather than `this.probed` directly) sidesteps TS's control-flow
  // narrowing of properties, which would otherwise pin the field's apparent type to whatever it was
  // narrowed to before an `await` — even though `ensure()`'s continuation can have just set it.
  private getProbed(): Probed | null {
    return this.probed;
  }

  async status(): Promise<SourceStatus> {
    const base = { kind: this.kind, name: this.kind, joined: false, dismissed: false };
    // Cached: a prior status()/list() already probed this agent's capabilities.
    const cached = this.getProbed();
    if (cached) {
      if (!cached.hasList) return { ...base, installed: true, detected: true, enabled: false, version: cached.version, disabledReason: '该 agent 不支持会话列表' };
      return { ...base, installed: true, detected: true, enabled: true, version: cached.version };
    }
    try {
      await this.ensure();
      const probed = this.getProbed();
      if (!probed?.hasList) {
        // Not supported: don't leave the process running just to have checked this once.
        this.killRpc();
        return { ...base, installed: true, detected: true, enabled: false, version: probed?.version, disabledReason: '该 agent 不支持会话列表' };
      }
      this.armIdle();
      return { ...base, installed: true, detected: true, enabled: true, version: probed.version };
    } catch (e: any) {
      const message = e?.message ?? String(e);
      return { ...base, installed: false, detected: false, enabled: false, error: message, disabledReason: message };
    }
  }

  async list(o: { cursor?: string; limit: number; archived?: boolean }): Promise<{ items: SessionSummary[]; next?: string }> {
    try {
      const rpc = await this.ensure();
      if (!this.getProbed()?.hasList) { this.killRpc(); return { items: [] }; }
      this.armIdle();
      const r = await rpc.request<any>('session/list', { cursor: o.cursor }, LIST_TIMEOUT_MS);
      const items: SessionSummary[] = (r?.sessions ?? []).map((s: any) => ({
        sessionId: libraryId(this.kind, s.sessionId),
        title: s.title || s.sessionId,
        cwd: s.cwd ?? '',
        lastModified: toMs(s.updatedAt),
        agent: this.kind,
        caps: this.caps,
      }));
      return { items, next: r?.nextCursor ?? undefined };
    } catch (e) {
      if (isNotInstalled(e)) return { items: [] }; // no session/list capability is handled above
      throw e;
    }
  }

  /** No official read op exists over ACP beyond `session/list` itself — unsupported. */
  async read(_nativeId: string, _o: { cursor?: string; limit: number }): Promise<{ messages: any[]; next?: string }> {
    return { messages: [] };
  }

  async close(): Promise<void> {
    this.gen++;
    this.killRpc();
    this.probed = null;
  }
}
