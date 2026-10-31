// 值班 Bot proposal card: its rules in plain words, and what adopting them would risk — the same sentences the policy
// editor asks before it lets a bot send, pay or delete on its own, plus one for a rule with no limits. Pure: the card draws it.
import type { PolicyRule, PolicyScope } from '@shared';
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
