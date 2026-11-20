// Opening / closing the 自定义 page (structure round 2's 扩展, spec 2026-10-10-ui-structure §2.2 / §4). A small store of
// its own, like the automation page's; they register with features/sections/pages.ts, which keeps one open at a time.
import { create } from 'zustand';
import { hideSheet, useStore } from '@/store';
import { closeOtherPages, registerPage } from '@/features/sections/pages';
import { markPageOpened } from '@/features/automation/state';
import { EXTENSION_TABS, type ExtensionTab } from './page';

export { EXTENSIONS_TITLE, EXTENSION_NAV, EXTENSION_TABS, EXTENSION_TAB_INFO, type ExtensionTab } from './page';

interface ExtensionsState {
  open: boolean;
  tab: ExtensionTab;
  /** tabs shown at least once: their bodies are mounted from then on (hidden, never unmounted) */
  seen: ExtensionTab[];
  /** asks 连接器 to show its JSON form (a count: each ask is a change) — the old settings id `mcp-json` lands here */
  askJson: number;
}

export const useExtensions = create<ExtensionsState>(() => ({ open: false, tab: 'skills', seen: [], askJson: 0 }));

const withSeen = (seen: ExtensionTab[], t: ExtensionTab) => (seen.includes(t) ? seen : EXTENSION_TABS.filter((x) => x === t || seen.includes(x)));

/** Show the page, on `tab` or the one shown last (`json`: 连接器 with its JSON form open). On a phone the two drawers get out of the way. */
export function openExtensions(tab?: ExtensionTab, opts?: { json?: boolean }): boolean {
  closeOtherPages('extensions');
  if (!useExtensions.getState().open) markPageOpened();
  useExtensions.setState((s) => {
    const t = tab ?? s.tab;
    return { open: true, tab: t, seen: withSeen(s.seen, t), ...(opts?.json ? { askJson: s.askJson + 1 } : {}) };
  });
  if (useStore.getState().mobile) { useStore.setState({ sidebarOpen: false }); hideSheet(); }
  return true;
}

export function showExtensionTab(tab: ExtensionTab): void {
  useExtensions.setState((s) => ({ tab, seen: withSeen(s.seen, tab) }));
}

export function closeExtensions(): void {
  if (useExtensions.getState().open) useExtensions.setState({ open: false });
}

registerPage('extensions', { isOpen: () => useExtensions.getState().open, close: closeExtensions, subscribe: (fn) => useExtensions.subscribe(fn) });
