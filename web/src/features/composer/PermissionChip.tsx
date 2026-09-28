import { useRef, useState } from 'react';
import type { PermissionMode } from '@shared';
import { clsx } from '@/util';
import { Icon } from '@/ui/icons';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { PERMISSION_MODES, PERMISSION_MODE_ORDER } from '@/ui/terms';
import { useStore } from '@/store';
import { Popover } from './Popover';

/**
 * The permission chip (spec §5.4): what Claude may do without asking, told as consequences. All six modes stay;
 * 「完全放开」 in the danger colour. `compact` = icon only (narrow composer, phone).
 */
export function PermissionChip({ mode, onPick, compact, disabled }: { mode: PermissionMode; onPick: (m: PermissionMode) => void; compact?: boolean; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const chip = useRef<HTMLButtonElement>(null);
  const cur = PERMISSION_MODES[mode] ?? PERMISSION_MODES.default;
  const close = (refocus: boolean) => { setOpen(false); if (refocus) chip.current?.focus(); };
  return (
    <>
      <button ref={chip} type="button" className={clsx('cchip perm-chip', open && 'open', cur.danger && 'danger', compact && 'compact')} disabled={disabled} onClick={() => setOpen((o) => !o)}
        title={`权限：${cur.label} — ${cur.desc}`} aria-label={`权限：${cur.label}`} aria-haspopup="menu" aria-expanded={open}>
        <Icon name={cur.danger ? 'alert' : 'approval'} size={15} />
        <span className="cc-l opt">{cur.label}</span>
        <span className="caret opt"><Icon name="chevronDown" size={10} /></span>
      </button>
      {open && (
        <ErrorBoundary area="权限菜单" compact onReset={() => setOpen(false)}>
          <Popover anchor={chip} onClose={close} prefer="up" align="right" className="perm-menu" label="权限">
            {PERMISSION_MODE_ORDER.map((m) => {
              const t = PERMISSION_MODES[m];
              return (
                <button key={m} type="button" data-mi data-mode={m} role="menuitemradio" aria-checked={m === mode} className={clsx('cm-it', t.danger && 'danger', m === mode && 'on')}
                  onClick={() => { close(true); if (m !== mode) onPick(m); }}>
                  <span className="cm-ck">{m === mode ? <Icon name="check" size={13} /> : t.danger ? <Icon name="alert" size={13} /> : null}</span>
                  <span className="cm-tx">
                    <span className="cm-l">{t.label}{t.recommended && <span className="cm-rec">推荐</span>}</span>
                    <span className="cm-d">{t.desc}</span>
                  </span>
                </button>
              );
            })}
            <div className="menu-sep" />
            <button type="button" data-mi className="cm-it cm-foot" onClick={() => { close(false); useStore.getState().openSettings({ section: 'session', reveal: 'ui.defaultMode' }); }}>
              <span className="cm-ck"><Icon name="settings" size={13} /></span>
              <span className="cm-tx"><span className="cm-l">设为新对话的默认…</span></span>
            </button>
          </Popover>
        </ErrorBoundary>
      )}
    </>
  );
}
