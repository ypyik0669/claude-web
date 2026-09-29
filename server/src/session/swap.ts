import { randomUUID } from 'node:crypto';
import type { RunnerPool } from '../runtime/pool.js';
import type { AgentTranscripts } from '../agents/transcript.js';
import type { MetaStore } from '../meta/store.js';
import type { AgentKind, OpenSessionParams, SessionInfoSnapshot } from '../protocol.js';
import type { CanonicalLog } from './canonical.js';
import { renderBriefing, toClaudeEntries } from './handoff.js';
import { seedCanonical } from '../library/briefing.js';

/**
 * Swapping what is behind a live session without the user losing the session.
 *
 * A CLI's environment is fixed at spawn — a base URL or API key cannot be changed in place — so
 * "switch provider without restarting" can only mean an invisible restart: stop the child, spawn a
 * new one with the new env, resume from where the old one stopped, keep the same session id, title,
 * history and tiles. The user sees one system line, not a new session.
 *
 * Switching *agent* is the same move plus a translation step, because the new agent has no native
 * transcript for this session. Claude gets synthesized entries through the SDK's `SessionStore`;
 * everyone else gets a rendered briefing as their first message. See handoff.ts for why not more.
 */
export interface SwapDeps {
  pool: RunnerPool;
  canonical: CanonicalLog;
  transcripts: AgentTranscripts;
  meta: MetaStore;
  /** Optional: read a session's native history from the session library (Task 8). Used to seed the
   * canonical timeline when a session was imported and never ran through this server before, so a
   * handoff still gets a real briefing instead of an empty one. */
  readAll?: (id: string) => Promise<any[]>;
  /** Optional: is this an IMPORTED library session (lives in another agent's store)? Its source agent,
   * library cwd and title if so, null otherwise. Imported sessions are never swapped in place. */
  imported?: (id: string) => Promise<{ agent: AgentKind; cwd: string; title?: string } | null>;
}

export interface SwapResult {
  sessionId: string;
  info: SessionInfoSnapshot;
  history: unknown[];
  briefing?: string;
}

/**
 * Non-Claude agents have no way to be resumed from synthesized history, so the briefing IS their
 * first turn. Drivers queue until ready and record the message into their transcript, so the client
 * sees it in the returned history. Not mirrored into canonical: it is derived from canonical, and
 * would otherwise nest into every later briefing.
 */
function deliverBriefing(r: ReturnType<RunnerPool['open']>, briefing: string) {
  r.send(briefing, undefined, false, randomUUID());
}

async function stop(pool: RunnerPool, sessionId: string) {
  const r = pool.get(sessionId);
  if (!r) return null;
  const info = r.info;
  // tell session watchers (orchestration) that the coming 'closed' is a handover to a new runner
  pool.emit('swapping', sessionId);
  await pool.close(sessionId).catch(() => { /* already gone */ });
  return info;
}

/**
 * One swap at a time per session. setProvider / switchAgent close the runner and open a new one; two of them
 * interleaving (a double click, two windows) would open two processes on one session id. Not re-entrant:
 * never call swapProvider / swapAgent from inside a locked section of the same session.
 */
const swapLocks = new Map<string, Promise<unknown>>();
export function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = swapLocks.get(sessionId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  const tail = next.catch(() => {});
  swapLocks.set(sessionId, tail);
  void tail.then(() => { if (swapLocks.get(sessionId) === tail) swapLocks.delete(sessionId); });
  return next;
}

export const normProvider = (id: string | undefined) => (id && id !== 'claude' ? id : undefined);

/**
 * What a provider change leaves behind — for a live swap (swapProvider) and for a conversation that is not running
 * reopened on another provider (the hub's `session.open` with an explicit providerId, which is how a pick on the
 * chips of a history conversation, IM, schedules and other windows reach it): the recorded profile
 * (SessionMeta.providerId; the account clears it, or a restart would bring the old relay back) and the canonical
 * `switch` line the hand-over briefing and usage attribution read (fromProviderId: who answered the turns before it;
 * 'claude' = the account). Callers hold the session's lock.
 */
