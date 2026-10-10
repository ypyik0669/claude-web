// The pages that lie over the main area — 自动化, 扩展 (structure round 2, spec 2026-10-10-ui-structure §2.2). Each has
// its own small store; this is what they share: only one is open at a time, and everything that used to ask "is the
// automation page open" (the composer under it, the shortcuts, the pane layer's `inert`) asks about any of them.
// The icon rail's sections are these pages plus 对话, which is "none of them open".
import { useSyncExternalStore } from 'react';

export type Section = 'chat' | 'automation' | 'extensions';
export type PageId = Exclude<Section, 'chat'>;

interface Page { isOpen(): boolean; close(): void; subscribe(fn: () => void): () => void }

const pages = new Map<PageId, Page>();

/** A page's state module registers itself when it is first imported. */
export function registerPage(id: PageId, p: Page): void { pages.set(id, p); }

/** Opening one page puts the others away (its own `open` calls this first). */
export function closeOtherPages(id: PageId): void {
  for (const [k, p] of pages) if (k !== id && p.isOpen()) p.close();
}

export function closePages(): void {
  for (const p of pages.values()) if (p.isOpen()) p.close();
}

export function openPage(): PageId | null {
  for (const [k, p] of pages) if (p.isOpen()) return k;
  return null;
}

export const currentSection = (): Section => openPage() ?? 'chat';

const subscribe = (fn: () => void) => {
  const offs = [...pages.values()].map((p) => p.subscribe(fn));
  return () => { for (const off of offs) off(); };
};

/** The section in front: a page, or the conversations. */
export function useSection(): Section {
  return useSyncExternalStore(subscribe, currentSection, currentSection);
}

/** A page covers the main area (what `useAutomation((s) => s.open)` used to answer). */
export function usePageOpen(): boolean {
  return useSection() !== 'chat';
}
