import { useEffect, useRef, useState } from 'react';
import { useScopedSession, useStore } from '@/store';
import { PANELS, PANEL_ICONS, PANEL_TITLES, dockView, workbenchOn, type PanelId } from '@/model/layout';
import { clsx } from '@/util';
import { Icon } from '@/ui/icons';
import { TERMS } from '@/ui/terms';
import { TasksPanel } from '@/features/panels/TasksPanel';
import { UsagePanel } from '@/features/panels/UsagePanel';
import { ConfigPanel } from '@/features/panels/ConfigPanel';
import { TerminalPanel } from '@/features/panels/TerminalPanel';
import { InspectorPanel } from '@/features/panels/InspectorPanel';
import { MissionPanel } from '@/features/panels/MissionPanel';
import { GoalsPanel } from '@/features/goals/GoalsPanel';
import { AndroidPanel } from '@/features/android/AndroidPanel';
import { MemoryPanel } from '@/features/memory/MemoryPanel';
import { OrchestraPanel } from '@/features/orchestra/OrchestraPanel';
import { BoardView } from '@/features/vcs/BoardView';
import { sessionPeer } from '@/features/peers';
import { MIME_PANEL } from './dnd';
import { ReviewView } from './ReviewView';
import { FilesView } from './FilesView';
import { MORE_PANELS } from './panel-entries';
import { useRightPanel } from './right-panel';
import { modKey } from './shortcuts';
import { ErrorBoundary } from '@/ui/ErrorBoundary';

export { PANELS, PANEL_ICONS, PANEL_TITLES };
export const DOCK_DEFAULT_WIDTH = 440;

/** A panel with its own error boundary: one broken panel does not blank the dock (or the tile it sits in). */
export function PanelBody({ id, visible }: { id: PanelId; visible: boolean }) {
  return (
    <ErrorBoundary area={`右侧面板 · ${PANEL_TITLES[id] ?? id}`}>
      <PanelContent id={id} visible={visible} />
    </ErrorBoundary>
  );
}

/** Issue 与 PR for the current conversation's repo (a temporary tab; the old 看板 workbench tab). */
function BoardPanel() {
  const active = useScopedSession();
  const sessions = useStore((s) => s.sessions);
  const peer = sessionPeer(active?.sessionId ?? null, sessions);
  if (!active) return <div className="empty">还没有打开对话。打开一个对话后，这里是它所在仓库的 Issue 与 PR。</div>;
  if (peer) return <div className="empty">这个对话在机器「{peer.name}」上，它的仓库在那台机器上。</div>;
  return <BoardView key={active.cwd} cwd={active.cwd} sid={active.sessionId} />;
}

function PanelContent({ id, visible }: { id: PanelId; visible: boolean }) {
  switch (id) {
    case 'tasks': return <TasksPanel />;
    case 'files': return <ReviewView visible={visible} />;
    case 'explorer': return <FilesView visible={visible} />;
    case 'usage': return <UsagePanel />;
    case 'config': return <ConfigPanel />;
    case 'terminal': return <TerminalPanel />;
    case 'inspector': return <InspectorPanel />;
    case 'mission': return <MissionPanel />;
    case 'goals': return <GoalsPanel />;
    case 'android': return <AndroidPanel visible={visible} />;
    case 'memory': return <MemoryPanel />;
    case 'orchestra': return <OrchestraPanel />;
    case 'board': return <BoardPanel />;
  }
}

/** The default right panel's 「更多」 menu: the extra-tier panels, opened as temporary tabs (spec §5.6). */
function MoreMenu({ mounted }: { mounted: PanelId[] }) {
  const dispatch = useStore((s) => s.dispatchLayout);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', off);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', off); document.removeEventListener('keydown', key); };
  }, [open]);
  return (
    <span ref={ref} className="dock-more">
      <button className={clsx('icon-btn', open && 'active')} title="更多面板：目标、编排、用量、Issue 与 PR…" aria-label="更多面板" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="plus" size={15} /></button>
      {open && (
        <div className="menu dock-more-menu" role="menu">
          <div className="menu-label">在右侧面板打开</div>
          {MORE_PANELS.map((p) => (
            <button key={p.id} role="menuitem" data-panel={p.id} onClick={() => { dispatch({ t: 'dock.show', panel: p.id }); setOpen(false); }}>
              <Icon name={p.icon} size={14} /><span className="grow">{p.title}</span>{mounted.includes(p.id) && <Icon name="check" size={13} />}
            </button>
          ))}
          <div className="menu-sep" />
          <div className="menu-note">总览、记忆、配置中心等在命令面板（{modKey}+K）里，或在设置里打开「{TERMS.workbench}」</div>
        </div>
      )}
    </span>
  );
}

