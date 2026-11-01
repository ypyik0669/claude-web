// The hub's own store (the rail's 用量与隐私 section): which page is in front, which pages have been mounted.
import { create } from 'zustand';
import { hideSheet, useStore } from '@/store';
import { closeOtherPages, registerPage } from '@/features/sections/pages';
import { markPageOpened } from '@/features/automation/state';
import type { HubPageId } from './page';

interface HubState {
  open: boolean;
  page: HubPageId;
  /** mounted at least once: from then on only hidden */
  seen: HubPageId[];
}

export const useHub = create<HubState>(() => ({ open: false, page: 'usage', seen: [] }));

export function openHub(page?: HubPageId): boolean {
  closeOtherPages('gateway');
  if (!useHub.getState().open) markPageOpened();
  useHub.setState((s) => {
    const next = page ?? s.page;
    return { open: true, page: next, seen: s.seen.includes(next) ? s.seen : [...s.seen, next] };
  });
  if (useStore.getState().mobile) { useStore.setState({ sidebarOpen: false }); hideSheet(); }
  return true;
}

export function showHubPage(page: HubPageId): void {
  useHub.setState((s) => ({ page, seen: s.seen.includes(page) ? s.seen : [...s.seen, page] }));
}

export function closeHub(): void {
  if (useHub.getState().open) useHub.setState({ open: false });
}

registerPage('gateway', { isOpen: () => useHub.getState().open, close: closeHub, subscribe: (fn) => useHub.subscribe(fn) });
