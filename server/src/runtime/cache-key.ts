import type { OpenSessionParams } from '../protocol.js';

/**
 * The prompt-cache route key (`cacheParentId`, see SessionRunner.cacheKey) for a `session.open`, decided before a
 * fork swaps in its new id. A fork shares its parent's prompt prefix, so it keeps routing the way the parent did:
 * the parent's recorded key (a fork of a fork → the root) or the parent's id. A session reopened later keeps the
 * key recorded when it was created (`SessionMeta.cacheKey`). `undefined` = the session's own id.
 */
export function cacheParentFor(params: Pick<OpenSessionParams, 'sessionId' | 'fork' | 'resumeAt' | 'cacheParentId'>, recorded: (sessionId: string) => string | undefined = () => undefined): string | undefined {
  if (params.cacheParentId) return params.cacheParentId;
  if (!params.sessionId) return undefined;
  const own = recorded(params.sessionId);
  if (params.fork || params.resumeAt) return own ?? params.sessionId;
  return own;
}
