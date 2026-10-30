// server/src/bots/policy/rules.ts
import type { ActionClass, AuditBasis, BotPolicy, PolicyLevel, PolicyRule, PolicyScope } from '../../protocol.js';

/**
 * What a call touches: every host, channel and recipient in it, and the largest amount.
 * opaque: the call also goes somewhere we can't read precisely (a bare host, user@host:, ssh / scp, a proxy, a
 * non-http scheme…) — no allow scope matches it. amountUnknown: some amount in it isn't a plain number — no
 * maxAmount matches it.
 */
export type Target = { domains?: string[]; channels?: string[]; recipients?: string[]; amount?: number; opaque?: boolean; amountUnknown?: boolean };
export interface Decision { level: PolicyLevel; basis: AuditBasis; rule?: PolicyRule }

/** 宽但不出事: everything local runs; installing tells; anything outward, money or irreversible asks. */
export const DEFAULT_RULES: PolicyRule[] = [
  { cls: 'read', level: 'do' }, { cls: 'write_local', level: 'do' }, { cls: 'browser', level: 'do' },
  { cls: 'install', level: 'do_tell' },
  { cls: 'send', level: 'ask' }, { cls: 'pay', level: 'ask' }, { cls: 'delete', level: 'ask' },
];

/** Scope list ↔ target field ↔ trust-key prefix. Order = which one names the trust key first. */
const KINDS = [['channels', 'channel'], ['recipients', 'recipient'], ['domains', 'domain']] as const;
const norm = (field: string, vals: string[]) => field === 'domains' ? vals.map((v) => v.toLowerCase()) : vals;

/** What trust is counted on: `channel:C1` / `recipient:a,b` / `domain:x.com` — every value of that kind, sorted. '*' when the call names none. */
export function scopeKey(_scope: PolicyScope | undefined, t: Target): string {
  if (t.opaque) return '*'; // trust is never earned on a call whose destination we couldn't see
  for (const [field, kind] of KINDS) {
    const vals = t[field];
    if (vals?.length) return `${kind}:${[...new Set(norm(field, vals))].sort().join(',')}`;
  }
  return '*';
}

/**
 * Is the call inside the scope (an allow rule / autopilot)? Each list applies to the kind of target it names: if the
 * target has values of that kind, EVERY one must be listed; a scope with lists needs the target to name at least one
 * listed kind. maxAmount is checked for payments and for anything that carries an amount (cls omitted = always).
 */
export function scopeMatches(scope: PolicyScope | undefined, t: Target, now: number, todayCount: number, cls?: ActionClass): boolean {
  if (!scope) return true;
  if (scope.unlimited) return true;
  if (scope.until !== undefined && now > scope.until) return false;
  if (t.opaque) return false;
  let listed = false, covered = false;
  for (const [field] of KINDS) {
    const list = scope[field];
    if (!list?.length) continue;
    listed = true;
    const vals = t[field];
    if (!vals?.length) continue;
    const allow = norm(field, list);
    if (!norm(field, vals).every((v) => allow.includes(v))) return false;
    covered = true;
  }
  if (listed && !covered) return false;
  if (scope.maxAmount !== undefined && (cls === undefined || cls === 'pay' || t.amount !== undefined || t.amountUnknown)
    && !(t.amount !== undefined && !t.amountUnknown && t.amount <= scope.maxAmount)) return false;
  if (scope.perDay !== undefined && todayCount >= scope.perDay) return false;
  return true;
}

/** Does a deny rule's scope touch the call at all? Any one listed value is enough — a deny is never talked past by adding a harmless host. */
function scopeTouches(scope: PolicyScope | undefined, t: Target, now: number): boolean {
  if (!scope || scope.unlimited) return true;
  if (scope.until !== undefined && now > scope.until) return false;
  if (t.opaque) return true; // it may be going exactly where the deny points
  let listed = false;
  for (const [field] of KINDS) {
    const list = scope[field];
    if (!list?.length) continue;
    listed = true;
    const allow = norm(field, list);
    if (norm(field, t[field] ?? []).some((v) => allow.includes(v))) return true;
  }
  return !listed;
}

/** A rule's identity for its daily count: class + scope, keys sorted (rules have no id; changing the scope starts a new count). */
export function ruleKey(rule: PolicyRule): string {
  const s = rule.scope ? Object.fromEntries(Object.entries(rule.scope).sort(([a], [b]) => a.localeCompare(b))) : null;
  return `${rule.cls}|${JSON.stringify(s)}`;
}

/** Today's allowed actions: per rule (a rule's perDay) and what autopilot let through on its own (autopilot's perDay). */
export interface DayCounts { perRule(rule: PolicyRule): number; autopilot: number }
export const NO_COUNTS: DayCounts = { perRule: () => 0, autopilot: 0 };

export function decide(policy: BotPolicy, cls: ActionClass, t: Target, now: number, counts: DayCounts = NO_COUNTS): Decision {
  const own = policy.rules.filter((r) => r.cls === cls);
  const deny = own.find((r) => r.level === 'deny' && scopeTouches(r.scope, t, now));
  if (deny) return { level: 'deny', basis: 'rule', rule: deny };
  if (policy.unleashed) return { level: 'do', basis: 'unleashed' };
  // autopilot needs a scope (none would be everywhere — an old bot.json); a payment only under a maxAmount or unlimited
  const ap = policy.autoPilot;
  if (ap?.on && ap.scope && (cls !== 'pay' || ap.scope.unlimited === true || ap.scope.maxAmount !== undefined)
    && scopeMatches(ap.scope, t, now, counts.autopilot, cls)) return { level: 'do', basis: 'autopilot' };
  const scoped = own.find((r) => r.level !== 'deny' && r.scope && scopeMatches(r.scope, t, now, counts.perRule(r), cls));
  if (scoped) return { level: scoped.level, basis: 'rule', rule: scoped };
  const plain = own.find((r) => r.level !== 'deny' && !r.scope);
  if (plain) return { level: plain.level, basis: 'rule', rule: plain };
  const d = DEFAULT_RULES.find((r) => r.cls === cls)!;
  return { level: d.level, basis: 'rule', rule: d };
}
