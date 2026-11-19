// Opening / closing the Artifacts page (redesign 2026-11 stage 1). A small store of its own, like the automation
// page's; it registers with features/sections/pages.ts, which keeps one page open at a time.
import { create } from 'zustand';
import { hideSheet, useStore } from '@/store';
import { closeOtherPages, registerPage } from '@/features/sections/pages';
import { markPageOpened } from '@/features/automation/state';

interface ArtifactsState {
  open: boolean;
  /** opened at least once: the page stays mounted from then on (hidden, never unmounted) */
  seen: boolean;
  /** bumped on every open: the page reads the list again (a conversation may have written something since) */
  openedAt: number;
}

export const useArtifacts = create<ArtifactsState>(() => ({ open: false, seen: false, openedAt: 0 }));

/** Show the page. On a phone the two drawers get out of the way. Returns true: it is on screen. */
export function openArtifacts(): boolean {
  closeOtherPages('artifacts');
  if (!useArtifacts.getState().open) markPageOpened();
  useArtifacts.setState({ open: true, seen: true, openedAt: Date.now() });
  if (useStore.getState().mobile) { useStore.setState({ sidebarOpen: false }); hideSheet(); }
  return true;
}

export function closeArtifacts(): void {
  if (useArtifacts.getState().open) useArtifacts.setState({ open: false });
}

registerPage('artifacts', { isOpen: () => useArtifacts.getState().open, close: closeArtifacts, subscribe: (fn) => useArtifacts.subscribe(fn) });
