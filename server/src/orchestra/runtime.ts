// The real OrchDeps: sessions go through the same pool / canonical / transcript path as the hub's
// `session.open` + `session.send`; git goes through GitService (orchestra/git.ts). Kept out of service.ts
// so the engine stays unit-testable with fakes.
import { randomUUID } from 'node:crypto';
import type { AgentKind, OpenSessionParams } from '../protocol.js';
import type { RunnerPool } from '../runtime/pool.js';
import type { MetaStore } from '../meta/store.js';
import type { CanonicalLog } from '../session/canonical.js';
import type { AgentTranscripts } from '../agents/transcript.js';
import type { AgentRegistry } from '../agents/types.js';
import type { GitService } from '../git/service.js';
import type { GoalService } from '../goals/service.js';
import type { LibraryService } from '../library/service.js';
import { expandSessionRefs } from '../library/briefing.js';
import { gitAdapter } from './git.js';
import { DEFAULT_MAX_PARALLEL, type OrchDeps, type SessionHandlers } from './service.js';

/** How long a 'closed' may be followed by a replacement runner (provider / agent hot swap) before it counts. */
const SWAP_GRACE_MS = 3000;

/**
 * Subscribe to one session through the pool (events are tagged with the session id), not to a runner:
 * a hot swap replaces the runner but keeps the id. A 'closed' only counts if no live runner holds the id
 * again after `graceMs`.
 */
export function poolWatch(pool: Pick<RunnerPool, 'on' | 'off' | 'get'>, sessionId: string, on: SessionHandlers, graceMs = SWAP_GRACE_MS): () => void {
  let active = true;
  const onMsg = (sid: string, m: unknown) => { if (active && sid === sessionId) on.message?.(m); };
  const onState = (sid: string, state: string, err?: string) => {
    if (!active || sid !== sessionId) return;
    if (state !== 'closed') { on.state?.(state, err); return; }
    setTimeout(() => {
      const r = pool.get(sessionId);
      if (active && (!r || r.state === 'closed' || r.state === 'error')) on.state?.('closed');
    }, graceMs).unref?.();
  };
  pool.on('message', onMsg);
  pool.on('state', onState);
  return () => { active = false; pool.off('message', onMsg); pool.off('state', onState); };
}

export interface RuntimeServices {
  pool: RunnerPool; meta: MetaStore; canonical: CanonicalLog; transcripts: AgentTranscripts;
  agents: AgentRegistry; git: GitService; goals: GoalService; library: LibraryService;
}

export function orchestraDeps(s: RuntimeServices, dirs: { runs: string; worktrees: string }, notify?: OrchDeps['notify']): OrchDeps {
  const titles = new Map<string, string>();
  const expand = (text: string) => (text.includes('<session-ref ') ? expandSessionRefs(text, (id) => s.library.readAll(id)) : Promise.resolve(text));
  return {
    dir: dirs.runs,
    worktreeRoot: dirs.worktrees,
    notify,
    git: gitAdapter(s.git),
    goals: s.goals,
    expand,
    workflows: {
      list: () => s.meta.workflows(),
      set: (w) => s.meta.setWorkflow(w),
      remove: (id) => s.meta.removeWorkflow(id),
    },
    available: async () => (await s.agents.list()).filter((a) => a.installed && a.enabled).map((a) => a.kind),
    maxParallel: () => Number(s.meta.settings()['orchestra.maxParallel']) || DEFAULT_MAX_PARALLEL,
    async open(p) {
      // same defaults as the hub's session.open for a brand-new session
      const settings = s.meta.settings();
      let params: OpenSessionParams = { cwd: p.cwd, model: p.model, permissionMode: p.permissionMode ?? 'default' };
      if (p.agent !== 'claude') params.agent = p.agent as AgentKind;
      else {
        params = { ...params, providerId: settings.defaultProviderId as string | undefined };
        if (settings.defaultFeatures) params.features = settings.defaultFeatures as any;
      }
      const r = s.pool.open(params, p.agent === 'claude' ? null : []);
      await s.canonical.ensure(r.sessionId, p.cwd);
      if (params.providerId && params.providerId !== 'claude') await s.meta.setSessionMeta(r.sessionId, { providerId: params.providerId }).catch(() => {});
      titles.set(r.sessionId, p.title);
      return { sessionId: r.sessionId };
    },
    async send(sessionId, text, isCancelled) {
      const runner = () => s.pool.get(sessionId);
      for (let i = 0; i < 240 && runner()?.state === 'starting'; i++) {
        if (isCancelled?.()) return false;
        await new Promise((res) => setTimeout(res, 250));
      }
      if (isCancelled?.()) return false;
      const r = runner();
      if (!r || r.state === 'closed' || r.state === 'error') throw new Error('会话没能启动');
      const outgoing = await expand(text);
      if (isCancelled?.()) return false;
      const uuid = randomUUID();
      r.send(outgoing, undefined, undefined, uuid);
      s.canonical.observe(sessionId, { type: 'user', uuid, message: { role: 'user', content: [{ type: 'text', text }] } });
      // foreign agents: give the session a recognisable title (Claude derives it from the first prompt, whose first line says 编排)
      const title = titles.get(sessionId);
      titles.delete(sessionId);
      const head = await s.transcripts.head(sessionId).catch(() => null);
      if (head && !head.title && title) await s.transcripts.patchHead(sessionId, { title: `编排 · ${title}`.slice(0, 80) }).catch(() => {});
      return true;
    },
    watch: (sessionId, on) => poolWatch(s.pool, sessionId, on),
    async stop(sessionId) {
      const r = s.pool.get(sessionId);
      if (!r) return;
      // a session still starting has no turn to interrupt: its prompt would go out as soon as it's ready
      if (r.state === 'starting') await s.pool.close(sessionId);
      else await r.interrupt();
    },
    async close(sessionId) { await s.pool.close(sessionId); },
  };
}
