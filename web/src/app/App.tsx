import { useEffect, useRef } from 'react';
import { useStore } from '@/store';
import { Sidebar } from '@/features/sidebar/Sidebar';
import { Workbench } from '@/features/workbench/Workbench';
import { Dock } from '@/features/workbench/Dock';
import { ShortcutsModal } from '@/features/workbench/ShortcutsModal';
import { matchBrowserKey } from '@/features/workbench/shortcuts';
import { runCommand } from '@/features/workbench/commands';
import { claimSession } from '@/features/workbench/windows';
import { clsx } from '@/util';
import { CommandPalette } from '@/features/palette/CommandPalette';
import { ImageViewer } from '@/features/chat/ImageViewer';
import { DialogHost } from '@/ui/dialog';
import { SettingsModal } from '@/features/settings/SettingsModal';
import { Onboarding } from '@/features/onboarding/Onboarding';
import { desktop } from '@/desktop';

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
  return (
    <div className="sidebar" style={{ position: 'relative' }}>
      <Sidebar onNew={() => runCommand('new')} />
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

export function App() {
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const sbWidth = useStore((s) => s.layout.sidebar.width);
  const dock = useStore((s) => s.layout.dock);
  const inspect = useStore((s) => s.inspect);
  const dockShown = dock.open && (dock.tabs.length > 0 || !!inspect);
  const rpWidth = !dockShown ? 0 : dock.minimized ? 36 : dock.width;

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
    <div className={clsx('app', !sidebarOpen && 'no-sidebar')} style={{ ['--rp' as any]: `${rpWidth}px`, ['--sb' as any]: `${sbWidth}px` }}>
      {sidebarOpen ? <SidebarColumn /> : <div className="sidebar" style={{ display: 'none' }} />}
      <Workbench />
      <div className="rpanel" style={{ display: rpWidth ? 'flex' : 'none' }}>
        <Dock />
      </div>
      <Toasts />
      <CommandPalette />
      <ShortcutsModal />
      <SettingsModal />
      <Onboarding />
      <ImageViewer />
      <DialogHost />
    </div>
  );
}
