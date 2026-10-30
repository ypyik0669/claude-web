// server/src/bots/policy/trust.ts
import type { ActionClass, BotPolicy, PolicyRule, PolicyScope } from '../../protocol.js';
import type { TrustMap } from '../types.js';

export const TRUST_THRESHOLD = 3;
const k = (cls: ActionClass, key: string) => `${cls}|${key}`;

/** An upgrade is always scoped: a key that names no channel / recipient / domain ('*') is never counted. */
const isScopedKey = (key: string) => Object.keys(scopeFromKey(key)).length > 0;

/** The Nth approval of the same class in the same scope with no correction in between: propose one level up. */
export function recordApproval(t: TrustMap, cls: ActionClass, key: string, now: number): { trust: TrustMap; propose: boolean } {
  if (!isScopedKey(key)) return { trust: t, propose: false };
  const cur = t[k(cls, key)] ?? { approvals: 0, lastAt: 0 };
  const next = { approvals: cur.approvals + 1, lastAt: now };
  return { trust: { ...t, [k(cls, key)]: next }, propose: next.approvals === TRUST_THRESHOLD };
}

export function recordCorrection(t: TrustMap, cls: ActionClass, key: string): TrustMap {
  const { [k(cls, key)]: _gone, ...rest } = t;
  return rest;
}

/** 'channel:C1' → { channels: ['C1'] }; multi-valued keys ('domain:a.com,b.com') keep every value; '*' → {}. */
export function scopeFromKey(key: string): PolicyScope {
  const i = key.indexOf(':');
  if (i < 0) return {};
  const kind = key.slice(0, i);
  const vals = key.slice(i + 1).split(',').filter(Boolean);
  if (!vals.length) return {};
  if (kind === 'channel') return { channels: vals };
  if (kind === 'domain') return { domains: vals };
  if (kind === 'recipient') return { recipients: vals };
  return {};
}

const sameRule = (a: PolicyRule, b: PolicyRule) => a.cls === b.cls && a.level === b.level && JSON.stringify(a.scope ?? null) === JSON.stringify(b.scope ?? null);

/**
 * A correction: the rule that let the action through (Decision.rule) stops letting it through. A scoped do / do_tell
 * rule is removed; a plain one goes back to 'ask'. Built-in defaults, autopilot and unleashed have no rule here to change.
 */
export function demoteRule(policy: BotPolicy, rule: PolicyRule | undefined): BotPolicy {
  if (!rule || (rule.level !== 'do' && rule.level !== 'do_tell')) return policy;
  let i = policy.rules.indexOf(rule);
  if (i < 0) i = policy.rules.findIndex((r) => sameRule(r, rule));
  if (i < 0) return policy;
  const rules = [...policy.rules];
  if (rules[i].scope) rules.splice(i, 1); else rules[i] = { ...rules[i], level: 'ask' };
  return { ...policy, rules };
}
