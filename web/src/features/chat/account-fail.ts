import { CLAUDE_PROVIDER_ID, parsePeerId } from '@shared';
import type { ErrorKind } from '@/model/health';

/**
 * A Claude-account conversation whose key was refused or that could not connect, while the user has added providers:
 * it never went through them. A user whose provider tested fine kept retrying such a conversation — it read an old
 * relay token from ~/.claude/settings.json — and nothing on screen said it was not on the provider (2026-10-08).
 * `live`: the running process's provider (undefined = the account); `recorded`: SessionMeta.providerId, for a
 * conversation with no process.
 */
export function accountFailed(i: {
  sessionId: string;
  errorKind?: ErrorKind;
  agent?: string;
  hasInfo: boolean;
  live?: string;
  recorded?: string;
  providers: number;
}): boolean {
  if (i.errorKind !== 'credential' && i.errorKind !== 'network') return false;
  if ((i.agent ?? 'claude') !== 'claude' || parsePeerId(i.sessionId) || i.providers === 0) return false;
  const p = i.hasInfo ? i.live : i.recorded;
  return !p || p === CLAUDE_PROVIDER_ID;
}
