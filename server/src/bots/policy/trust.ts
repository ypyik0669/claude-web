// server/src/bots/policy/trust.ts
import type { ActionClass, BotPolicy, PolicyScope } from '../../protocol.js';
import type { TrustMap } from '../types.js';
import { scopeMatches } from './rules.js';

export const TRUST_THRESHOLD = 3;
const k = (cls: ActionClass, key: string) => `${cls}|${key}`;

/** The Nth approval of the same class in the same scope with no correction in between: propose one level up. */
export function recordApproval(t: TrustMap, cls: ActionClass, key: string, now: number): { trust: TrustMap; propose: boolean } {
  const cur = t[k(cls, key)] ?? { approvals: 0, lastAt: 0 };
  const next = { approvals: cur.approvals + 1, lastAt: now };
  return { trust: { ...t, [k(cls, key)]: next }, propose: next.approvals === TRUST_THRESHOLD };
}

export function recordCorrection(t: TrustMap, cls: ActionClass, key: string): TrustMap {
  const { [k(cls, key)]: _gone, ...rest } = t;
  return rest;
}

export function scopeFromKey(key: string): PolicyScope {
  const [kind, ...rest] = key.split(':'); const v = rest.join(':');
  if (kind === 'channel') return { channels: [v] };
  if (kind === 'domain') return { domains: [v] };
  if (kind === 'recipient') return { recipients: [v] };
  return {};
}

/** A correction: the scoped rules that let this class run on this target go away — it asks again. */
export function demoteRule(policy: BotPolicy, cls: ActionClass, key: string): BotPolicy {
  const s = scopeFromKey(key);
  const target = { channel: s.channels?.[0], domain: s.domains?.[0], recipient: s.recipients?.[0] };
  return { ...policy, rules: policy.rules.filter((r) => !(r.cls === cls && r.scope && r.level !== 'ask' && r.level !== 'deny' && scopeMatches(r.scope, target, 0, 0))) };
}
