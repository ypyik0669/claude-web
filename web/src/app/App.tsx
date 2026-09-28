import { useEffect, useRef } from 'react';
import { useStore } from '@/store';
import { Sidebar } from '@/features/sidebar/Sidebar';
import { Workbench } from '@/features/workbench/Workbench';
import { Dock } from '@/features/workbench/Dock';
import { ShortcutsModal } from '@/features/workbench/ShortcutsModal';
import { matchBrowserKey } from '@/features/workbench/shortcuts';
import { runCommand } from '@/features/workbench/commands';
import { claimSession } from '@/features/workbench/windows';
import { showPanel } from '@/features/workbench/right-panel';
import { clsx } from '@/util';
import { CommandPalette } from '@/features/palette/CommandPalette';
import { ImageViewer } from '@/features/chat/ImageViewer';
import { DialogHost } from '@/ui/dialog';
import { SettingsModal } from '@/features/settings/SettingsModal';
import { Onboarding } from '@/features/onboarding/Onboarding';
import { desktop } from '@/desktop';
import { Icon } from '@/ui/icons';
import { installOrchestra } from '@/features/orchestra/state';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { chromeVisibility, workbenchOn } from '@/model/layout';
import { MOBILE_QUERY } from '@/ui/viewport';

/** Width of the right panel minimized to its icon rail. */
const MIN_RAIL = 36;

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  if (!toasts.length) return null;
  return (
    <div className="toast-wrap">
      {toasts.map((t) => (
        <div key={t.id} className={clsx('toast', t.ok && 'ok')}>{t.text}</div>
      ))}
    </div>
  );
}

/** Sidebar column with a drag handle on its right edge (width lives in the layout state). */
function SidebarColumn() {
  const width = useStore((s) => s.layout.sidebar.width);
  const dispatch = useStore((s) => s.dispatchLayout);
  const drag = useRef<{ x0: number; w0: number } | null>(null);
  // NOTE: no inline `position` here — an inline style beats `.app.mobile .sidebar { position: fixed }`
  // regardless of specificity, which would leave the drawer in the grid flow and squash the workbench to 0px.
  return (
    <div className="sidebar has-resizer">
      <ErrorBoundary area="侧栏"><Sidebar onNew={() => runCommand('new')} /></ErrorBoundary>
      <div
        className="resizer right"
        onPointerDown={(e) => { drag.current = { x0: e.clientX, w0: width }; (e.target as HTMLElement).setPointerCapture(e.pointerId); }}
        onPointerMove={(e) => { if (drag.current) dispatch({ t: 'sidebar.set', patch: { width: Math.max(200, Math.min(520, drag.current.w0 + (e.clientX - drag.current.x0))) } }); }}
        onPointerUp={() => { drag.current = null; }}
        onDoubleClick={() => dispatch({ t: 'sidebar.set', patch: { width: 264 } })}
      />
    </div>
  );
}

const MOBILE = window.matchMedia(MOBILE_QUERY);

