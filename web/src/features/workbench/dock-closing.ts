// When the right panel closes with a fade (UI refresh §6: 「关闭：面板先淡出 150ms，再收列」). Pure; Dock.tsx watches the
// store with it.

/** What matters of the right panel's state for that: is it open, is it the 36px rail, is anything in it, a phone? */
export interface DockSeen { open: boolean; minimized: boolean; mounted: boolean; mobile: boolean }

/** How long the panel fades before its column goes (floating.css: `fl-rp-out` and the delayed changes run this long). */
export const RP_OUT_MS = 150;

/**
 * The panel was on screen as a card and is now hidden while still mounted (Ctrl+J, the header's button, its own ×,
 * toggling a fixed tab that is in view): it fades out first. Not from the icon rail (no card to fade), not when its
 * last tab was closed (nothing left to show), not on a phone (the bottom sheet), not when it opens.
 */
export function panelFadesOut(prev: DockSeen, next: DockSeen): boolean {
  return prev.open && prev.mounted && !prev.minimized && !prev.mobile && !next.open && next.mounted && !next.mobile;
}
