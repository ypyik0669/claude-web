import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { SessionRunner } from './session-runner.js';
import type { AgentKind, OpenSessionParams, Provider, RunnerState } from '../protocol.js';
import { loopbackNoProxy, type ProviderService } from '../providers/service.js';
import type { AgentRegistry, AgentDriver } from '../agents/types.js';
import type { AgentTranscripts } from '../agents/transcript.js';
import { AcpDriver } from '../agents/acp-driver.js';
import { beforeAppServer } from '../gateway/agents.js';
import { CodexDriver } from '../agents/codex-driver.js';
import { proxy } from '../net/proxy.js';
import { withExplanation } from '../errors/explain.js';

const IDLE_TTL_MS = 30 * 60 * 1000;
/** an idle Codex conversation lets go of its thread after this (the Codex CLI cannot resume it while we hold it) */
export const CODEX_IDLE_TTL_MS = 2 * 60 * 1000;

/**
 * How long an idle Claude session keeps its process. Reopening means `--resume`, and ccb rebuilds the first user
 * message on resume (skills reminder gone) — the cached prompt prefix breaks there and the next turn pays for the
 * whole context again. That only costs something while the provider's cache would still have been warm:
 *   openai / grok (OpenAI in-memory 5–60 min + extended 24 h retention, DeepSeek's disk cache lasts hours) → 2 h;
 *   anthropic with the 1-hour TTL → just past it (65 min); everything else (5-minute Anthropic cache, Gemini's
 *   short implicit cache, gateway groups of unknown members, the claude.ai login) → the old 30 min.
 * The long TTL belongs to the cache optimisation: a profile with the shim switched off (cacheShim:false) gets 30 min.
 */
export function idleTtlFor(p: Pick<Provider, 'type' | 'cache1h' | 'cacheShim'> | undefined): number {
  if ((p?.type === 'openai' || p?.type === 'grok') && p.cacheShim !== false) return 2 * 3600_000;
  if (p?.type === 'anthropic' && p.cache1h) return 65 * 60_000;
  return IDLE_TTL_MS;
}

/**
 * Longer TTLs mean more idle ccb processes (~150–300 MB each): past this many idle Claude sessions the least
 * recently used one is closed anyway (it resumes on the next message, paying one uncached turn).
 */
