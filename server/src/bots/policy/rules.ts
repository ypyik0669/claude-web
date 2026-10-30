// server/src/bots/policy/rules.ts
import type { ActionClass, AuditBasis, BotPolicy, PolicyLevel, PolicyRule, PolicyScope } from '../../protocol.js';

export type Target = { domain?: string; recipient?: string; channel?: string; amount?: number };
export interface Decision { level: PolicyLevel; basis: AuditBasis; rule?: PolicyRule }

/** 宽但不出事: everything local runs; installing tells; anything outward, money or irreversible asks. */
export const DEFAULT_RULES: PolicyRule[] = [
  { cls: 'read', level: 'do' }, { cls: 'write_local', level: 'do' }, { cls: 'browser', level: 'do' },
  { cls: 'install', level: 'do_tell' },
  { cls: 'send', level: 'ask' }, { cls: 'pay', level: 'ask' }, { cls: 'delete', level: 'ask' },
];

export function scopeKey(_scope: PolicyScope | undefined, t: Target): string {
  if (t.channel) return `channel:${t.channel}`;
  if (t.recipient) return `recipient:${t.recipient}`;
  if (t.domain) return `domain:${t.domain}`;
  return '*';
}

export function scopeMatches(scope: PolicyScope | undefined, t: Target, now: number, todayCount: number): boolean {
  if (!scope) return true;
  if (scope.unlimited) return true;
  if (scope.until !== undefined && now > scope.until) return false;
  if (scope.domains?.length && !(t.domain && scope.domains.includes(t.domain))) return false;
  if (scope.channels?.length && !(t.channel && scope.channels.includes(t.channel))) return false;
  if (scope.recipients?.length && !(t.recipient && scope.recipients.includes(t.recipient))) return false;
  if (scope.maxAmount !== undefined && !(t.amount !== undefined && t.amount <= scope.maxAmount)) return false;
  if (scope.perDay !== undefined && todayCount >= scope.perDay) return false;
  return true;
}

export function decide(policy: BotPolicy, cls: ActionClass, t: Target, now: number, todayCount: number): Decision {
  const own = policy.rules.filter((r) => r.cls === cls);
  const deny = own.find((r) => r.level === 'deny' && scopeMatches(r.scope, t, now, todayCount));
  if (deny) return { level: 'deny', basis: 'rule', rule: deny };
  if (policy.unleashed) return { level: 'do', basis: 'unleashed' };
  if (policy.autoPilot?.on && scopeMatches(policy.autoPilot.scope, t, now, todayCount)) return { level: 'do', basis: 'autopilot' };
  const scoped = own.find((r) => r.scope && scopeMatches(r.scope, t, now, todayCount));
  if (scoped) return { level: scoped.level, basis: 'rule', rule: scoped };
  const plain = own.find((r) => !r.scope);
  if (plain) return { level: plain.level, basis: 'rule', rule: plain };
  const d = DEFAULT_RULES.find((r) => r.cls === cls)!;
  return { level: d.level, basis: 'rule', rule: d };
}
