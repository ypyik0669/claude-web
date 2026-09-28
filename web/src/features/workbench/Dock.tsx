import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useScopedSession, useStore } from '@/store';
import { PANELS, PANEL_ICONS, PANEL_TITLES, defaultDockPanel, dockView, workbenchOn, type DockTab, type PanelId } from '@/model/layout';
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
import { Popover } from './Popover';
import { useRightPanel } from './right-panel';
import { modKey } from './shortcuts';
import { ErrorBoundary } from '@/ui/ErrorBoundary';

export { PANELS, PANEL_ICONS, PANEL_TITLES };
export const DOCK_DEFAULT_WIDTH = 440;

/**
 * Where a panel body lives: the right panel, or a pane (a panel tile, workbench mode). Only the right panel's
 * 审阅 / 文件 take the open requests (`right-panel.ts`) and show the review's count on the tab — a second copy in a
 * pane must not swallow a request meant for the right panel, nor zero the count when it closes.
 */
export type PanelHost = 'dock' | 'tile';

/** A panel with its own error boundary: one broken panel does not blank the dock (or the tile it sits in). */
export function PanelBody({ id, visible, host = 'dock' }: { id: PanelId; visible: boolean; host?: PanelHost }) {
  return (
    <ErrorBoundary area={`右侧面板 · ${PANEL_TITLES[id] ?? id}`}>
      <PanelContent id={id} visible={visible} host={host} />
    </ErrorBoundary>
  );
}

/**
 * Issue 与 PR for the current conversation's repo (a temporary tab; the old 看板 workbench tab). While hidden it
 * keeps the repo it showed: switching conversations must not remount the board (a `vcs.repo` request, maybe `gh`)
 * for every repo passed through.
 */
function BoardPanel({ visible }: { visible: boolean }) {
  const active = useScopedSession();
  const sessions = useStore((s) => s.sessions);
  const [shown, setShown] = useState(active ? { cwd: active.cwd, sid: active.sessionId } : null);
  useEffect(() => {
    if (visible && active && (active.cwd !== shown?.cwd || active.sessionId !== shown?.sid)) setShown({ cwd: active.cwd, sid: active.sessionId });
  }, [visible, active?.cwd, active?.sessionId]);
  const peer = sessionPeer(shown?.sid ?? null, sessions);
  if (!shown) return <div className="empty">还没有打开对话。打开一个对话后，这里是它所在仓库的 Issue 与 PR。</div>;
  if (peer) return <div className="empty">这个对话在机器「{peer.name}」上，它的仓库在那台机器上。</div>;
  return <BoardView key={shown.cwd} cwd={shown.cwd} sid={shown.sid} />;
}

function PanelContent({ id, visible, host }: { id: PanelId; visible: boolean; host: PanelHost }) {
  switch (id) {
    case 'tasks': return <TasksPanel />;
    case 'files': return <ReviewView visible={visible} inDock={host === 'dock'} />;
    case 'explorer': return <FilesView visible={visible} inDock={host === 'dock'} />;
    case 'usage': return <UsagePanel />;
    case 'config': return <ConfigPanel />;
    case 'terminal': return <TerminalPanel />;
    case 'inspector': return <InspectorPanel />;
    case 'mission': return <MissionPanel />;
    case 'goals': return <GoalsPanel />;
    case 'android': return <AndroidPanel visible={visible} />;
    case 'memory': return <MemoryPanel />;
    case 'orchestra': return <OrchestraPanel />;
    case 'board': return <BoardPanel visible={visible} />;
  }
}

/** The default right panel's 「更多」 menu: the extra-tier panels, opened as temporary tabs (spec §5.6). */
function MoreMenu({ mounted }: { mounted: PanelId[] }) {
  const dispatch = useStore((s) => s.dispatchLayout);
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={btn} className={clsx('icon-btn dock-more', open && 'active')} title="更多面板：目标、编排、用量、Issue 与 PR…" aria-label="更多面板" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="plus" size={15} /></button>
      <Popover anchor={btn} open={open} onClose={() => setOpen(false)} width={240} align="right" className="dock-more-menu" label="更多面板">
        <div className="menu-label">在右侧面板打开</div>
        {MORE_PANELS.map((p) => (
          <button key={p.id} role="menuitem" data-panel={p.id} onClick={() => { dispatch({ t: 'dock.show', panel: p.id }); setOpen(false); }}>
            <Icon name={p.icon} size={14} /><span className="grow">{p.title}</span>{mounted.includes(p.id) && <Icon name="check" size={13} />}
          </button>
        ))}
        <div className="menu-sep" />
        <div className="menu-note">总览、记忆、配置中心等在命令面板（{modKey}+K）里，或在设置里打开「{TERMS.workbench}」</div>
      </Popover>
    </>
  );
}