export const MAX_IDLE_CLAUDE = 12;

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
    void proxy.refresh(); // IM / schedules / goals come straight here: a stale look is redone for the next start (net/proxy.ts)
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
    // the provider, when the caller did not say: IM, scheduled tasks, goals and hand-overs open sessions here
    // without going through the hub, and used to start on the account whatever the user had set up
    const chosen = this.resolveProvider(params);
    if (chosen.byPool) params = { ...params, providerId: chosen.providerId };
    let r: AgentDriver;
    if (kind === 'claude' || !this.agents || !this.transcripts) {
      // a fork routes its prompt cache under its root's key; every reopen (goals, IM, schedules, hot switch) keeps it
      if (params.sessionId && !params.fork && !params.resumeAt && !params.cacheParentId) {
        const recorded = this.providers.meta?.sessionMeta(params.sessionId).cacheKey;
        if (recorded) params = { ...params, cacheParentId: recorded };
      }
      const sp = this.providers.forSession(params.providerId);
      r = new SessionRunner(params, sp);
      this.ttl.set(r, idleTtlFor(sp));
    }
    else {
      const l = this.agents.launch(kind);
      // on a provider the id is fixed before the process starts: the cache shim's route (and ledger rows) carry it.
      // The drivers resume only a session whose transcript already names a native thread, so this is still new.
      if (!params.sessionId && params.providerId && params.providerId !== 'claude') params = { ...params, sessionId: randomUUID() };
      // a model-gateway profile works for every agent: its endpoint goes into the agent's own env variables
      const gw = this.providers.agentLaunch?.(params.providerId, l.def.protocol === 'codex' ? 'codex' : 'acp', kind, params.sessionId) ?? { env: {}, args: [] };
      const env = { ...l.env, ...gw.env };
      // the shim / gateway are on this machine: a system HTTP(S)_PROXY must not get those requests (Codex honours it)
      const local = Object.values(gw.env).find((v) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/i.test(v));
      if (local) Object.assign(env, loopbackNoProxy({ OPENAI_BASE_URL: local, NO_PROXY: env.NO_PROXY ?? process.env.NO_PROXY, no_proxy: env.no_proxy ?? process.env.no_proxy }));
      const launch = { command: l.command, args: beforeAppServer(l.args, gw.args), env, model: l.model, name: l.def.name, login: l.def.login };
      // before Codex resumes a thread, turns the Codex CLI added to it go into the mirror (library.syncMirror)
      const sid = params.sessionId;
      const beforeResume = sid && this.syncMirror ? () => this.syncMirror!(sid) : undefined;
      r = l.def.protocol === 'codex' ? new CodexDriver(kind, launch, params, this.transcripts, { beforeResume }) : new AcpDriver(kind, launch, params, this.transcripts, resumeHistory);
      // an idle Codex holds its thread: `codex exec resume` in a terminal fails "already has an active writer" until it goes
      if (l.def.protocol === 'codex') this.ttl.set(r, CODEX_IDLE_TTL_MS);
      // the composer's model chip reads the profile off the info (`档案 / 模型`); Claude's runner sets it itself
      const name = params.providerId && params.providerId !== 'claude' ? this.providers.meta?.provider(params.providerId)?.name : undefined;
      if (name) Object.assign(r.info, { providerId: params.providerId, providerName: name });
    }
    // what the pool chose is remembered like a choice made in the window (resume / fork keep it)
    const meta = this.providers.meta;
    if (chosen.byPool && chosen.providerId && meta && meta.sessionMeta(r.sessionId).providerId !== chosen.providerId) {
      void meta.setSessionMeta(r.sessionId, { providerId: chosen.providerId }).catch(() => { /* in memory; the next save persists it */ });
    }
    this.runners.set(r.id, r);
    r.on('message', (m) => this.emit('message', r.sessionId, m));
    // the user message a send accepted, from whichever window, IM, schedule or goal sent it (AgentDriver 'sent'). Its
    // own event, not 'message': the canonical mirror records sends itself, the ledger / IM / goals read the agent's stream
    r.on('sent', (m) => this.emit('sent', r.sessionId, m));
    r.on('state', (s, err) => {
      // a replaced runner (reopened after an error) must not report its shutdown as the new one's state
      const holder = this.runners.get(r.sessionId);
      if (holder && holder !== r) return;
      // every agent's failure in the user's words, the original kept under it (Claude's runner explains its own already)
      this.emit('state', r.sessionId, s, s === 'error' && err ? withExplanation(err) : err);
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

  /**
   * The provider a session runs on when `params.providerId` is not given (an explicit one — `'claude'` = the
   * account / the agent's own login — always wins): a resume keeps the one it was recorded with; a new session,
   * or a resume whose recorded provider this agent cannot use (handed over from Claude to Codex), gets its
   * agent's default — settings → 供应商 「设为默认」 for Claude, the agent card's 「新对话用」 (settings →
   * Agents) for the others. A resume with nothing recorded stays on the account / own login, as before.
   */
  private resolveProvider(params: OpenSessionParams): { providerId?: string; byPool: boolean } {
    if (params.providerId !== undefined) return { providerId: params.providerId, byPool: false };
    const meta = this.providers.meta;
    if (!meta) return { byPool: false };
    const agent = params.agent ?? 'claude';
    if (params.sessionId) {
      const recorded = meta.sessionMeta(params.sessionId).providerId;
      if (this.fits(recorded, agent)) return { providerId: recorded, byPool: true };
      if (recorded) return { providerId: this.defaultProviderFor(agent), byPool: true };
      // nothing recorded (a conversation made in the CLI) = the account — unless the account is known to be logged
      // out: then the default provider, like a new conversation (it failed "Not logged in" with a provider set up)
      return agent === 'claude' && this.accountLoggedOut?.() ? { providerId: this.defaultProviderFor(agent), byPool: true } : { byPool: false };
    }
    return { providerId: this.defaultProviderFor(agent), byPool: true };
  }

  /** Set by the server: the last `claude auth status` said logged out (unknown = false). */
  accountLoggedOut?: () => boolean;
  /** Set by the server: bring turns another writer added to an agent's thread into the mirror (library.syncMirror). */
  syncMirror?: (sessionId: string) => Promise<unknown>;

  /** The provider a new session of `agent` gets (undefined = the account / the agent's own login). */
  defaultProviderFor(agent: AgentKind): string | undefined {
    const meta = this.providers.meta;
    if (!meta) return undefined;
    const def = agent === 'claude' ? meta.settings().defaultProviderId : this.agents?.config(agent).providerId;
    return this.fits(def, agent) ? def : undefined;
  }

  private fits(id: unknown, agent: AgentKind): id is string {
    return typeof id === 'string' && !!id && id !== 'claude' && !!this.providers.meta?.provider(id) && !this.providers.fitError(id, agent);
  }

  /** Why `providerId` cannot drive `agent` (null = it can) — IM checks its configured provider with this. */
  providerFitError(providerId: string | undefined, agent: string | undefined): string | null {
    return this.providers.fitError(providerId, (agent || 'claude') as AgentKind);
  }

  async close(sessionId: string) {
    const r = this.runners.get(sessionId);
    if (!r) return;
    this.runners.delete(sessionId);
    await r.close();
  }

  /**
   * The transcript of a conversation changed. An idle Claude process whose conversation got a turn from somewhere else
   * (the CLI in a terminal) has a stale context: its next turn answered without that turn and branched it off for good.
   * Close it; the window re-reads the transcript and the next message resumes from disk.
   */
  transcriptChanged(sessionId: string) {
    const r = this.runners.get(sessionId);
    if (!(r instanceof SessionRunner) || !r.wroteElsewhere()) return;
    this.runners.delete(sessionId);
    void r.yieldToOutside().catch(() => { /* already gone */ });
  }

  findPermission(requestId: string) {
    for (const r of this.runners.values()) if (r.getPendingPermissions().some((p) => p.requestId === requestId)) return r;
    return undefined;
  }

  private reap() {
    const now = Date.now();
    const idleClaude: [string, AgentDriver][] = [];
    for (const [id, r] of this.runners) {
      if (r.state !== 'idle') continue;
      if (now - r.lastActivity > (this.ttl.get(r) ?? IDLE_TTL_MS)) void this.close(id).catch(() => { /* already gone */ });
      else if (r instanceof SessionRunner) idleClaude.push([id, r]);
    }
    // cap on idle Claude processes: the least recently used beyond MAX_IDLE_CLAUDE go
    idleClaude.sort((a, b) => a[1].lastActivity - b[1].lastActivity);
    for (const [id] of idleClaude.slice(0, Math.max(0, idleClaude.length - MAX_IDLE_CLAUDE))) void this.close(id).catch(() => { /* already gone */ });
  }

  async closeAll() {
    // one runner failing to close must not stop the rest (or the server shutdown) from proceeding
    await Promise.allSettled([...this.runners.keys()].map((id) => this.close(id)));
  }
}
