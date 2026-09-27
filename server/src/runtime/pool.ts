import { EventEmitter } from 'node:events';
import { SessionRunner } from './session-runner.js';
import type { OpenSessionParams, RunnerState } from '../protocol.js';
import type { ProviderService } from '../providers/service.js';
import type { AgentRegistry, AgentDriver } from '../agents/types.js';
import type { AgentTranscripts } from '../agents/transcript.js';
import { AcpDriver } from '../agents/acp-driver.js';
import { CodexDriver } from '../agents/codex-driver.js';

const IDLE_TTL_MS = 30 * 60 * 1000;

/** sessionId -> live runner. Emits everything runners emit, tagged with the session id. */
export class RunnerPool extends EventEmitter {
  private runners = new Map<string, AgentDriver>();

  constructor(private providers: ProviderService, private agents?: AgentRegistry, private transcripts?: AgentTranscripts) {
    super();
    setInterval(() => this.reap(), 60_000).unref();
  }

  get(sessionId: string) {
    return this.runners.get(sessionId);
  }
  list() {
    return [...this.runners.values()];
  }
  stateOf(sessionId: string): RunnerState | undefined {
    return this.runners.get(sessionId)?.state;
  }

  open(params: OpenSessionParams, resumeHistory: unknown[] | null = null): AgentDriver {
    if (params.sessionId && !params.fork && !params.resumeAt) {
      const existing = this.runners.get(params.sessionId);
      if (existing && existing.state !== 'closed' && existing.state !== 'error') return existing;
      if (existing) {
        this.runners.delete(params.sessionId);
        // an errored runner may still hold a child process / input queue; its late 'closed' is filtered below
        void existing.close().catch(() => { /* already dead */ });
      }
    }
    const kind = params.agent ?? 'claude';
    let r: AgentDriver;
    if (kind === 'claude' || !this.agents || !this.transcripts) r = new SessionRunner(params, this.providers.forSession(params.providerId));
    else {
      const l = this.agents.launch(kind);
      // a model-gateway profile works for every agent: its endpoint goes into the agent's own env variables
      const gwEnv = this.providers.agentEnv?.(params.providerId, l.def.protocol === 'codex' ? 'codex' : 'acp');
      const launch = { command: l.command, args: l.args, env: { ...l.env, ...(gwEnv ?? {}) }, model: l.model, name: l.def.name, login: l.def.login };
      r = l.def.protocol === 'codex' ? new CodexDriver(kind, launch, params, this.transcripts) : new AcpDriver(kind, launch, params, this.transcripts, resumeHistory);
    }
    this.runners.set(r.id, r);
    r.on('message', (m) => this.emit('message', r.sessionId, m));
    r.on('state', (s, err) => {
      // a replaced runner (reopened after an error) must not report its shutdown as the new one's state
      const holder = this.runners.get(r.sessionId);
      if (holder && holder !== r) return;
      this.emit('state', r.sessionId, s, err);
      // after init the map may be keyed by sessionId rather than id; only drop entries that still point at this runner
      if (s === 'closed') for (const k of [r.id, r.sessionId]) if (this.runners.get(k) === r) this.runners.delete(k);
    });
    r.on('info', (i) => {
      // session id can be assigned by init (new session) — keep the map keyed by the real id
      if (i.sessionId !== r.id && this.runners.get(r.id) === r) {
        this.runners.delete(r.id);
        this.runners.set(i.sessionId, r);
      }
      this.emit('info', i);
    });
    r.on('permission', (e) => this.emit('permission', e));
    r.on('permissionResolved', (id) => this.emit('permissionResolved', r.sessionId, id));
    return r;
  }

  async close(sessionId: string) {
    const r = this.runners.get(sessionId);
    if (!r) return;
    this.runners.delete(sessionId);
    await r.close();
  }

  findPermission(requestId: string) {
    for (const r of this.runners.values()) if (r.getPendingPermissions().some((p) => p.requestId === requestId)) return r;
    return undefined;
  }

  private reap() {
    const now = Date.now();
    for (const [id, r] of this.runners) {
      if (r.state === 'idle' && now - r.lastActivity > IDLE_TTL_MS) void this.close(id).catch(() => { /* already gone */ });
    }
  }

  async closeAll() {
    // one runner failing to close must not stop the rest (or the server shutdown) from proceeding
    await Promise.allSettled([...this.runners.keys()].map((id) => this.close(id)));
  }
}
