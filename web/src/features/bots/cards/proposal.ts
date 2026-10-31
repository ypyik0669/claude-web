// 值班 Bot proposal card: its rules in plain words, and what adopting them would risk — the same sentences the policy
// editor asks before it lets a bot send, pay or delete on its own, plus one for a rule with no limits. Pure: the card draws it.
import type { ActionClass, BotPolicy, PolicyLevel, PolicyRule, PolicyScope } from '@shared';
import { tr } from '@/i18n';
import { classLabel, levelLabel } from '../model';
import { doRisk } from '../fields';

export function scopeWords(s?: PolicyScope): string {
  if (!s) return '';
  if (s.unlimited) return tr('不限范围');
  const parts = [...(s.domains ?? []), ...(s.channels ?? []), ...(s.recipients ?? [])];
  if (s.maxAmount !== undefined) parts.push(tr('不超过 {n}', { n: s.maxAmount }));
  if (s.perDay !== undefined) parts.push(tr('每天最多 {n} 次', { n: s.perDay }));
  if (s.until !== undefined) parts.push(tr('到 {date} 为止', { date: new Date(s.until).toLocaleDateString() }));
  return parts.join('、');
}

export const ruleWords = (r: PolicyRule) => {
  const scope = scopeWords(r.scope);
  return `${classLabel(r.cls)}：${levelLabel(r.level)}${scope ? `（${scope}）` : ''}`;
};

/** what to confirm before adopting these rules (one sentence each, none repeated); empty: nothing risky */
export function proposalRisks(rules: PolicyRule[]): string[] {
  const out = new Set<string>();
  for (const r of rules) {
    if (r.level === 'deny' || r.level === 'ask') continue;
    const risk = doRisk(r.cls, r.level);
    if (risk) out.add(risk);
    if (r.scope?.unlimited) out.add(tr('「{cls}」这条不限范围：以后它对谁、在哪儿都直接做，不再问你。确定？', { cls: classLabel(r.cls) }));
  }
  return [...out];
}

/** the server's defaults (server bots/policy/rules.ts DEFAULT_RULES): local work runs, anything outward / money / irreversible asks */
const DEFAULT_LEVEL: Record<ActionClass, PolicyLevel> = { read: 'do', write_local: 'do', browser: 'do', install: 'do_tell', send: 'ask', pay: 'ask', delete: 'ask' };
const ORDER: ActionClass[] = ['send', 'pay', 'delete', 'install', 'browser', 'read', 'write_local'];

/**
 * 规矩 in plain words: which kinds of thing the bot asks first, does on its own, or never does — by each class's rule
 * that applies everywhere (a deny wins, else an unscoped rule, else the default). Rules limited to some places are
 * counted, not listed. 全自动 (unleashed): everything on its own.
 */
export function rulesWords(policy: Pick<BotPolicy, 'rules' | 'unleashed'>): { ask: string[]; own: string[]; never: string[]; scoped: number } {
  const out = { ask: [] as string[], own: [] as string[], never: [] as string[], scoped: policy.rules.filter((r) => r.scope && r.level !== 'deny').length };
  for (const cls of ORDER) {
    const own = policy.rules.filter((r) => r.cls === cls);
    const level = policy.unleashed ? 'do' : own.find((r) => r.level === 'deny')?.level ?? own.find((r) => !r.scope)?.level ?? DEFAULT_LEVEL[cls];
    (level === 'deny' ? out.never : level === 'ask' ? out.ask : out.own).push(classLabel(cls));
  }
  return out;
}
