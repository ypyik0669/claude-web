// Command dispatcher shared by browser keydown, Electron menu accelerators and the command palette.
import { useStore, type PanelId } from '@/store';
import { activeGroup, chatTile } from '@/model/layout';
import { offerGroupToNewWindow } from './windows';

export function runCommand(id: string): boolean {
  const st = useStore.getState();
  const d = st.dispatchLayout;
  const g = activeGroup(st.layout);
  const pane = g.panes[g.focusedPaneId];
  const a = st.activeId ? st.open[st.activeId] : undefined;
  const single = !!st.settings['ui.singleWindow'];
  const m = /^(group\.jump|pane\.jump)\.(\d)$/.exec(id);
  if (m) {
    if (m[1] === 'group.jump') { const t = st.layout.groups[Number(m[2])]; if (t) d({ t: 'group.activate', id: t.id }); }
    else d({ t: 'pane.jump', index: Number(m[2]) });
    return true;
  }
  switch (id) {
    case 'new': st.openInPane(null, single ? 'replace' : 'tab'); return true;
    case 'palette': useStore.setState((s) => ({ paletteOpen: !s.paletteOpen })); return true;
    case 'sidebar': useStore.setState((s) => ({ sidebarOpen: !s.sidebarOpen })); return true;
    case 'shortcuts': useStore.setState({ shortcutsOpen: true }); return true;
    case 'tab': {
      const t = pane?.tiles.find((x) => x.id === pane.activeTileId);
      if (t?.kind === 'chat') d({ t: 'tile.patch', paneId: pane.id, tileId: t.id, patch: { view: t.view === 'chat' ? 'trajectory' : 'chat' } });
      return true;
    }
    case 'group.new': if (!single) d({ t: 'group.new' }); return true;
    case 'group.close': d({ t: 'group.close', id: st.layout.activeGroupId }); return true;
    case 'group.next': d({ t: 'group.next', dir: 1 }); return true;
    case 'group.prev': d({ t: 'group.next', dir: -1 }); return true;
    case 'group.rename': {
      const el = document.querySelector<HTMLElement>('.gtab.active');
      el?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return true;
    }
    case 'pane.splitRight': case 'pane.splitDown': {
      if (single) return true;
      const before = st.layout;
      d({ t: 'pane.split', paneId: g.focusedPaneId, dir: id === 'pane.splitRight' ? 'row' : 'col' });
      if (useStore.getState().layout === before) st.toast('最多 6 个窗格');
      return true;
    }
    case 'tile.close': if (pane?.activeTileId) d({ t: 'tile.close', paneId: pane.id, tileId: pane.activeTileId }); return true;
    case 'pane.zoom': d({ t: 'pane.zoom', paneId: g.zoomedPaneId ? null : g.focusedPaneId }); return true;
    case 'pane.next': d({ t: 'pane.cycle', dir: 1 }); return true;
    case 'pane.prev': d({ t: 'pane.cycle', dir: -1 }); return true;
    case 'tile.new': d({ t: 'tile.open', paneId: g.focusedPaneId, tile: chatTile(null), mode: single ? 'replace' : 'tab' }); return true;
    case 'tile.next': d({ t: 'tile.next', paneId: g.focusedPaneId, dir: 1 }); return true;
    case 'tile.prev': d({ t: 'tile.next', paneId: g.focusedPaneId, dir: -1 }); return true;
    case 'dock.toggle': d({ t: 'dock.set', patch: { open: !st.layout.dock.open, minimized: false } }); return true;
    case 'dock.minimize': d({ t: 'dock.set', patch: { minimized: !st.layout.dock.minimized, open: true } }); return true;
    case 'interrupt': if (a) void st.interrupt(a.sessionId); return true;
    case 'close': if (a) void st.closeSession(a.sessionId); return true;
    case 'window.new': void offerGroupToNewWindow(st.layout.activeGroupId); return true;
  }
  if (id.startsWith('panel.')) { st.togglePanel(id.slice(6) as PanelId); return true; }
  return false;
}
