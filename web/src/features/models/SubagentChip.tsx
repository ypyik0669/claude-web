import { useEffect, useRef, useState } from 'react';
import { useStore } from '@/store';
import { clsx, shortModel } from '@/util';
import { Icon } from '@/ui/icons';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { ModelMenu } from './ModelMenu';
import { OWN_PROVIDER } from './menu';
import { SUBAGENT_DEFAULT, crossPick, crossValue, subagentModelFor } from '../../../../server/src/models/subagent';
import { subagentLabel } from './subagent-label';
export { subagentLabel } from './subagent-label';
import { tr } from '@/i18n';

/**
 * 子代理: the model a conversation's subagents (and workflows) run on, next to the model chip — the main task on the
 * main model, the subagents on a cheaper one (user request 2026-10-14: a friend's subagents spent the budget on the
 * main model). A model of the conversation's own provider / account; a pick is a whole (provider, model), '' = the
 * same as the main model. The bottom of the menu makes the pick the default for new
 * conversations (`subagentModel` in meta.json).
 */
export function SubagentChip(p: {
  providerId: string;
  value: string;
  onPick: (model: string) => void;
  builtin?: { value: string; displayName: string; description?: string }[];
  builtinTitle?: string;
  disabled?: boolean;
  /** bumped by the model menu's 「子代理用的模型」 row: open this menu */
  openSignal?: number;
}) {
  const [open, setOpen] = useState(false);
  // only a bump while mounted opens it: a chip mounted again (resumed from the phone, handed back) keeps it closed
  const seenSignal = useRef(p.openSignal);
  useEffect(() => {
    if (p.openSignal === seenSignal.current) return;
    seenSignal.current = p.openSignal;
    if (p.openSignal) setOpen(true);
  }, [p.openSignal]);
  const anchor = useRef<HTMLSpanElement>(null);
  const providers = useStore((s) => s.providers);
  const settings = useStore((s) => s.settings);
  const setSetting = useStore((s) => s.setSetting);
  const label = subagentLabel({ providers, providerId: p.providerId, model: p.value, builtin: p.builtin });
  const def = subagentModelFor({ settings, providerId: p.providerId });
  const cross = crossPick(p.value);
  const title = tr("子代理用的模型：{label}{v}\n主任务用主模型，子代理（Task / 工作流）用这里选的，可以选个便宜的省额度", { label: p.value ? label : tr('跟主模型一样'), v: def === p.value && p.value ? tr('（新对话默认）') : '' });
  return (
    <span ref={anchor} className={clsx('mm-anchor sub-anchor', !p.value && 'same')}>
      <button type="button" className={clsx('chip', open && 'active', p.value && 'on')} title={title} disabled={p.disabled} aria-label={tr('子代理：{label}', { label })} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="agent" size={13} />
        {/* nothing picked: just 「子代理」 (the row is full already); a pick: its name, 「子代理 · 」 when there is room */}
        <span className="mm-chip-label">{p.value ? <><span className="opt">{tr('子代理 ·')} </span>{label === p.value ? shortModel(label) : label}</> : tr('子代理')}</span>
        <span className="caret"><Icon name="chevronDown" size={10} /></span>
      </button>
      {open && (
        <ErrorBoundary area={tr('子代理菜单')} compact onReset={() => setOpen(false)}>
          <ModelMenu
            agent="claude"
            current={cross ? { providerId: cross.providerId, model: cross.model } : { providerId: p.providerId, model: p.value || null }}
            builtin={p.builtin}
            builtinTitle={p.builtinTitle}
            lockProvider={p.providerId}
            lockNote={tr('子代理（Task、工作流）用哪个模型：主任务还是用主模型')}
            anchor={anchor}
            onClose={() => setOpen(false)}
            onPick={(it) => p.onPick(crossValue(it.providerId || OWN_PROVIDER, it.model))}
            subagent={{
              same: !p.value,
              onSame: () => p.onPick(''),
              isDefault: def === p.value,
              onToggleDefault: () => void setSetting(SUBAGENT_DEFAULT, def === p.value ? '' : p.value),
            }}
          />
        </ErrorBoundary>
      )}
    </span>
  );
}
