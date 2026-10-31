// 值班 Bot: the conversations that belong to a bot — its main conversation (thread), its routine runs, internal work —
// stay out of every conversation list (sidebar, palette search, home, IM's /sessions, the sessions MCP tools).
import type { SessionMeta, SessionSummary } from '../protocol.js';
import { tr } from '../i18n/index.js';

/** how phase 1's one-sentence generator began its prompt: those conversations (no meta) are only known by it */
export const GENERATOR_PREFIX = '把下面这句话变成一个「值班 Bot」的设置';

export function isBotSession(meta: SessionMeta | undefined, s?: Pick<SessionSummary, 'firstPrompt' | 'title'>): boolean {
  if (meta?.botId || meta?.botRole) return true;
  return !!s && [s.firstPrompt, s.title].some((t) => typeof t === 'string' && t.trimStart().startsWith(GENERATOR_PREFIX));
}

/** requests that would change what a bot's own conversation runs on, or hand it away */
const THREAD_LOCKED = new Set<string>(['session.setProvider', 'session.switchAgent', 'handoff.start']);
/**
 * Throws for such a request on a bot's own conversation: it stays the gated Claude conversation the bot page set up (a
 * provider / agent swap reopens it ungated, which the pool refuses — the thread would die; a handoff makes it read-only).
 */
export function refuseOnThread(req: { kind: string; sessionId?: unknown }, isThread: (sessionId: string) => boolean): void {
  if (THREAD_LOCKED.has(req.kind) && typeof req.sessionId === 'string' && isThread(req.sessionId)) {
    throw new Error(tr('这是 Bot 的对话：它的模型来源和设置在 Bot 资料里改'));
  }
}
