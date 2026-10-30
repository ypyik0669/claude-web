// server/src/bots/policy/trust.ts
import type { ActionClass, BotPolicy, PolicyRule, PolicyScope } from '../../protocol.js';
import type { TrustEntry, TrustMap } from '../types.js';

export const TRUST_THRESHOLD = 3;
const k = (cls: ActionClass, key: string) => `${cls}|${key}`;

/** An upgrade is always scoped: a key that names no channel / recipient / domain ('*') is never counted. */
const isScopedKey = (key: string) => Object.keys(scopeFromKey(key)).length > 0;

/**
 * The Nth approval of the same class in the same scope with no correction in between: propose one level up, with
 * `scope` = what the upgrade covers. A payment upgrade is capped at the largest amount approved (`amount` = the
 * call's target amount); if any approved payment had no amount, no payment upgrade is proposed at all.
 */
export function recordApproval(t: TrustMap, cls: ActionClass, key: string, now: number, amount?: number): { trust: TrustMap; propose: boolean; scope?: PolicyScope } {
  if (!isScopedKey(key)) return { trust: t, propose: false };
  const cur: TrustEntry = t[k(cls, key)] ?? { approvals: 0, lastAt: 0 };
  const next: TrustEntry = { approvals: cur.approvals + 1, lastAt: now };
  if (cls === 'pay') {
    const priced = amount !== undefined && Number.isFinite(amount);
    if (cur.unpriced || !priced) next.unpriced = true;
    const max = Math.max(cur.maxAmount ?? -Infinity, priced ? amount : -Infinity);
    if (Number.isFinite(max)) next.maxAmount = max;
  }
  const trust = { ...t, [k(cls, key)]: next };
  if (next.approvals !== TRUST_THRESHOLD) return { trust, propose: false };
  if (cls === 'pay') {
    if (next.unpriced || next.maxAmount === undefined) return { trust, propose: false };
    return { trust, propose: true, scope: { ...scopeFromKey(key), maxAmount: next.maxAmount } };
  }
  return { trust, propose: true, scope: scopeFromKey(key) };
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
