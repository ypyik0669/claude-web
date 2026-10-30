// 值班 Bot: the one scope form — 批并以后直接做 in the inbox and 全自动 in the policy tab. Every field is either filled
// in or has its 无限制 ticked (each tick confirmed with its own risk); nothing blank ever means "no limit"; one 保存
// sends the whole scope. Matches the server's allowScope (bots/shape.ts): a destination list unless unlimited, and a
// payment's 金额上限 unless the whole scope is unlimited.
import { useState, type KeyboardEvent, type ReactNode } from 'react';
import type { InboxItem, PolicyScope } from '@shared';
import { imeComposing } from '@/ui/ime';
import { SwitchChip } from '@/ui/Switch';
import { tr } from '@/i18n';
import { confirmRisk, splitList } from './fields';

export type ScopeField = 'domains' | 'channels' | 'recipients' | 'maxAmount' | 'perDay' | 'until';
export type ScopeForm = Record<ScopeField, string>;
export type ScopeUnlimited = Record<ScopeField, boolean>;

export const ALL_SCOPE_FIELDS: ScopeField[] = ['domains', 'channels', 'recipients', 'maxAmount', 'perDay', 'until'];
const BLANK: ScopeForm = { domains: '', channels: '', recipients: '', maxAmount: '', perDay: '', until: '' };
const NONE: ScopeUnlimited = { domains: false, channels: false, recipients: false, maxAmount: false, perDay: false, until: false };

