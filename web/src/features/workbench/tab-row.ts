/**
 * The default right panel's tab row on the desktop app: where the row goes and whether the temporary tabs get a strip.
 * Pure, so the numbers behind 「整行挪到系统按钮下面」 are tested (tab-row.test.ts) and not tuned by eye.
 *
 * Two decisions, both from widths that do not change with what the panel shows:
 *  - `stacked`: the row moves below the Windows / Linux caption buttons only when the four fixed tabs and the buttons
 *    at the end do not fit beside them. The temporary tabs never count (they only scroll), the 审阅 count has a fixed
 *    width whatever it says (0, 3, 12), and the row width is the column's final width (`panelColumnWidth`), not the
 *    one in the middle of the 240ms opening transition — so opening the panel, switching conversation, committing
 *    (count → 0) and opening a temporary tab leave it where it is. Once moved down it moves back up only with
 *    `STACK_HYSTERESIS` to spare.
 *  - `folded`: when what is left for the temporary strip is narrower than one tab, the temporary tabs are listed in
 *    the 「更多」 menu (its button shows how many) instead of a strip that would only show its arrows.
 */

/** styles.css: `html.desktop:not(.mac) .app.dock-open .dock:not(.min) .dock-tabs { padding-right: 150px }`. */
export const CAPTION_W = 150;
/** styles.css: the default row's right padding (`.dock.simple:not(.min) .dock-tabs`, and `.stacked`). */
export const SIDE_PAD = 8;
/** Moved down, the row moves back up only when it fits with this much to spare (no flip-flop on a pixel). */
export const STACK_HYSTERESIS = 8;
/** styles.css `.dock-sep`: 1px line + 6px margins, drawn only when the strip is. */
export const SEP_W = 13;
/** Narrower than this the strip is folded into 「更多」: one short tab with its × is about this wide. */
export const MIN_STRIP = 56;

/** The right panel's column width: the same clamp as `.app:not(.mobile)`'s grid in styles.css. */
export function panelColumnWidth(o: { dock: number; viewport: number; sidebar: number }): number {
  return Math.min(o.dock, Math.max(300, o.viewport - o.sidebar - 360));
}

/** The row's widths that decide where it goes (px). */
export interface RowMeasure {
  /** the row's width (the column less its 1px left border) */
  row: number;
  padLeft: number;
  /** the four fixed tabs, count included */
  fixed: number;
  /** the buttons at the end (更多, hide) */
  controls: number;
  /** the flex gaps between the tab groups, the spacer and the buttons */
  gaps: number;
}

/** Whether the row moves below the caption buttons (`caption`: desktop app on Windows / Linux). */
export function rowStacked(prev: boolean, m: RowMeasure, caption: boolean): boolean {
  if (!caption) return false;
  const room = m.row - m.padLeft - CAPTION_W;
  const need = m.fixed + m.controls + m.gaps;
  return prev ? need > room - STACK_HYSTERESIS : need > room;
}

/** Whether the temporary tabs are folded into 「更多」, given where the row is. */
export function tempsFolded(m: RowMeasure, o: { stacked: boolean; caption: boolean }): boolean {
  const padRight = o.caption && !o.stacked ? CAPTION_W : SIDE_PAD;
  return m.row - m.padLeft - padRight - m.fixed - m.controls - m.gaps - SEP_W < MIN_STRIP;
}

/** The 审阅 count as shown: it has room for two digits; more than 99 says 99+ (the tooltip has the number). */
export function countText(n: number): string {
  return n <= 0 ? '' : n > 99 ? '99+' : String(n);
}
