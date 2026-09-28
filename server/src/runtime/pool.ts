import { EventEmitter } from 'node:events';
import { SessionRunner } from './session-runner.js';
import type { OpenSessionParams, Provider, RunnerState } from '../protocol.js';
import type { ProviderService } from '../providers/service.js';
import type { AgentRegistry, AgentDriver } from '../agents/types.js';
import type { AgentTranscripts } from '../agents/transcript.js';
import { AcpDriver } from '../agents/acp-driver.js';
import { beforeAppServer } from '../gateway/agents.js';
import { CodexDriver } from '../agents/codex-driver.js';

const IDLE_TTL_MS = 30 * 60 * 1000;

/**
 * How long an idle Claude session keeps its process. Reopening means `--resume`, and ccb rebuilds the first user
 * message on resume (skills reminder gone) — the cached prompt prefix breaks there and the next turn pays for the
 * whole context again. That only costs something while the provider's cache would still have been warm:
 *   openai / grok (OpenAI in-memory 5–60 min + extended 24 h retention, DeepSeek's disk cache lasts hours) → 2 h;
 *   anthropic with the 1-hour TTL → just past it (65 min); everything else (5-minute Anthropic cache, Gemini's
 *   short implicit cache, gateway groups of unknown members, the claude.ai login) → the old 30 min.
 */
export function idleTtlFor(p: Pick<Provider, 'type' | 'cache1h'> | undefined): number {
  if (p?.type === 'openai' || p?.type === 'grok') return 2 * 3600_000;
  if (p?.type === 'anthropic' && p.cache1h) return 65 * 60_000;
  return IDLE_TTL_MS;
}

/** sessionId -> live runner. Emits everything runners emit, tagged with the session id. */
export class RunnerPool extends EventEmitter {
  private runners = new Map<string, AgentDriver>();
  private ttl = new WeakMap<AgentDriver, number>();

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
    if (kind === 'claude' || !this.agents || !this.transcripts) {
      const sp = this.providers.forSession(params.providerId);
      r = new SessionRunner(params, sp);
      this.ttl.set(r, idleTtlFor(sp));
    }
    else {
      const l = this.agents.launch(kind);
      // a model-gateway profile works for every agent: its endpoint goes into the agent's own env variables
      const gw = this.providers.agentLaunch?.(params.providerId, l.def.protocol === 'codex' ? 'codex' : 'acp', kind) ?? { env: {}, args: [] };
      const launch = { command: l.command, args: beforeAppServer(l.args, gw.args), env: { ...l.env, ...gw.env }, model: l.model, name: l.def.name, login: l.def.login };
      r = l.def.protocol === 'codex' ? new CodexDriver(kind, launch, params, this.transcripts) : new AcpDriver(kind, launch, params, this.transcripts, resumeHistory);
      // the composer's model chip reads the profile off the info (`档案 / 模型`); Claude's runner sets it itself
      const name = params.providerId && params.providerId !== 'claude' ? this.providers.meta?.provider(params.providerId)?.name : undefined;
      if (name) Object.assign(r.info, { providerId: params.providerId, providerName: name });
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
      if (r.state === 'idle' && now - r.lastActivity > (this.ttl.get(r) ?? IDLE_TTL_MS)) void this.close(id).catch(() => { /* already gone */ });
    }
  }

  async closeAll() {
    // one runner failing to close must not stop the rest (or the server shutdown) from proceeding
    await Promise.allSettled([...this.runners.keys()].map((id) => this.close(id)));
  }
}
