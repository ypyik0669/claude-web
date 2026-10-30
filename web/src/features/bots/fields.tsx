// 值班 Bot: the detail's small editing pieces — a field that saves when it loses the focus, a number field, and the
// one-time risk sentences (spec §10) shown before a gate is turned off.
import { useEffect, useState, type KeyboardEvent } from 'react';
import type { ActionClass, BotPolicy, BotStatus } from '@shared';
import { dlg } from '@/ui/dialog';
import { imeComposing } from '@/ui/ime';
import { clsx } from '@/util';
import { tr } from '@/i18n';
import { unleashBot, useBots } from './state';

/** The bot as the store has it now — what an edit is built from at the moment it is sent (never a render's copy). */
export const currentBot = (id: string): BotStatus | undefined => useBots.getState().bots.find((b) => b.id === id);

/** A policy to send with bots.update: everything but `unleashed` (that goes through bots.unleash only). */
export function policyPatch(p: BotPolicy): BotPolicy {
  const { unleashed: _skip, ...rest } = p;
  return rest;
}

/**
 * A text box that saves on blur (only when the text changed). Enter (single line) commits by blurring; Escape puts
 * the saved text back. `value` from the server replaces what is shown whenever it changes.
 */
export function BlurField({ value, onSave, multiline, placeholder, label, className, type }: {
  value: string; /** false: the text is not valid — the saved one comes back */ onSave: (v: string) => void | boolean; multiline?: boolean; placeholder?: string; label: string; className?: string; type?: 'text' | 'time' | 'date';
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  const commit = () => { if (draft !== value && onSave(draft) === false) setDraft(value); };
  const onKey = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (imeComposing(e.nativeEvent)) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setDraft(value); setTimeout(() => (e.target as HTMLElement).blur(), 0); }
    else if (e.key === 'Enter' && !multiline) { e.preventDefault(); (e.target as HTMLElement).blur(); }
  };
  if (multiline) return <textarea className={clsx('field', className)} rows={2} value={draft} placeholder={placeholder} aria-label={label} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={onKey} />;
  return <input className={clsx('field', className)} type={type ?? 'text'} value={draft} placeholder={placeholder} aria-label={label} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={onKey} />;
}

/** A non-negative number box that saves on blur; empty = undefined (no limit). */
export function NumField({ value, onSave, label, placeholder, className }: { value: number | undefined; onSave: (v: number | undefined) => void; label: string; placeholder?: string; className?: string }) {
  return (
    <BlurField
      className={clsx('num', className)}
      label={label}
      placeholder={placeholder}
      value={value === undefined ? '' : String(value)}
      onSave={(s) => {
        const t = s.trim();
        if (!t) { onSave(undefined); return; }
        const n = Number(t);
        if (!(Number.isFinite(n) && n >= 0)) return false;
        onSave(n);
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

/** A class set to 直接做 that can't be taken back (send / pay / delete): the sentence for it, else null. */
export function doRisk(cls: ActionClass): string | null {
  switch (cls) {
    case 'send': return tr('设成「直接做」后，它可以不问你就用你的名义发消息、发邮件、推代码，发出去就收不回。确定？');
    case 'pay': return tr('设成「直接做」后，它可以在你不在时花钱、下单、转账，没有金额上限。确定？');
    case 'delete': return tr('设成「直接做」后，它可以不问你就删掉文件、分支、邮件这类找不回来的东西。确定？');
    default: return null;
  }
}

export const confirmRisk = (sentence: string) => risky(sentence);
