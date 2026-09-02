import { EventEmitter } from 'node:events';
import { SessionRunner } from './session-runner.js';
import type { OpenSessionParams, RunnerState } from '../protocol.js';
import type { ProviderService } from '../providers/service.js';

const IDLE_TTL_MS = 30 * 60 * 1000;

/** sessionId -> live runner. Emits everything runners emit, tagged with the session id. */
export class RunnerPool extends EventEmitter {
  private runners = new Map<string, SessionRunner>();

  constructor(private providers: ProviderService) {
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

  open(params: OpenSessionParams): SessionRunner {
    if (params.sessionId && !params.fork && !params.resumeAt) {
      const existing = this.runners.get(params.sessionId);
      if (existing && existing.state !== 'closed' && existing.state !== 'error') return existing;
      if (existing) this.runners.delete(params.sessionId);
    }
    const r = new SessionRunner(params, this.providers.forSession(params.providerId));
    this.runners.set(r.id, r);
    r.on('message', (m) => this.emit('message', r.sessionId, m));
    r.on('state', (s, err) => {
      this.emit('state', r.sessionId, s, err);
      if (s === 'closed') this.runners.delete(r.id);
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
      if (r.state === 'idle' && now - r.lastActivity > IDLE_TTL_MS) void this.close(id);
    }
  }

  async closeAll() {
    await Promise.all([...this.runners.keys()].map((id) => this.close(id)));
  }
}