export async function recordProviderSwitch(d: Pick<SwapDeps, 'meta' | 'canonical'>, sessionId: string, from: string | undefined, providerId: string | undefined, providerName: string): Promise<void> {
  // not fire-and-forget: a failed meta save would otherwise be an unhandled rejection that kills the server
  await d.meta.setSessionMeta(sessionId, { providerId: normProvider(providerId) }).catch(() => { /* kept in memory; the next save persists it */ });
  d.canonical.mark(sessionId, { providerId: normProvider(providerId), providerName, fromProviderId: normProvider(from) ?? 'claude', note: `已切换到供应商「${providerName}」` });
}

/**
 * `session.open` of an existing conversation that is not running, with an explicit providerId other than the one it
 * recorded (none recorded = the account): the same bookkeeping as swapProvider before `open` runs, under the same
 * session lock (checked again inside it, so a second open racing this one sees the first one's record). Forks and
 * rewinds get a new id and keep their own record; a running conversation changes provider through swapProvider.
 */
export function openOnProvider<T>(
  d: Pick<SwapDeps, 'pool' | 'meta' | 'canonical'>,
  params: OpenSessionParams,
  nameOf: (providerId: string) => string,
  open: (p: OpenSessionParams) => Promise<T>,
  onRecorded?: () => void,
): Promise<T> {
  const sid = params.sessionId && !params.fork && !params.resumeAt ? params.sessionId : undefined;
  const to = params.providerId;
  const idle = (id: string) => { const r = d.pool.get(id); return !r || r.state === 'closed' || r.state === 'error'; };
  const differs = (id: string) => to !== undefined && normProvider(to) !== normProvider(d.meta.sessionMeta(id).providerId);
  if (!sid || to === undefined || !idle(sid) || !differs(sid)) return open(params);
  return withSessionLock(sid, async () => {
    if (idle(sid) && differs(sid)) {
      await d.canonical.ensure(sid, params.cwd); // a CLI conversation that never ran here has no mirror yet
      await recordProviderSwitch(d, sid, d.meta.sessionMeta(sid).providerId, to, nameOf(to));
      onRecorded?.();
    }
    return open(params);
  });
}

/**
 * Same agent, different provider profile: close, respawn with the new env, resume in place.
 * `model`: what to start on. Omitted on a real profile change = the new profile's / login's default — the old
 * profile's model id rarely exists behind another endpoint; omitted on the same profile = keep the current one.
 */
export function swapProvider(d: SwapDeps, sessionId: string, providerId: string | undefined, providerName: string, model?: string): Promise<SwapResult> {
  // the lock lives here, not in the hub: federation hand-overs, orchestration and IM reach these without the hub
  return withSessionLock(sessionId, () => swapProviderNow(d, sessionId, providerId, providerName, model));
}
async function swapProviderNow(d: SwapDeps, sessionId: string, providerId: string | undefined, providerName: string, model?: string): Promise<SwapResult> {
  const live = d.pool.get(sessionId);
  const before = normProvider(live ? live.info.providerId : d.meta.sessionMeta(sessionId).providerId);
  const changed = before !== normProvider(providerId);
  const prev = await stop(d.pool, sessionId);
  const cwd = prev?.cwd ?? (await d.canonical.head(sessionId))?.cwd ?? process.cwd();
  await recordProviderSwitch(d, sessionId, before, providerId, providerName);

  const params: OpenSessionParams = {
    sessionId,
    cwd,
    model: model || (changed ? undefined : prev?.model ?? undefined),
    effort: prev?.effort ?? undefined,
    permissionMode: prev?.permissionMode,
    features: prev?.features,
    providerId,
    agent: prev?.agent ?? 'claude',
  };
  const r = d.pool.open(params);
  return { sessionId: r.sessionId, info: r.info, history: r.getHistory() };
}

