// Command dispatcher shared by browser keydown, Electron menu accelerators and the command palette.
import { useStore, type PanelId } from '@/store';
import { activeGroup, chatTile, currentChatTile, defaultDockPanel, workbenchOn } from '@/model/layout';
import { offerGroupToNewWindow } from './windows';

export function runCommand(id: string): boolean {
  const st = useStore.getState();
  const d = st.dispatchLayout;
  const g = activeGroup(st.layout);
  const pane = g.panes[g.focusedPaneId];
  const a = st.activeId ? st.open[st.activeId] : undefined;
  // without the workbench setting a new conversation takes the place of the conversation in front (the old one
  // stays in the sidebar, a running one keeps running); a terminal / document in front is never replaced — the
  // reducer opens a tab next to it. Splits / groups / tabs still work from the keyboard and bring their own chrome.
  const workbench = workbenchOn(st.settings);
  // a phone's right panel is the bottom drawer: it has no icon rail to minimise to — the same key shows / hides it
  if (st.mobile && id === 'dock.minimize') return runCommand('dock.toggle');
  const m = /^(group\.jump|pane\.jump)\.(\d)$/.exec(id);
  if (m) {
    if (m[1] === 'group.jump') { const t = st.layout.groups[Number(m[2])]; if (t) d({ t: 'group.activate', id: t.id }); }
    else d({ t: 'pane.jump', index: Number(m[2]) });
    return true;
  }
  switch (id) {
    case 'new': st.openInPane(null, workbench ? 'tab' : 'replace'); return true;
    case 'palette': useStore.setState((s) => ({ paletteOpen: !s.paletteOpen })); return true;
    case 'sidebar': useStore.setState((s) => ({ sidebarOpen: !s.sidebarOpen })); return true;
    case 'shortcuts': useStore.setState({ shortcutsOpen: true }); return true;
    case 'settings': st.openSettings(); return true;
    case 'tab': {
      // the conversation next to a document / terminal in front counts too (it is what the palette calls 当前对话)
      const at = currentChatTile(st.layout);
      const t = at && activeGroup(st.layout).panes[at.paneId]?.tiles.find((x) => x.id === at.tileId);
      if (!at || t?.kind !== 'chat') return true;
      d({ t: 'tile.activate', paneId: at.paneId, tileId: at.tileId });
      d({ t: 'tile.patch', paneId: at.paneId, tileId: at.tileId, patch: t.wb !== 'live' ? { wb: 'live', view: 'trajectory' } : { view: t.view === 'chat' ? 'trajectory' : 'chat' } });
      return true;
    }
    case 'group.new': d({ t: 'group.new' }); return true;
    case 'group.close': d({ t: 'group.close', id: st.layout.activeGroupId }); return true;
    case 'group.next': d({ t: 'group.next', dir: 1 }); return true;
    case 'group.prev': d({ t: 'group.next', dir: -1 }); return true;
    case 'group.rename': {
      const el = document.querySelector<HTMLElement>('.gtab.active');
      el?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return true;
    }
    case 'pane.splitRight': case 'pane.splitDown': {
      const before = st.layout;
      d({ t: 'pane.split', paneId: g.focusedPaneId, dir: id === 'pane.splitRight' ? 'row' : 'col' });
      if (useStore.getState().layout === before) st.toast('最多 6 个窗格');
      return true;
    }
    case 'tile.close': if (pane?.activeTileId) st.closeTile(pane.id, pane.activeTileId); return true;
    case 'pane.zoom': d({ t: 'pane.zoom', paneId: g.zoomedPaneId ? null : g.focusedPaneId }); return true;
    case 'pane.next': d({ t: 'pane.cycle', dir: 1 }); return true;
    case 'pane.prev': d({ t: 'pane.cycle', dir: -1 }); return true;
    case 'tile.new': d({ t: 'tile.open', paneId: g.focusedPaneId, tile: chatTile(null), mode: 'tab' }); return true;
    case 'tile.next': d({ t: 'tile.next', paneId: g.focusedPaneId, dir: 1 }); return true;
    case 'tile.prev': d({ t: 'tile.next', paneId: g.focusedPaneId, dir: -1 }); return true;
    case 'dock.toggle':
      // nothing to show yet (a fresh window mounts no panel, every tab closed): open it on its first tab instead of an
      // empty column — that is where 审阅 is mounted (and starts watching the repo) the first time
      if (!st.layout.dock.tabs.length && !st.inspect) d({ t: 'dock.show', panel: defaultDockPanel(workbench) });
      else d({ t: 'dock.set', patch: { open: !st.layout.dock.open, minimized: false } });
      return true;
    case 'dock.minimize':
      if (!st.layout.dock.tabs.length && !st.inspect) d({ t: 'dock.show', panel: defaultDockPanel(workbench) });
      d({ t: 'dock.set', patch: { minimized: !st.layout.dock.minimized, open: true } });
      return true;
    case 'interrupt': if (a) void st.interrupt(a.sessionId); return true;
    case 'close': if (a) void st.closeSession(a.sessionId); return true;
    case 'window.new': void offerGroupToNewWindow(st.layout.activeGroupId); return true;
  }
  if (id.startsWith('panel.')) { st.togglePanel(id.slice(6) as PanelId); return true; }
  return false;
}
