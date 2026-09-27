import type { RunnerPool } from '../runtime/pool.js';
import type { AgentTranscripts } from '../agents/transcript.js';
import type { MetaStore } from '../meta/store.js';
import type { AgentKind, OpenSessionParams, SessionInfoSnapshot } from '../protocol.js';
import type { CanonicalLog } from './canonical.js';
import { renderBriefing, toClaudeEntries } from './handoff.js';

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
}

export interface SwapResult {
  sessionId: string;
  info: SessionInfoSnapshot;
  history: unknown[];
  briefing?: string;
}

async function stop(pool: RunnerPool, sessionId: string) {
  const r = pool.get(sessionId);
  if (!r) return null;
  const info = r.info;
  await pool.close(sessionId).catch(() => { /* already gone */ });
  return info;
}

/** Same agent, different provider profile: close, respawn with the new env, resume in place. */
export async function swapProvider(d: SwapDeps, sessionId: string, providerId: string | undefined, providerName: string): Promise<SwapResult> {
  const prev = await stop(d.pool, sessionId);
  const cwd = prev?.cwd ?? (await d.canonical.head(sessionId))?.cwd ?? process.cwd();
  // not fire-and-forget: a failed meta save would otherwise be an unhandled rejection that kills the server
  await d.meta.setSessionMeta(sessionId, { providerId }).catch(() => { /* kept in memory; the next save persists it */ });
  d.canonical.mark(sessionId, { providerId, providerName, note: `已切换到供应商「${providerName}」` });

  const params: OpenSessionParams = {
    sessionId,
    cwd,
    model: prev?.model ?? undefined,
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
export async function swapAgent(d: SwapDeps, sessionId: string, agent: AgentKind, model: string | undefined, objective?: string): Promise<SwapResult> {
  const prev = await stop(d.pool, sessionId);
  const from = prev?.agent ?? (await d.transcripts.head(sessionId))?.agent ?? 'claude';
  const cwd = prev?.cwd ?? (await d.canonical.head(sessionId))?.cwd ?? process.cwd();
  const events = await d.canonical.load(sessionId);
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
    else await d.transcripts.create({ agent, cwd, title: objective ?? '交接的会话', createdAt: Date.now(), sessionId, model });
  }

  const r = d.pool.open(params);
  return { sessionId: r.sessionId, info: r.info, history: r.getHistory(), briefing: agent === 'claude' ? undefined : briefing };
}
