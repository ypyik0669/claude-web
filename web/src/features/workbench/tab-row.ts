/**
 * The default right panel's tab row on the desktop app: where the row goes and whether the temporary tabs get a strip.
 * Pure, so the numbers behind 「整行挪到系统按钮下面」 are tested (tab-row.test.ts) and not tuned by eye.
 *
 * Two decisions, both from widths that do not change with what the panel shows:
 *  - `stacked`: the row moves below the Windows / Linux caption buttons only when the four fixed tabs and the buttons
 *    at the end do not fit beside them. The temporary tabs never count (they only scroll), the 审阅 count has a fixed
 *    width whatever it says (0, 3, 12), and the row width is the column's final width (`panelColumnWidth`), not the
 *    one measured while the panel is still sliding in — so opening the panel, switching conversation, committing
 *    (count → 0) and opening a temporary tab leave it where it is. Once moved down it moves back up only with
 *    `STACK_HYSTERESIS` to spare.
 *  - `folded`: when what is left for the temporary strip is narrower than one tab, the temporary tabs are listed in
 *    the 「更多」 menu (its button shows how many) instead of a strip that would only show its arrows.
 */

/** tokens.css `--shell-gap`: the right panel is a card, one gap narrower than its grid column (4px in compact density —
 *  the 4px this over-counts there only makes the row move down a little earlier). */
export const SHELL_GAP = 8;
/** styles.css: `html.desktop:not(.mac) .app.dock-open .dock:not(.min) .dock-tabs { padding-right: calc(142px / var(--zoom, 1)) }`
 *  — the three caption buttons are 46px each (138), plus 4px of air, at 100%. */
export const CAPTION_W = 142;
/**
 * The room the caption buttons take in the page's pixels at a 界面缩放 factor (ui/zoom.ts): they are drawn by the
 * system, as big as ever in the window's pixels, while the page's pixels are `zoom` of those — zoomed in they take
 * less of the row, zoomed out more. The same division as styles.css's.
 */
export const captionWidth = (zoom = 1) => CAPTION_W / (zoom > 0 ? zoom : 1);
/** styles.css: the default row's right padding (`.dock.simple:not(.min) .dock-tabs`, and `.stacked`). */
export const SIDE_PAD = 8;
/** Moved down, the row moves back up only when it fits with this much to spare (no flip-flop on a pixel). */
export const STACK_HYSTERESIS = 8;
/** styles.css `.dock-sep`: 1px line + 6px margins, drawn only when the strip is. */
export const SEP_W = 13;
/** Narrower than this the strip is folded into 「更多」: one short tab with its × is about this wide. */
export const MIN_STRIP = 56;

/**
 * The row the Windows / Linux caption buttons sit over, at the window's top-right corner: a 52px head row (a session
 * header, the home page's top row, the automation page's, the default right panel's tab row, the settings page's drag
 * strip) or a 40px bar (the group bar, a tab strip, the right panel's tab row under a group bar with the workbench tools).
 */
export type CaptionRow = 'head' | 'bar';
export function captionRow(o: { settings: boolean; dockOpen: boolean; workbench: boolean; groupBar: boolean; chromeRow: boolean }): CaptionRow {
  if (o.settings) return 'head';
  // styles.css: `.app:has(.workbench.gb) .dock-tabs` is a bar, except the default panel's (`.dock.simple`)
  if (o.dockOpen) return o.workbench && o.groupBar ? 'bar' : 'head';
  return o.chromeRow ? 'bar' : 'head';
}
/**
 * How tall the caption buttons' area is: from the window's top edge to the bottom of the row they sit over — so the
 * glyphs are centred half a shell gap above the row's own icons (a fixed 40px left them 14px above), and the area
 * never reaches below the row: only the row itself has to keep its right end clear (`CAPTION_W`). `gap` is the shell
 * gap above the row (0 on Linux, where the card touches the window's edge). In the page's pixels: the shell wants it
 * in the window's, so the caller multiplies by the 界面缩放 factor (`captionHeightAt`).
 */
export function captionHeight(row: CaptionRow, o: { gap: number; head: number; bar: number }): number {
  const h = Math.round(o.gap + (row === 'bar' ? o.bar : o.head));
  return Number.isFinite(h) ? Math.min(80, Math.max(32, h)) : 60;
}

/** …as the shell is told: in the window's pixels, where the row is `zoom` times as tall. */
export function captionHeightAt(zoom: number, row: CaptionRow, o: { gap: number; head: number; bar: number }): number {
  return Math.round(captionHeight(row, o) * (zoom > 0 ? zoom : 1));
}

/** The right panel's column width: the same clamp as `.app:not(.mobile)`'s grid in styles.css. */
export function panelColumnWidth(o: { dock: number; viewport: number; sidebar: number }): number {
  return Math.min(o.dock, Math.max(300, o.viewport - o.sidebar - 360));
}

/** The row's widths that decide where it goes (px). */
export interface RowMeasure {
  /** the row's width (the column less the shell gap: the panel is a card) */
  row: number;
  padLeft: number;
  /** the four fixed tabs, count included */
  fixed: number;
  /** the buttons at the end (更多, hide) */
  controls: number;
  /** the flex gaps between the tab groups, the spacer and the buttons */
  gaps: number;
}

/** Whether the row moves below the caption buttons (`caption`: desktop app on Windows / Linux; `zoom`: 界面缩放). */
export function rowStacked(prev: boolean, m: RowMeasure, caption: boolean, zoom = 1): boolean {
  if (!caption) return false;
  const room = m.row - m.padLeft - captionWidth(zoom);
  const need = m.fixed + m.controls + m.gaps;
  return prev ? need > room - STACK_HYSTERESIS : need > room;
}

/** Whether the temporary tabs are folded into 「更多」, given where the row is. */
export function tempsFolded(m: RowMeasure, o: { stacked: boolean; caption: boolean; zoom?: number }): boolean {
  const padRight = o.caption && !o.stacked ? captionWidth(o.zoom) : SIDE_PAD;
  return m.row - m.padLeft - padRight - m.fixed - m.controls - m.gaps - SEP_W < MIN_STRIP;
}

/** The 审阅 count as shown: it has room for two digits; more than 99 says 99+ (the tooltip has the number). */
export function countText(n: number): string {
  return n <= 0 ? '' : n > 99 ? '99+' : String(n);
}
