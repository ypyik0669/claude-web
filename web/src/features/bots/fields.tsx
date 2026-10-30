// 值班 Bot: the detail's small editing pieces — a field that saves when it loses the focus, a number field, and the
// one-time risk sentences (spec §10) shown before a gate is turned off.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ActionClass, BotPolicy, BotStatus, PolicyLevel } from '@shared';
import { dlg } from '@/ui/dialog';
import { imeComposing } from '@/ui/ime';
import { clsx } from '@/util';
import { tr } from '@/i18n';
import { unleashBot, useBots } from './state';
import { levelLabel } from './model';

/** The bot as the store has it now — what an edit is built from at the moment it is sent (never a render's copy). */
export const currentBot = (id: string): BotStatus | undefined => useBots.getState().bots.find((b) => b.id === id);

/** A policy to send with bots.update: everything but `unleashed` (that goes through bots.unleash only). */
export function policyPatch(p: BotPolicy): BotPolicy {
  const { unleashed: _skip, ...rest } = p;
  return rest;
}

/** What a field's save answers: false (now, or once the server refused it) puts the stored text back. */
export type SaveResult = void | boolean | Promise<void | boolean>;

/**
 * A text box that saves on blur (only when the text changed). Enter (single line) commits by blurring; Escape puts
 * the saved text back. `value` from the server replaces what is shown whenever it changes; a save that is refused —
 * at once (not valid) or by the server (updateBot resolving false) — shows the stored text again.
 */
export function BlurField({ value, onSave, multiline, placeholder, label, className, type }: {
  value: string; onSave: (v: string) => SaveResult; multiline?: boolean; placeholder?: string; label: string; className?: string; type?: 'text' | 'time' | 'date';
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  // the stored value of the latest render: a refusal that arrives later puts back what is stored then
  const stored = useRef(value);
  stored.current = value;
  const commit = () => {
    if (draft === value) return;
    void Promise.resolve(onSave(draft)).then((ok) => { if (ok === false) setDraft(stored.current); }, () => setDraft(stored.current));
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (imeComposing(e.nativeEvent)) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setDraft(value); setTimeout(() => (e.target as HTMLElement).blur(), 0); }
    else if (e.key === 'Enter' && !multiline) { e.preventDefault(); (e.target as HTMLElement).blur(); }
  };
  if (multiline) return <textarea className={clsx('field', className)} rows={2} value={draft} placeholder={placeholder} aria-label={label} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={onKey} />;
  return <input className={clsx('field', className)} type={type ?? 'text'} value={draft} placeholder={placeholder} aria-label={label} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={onKey} />;
}

/** A non-negative number box that saves on blur; empty = undefined (no limit). */
export function NumField({ value, onSave, label, placeholder, className }: { value: number | undefined; onSave: (v: number | undefined) => SaveResult; label: string; placeholder?: string; className?: string }) {
  return (
    <BlurField
      className={clsx('num', className)}
      label={label}
      placeholder={placeholder}
      value={value === undefined ? '' : String(value)}
      onSave={(s) => {
        const t = s.trim();
        if (!t) return onSave(undefined);
        const n = Number(t);
        if (!(Number.isFinite(n) && n >= 0)) return false;
        return onSave(n);
      }}
    />
  );
}

/** 'a, b\nc' → ['a', 'b', 'c'] */
export const splitList = (s: string): string[] => s.split(/[,，\n]/).map((x) => x.trim()).filter(Boolean);

const risky = (title: string) => dlg.confirm(title, { danger: true, focusCancel: true, okLabel: tr('我知道，打开') });

/** 放开全部: turning it on asks once with the concrete risk; turning it off never asks. */
export async function toggleUnleash(bot: BotStatus, on: boolean): Promise<void> {
  if (on && !(await risky(tr('放开全部后，发送、付款、删除都不再问你，只有停止和审计还在。确定？')))) return;
  await unleashBot(bot.id, on);
}

/**
 * A class that can't be taken back (send / pay / delete) set to 直接做 or 做了告诉我 — both run it without asking:
 * the sentence for it, else null.
 */
export function doRisk(cls: ActionClass, level: PolicyLevel = 'do'): string | null {
  if (level !== 'do' && level !== 'do_tell') return null;
  const o = { level: levelLabel(level) };
  switch (cls) {
    case 'send': return tr('设成「{level}」后，它可以不问你就用你的名义发消息、发邮件、推代码，发出去就收不回。确定？', o);
    case 'pay': return tr('设成「{level}」后，它可以在你不在时花钱、下单、转账，没有金额上限。确定？', o);
    case 'delete': return tr('设成「{level}」后，它可以不问你就删掉文件、分支、邮件这类找不回来的东西。确定？', o);
    default: return null;
  }
}

export const confirmRisk = (sentence: string) => risky(sentence);