/** Different agent: close, spawn the new one on the same session id, hand it a briefing. */
export function swapAgent(d: SwapDeps, sessionId: string, agent: AgentKind, model: string | undefined, objective?: string): Promise<SwapResult> {
  return withSessionLock(sessionId, () => swapAgentNow(d, sessionId, agent, model, objective));
}
async function swapAgentNow(d: SwapDeps, sessionId: string, agent: AgentKind, model: string | undefined, objective?: string): Promise<SwapResult> {
  const imp = d.imported ? await d.imported(sessionId) : null;
  if (imp) return handOverImported(d, sessionId, imp, agent, model, objective);
  const prev = await stop(d.pool, sessionId);
  const from = prev?.agent ?? (await d.transcripts.head(sessionId))?.agent ?? 'claude';
  const cwd = prev?.cwd ?? (await d.canonical.head(sessionId))?.cwd ?? process.cwd();
  let events = await d.canonical.load(sessionId);
  if (!events.length && d.readAll) {
    // an imported library session that never ran through this server: seed the mirror from its
    // native history so the briefing isn't empty, then re-read what got written
    const native = await d.readAll(sessionId).catch(() => []);
    if (native.length) {
      await d.canonical.ensure(sessionId, cwd);
      await seedCanonical(d.canonical, sessionId, native);
      events = await d.canonical.load(sessionId);
    }
  }
  const briefing = renderBriefing(events, { fromAgent: from, toAgent: agent, cwd, objective }).text;
  d.canonical.mark(sessionId, { agent, model, note: `已从 ${from} 交接给 ${agent}` });

  const params: OpenSessionParams = {
    sessionId,
    cwd,
    model,
    permissionMode: prev?.permissionMode,
    agent,
    // Claude resumes from synthesized entries; the others get the briefing as their first message
    resumeEntries: agent === 'claude' ? toClaudeEntries(events, { cwd, sessionId, briefing }) : undefined,
  } as OpenSessionParams;

  // the foreign-agent transcript has to exist (and name the new agent) before the driver appends
  if (agent !== 'claude') {
    if (await d.transcripts.exists(sessionId)) await d.transcripts.patchHead(sessionId, { agent, model });
    else await d.transcripts.create({ agent, cwd, title: objective ?? '交接的对话', createdAt: Date.now(), sessionId, model });
  }

  const r = d.pool.open(params);
  if (agent !== 'claude') deliverBriefing(r, briefing);
  return { sessionId: r.sessionId, info: r.info, history: r.getHistory(), briefing: agent === 'claude' ? undefined : briefing };
}

/**
 * Handing over an IMPORTED session (one that lives in Codex's / OpenCode's / an ACP agent's own
 * store) always starts a NEW session — Claude gets a fresh UUID, the others a new claude-web session
 * — seeded with a briefing built from the library history. The imported session itself is not
 * touched (no head patched, nothing stopped) and stays listed under its source; the new session runs
 * in the library summary's cwd, never this process's.
 */
async function handOverImported(d: SwapDeps, fromId: string, src: { agent: AgentKind; cwd: string; title?: string }, agent: AgentKind, model: string | undefined, objective?: string): Promise<SwapResult> {
  if (!d.readAll) throw new Error('对话库不可用，无法交接导入的对话');
  const native = await d.readAll(fromId); // no history → no hand-over (don't start an empty session)
  const sessionId = randomUUID();
  const cwd = src.cwd;
  await d.canonical.ensure(sessionId, cwd);
  if (native.length) await seedCanonical(d.canonical, sessionId, native);
  const events = await d.canonical.load(sessionId);
  const briefing = renderBriefing(events, { fromAgent: src.agent, toAgent: agent, cwd, objective }).text;
  d.canonical.mark(sessionId, { agent, model, note: `已从 ${src.agent} 的对话 ${fromId} 交接给 ${agent}` });

  if (agent !== 'claude') {
    const title = objective ?? (src.title ? `${src.title}（交接）` : '交接的对话');
    await d.transcripts.create({ agent, cwd, title, createdAt: Date.now(), sessionId, model });
  }
  const params = {
    sessionId,
    cwd,
    model,
    agent,
    resumeEntries: agent === 'claude' ? toClaudeEntries(events, { cwd, sessionId, briefing }) : undefined,
  } as OpenSessionParams;
  const r = d.pool.open(params);
  if (agent !== 'claude') deliverBriefing(r, briefing);
  return { sessionId: r.sessionId, info: r.info, history: r.getHistory(), briefing: agent === 'claude' ? undefined : briefing };
}
