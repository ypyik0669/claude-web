import { useStore, type PanelId } from '@/store';
import { PANEL_TITLES, currentChatTile } from '@/model/layout';
import { TERMS } from '@/ui/terms';

/**
 * Bring a right-panel tab into view (never toggles it away: the sidebar's entries are "go there"). The right panel is
 * not drawn on a phone — opening a tab there would start things nobody sees — so a phone gets the conversation's own
 * view when there is one (定时任务 is also a view of the conversation) or a note.
 */
export function showPanel(p: PanelId): void {
  const st = useStore.getState();
  if (st.mobile) {
    const at = p === 'tasks' ? currentChatTile(st.layout) : null;
    if (at) {
      st.dispatchLayout({ t: 'tile.activate', paneId: at.paneId, tileId: at.tileId });
      st.dispatchLayout({ t: 'tile.patch', paneId: at.paneId, tileId: at.tileId, patch: { wb: 'schedules' } });
      useStore.setState({ sidebarOpen: false });
      return;
    }
    st.toast(`手机上没有${TERMS.dock}，「${PANEL_TITLES[p]}」请在电脑上查看`);
    return;
  }
  st.dispatchLayout({ t: 'dock.show', panel: p });
}
