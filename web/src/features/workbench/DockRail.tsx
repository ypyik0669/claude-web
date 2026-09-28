import { useEffect, useRef, useState } from 'react';
import { useStore } from '@/store';
import { clsx } from '@/util';
import { PANELS } from '@/model/layout';
import { Icon } from '@/ui/icons';
import { modKey } from './shortcuts';

/** Every panel behind one button (the rail-marked few also get a direct button). */
function PanelMenu() {
  const dock = useStore((s) => s.layout.dock);
  const togglePanel = useStore((s) => s.togglePanel);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', off);
    return () => document.removeEventListener('mousedown', off);
  }, [open]);
  const on = (id: string) => dock.open && dock.tabs.includes(id as never);
  return (
    <span ref={ref} style={{ position: 'relative' }}>
      <button className={clsx('icon-btn', open && 'active')} title="全部面板" aria-label="全部面板" onClick={() => setOpen(!open)}><Icon name="board" size={16} /></button>
      {open && (
        <div className="menu" style={{ top: 32, right: 0 }}>
          {PANELS.map((p) => (
            <button key={p.id} onClick={() => { togglePanel(p.id); setOpen(false); }}>
              <Icon name={p.icon} size={14} />
              <span style={{ flex: 1 }}>{p.title}</span>
              {on(p.id) && <Icon name="check" size={13} />}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/**
 * The panel icon rail of the workbench (「显示工作台工具」 only — spec §5.10 `dockRail`): one button per rail panel,
 * the full panel menu, the right-panel toggle and the command palette. It sits at the right end of the group bar.
 */
export function DockRail() {
  const dock = useStore((s) => s.layout.dock);
  const dispatch = useStore((s) => s.dispatchLayout);
  const togglePanel = useStore((s) => s.togglePanel);
  return (
    <span className="dock-rail">
      {PANELS.filter((p) => p.rail).map((p) => (
        <button key={p.id} className={clsx('icon-btn', dock.open && dock.tabs.includes(p.id) && 'active')} onClick={() => togglePanel(p.id)} title={p.title} aria-label={p.title}>
          <Icon name={p.icon} size={16} />
        </button>
      ))}
      <PanelMenu />
      <span className="rail-sep" />
      <button className={clsx('icon-btn', dock.open && 'active')} title={`右侧面板 (${modKey}+J)`} aria-label="右侧面板" onClick={() => dispatch({ t: 'dock.set', patch: { open: !dock.open, minimized: false } })}><Icon name="inspector" size={16} /></button>
      <button className="icon-btn" title={`命令面板 (${modKey}+K)`} aria-label="命令面板" onClick={() => useStore.setState({ paletteOpen: true })}><Icon name="command" size={16} /></button>
    </span>
  );
}
