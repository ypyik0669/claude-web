import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
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
import { Popover } from '@/features/composer/Popover';
import { useRightPanel } from './right-panel';
import { countText, panelColumnWidth, rowStacked, tempsFolded, type RowMeasure } from './tab-row';
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
    case 'tasks': return <TasksPanel inDock={host === 'dock'} />;
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

const NONE: PanelId[] = [];

/**
 * The default right panel's 「更多」 menu: the extra-tier panels, opened as temporary tabs (spec §5.6). When the row has
 * no room for the temporary strip (`tab-row.ts`), the open temporary tabs are here too, on top — switch to one or
 * close it — and the button says how many there are (and is marked while one of them is in front).
 */
function MoreMenu({ mounted, open: temps, active, onPick, onClose }: { mounted: PanelId[]; open: PanelId[]; active: PanelId | null; onPick: (id: PanelId) => void; onClose: (id: PanelId) => void }) {
  const dispatch = useStore((s) => s.dispatchLayout);
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const close = useCallback((refocus: boolean) => { setOpen(false); if (refocus) btn.current?.focus(); }, []);
  const front = !!active && temps.includes(active);
  const names = temps.map((id) => PANEL_TITLES[id]).join('、');
  // closing one from 「已打开」 (the × was focused — a keyboard user): the focus moves to the next open row, else the
  // one before it; with none left the menu closes and the focus goes back to 「更多」 (never left on <body>, where
  // neither the arrows nor Esc reach the menu)
  const closeOpen = (id: PanelId) => {
    const i = temps.indexOf(id);
    const next = temps[i + 1] ?? temps[i - 1];
    onClose(id);
    if (!next) { close(true); return; }
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`.dock-more-menu .dock-more-open[data-open="${next}"] > button[data-panel]`)?.focus());
  };
  const title = temps.length ? `更多面板 · 已打开：${names}` : '更多面板：目标、编排、用量、Issue 与 PR…';
  return (
    <>
      <button ref={btn} className={clsx('icon-btn dock-more', (open || front) && 'active')} title={title} aria-label={temps.length ? `更多面板（已打开 ${temps.length} 个）` : '更多面板'} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="plus" size={15} />
        {temps.length > 0 && <span className="dock-more-n" aria-hidden>{temps.length}</span>}
      </button>
      {open && (
        <Popover anchor={btn} onClose={close} prefer="down" align="right" className="dock-more-menu" label="更多面板">
          {temps.length > 0 && (
            <>
              <div className="menu-label">已打开</div>
              {temps.map((id) => (
                <div key={id} className="dock-more-open" data-open={id}>
                  <button role="menuitemradio" aria-checked={active === id} data-mi data-panel={id} onClick={() => { onPick(id); setOpen(false); }}>
                    <Icon name={PANEL_ICONS[id]} size={14} /><span className="grow">{PANEL_TITLES[id]}</span>{active === id && <Icon name="check" size={13} />}
                  </button>
                  <button className="x" role="menuitem" data-mi title={`关闭${PANEL_TITLES[id]}`} aria-label={`关闭${PANEL_TITLES[id]}`} onClick={() => closeOpen(id)}><Icon name="close" size={12} /></button>
                </div>
              ))}
              <div className="menu-sep" />
            </>
          )}
          <div className="menu-label">在右侧面板打开</div>
          {MORE_PANELS.map((p) => (
            <button key={p.id} role="menuitem" data-mi data-panel={p.id} onClick={() => { dispatch({ t: 'dock.show', panel: p.id }); setOpen(false); }}>
              <Icon name={p.icon} size={14} /><span className="grow">{p.title}</span>{mounted.includes(p.id) && <Icon name="check" size={13} />}
            </button>
          ))}
          <div className="menu-sep" />
          <div className="menu-note">总览、记忆、配置中心等在命令面板（{modKey}+K）里，或在设置里打开「{TERMS.workbench}」</div>
        </Popover>
      )}
    </>
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
 * The fixed tabs never scroll: only the temporary tabs do, in their own strip with fading edges and arrows — or, with
 * no room for a strip, listed in 「更多」. On the desktop app (Windows / Linux) the row shares the top 40px with the
 * window's caption buttons; only when the fixed tabs and the buttons themselves do not fit beside them does the row
 * move below them (`stacked`; the decisions and their numbers are in `tab-row.ts`).
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
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const sbWidth = useStore((s) => s.layout.sidebar.width);
  const drag = useRef<{ x0: number; w0: number; id: number } | null>(null);
  const row = useRef<HTMLDivElement>(null);
  const fixedRef = useRef<HTMLDivElement>(null);
  const ctlRef = useRef<HTMLSpanElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState({ stacked: false, folded: false });
  const [fade, setFade] = useState({ l: false, r: false });
  const view = dockView(dock, { workbench, inspect: !!inspect });
  const { tabs, active, mounted } = view;
  const fixed = tabs.filter((t) => t.fixed);
  const temps = tabs.filter((t) => !t.fixed);
  const min = dock.minimized;
  const shown = dock.open;
  const simple = !workbench && !min;
  const stacked = simple && place.stacked;
  // no room for a strip: the temporary tabs are listed in 「更多」 (default look only; workbench tabs are icons)
  const folded = simple && place.folded && temps.length > 0;
  // …and one of them is in front: nothing in the row names it, so the panel gets a title row with its ×
  const foldedFront = folded && !!active && temps.some((t) => t.id === active);

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
  }, [active, temps.length, dock.open, dock.minimized, workbench, stacked, folded]);

  // where the row goes (`tab-row.ts`): from the column's final width (the grid clamp, not the width in the middle of
  // the opening transition) and the natural widths of the fixed tabs (the count has a fixed room) and the buttons —
  // none of which change with the temporary tabs, the count, or the row moving down, so it does not jump
  useLayoutEffect(() => {
    const r = row.current;
    if (!r || !simple || !shown) return;
    let raf = 0;
    const measure = () => {
      const root = document.documentElement;
      const caption = root.classList.contains('desktop') && !root.classList.contains('mac');
      const cs = getComputedStyle(r);
      const m: RowMeasure = {
        row: panelColumnWidth({ dock: dock.width, viewport: window.innerWidth, sidebar: sidebarOpen ? sbWidth : 0 }) - 1,
        padLeft: parseFloat(cs.paddingLeft) || 0,
        fixed: fixedRef.current?.getBoundingClientRect().width ?? 0,
        controls: ctlRef.current?.getBoundingClientRect().width ?? 0,
        gaps: 2 * (parseFloat(cs.columnGap) || 0),
      };
      setPlace((cur) => {
        const s = rowStacked(cur.stacked, m, caption);
        const f = tempsFolded(m, { stacked: s, caption });
        return cur.stacked === s && cur.folded === f ? cur : { stacked: s, folded: f };
      });
      updateFade();
    };
    measure();
    const again = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(measure); };
    const ro = new ResizeObserver(again);
    ro.observe(r);
    if (fixedRef.current) ro.observe(fixedRef.current);
    if (ctlRef.current) ro.observe(ctlRef.current);
    if (list.current) ro.observe(list.current);
    window.addEventListener('resize', again);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); window.removeEventListener('resize', again); };
  }, [simple, shown, !!mounted.length, temps.length > 0, folded, dock.width, sidebarOpen, sbWidth]);

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
      {/* always there in the default look, with a fixed two-digit room: 0 → 3 → 12 files must not move the row */}
      {!workbench && id === 'files' && <span className="n" aria-label={reviewCount > 0 ? `${reviewCount} 个文件` : undefined} title={reviewCount > 99 ? `${reviewCount} 个文件` : undefined}>{countText(reviewCount)}</span>}
      {!isFixed && <button className="x" title="关闭" aria-label={`关闭${PANEL_TITLES[id]}`} onClick={(e) => { e.stopPropagation(); close(id); }}><Icon name="close" size={11} /></button>}
    </div>
  );

  return (
    <div className={clsx('dock', min && 'min', !workbench && 'simple')} hidden={!shown}>
      {!min && <div className="resizer" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onDoubleClick={() => dispatch({ t: 'dock.set', patch: { width: DOCK_DEFAULT_WIDTH } })} title="拖动调整 · 双击复位" />}
      <div className={clsx('dock-tabs', stacked && 'stacked')} ref={row}>
        <div className="dock-tabgroups" role="tablist" aria-label={TERMS.dock}>
          {fixed.length > 0 && <div className="dock-fixed" ref={fixedRef}>{fixed.map(tab)}</div>}
          {fixed.length > 0 && temps.length > 0 && !folded && <span className="dock-sep" aria-hidden />}
          {/* only the temporary tabs scroll; the menus hang in <body>, so nothing here clips them */}
          {!folded && (
            <div className={clsx('dock-temps', fade.l && 'fade-l', fade.r && 'fade-r')}>
              {fade.l && <button className="dock-scroll l" tabIndex={-1} aria-hidden title="向左滚动" onClick={() => scrollTemps(-1)}><Icon name="chevronLeft" size={12} /></button>}
              <div className="dock-tablist" ref={list} onScroll={updateFade} onWheel={onWheel}>{temps.map(tab)}</div>
              {fade.r && <button className="dock-scroll r" tabIndex={-1} aria-hidden title="向右滚动" onClick={() => scrollTemps(1)}><Icon name="chevronRight" size={12} /></button>}
            </div>
          )}
        </div>
        <span className="grow" />
        <span className="dock-ctl" ref={ctlRef}>
          {simple && <MoreMenu mounted={mounted} open={folded ? temps.map((t) => t.id) : NONE} active={active} onPick={pick} onClose={close} />}
          {(workbench || min) && (
            <button className="icon-btn" title={min ? `还原${TERMS.dock} (${modKey}+Shift+J)` : `最小化 (${modKey}+Shift+J)`} onClick={() => dispatch({ t: 'dock.set', patch: { minimized: !min } })}>
              <Icon name={min ? 'restore' : 'minimize'} size={16} />
            </button>
          )}
          {!min && <button className="icon-btn" title={`隐藏${TERMS.dock} (${modKey}+J)`} aria-label={`隐藏${TERMS.dock}`} onClick={() => dispatch({ t: 'dock.set', patch: { open: false } })}><Icon name="close" size={15} /></button>}
        </span>
      </div>
      <div className={clsx('dock-body', foldedFront && 'headed')}>
        {/* a temporary panel in front that has no tab of its own (folded into 「更多」): its name and × on top of the
            panel itself — the tab row does not move, no fixed tab is lit, and it says what this is and how to close it */}
        {foldedFront && active && (
          <div className="dock-foldhead" data-panel={active}>
            <Icon name={PANEL_ICONS[active]} size={14} />
            <span className="t">{PANEL_TITLES[active]}</span>
            <span className="grow" />
            <button className="icon-btn xs" title={`关闭${PANEL_TITLES[active]}`} aria-label={`关闭${PANEL_TITLES[active]}`} onClick={() => close(active)}><Icon name="close" size={12} /></button>
          </div>
        )}
        {mounted.map((id) => (
          <div key={id} className="dock-panel" hidden={active !== id} data-panel={id}>
            <PanelBody id={id} visible={shown && !min && active === id} />
          </div>
        ))}
      </div>
    </div>
  );
}