/**
 * Right-hand dock (the 右侧面板): one tab row, one visible panel.
 *
 * Two looks over the same state (`dockView`): by default the four fixed tabs 审阅 · 文件 · 终端 · 任务 (text only, no
 * ×) plus any other open panel as a temporary tab with a ×, a 「更多」 menu and a close button (spec §5.6, the
 * mock's inspector); with 「显示工作台工具」 the pre-redesign dock — every panel an icon tab that can be closed,
 * dragged into a pane, and a minimise-to-rail button.
 *
 * There is exactly ONE render branch for the bodies. Minimising collapses the column to an icon rail with CSS and
 * hides the panel bodies — it must never unmount them, or the terminal loses its pty and xterm buffer and every form
 * loses its state. Same discipline as `PaneLayer`. Hiding the whole dock (Ctrl+J, the session header's right-panel
 * button) is the same: `hidden`, not unmounted; so is switching tabs, and flipping the workbench setting. Only
 * closing a tab (its ×, middle click) unmounts that one panel; a fixed tab is mounted the first time it is opened.
 */
export function Dock() {
  const dock = useStore((s) => s.layout.dock);
  const inspect = useStore((s) => s.inspect);
  const workbench = useStore((s) => workbenchOn(s.settings));
  const dispatch = useStore((s) => s.dispatchLayout);
  const reviewCount = useRightPanel((s) => s.reviewCount);
  const drag = useRef<{ x0: number; w0: number; id: number } | null>(null);
  const view = dockView(dock, { workbench, inspect: !!inspect });
  const { tabs, active, mounted } = view;
  // hidden (Ctrl+J / the header's right-panel button) is CSS too: closing the panel must not end the terminal's pty
  if (!mounted.length) return null;
  const min = dock.minimized;
  const shown = dock.open;

  // 详情 shown for an inspection is closed by dropping the inspection; a tab is closed by removing it (unmounting it)
  const close = (id: PanelId) => {
    if (id === 'inspector') useStore.setState({ inspect: null });
    if (dock.tabs.includes(id)) dispatch({ t: 'dock.close', panel: id });
  };
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
  // clicking a tab while minimised restores the dock on that panel; a fixed tab not opened yet is mounted by `dock.show`
  const pick = (id: PanelId) => {
    if (id === 'inspector' && inspect && !dock.tabs.includes('inspector')) return dispatch({ t: 'dock.set', patch: min ? { minimized: false, active: id } : { active: id } });
    if (!dock.tabs.includes(id)) return dispatch({ t: 'dock.show', panel: id });
    dispatch({ t: 'dock.set', patch: min ? { minimized: false, active: id } : { active: id } });
  };

  return (
    <div className={clsx('dock', min && 'min', !workbench && 'simple')} hidden={!shown}>
      {!min && <div className="resizer" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onDoubleClick={() => dispatch({ t: 'dock.set', patch: { width: DOCK_DEFAULT_WIDTH } })} title="拖动调整 · 双击复位" />}
      <div className="dock-tabs">
        {/* the tabs scroll sideways on their own: the 「更多」 menu below the row must not be clipped by a scroller */}
        <div className="dock-tablist" role="tablist" aria-label={TERMS.dock}>
          {tabs.map(({ id, fixed }) => (
            <div
              key={id}
              className={clsx('tab', active === id && 'active', fixed && 'fixed')}
              draggable={workbench && id !== 'inspector'}
              tabIndex={0}
              role="tab"
              aria-selected={active === id}
              data-panel={id}
              onDragStart={(e) => { e.dataTransfer.setData(MIME_PANEL, id); e.dataTransfer.effectAllowed = 'copyMove'; }}
              onClick={() => pick(id)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(id); } }}
              onAuxClick={(e) => { if (e.button === 1 && !fixed) { e.preventDefault(); close(id); } }}
              title={min || !workbench ? PANEL_TITLES[id] : `${PANEL_TITLES[id]} · 可拖到分屏里`}
            >
              <span className="ic"><Icon name={PANEL_ICONS[id]} size={15} /></span>
              <span className="t">{PANEL_TITLES[id]}</span>
              {!workbench && id === 'files' && reviewCount > 0 && <span className="n" aria-label={`${reviewCount} 个文件`}>{reviewCount}</span>}
              {!fixed && <button className="x" title="关闭" aria-label={`关闭${PANEL_TITLES[id]}`} onClick={(e) => { e.stopPropagation(); close(id); }}><Icon name="close" size={11} /></button>}
            </div>
          ))}
        </div>
        <span className="grow" />
        {!workbench && !min && <MoreMenu mounted={mounted} />}
        {(workbench || min) && (
          <button className="icon-btn" title={min ? `还原${TERMS.dock} (${modKey}+Shift+J)` : `最小化 (${modKey}+Shift+J)`} onClick={() => dispatch({ t: 'dock.set', patch: { minimized: !min } })}>
            <Icon name={min ? 'restore' : 'minimize'} size={16} />
          </button>
        )}
        {!min && <button className="icon-btn" title={`隐藏${TERMS.dock} (${modKey}+J)`} aria-label={`隐藏${TERMS.dock}`} onClick={() => dispatch({ t: 'dock.set', patch: { open: false } })}><Icon name="close" size={15} /></button>}
      </div>
      <div className="dock-body">
        {mounted.map((id) => (
          <div key={id} className="dock-panel" hidden={active !== id} data-panel={id}>
            <PanelBody id={id} visible={shown && !min && active === id} />
          </div>
        ))}
      </div>
    </div>
  );
}
