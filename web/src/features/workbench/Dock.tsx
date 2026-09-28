import { useRef } from 'react';
import { useStore } from '@/store';
import { PANELS, PANEL_ICONS, PANEL_TITLES, type PanelId } from '@/model/layout';
import { clsx } from '@/util';
import { Icon } from '@/ui/icons';
import { TasksPanel } from '@/features/panels/TasksPanel';
import { FilesPanel } from '@/features/panels/FilesPanel';
import { UsagePanel } from '@/features/panels/UsagePanel';
import { ConfigPanel } from '@/features/panels/ConfigPanel';
import { TerminalPanel } from '@/features/panels/TerminalPanel';
import { InspectorPanel } from '@/features/panels/InspectorPanel';
import { MissionPanel } from '@/features/panels/MissionPanel';
import { GoalsPanel } from '@/features/goals/GoalsPanel';
import { AndroidPanel } from '@/features/android/AndroidPanel';
import { MemoryPanel } from '@/features/memory/MemoryPanel';
import { OrchestraPanel } from '@/features/orchestra/OrchestraPanel';
import { MIME_PANEL } from './dnd';
import { ErrorBoundary } from '@/ui/ErrorBoundary';

export { PANELS, PANEL_ICONS, PANEL_TITLES };
export const DOCK_DEFAULT_WIDTH = 440;

/** A panel with its own error boundary: one broken panel does not blank the dock (or the tile it sits in). */
export function PanelBody({ id, visible }: { id: PanelId; visible: boolean }) {
  return (
    <ErrorBoundary area={`停靠面板 · ${PANEL_TITLES[id] ?? id}`}>
      <PanelContent id={id} visible={visible} />
    </ErrorBoundary>
  );
}

function PanelContent({ id, visible }: { id: PanelId; visible: boolean }) {
  switch (id) {
    case 'tasks': return <TasksPanel />;
    case 'files': return <FilesPanel />;
    case 'usage': return <UsagePanel />;
    case 'config': return <ConfigPanel />;
    case 'terminal': return <TerminalPanel />;
    case 'inspector': return <InspectorPanel />;
    case 'mission': return <MissionPanel />;
    case 'goals': return <GoalsPanel />;
    case 'android': return <AndroidPanel visible={visible} />;
    case 'memory': return <MemoryPanel />;
    case 'orchestra': return <OrchestraPanel />;
  }
}

/**
 * Right-hand dock: one tab strip, one visible panel.
 *
 * There is exactly ONE render branch. Minimising collapses the column to an icon rail with CSS and
 * hides the panel bodies with `visibility` — it must never unmount them, or the terminal loses its
 * pty and xterm buffer and every form loses its state. Same discipline as `PaneLayer`. Hiding the whole dock
 * (Ctrl+J, the session header's right-panel button) is the same: `hidden`, not unmounted. Only closing a tab
 * (its ×, middle click) unmounts that one panel.
 */
export function Dock() {
  const dock = useStore((s) => s.layout.dock);
  const inspect = useStore((s) => s.inspect);
  const dispatch = useStore((s) => s.dispatchLayout);
  const drag = useRef<{ x0: number; w0: number; id: number } | null>(null);
  const tabs: PanelId[] = [...dock.tabs, ...(inspect && !dock.tabs.includes('inspector') ? (['inspector'] as PanelId[]) : [])];
  const active: PanelId | null = inspect && dock.active !== 'inspector' && !dock.tabs.includes('inspector') ? 'inspector' : dock.active && tabs.includes(dock.active) ? dock.active : tabs[0] ?? null;
  // hidden (Ctrl+J / the header's right-panel button) is CSS too: closing the panel must not end the terminal's pty
  if (!tabs.length) return null;
  const min = dock.minimized;
  const shown = dock.open;

  const close = (id: PanelId) => (id === 'inspector' ? useStore.setState({ inspect: null }) : dispatch({ t: 'dock.toggle', panel: id }));
  const onDown = (e: React.PointerEvent) => {
    if (min) return;
    e.preventDefault();
    drag.current = { x0: e.clientX, w0: dock.width, id: e.pointerId };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    dispatch({ t: 'dock.set', patch: { width: Math.max(300, Math.min(960, drag.current.w0 - (e.clientX - drag.current.x0))) } });
  };
  const onUp = (e: React.PointerEvent) => {
    if (drag.current) (e.currentTarget as HTMLElement).releasePointerCapture(drag.current.id);
    drag.current = null;
  };
  // clicking a tab while minimised restores the dock on that panel
  const pick = (id: PanelId) => dispatch({ t: 'dock.set', patch: min ? { minimized: false, active: id } : { active: id } });

  return (
    <div className={clsx('dock', min && 'min')} hidden={!shown}>
      {!min && <div className="resizer" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onDoubleClick={() => dispatch({ t: 'dock.set', patch: { width: DOCK_DEFAULT_WIDTH } })} title="拖动调整 · 双击复位" />}
      <div className="dock-tabs">
        {tabs.map((id) => (
          <div
            key={id}
            className={clsx('tab', active === id && 'active')}
            draggable={id !== 'inspector'}
            tabIndex={0}
            role="tab"
            aria-selected={active === id}
            onDragStart={(e) => { e.dataTransfer.setData(MIME_PANEL, id); e.dataTransfer.effectAllowed = 'copyMove'; }}
            onClick={() => pick(id)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(id); } }}
            onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); close(id); } }}
            title={min ? PANEL_TITLES[id] : `${PANEL_TITLES[id]} · 可拖到窗格里`}
          >
            <span className="ic"><Icon name={PANEL_ICONS[id]} size={15} /></span>
            <span className="t">{PANEL_TITLES[id]}</span>
            <button className="x" title="关闭" aria-label={`关闭${PANEL_TITLES[id]}`} onClick={(e) => { e.stopPropagation(); close(id); }}><Icon name="close" size={11} /></button>
          </div>
        ))}
        <span className="grow" />
        <button className="icon-btn" title={min ? '还原停靠面板 (Ctrl+Shift+J)' : '最小化 (Ctrl+Shift+J)'} onClick={() => dispatch({ t: 'dock.set', patch: { minimized: !min } })}>
          <Icon name={min ? 'restore' : 'minimize'} size={16} />
        </button>
        {!min && <button className="icon-btn" title="隐藏停靠面板 (Ctrl+J)" onClick={() => dispatch({ t: 'dock.set', patch: { open: false } })}><Icon name="close" size={15} /></button>}
      </div>
      <div className="dock-body">
        {tabs.map((id) => (
          <div key={id} className="dock-panel" hidden={active !== id}>
            <PanelBody id={id} visible={shown && !min && active === id} />
          </div>
        ))}
      </div>
    </div>
  );
}