const strs = (...vs: unknown[]): string[] => vs.flatMap((v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])).map((s) => s.trim()).filter(Boolean);
const hostsIn = (s: string): string[] => [...s.matchAll(/https?:\/\/([^\s/?#"'<>()，,]+)/gi)].map((m) => m[1].replace(/:\d+$/, '').toLowerCase()).filter((h) => !h.includes('@'));

/** The params of a call — unwrapped when an ExecuteExtraTool / MCP wrapper carries them in `params`. */
export const callParams = (input: Record<string, unknown> | undefined): Record<string, unknown> =>
  (input?.params && typeof input.params === 'object' ? input.params : input ?? {}) as Record<string, unknown>;

/**
 * What the scope form starts with: the hosts of the URLs the call names, its channel(s), its recipients — the same
 * kinds the server's targetOf reads (the params of an ExecuteExtraTool / MCP call when they are wrapped). Rough on
 * purpose: the user sees and edits every field before anything is sent.
 */
export function scopeDefaults(item: Pick<InboxItem, 'toolName' | 'input'>): ScopeForm {
  const input = item.input ?? {};
  const p = callParams(input);
  const hosts = [...new Set([p.command, p.url, p.uri, input.command, input.url].flatMap((t) => (typeof t === 'string' ? hostsIn(t) : [])))];
  return {
    ...BLANK,
    domains: hosts.join(', '),
    channels: [...new Set(strs(p.channel, p.channel_id, p.channels, p.channel_ids))].join(', '),
    recipients: [...new Set(strs(p.to, p.recipient, p.recipients, p.cc, p.bcc))].join(', '),
  };
}

/** The fields the inbox form shows: the three lists, 每天最多, 有效期; 金额上限 too for a payment. */
export function scopeFields(cls: InboxItem['cls']): ScopeField[] {
  return cls === 'pay' ? ALL_SCOPE_FIELDS : ['domains', 'channels', 'recipients', 'perDay', 'until'];
}

const isoDay = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/**
 * A stored scope as the form shows it: none → every field blank (to be filled or ticked); `unlimited` → every field
 * ticked; else each set field filled and each unset one ticked 无限制 (what it means on the server).
 */
export function formOfScope(s: PolicyScope | undefined): { form: ScopeForm; unlimited: ScopeUnlimited } {
  if (!s) return { form: { ...BLANK }, unlimited: { ...NONE } };
  if (s.unlimited) return { form: { ...BLANK }, unlimited: { domains: true, channels: true, recipients: true, maxAmount: true, perDay: true, until: true } };
  const list = (v?: string[]) => (v ?? []).join(', ');
  const form: ScopeForm = {
    domains: list(s.domains), channels: list(s.channels), recipients: list(s.recipients),
    maxAmount: s.maxAmount !== undefined ? String(s.maxAmount) : '',
    perDay: s.perDay !== undefined ? String(s.perDay) : '',
    until: s.until !== undefined ? isoDay(s.until) : '',
  };
  const unlimited = { ...NONE };
  for (const f of ALL_SCOPE_FIELDS) unlimited[f] = !form[f];
  return { form, unlimited };
}

/** A scope the server takes for a 全自动 / scoped rule as it is: `{unlimited:true}` or one that names a destination. */
export const validScope = (s: PolicyScope | undefined): boolean => !!s && (s.unlimited === true || !!(s.domains?.length || s.channels?.length || s.recipients?.length));

const DAY_MS = 24 * 60 * 60 * 1000;

/** 有效期 as typed: whole days from now (≥ 1) or a date (YYYY-MM-DD, valid to the end of that day, not in the past). */
export function parseUntil(text: string, now: number): number | null {
  const t = text.trim();
  if (/^\d+$/.test(t)) { const n = Number(t); return n >= 1 ? now + n * DAY_MS : null; }
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (!m) return null;
  const end = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999);
  if (end.getMonth() !== Number(m[2]) - 1 || end.getTime() <= now) return null;
  return end.getTime();
}

export type ScopeResult = { scope: PolicyScope } | { problem: string };

/**
 * The scope the user confirmed, field by field — nothing blank ever means "no limit":
 * - every shown field is either filled in or has its 无限制 ticked (each tick was confirmed with its own risk);
 * - at least one list (域名 / 频道 / 收件人) is filled in — a scope of numbers alone would match every destination;
 * - only when every shown field is ticked 无限制 is the scope `{ unlimited: true }`;
 * - `amountRequired` (a payment): 金额上限 is filled in unless the whole scope is unlimited.
 * 每天最多 is a whole number ≥ 1, 金额上限 a number ≥ 0, 有效期 whole days ≥ 1 or a date.
 */
export function buildScope(form: ScopeForm, unlimited: ScopeUnlimited, fields: ScopeField[], now: number, opts: { amountRequired?: boolean } = {}): ScopeResult {
  if (fields.every((f) => unlimited[f])) return { scope: { unlimited: true } };
  if (opts.amountRequired && fields.includes('maxAmount') && unlimited.maxAmount) return { problem: tr('付款要写金额上限；要不限金额，就把每一项都勾上「无限制」') };
  const out: PolicyScope = {};
  for (const f of fields) {
    if (unlimited[f]) continue;
    const text = form[f].trim();
    const blank = { problem: tr('「{field}」要填，或者勾它的「无限制」', { field: fieldLabel(f) }) };
    if (!text) return blank;
    if (f === 'domains' || f === 'channels' || f === 'recipients') {
      const list = splitList(text);
      if (!list.length) return blank;
      out[f] = list;
    } else if (f === 'perDay') {
      const n = Number(text);
      if (!(Number.isInteger(n) && n >= 1)) return { problem: tr('每天最多要填不小于 1 的整数') };
      out.perDay = n;
    } else if (f === 'maxAmount') {
      const n = Number(text);
      if (!(Number.isFinite(n) && n >= 0)) return { problem: tr('金额上限要填不小于 0 的数') };
      out.maxAmount = n;
    } else {
      const until = parseUntil(text, now);
      if (until === null) return { problem: tr('有效期填天数（至少 1），或者一个以后的日期，如 2026-12-31') };
      out.until = until;
    }
  }
  if (!out.domains && !out.channels && !out.recipients) return { problem: tr('域名、频道、收件人至少填一项：只限次数或金额，等于对谁都直接做') };
  return { scope: out };
}

export function fieldLabel(f: ScopeField): string {
  switch (f) {
    case 'domains': return tr('域名');
    case 'channels': return tr('频道');
    case 'recipients': return tr('收件人');
    case 'maxAmount': return tr('金额上限');
    case 'perDay': return tr('每天最多');
    case 'until': return tr('有效期');
  }
}

/** What 无限制 on one field of a scoped rule (批并以后直接做) lets the bot do without asking (spec §10). */
export function ruleUnlimitedRisk(f: ScopeField): string {
  switch (f) {
    case 'domains': return tr('域名不限后，这类操作它以后对任何网站都直接做，不再问你。确定？');
    case 'channels': return tr('频道不限后，它以后可以往任何频道、群发消息，不再问你。确定？');
    case 'recipients': return tr('收件人不限后，它以后可以给任何人发消息、发邮件，不再问你。确定？');
    case 'maxAmount': return tr('金额不限后，它可以在你不在时无上限花钱。确定？');
    case 'perDay': return tr('次数不限后，它一天里可以不停地做下去，没有次数上限。确定？');
    case 'until': return tr('不设有效期后，这条范围会一直有效，直到你自己删掉它。确定？');
  }
}

/** The same for 全自动. */
export function autoPilotUnlimitedRisk(f: ScopeField): string {
  switch (f) {
    case 'domains': return tr('域名不限后，全自动时它可以访问并操作任何网站。确定？');
    case 'channels': return tr('频道不限后，全自动时它可以往任何频道、群发消息。确定？');
    case 'recipients': return tr('收件人不限后，全自动时它可以给任何人发消息、发邮件。确定？');
    case 'maxAmount': return tr('金额不限后，它可以在你不在时无上限花钱。确定？');
    case 'perDay': return tr('次数不限后，它一天里可以不停地做下去，没有次数上限。确定？');
    case 'until': return tr('不设到期后，全自动会一直开着，直到你自己关掉。确定？');
  }
}

/** The form: one row per field (a box and its 无限制), the problem if any, 保存 / 取消. */
export function ScopeEditor({ head, fields, initial, risk, amountRequired, okLabel, busy, onSend, onCancel, className }: {
  head: ReactNode; fields: ScopeField[]; initial: { form: ScopeForm; unlimited: ScopeUnlimited }; risk: (f: ScopeField) => string;
  amountRequired?: boolean; okLabel: string; busy: boolean; onSend: (s: PolicyScope) => void; onCancel: () => void; className?: string;
}) {
  const [form, setForm] = useState<ScopeForm>(initial.form);
  const [unlimited, setUnlimited] = useState<ScopeUnlimited>(initial.unlimited);
  const [problem, setProblem] = useState('');
  const tick = async (f: ScopeField, on: boolean) => {
    if (on && !(await confirmRisk(risk(f)))) return;
    setUnlimited((u) => ({ ...u, [f]: on }));
    setProblem('');
  };
  const submit = () => {
    const r = buildScope(form, unlimited, fields, Date.now(), { amountRequired });
    if ('problem' in r) { setProblem(r.problem); return; }
    onSend(r.scope);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (imeComposing(e.nativeEvent)) return;
    if (e.key === 'Enter') { e.preventDefault(); submit(); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
  };
  return (
    <div className={className ?? 'ib-scope bd-form'} onClick={(e) => e.stopPropagation()}>
      <div className="ib-scope-h">{head}</div>
      {fields.map((f) => (
        <div className="bd-row" key={f} data-field={f}>
          <span>{fieldLabel(f)}</span>
          <span className="bd-pair">
            <input
              className="field"
              aria-label={fieldLabel(f)}
              disabled={unlimited[f]}
              value={unlimited[f] ? '' : form[f]}
              placeholder={unlimited[f] ? tr('无限制') : f === 'until' ? tr('天数，或 2026-12-31') : f === 'perDay' ? tr('次数') : f === 'maxAmount' ? tr('金额') : tr('用逗号隔开')}
              inputMode={f === 'maxAmount' ? 'decimal' : f === 'perDay' ? 'numeric' : undefined}
              onChange={(e) => { const v = e.target.value; setForm((s) => ({ ...s, [f]: v })); setProblem(''); }}
              onKeyDown={onKey}
            />
            <SwitchChip on={unlimited[f]} onChange={(on) => void tick(f, on)}>{tr('无限制')}</SwitchChip>
          </span>
        </div>
      ))}
      {problem && <div className="ib-problem" role="alert">{problem}</div>}
      <div className="ib-acts">
        <button className="btn sm primary" disabled={busy} onClick={submit}>{okLabel}</button>
        <button className="btn sm" onClick={onCancel}>{tr('取消')}</button>
      </div>
    </div>
  );
}