/** The caption buttons of the desktop app on Windows / Linux: styles.css gives the right panel's tab row this much
 *  room on its right (`html.desktop:not(.mac) … .dock-tabs { padding-right: 150px }`). */
const CAPTION_W = 150;
/** What a row of temporary tabs gets at least before the tab row moves below the caption buttons. */
const MIN_TEMPS = 72;

/**
 * Right-hand dock (the 右侧面板): one tab row, one visible panel.
 *
 * Two looks over the same state (`dockView`): by default the four fixed tabs 审阅 · 文件 · 终端 · 任务 (text only, no
 * ×) plus any other open panel as a temporary tab with a ×, a 「更多」 menu and a close button (spec §5.6, the
 * mock's inspector); with 「显示工作台工具」 the pre-redesign dock — every panel an icon tab that can be closed,
 * dragged into a pane, and a minimise-to-rail button.
 *
 * The fixed tabs never scroll: only the temporary tabs do, in their own strip with fading edges and arrows. On the
 * desktop app (Windows / Linux) the row shares the top 40px with the window's caption buttons; when the fixed tabs
 * and the buttons do not fit beside them the row moves below them (`stacked`).
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
  const row = useRef<HTMLDivElement>(null);
  const fixedRef = useRef<HTMLDivElement>(null);
  const ctlRef = useRef<HTMLSpanElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [stacked, setStacked] = useState(false);
  const [fade, setFade] = useState({ l: false, r: false });
  const view = dockView(dock, { workbench, inspect: !!inspect });
  const { tabs, active, mounted } = view;
  const fixed = tabs.filter((t) => t.fixed);
  const temps = tabs.filter((t) => !t.fixed);
  const min = dock.minimized;
  const shown = dock.open;

  // the temporary strip's edges fade (and get an arrow) while there is more to scroll to on that side
  const updateFade = () => {
    const l = list.current;
    const next = l && !min ? { l: l.scrollLeft > 1, r: l.scrollLeft + l.clientWidth < l.scrollWidth - 1 } : { l: false, r: false };
    setFade((cur) => (cur.l === next.l && cur.r === next.r ? cur : next));
  };
  // keep the temporary tab in front in view (only the strip scrolls, never the page)
  useEffect(() => {
    const l = list.current;
    const t = l?.querySelector<HTMLElement>('.tab.active');
    if (l && t) {
      if (t.offsetLeft < l.scrollLeft) l.scrollLeft = t.offsetLeft;
      else if (t.offsetLeft + t.offsetWidth > l.scrollLeft + l.clientWidth) l.scrollLeft = t.offsetLeft + t.offsetWidth - l.clientWidth;
    }
    updateFade();
  }, [active, temps.length, dock.open, dock.minimized, workbench, stacked]);

  // the desktop app's caption buttons: does the row fit beside them? (only the fixed tabs' and the buttons' natural
  // widths and the row's width count — none of which change when the row moves down, so it never flips back and forth)
  useLayoutEffect(() => {
    const r = row.current;
    if (!r) return;
    let raf = 0;
    const measure = () => {
      const root = document.documentElement;
      const caption = root.classList.contains('desktop') && !root.classList.contains('mac');
      let next = false;
      if (caption && !workbench && shown && !min) {
        const pl = parseFloat(getComputedStyle(r).paddingLeft) || 0;
        const need = (fixedRef.current?.scrollWidth ?? 0) + (temps.length ? MIN_TEMPS : 0) + (ctlRef.current?.offsetWidth ?? 0) + 16;
        next = need > r.clientWidth - pl - CAPTION_W;
      }
      setStacked(next);
      updateFade();
    };
    measure();
    const ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(measure); });
    ro.observe(r);
    if (fixedRef.current) ro.observe(fixedRef.current);
    if (list.current) ro.observe(list.current);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [workbench, shown, min, temps.length, !!mounted.length]);

  // hidden (Ctrl+J / the header's right-panel button) is CSS too: closing the panel must not end the terminal's pty
  if (!mounted.length) return null;

  // 详情 shown for an inspection is closed by dropping the inspection; a tab is closed by removing it (unmounting it).
  // The default panel always keeps a fixed tab in front: closing the last temporary tab lands on one.
  const close = (id: PanelId) => {
    if (id === 'inspector' && inspect && !dock.tabs.includes('inspector')) {
      useStore.setState({ inspect: null });
      if (!workbench && !dock.tabs.length) dispatch({ t: 'dock.show', panel: defaultDockPanel(false) });
      return;
    }
    if (id === 'inspector') useStore.setState({ inspect: null });
    if (dock.tabs.includes(id)) dispatch({ t: 'dock.close', panel: id, workbench });
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
  const scrollTemps = (dir: 1 | -1) => list.current?.scrollBy({ left: dir * Math.max(80, (list.current.clientWidth * 2) / 3), behavior: 'smooth' });
  // a mouse wheel over the strip scrolls it sideways
  const onWheel = (e: React.WheelEvent) => {
    const l = list.current;
    if (!l || min || Math.abs(e.deltaX) > Math.abs(e.deltaY) || l.scrollWidth <= l.clientWidth) return;
    l.scrollLeft += e.deltaY;
  };

  const tab = ({ id, fixed: isFixed }: DockTab) => (
    <div
      key={id}
      className={clsx('tab', active === id && 'active', isFixed && 'fixed')}
      draggable={workbench && id !== 'inspector'}
      tabIndex={0}
      role="tab"
      aria-selected={active === id}
      data-panel={id}
      onDragStart={(e) => { e.dataTransfer.setData(MIME_PANEL, id); e.dataTransfer.effectAllowed = 'copyMove'; }}
      onClick={() => pick(id)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(id); } }}
      onAuxClick={(e) => { if (e.button === 1 && !isFixed) { e.preventDefault(); close(id); } }}
      title={min || !workbench ? PANEL_TITLES[id] : `${PANEL_TITLES[id]} · 可拖到分屏里`}
    >
      <span className="ic"><Icon name={PANEL_ICONS[id]} size={15} /></span>
      <span className="t">{PANEL_TITLES[id]}</span>
      {!workbench && id === 'files' && reviewCount > 0 && <span className="n" aria-label={`${reviewCount} 个文件`}>{reviewCount}</span>}
      {!isFixed && <button className="x" title="关闭" aria-label={`关闭${PANEL_TITLES[id]}`} onClick={(e) => { e.stopPropagation(); close(id); }}><Icon name="close" size={11} /></button>}
    </div>
  );

  return (
    <div className={clsx('dock', min && 'min', !workbench && 'simple')} hidden={!shown}>
      {!min && <div className="resizer" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onDoubleClick={() => dispatch({ t: 'dock.set', patch: { width: DOCK_DEFAULT_WIDTH } })} title="拖动调整 · 双击复位" />}
      <div className={clsx('dock-tabs', stacked && 'stacked')} ref={row}>
        <div className="dock-tabgroups" role="tablist" aria-label={TERMS.dock}>
          {fixed.length > 0 && <div className="dock-fixed" ref={fixedRef}>{fixed.map(tab)}</div>}
          {fixed.length > 0 && temps.length > 0 && <span className="dock-sep" aria-hidden />}
          {/* only the temporary tabs scroll; the menus hang in <body>, so nothing here clips them */}
          <div className={clsx('dock-temps', fade.l && 'fade-l', fade.r && 'fade-r')}>
            {fade.l && <button className="dock-scroll l" tabIndex={-1} aria-hidden title="向左滚动" onClick={() => scrollTemps(-1)}><Icon name="chevronLeft" size={12} /></button>}
            <div className="dock-tablist" ref={list} onScroll={updateFade} onWheel={onWheel}>{temps.map(tab)}</div>
            {fade.r && <button className="dock-scroll r" tabIndex={-1} aria-hidden title="向右滚动" onClick={() => scrollTemps(1)}><Icon name="chevronRight" size={12} /></button>}
          </div>
        </div>
        <span className="grow" />
        <span className="dock-ctl" ref={ctlRef}>
          {!workbench && !min && <MoreMenu mounted={mounted} />}
          {(workbench || min) && (
            <button className="icon-btn" title={min ? `还原${TERMS.dock} (${modKey}+Shift+J)` : `最小化 (${modKey}+Shift+J)`} onClick={() => dispatch({ t: 'dock.set', patch: { minimized: !min } })}>
              <Icon name={min ? 'restore' : 'minimize'} size={16} />
            </button>
          )}
          {!min && <button className="icon-btn" title={`隐藏${TERMS.dock} (${modKey}+J)`} aria-label={`隐藏${TERMS.dock}`} onClick={() => dispatch({ t: 'dock.set', patch: { open: false } })}><Icon name="close" size={15} /></button>}
        </span>
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
