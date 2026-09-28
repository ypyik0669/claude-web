import type { ProviderType } from '../protocol.js';

/** A provider switch recorded in the canonical log (`session/swap.ts`). `fromProviderId`: 'claude' = the account; absent = not recorded (older logs). */
export interface ProviderMark { t: number; providerId?: string; providerName?: string; fromProviderId?: string }
export interface TurnProvider { type?: ProviderType; name: string }
export interface ProviderTimeline { at(ts: number): TurnProvider; /** changes whenever `at` could answer differently (cache key) */ key: string }

const ACCOUNT: TurnProvider = { name: 'Claude 账号' };
const UNKNOWN: TurnProvider = { name: '未知档案' };
const norm = (id: string | undefined) => (id && id !== 'claude' ? id : undefined);

/**
 * Which profile answered a turn at time `ts`: switches split a session by time; before the first switch it is that
 * switch's recorded origin (unknown for logs written before the origin was recorded — reported as 未知档案, not
 * guessed); with no switch it is the session's profile. A deleted profile is never the Claude account.
 */
export function providerTimeline(marks: ProviderMark[], currentId: string | undefined, resolve: (id: string) => { type: ProviderType; name: string } | undefined): ProviderTimeline {
  const describe = (id: string | undefined, recordedName?: string): TurnProvider => {
    const pid = norm(id);
    if (!pid) return ACCOUNT;
    const p = resolve(pid);
    return p ? { type: p.type, name: p.name } : { name: recordedName ? `${recordedName}（已删除）` : '已删除的档案' };
  };
  const sorted = [...marks].sort((a, b) => a.t - b.t);
  if (!sorted.length) {
    const only = describe(currentId);
    return { at: () => only, key: JSON.stringify(only) };
  }
  const first = sorted[0].fromProviderId === undefined ? UNKNOWN : describe(sorted[0].fromProviderId);
  const segs: { from: number; p: TurnProvider }[] = sorted.map((m) => ({ from: m.t, p: describe(m.providerId, m.providerName) }));
  return {
    at: (ts) => { let p = first; for (const s of segs) if (ts >= s.from) p = s.p; return p; },
    key: JSON.stringify([first, segs]),
  };
}
