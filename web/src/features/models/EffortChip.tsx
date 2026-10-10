import { useRef, useState } from 'react';
import type { EffortLevel } from '@shared';
import { clsx } from '@/util';
import { Icon } from '@/ui/icons';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { EFFORT_DESC, EFFORT_LABEL, TERMS, ULTRACODE, effortTitle } from '@/ui/terms';
import { Popover } from '@/features/composer/Popover';
import { EFFORT_MENU_ID } from '@/features/composer/ids';
import { EFFORT_PROMPT_TITLE } from './intelligence';

export interface EffortChipProps {
  /** the levels the current model takes; none → no ladder (Gemini) */
  intelligence?: { levels: EffortLevel[]; value?: EffortLevel | null; defaultLevel?: EffortLevel; mode?: 'native' | 'prompt'; onChange: (l: EffortLevel) => void; disabled?: boolean };
  /** 深度编排 — only where the agent has it */
  ultracode?: { on: boolean; onChange: (on: boolean) => void; disabled?: boolean };
  compact?: boolean;
  disabled?: boolean;
}

/**
 * 「想多深」 next to the model chip (structure round 2, spec 2026-10-10-ui-structure §3): its own button and menu,
 * one row per level — its name and what it costs — and 深度编排 as the last row, the deepest setting, where it used
 * to be a switch squeezed into the top of the model list. Picking a level leaves 深度编排 (the caller's rule; the
 * menu only shows it: with 深度编排 on no level is the chosen one).
 *
 * Nothing to choose (no levels, no 深度编排) → no chip.
 */
export function EffortChip({ intelligence, ultracode, compact, disabled }: EffortChipProps) {
  const [open, setOpen] = useState(false);
  const chip = useRef<HTMLButtonElement>(null);
  const levels = intelligence?.levels ?? [];
  if (!levels.length && !ultracode) return null;
  const ultra = !!ultracode?.on;
  const cur = intelligence?.value ?? intelligence?.defaultLevel;
  const label = ultra ? ULTRACODE.label : cur ? EFFORT_LABEL[cur] : TERMS.effort;
  const close = (refocus: boolean) => { setOpen(false); if (refocus) chip.current?.focus(); };
  const pick = (l: EffortLevel) => { close(true); if (ultra || intelligence?.value !== l) intelligence?.onChange(l); };
  return (
    <>
      <button ref={chip} type="button" className={clsx('cchip depth-chip', open && 'open', ultra && 'ultra', compact && 'compact')} disabled={disabled} onClick={() => setOpen((o) => !o)}
        title={ultra ? ULTRACODE.title : `${TERMS.effort}：${label}${cur ? ` — ${EFFORT_DESC[cur]}` : ''}`} aria-label={`${TERMS.effort}：${label}`} aria-haspopup="menu" aria-expanded={open}>
        <Icon name={ultra ? 'bolt' : 'gauge'} size={15} />
        <span className="cc-l opt">{label}</span>
        <span className="caret opt"><Icon name="chevronDown" size={10} /></span>
      </button>
      {open && (
        <ErrorBoundary area="智能程度菜单" compact onReset={() => setOpen(false)}>
          <Popover anchor={chip} onClose={close} prefer="up" align="right" className="depth-menu" label={TERMS.effort}>
            {levels.length > 0 && (
              <div role="group" aria-label={TERMS.effort} data-id={EFFORT_MENU_ID.effort}>
                <div className="menu-label" title={`${TERMS.effort}（effort）：想得越久越稳，也越慢、越费额度`}>{TERMS.effort}</div>
                {levels.map((l) => {
                  const on = !ultra && l === cur;
                  return (
                    <button key={l} type="button" data-mi data-level={l} role="menuitemradio" aria-checked={on} className={clsx('cm-it', on && 'on')} title={effortTitle(l)} disabled={intelligence?.disabled} onClick={() => pick(l)}>
                      <span className="cm-ck">{on && <Icon name="check" size={13} />}</span>
                      <span className="cm-tx">
                        <span className="cm-l">{EFFORT_LABEL[l]}{l === intelligence?.defaultLevel && <span className="cm-rec">默认</span>}</span>
                        <span className="cm-d">{EFFORT_DESC[l]}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
            {ultracode && (
              <>
                {levels.length > 0 && <div className="menu-sep" />}
                <button type="button" data-mi data-id={EFFORT_MENU_ID.ultracode} role="menuitemcheckbox" aria-checked={ultra} className={clsx('cm-it ultra', ultra && 'on')} title={ULTRACODE.title} disabled={ultracode.disabled} onClick={() => { close(true); ultracode.onChange(!ultra); }}>
                  <span className="cm-ck">{ultra ? <Icon name="check" size={13} /> : <Icon name="bolt" size={13} />}</span>
                  <span className="cm-tx">
                    <span className="cm-l">{ULTRACODE.label}</span>
                    <span className="cm-d">{ULTRACODE.desc}</span>
                  </span>
                </button>
              </>
            )}
            {/* a model without the parameter: the level goes out as a reminder in the prompt — said once, here */}
            {intelligence?.mode === 'prompt' && levels.length > 0 && <div className="menu-note depth-note">{EFFORT_PROMPT_TITLE}</div>}
          </Popover>
        </ErrorBoundary>
      )}
    </>
  );
}
