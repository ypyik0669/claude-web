// 值班 Bot approval card: what 允许 ▾ offers, narrowest first (spec 2026-10-31 §1). Pure: the card draws it.
import type { InboxAnswer, InboxItem, PolicyScope } from '@shared';
import { tr } from '@/i18n';
import { scopeDefaults } from '../scope-form';
import { splitList } from '../fields';

/** 这次运行内: a scope on this call's target that lasts this long. */
export const RUN_SCOPE_MS = 30 * 60 * 1000;

export type ApprovalChoiceId = 'once' | 'run' | 'target' | 'always';

export interface ApprovalChoice {
  id: ApprovalChoiceId;
  label: string;
  answer: InboxAnswer['answer'];
  /** sent as it is (no form) */
  scope?: PolicyScope;
  /** the scope form opens first: prefilled on the target ('run' with 有效期 set too), or with every 无限制 ticked */
  editor?: 'run' | 'target' | 'unlimited';
  /** a payment: the form wants 金额上限 */
  amountRequired?: boolean;
}

/**
 * The choices of 允许 ▾. A call with no target the scope can name (no domain / channel / recipient) has only
 * 仅这次 and 总是 — a scope of numbers alone would match everything. A payment's narrow scopes need 金额上限,
 * which the call does not say, so its 这次运行内 goes through the form too.
 */
export function approvalChoices(item: Pick<InboxItem, 'cls' | 'toolName' | 'input'>, now: number): ApprovalChoice[] {
  const d = scopeDefaults(item);
  const pay = item.cls === 'pay';
  const once: ApprovalChoice = { id: 'once', label: tr('仅这次'), answer: 'approve' };
  const always: ApprovalChoice = { id: 'always', label: tr('总是'), answer: 'approve_scope', editor: 'unlimited' };
  const target: PolicyScope = {};
  for (const f of ['domains', 'channels', 'recipients'] as const) {
    const list = splitList(d[f]);
    if (list.length) target[f] = list;
  }
  if (!Object.keys(target).length) return [once, always];
  const run: ApprovalChoice = pay
    ? { id: 'run', label: tr('这次运行内'), answer: 'approve_scope', editor: 'run', amountRequired: true }
    : { id: 'run', label: tr('这次运行内'), answer: 'approve_scope', scope: { ...target, until: now + RUN_SCOPE_MS } };
  return [once, run, { id: 'target', label: tr('对这个目标总是允许'), answer: 'approve_scope', editor: 'target', amountRequired: pay }, always];
}

/**
 * What an answered card says: 已允许 · 9:42 / 已拒绝; closed with a note (its run stopped, its day ran out) 已过期;
 * put away from the inbox 已收起; anything else 已关闭 — never 「已允许」 for what nobody allowed.
 */
export function doneText(d: NonNullable<InboxItem['done']>, clock: (at: number) => string): string {
  if (d.note) return tr('已过期');
  if (d.answer === 'approve' || d.answer === 'approve_scope') return tr('已允许 · {time}', { time: clock(d.at) });
  if (d.answer === 'reject') return tr('已拒绝');
  if (d.answer === 'archive') return tr('已收起');
  return tr('已关闭');
}