export function App() {
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  // phone width lives in the store: the workbench chrome, the session header and the panel commands all follow it
  const mobile = useStore((s) => s.mobile);
  useEffect(() => { const on = () => useStore.setState({ mobile: MOBILE.matches }); on(); MOBILE.addEventListener('change', on); return () => MOBILE.removeEventListener('change', on); }, []);
  useEffect(() => { if (mobile) useStore.setState({ sidebarOpen: false }); }, [mobile]);
  useEffect(() => installOrchestra(), []);
  const sbWidth = useStore((s) => s.layout.sidebar.width);
  const dock = useStore((s) => s.layout.dock);
  const inspect = useStore((s) => s.inspect);
  const dispatchLayout = useStore((s) => s.dispatchLayout);
  const dockShown = dock.open && (dock.tabs.length > 0 || !!inspect);
  const rpWidth = !dockShown ? 0 : dock.minimized ? MIN_RAIL : dock.width;

  // desktop caption buttons (Windows / Linux overlay) are painted in one colour: match whatever row is under them —
  // the page (--bg) when the session header / empty page is there, the side surface (--bg-1) for the right panel's
  // tab row, the group bar or a tab strip
  const theme = useStore((s) => s.theme);
  const sideSurface = useStore((s) => {
    const workbench = workbenchOn(s.settings);
    // an open right panel owns the corner: its tab row is --bg-1 only with the workbench tools (the default one is white)
    if (rpWidth > MIN_RAIL) return workbench;
    const vis = chromeVisibility(s.layout, { workbench });
    return vis.groupBar || Object.values(vis.tabStrip).some(Boolean);
  });
  useEffect(() => {
    const d = desktop;
    if (!d) return;
    const t = setTimeout(() => {
      const cs = getComputedStyle(document.documentElement);
      d.setTitleBarColors(cs.getPropertyValue(sideSurface ? '--bg-1' : '--bg').trim(), cs.getPropertyValue('--fg-1').trim());
    }, 0);
    return () => clearTimeout(t);
  }, [theme, sideSurface]);

  // asking to inspect a tool call must bring 详情 to the front of the right panel — also when it is already a tab
  // behind another one (otherwise the detail button on a tool row does nothing visible); a phone says where it is
  useEffect(() => {
    if (inspect) showPanel('inspector');
  }, [inspect]);

  // desktop shell: menu accelerators arrive as commands; notifications click → focus session
  useEffect(() => {
    if (!desktop) return;
    const offCmd = desktop.onCommand((id) => runCommand(id));
    const offFocus = desktop.onFocusSession((sessionId) => {
      const st = useStore.getState();
      // only the window that holds the session responds; otherwise the main window claims it
      const holds = st.layout.groups.some((g) => Object.values(g.panes).some((p) => p.tiles.some((t) => t.kind === 'chat' && t.sessionId === sessionId)));
      if (holds) st.setActive(sessionId);
      else if (!desktop?.windowId || desktop.windowId === 'main') (st.open[sessionId] ? st.setActive(sessionId) : void st.loadHistory(sessionId));
      else claimSession(sessionId);
    });
    return () => { offCmd(); offFocus(); };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { if (useStore.getState().settingsOpen) useStore.setState({ settingsOpen: null }); useStore.setState({ shortcutsOpen: false }); return; }
      const id = matchBrowserKey(e);
      if (!id) return;
      // on desktop the menu accelerators own the Ctrl-only chords; browser-only (Alt) chords still run here
      if (desktop && (e.ctrlKey || e.metaKey) && !e.altKey && !['pane.splitRight', 'pane.splitDown', 'pane.zoom', 'dock.toggle', 'dock.minimize'].includes(id) && !id.startsWith('panel.') && !/^group\.jump/.test(id)) return;
      e.preventDefault();
      runCommand(id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    // `dock-open`: the right panel owns the window's top-right corner (desktop caption buttons sit over its tab row).
    // Not when it is minimized to its 36px icon rail: the buttons then cover the workbench's top-right row as well.
    <div className={clsx('app', !sidebarOpen && 'no-sidebar', mobile && 'mobile', mobile && sidebarOpen && 'drawer-open', rpWidth > MIN_RAIL && !mobile && 'dock-open')} style={{ ['--rp' as any]: `${mobile ? 0 : rpWidth}px`, ['--sb' as any]: `${sbWidth}px` }}>
      {mobile && sidebarOpen && <div className="drawer-backdrop" onClick={() => useStore.setState({ sidebarOpen: false })} />}
      {sidebarOpen ? <SidebarColumn /> : <div className="sidebar" style={{ display: 'none' }} />}
      <ErrorBoundary area="工作台"><Workbench /></ErrorBoundary>
      <div className="rpanel" style={{ display: rpWidth ? 'flex' : 'none' }}>
        <ErrorBoundary area="右侧面板"><Dock /></ErrorBoundary>
      </div>
      <ErrorBoundary area="通知" floating><Toasts /></ErrorBoundary>
      <ErrorBoundary area="命令面板" floating><CommandPalette /></ErrorBoundary>
      <ErrorBoundary area="快捷键" floating><ShortcutsModal /></ErrorBoundary>
      <ErrorBoundary area="设置" floating onReset={() => useStore.setState({ settingsOpen: null })}><SettingsModal /></ErrorBoundary>
      <ErrorBoundary area="首次引导" floating><Onboarding /></ErrorBoundary>
      <ErrorBoundary area="图片查看" floating><ImageViewer /></ErrorBoundary>
      <ErrorBoundary area="对话框" floating><DialogHost /></ErrorBoundary>
    </div>
  );
}
