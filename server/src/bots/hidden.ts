// 值班 Bot: the conversations that belong to a bot — its main conversation (thread), its routine runs, internal work —
// stay out of every conversation list (sidebar, palette search, home, IM's /sessions, the sessions MCP tools).
import type { SessionMeta, SessionSummary } from '../protocol.js';

/** how phase 1's one-sentence generator began its prompt: those conversations (no meta) are only known by it */
export const GENERATOR_PREFIX = '把下面这句话变成一个「值班 Bot」的设置';

export function isBotSession(meta: SessionMeta | undefined, s?: Pick<SessionSummary, 'firstPrompt' | 'title'>): boolean {
  if (meta?.botId || meta?.botRole) return true;
  return !!s && [s.firstPrompt, s.title].some((t) => typeof t === 'string' && t.trimStart().startsWith(GENERATOR_PREFIX));
}
