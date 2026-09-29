// The settings page covers the whole window but leaves the app mounted, so something can be sent to the main area
// underneath it — a conversation picked in the command palette, a terminal a settings button opens — and the user
// sees nothing change (re-review M-5). Like the automation page, it gets out of the way when the main area is sent
// somewhere (`closesAutomation`: opening / bringing forward a tile or a conversation, a split, a group), but not for
// the answer to a request sent before the page was opened (`meta.since`: a new conversation placed in its tile when
// `session.open` came back).
import { onLayoutAction, useStore } from '@/store';
import { closesAutomation } from '@/features/automation/page';

export function installSettingsClose(): () => void {
  let openedAt = useStore.getState().settingsOpen ? Date.now() : 0;
  const unsub = useStore.subscribe((s, prev) => { if (s.settingsOpen && !prev.settingsOpen) openedAt = Date.now(); });
  const off = onLayoutAction((a, meta) => {
    if (!closesAutomation(a) || !useStore.getState().settingsOpen) return;
    if (meta.since !== undefined && openedAt >= meta.since) return; // opened after the request this answers
    useStore.setState({ settingsOpen: null });
  });
  return () => { unsub(); off(); };
}
