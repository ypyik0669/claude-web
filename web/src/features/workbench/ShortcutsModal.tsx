import { useLayoutEffect, useRef } from 'react';
import { useStore } from '@/store';
import { SHORTCUTS, keyLabel } from './shortcuts';

/**
 * The shortcut sheet (`?` / F1). It can open over the settings page (final review M1): `.shortcuts-bg` is one of the
 * layers above that page (`settings/cover.ts` `ABOVE_COVER`, and above it in z), it takes the focus while open and
 * an Esc closes only the sheet — the page (or whatever had the focus) gets it back.
 */
export function ShortcutsModal() {
  const open = useStore((s) => s.shortcutsOpen);
  if (!open) return null;
  return <Sheet />;
}

function Sheet() {
  const box = useRef<HTMLDivElement>(null);
  const close = () => useStore.setState({ shortcutsOpen: false });
  useLayoutEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    box.current?.focus({ preventScroll: true });
    return () => { if (back && back !== document.body && back.isConnected && typeof back.focus === 'function') back.focus({ preventScroll: true }); };
  }, []);
  const groups = [...new Set(SHORTCUTS.map((s) => s.group))];
  return (
    <div className="modal-bg shortcuts-bg" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={box}
        className="modal wide"
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="键盘快捷键"
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}
      >
        <h3>键盘快捷键</h3>
        <div className="shortcut-groups">
          {groups.map((g) => (
            <div key={g} className="sc-group">
              <h5>{g}</h5>
              {SHORTCUTS.filter((s) => s.group === g).map((s) => (
                <div key={s.id}><span>{s.label}</span><span className="kbd">{keyLabel(s)}</span></div>
              ))}
            </div>
          ))}
        </div>
        <div className="actions"><button className="btn" onClick={close}>关闭</button></div>
      </div>
    </div>
  );
}
