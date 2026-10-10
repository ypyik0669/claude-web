import { describe, expect, it } from 'vitest';
import { CAPTION_W, MIN_STRIP, SEP_W, SHELL_GAP, SIDE_PAD, STACK_HYSTERESIS, captionHeight, captionRow, countText, panelColumnWidth, rowStacked, tempsFolded, type RowMeasure } from './tab-row';

// the default right panel's numbers on the desktop app (ui-smoke measures the real ones): four 13px text tabs with 8px
// sides and the count's two-digit room ≈ 201, 更多 + hide = 62, two 2px gaps, 12px left padding
const at = (viewport: number, sidebar = 264, dock = 440): RowMeasure => ({
  row: panelColumnWidth({ dock, viewport, sidebar }) - SHELL_GAP,
  padLeft: 12,
  fixed: 201,
  controls: 62,
  gaps: 4,
});

describe('right panel tab row', () => {
  it('the column width is the grid clamp: the dock width, giving way to keep the conversation ≥ 360 and itself ≥ 300', () => {
    expect(panelColumnWidth({ dock: 440, viewport: 1440, sidebar: 264 })).toBe(440);
    expect(panelColumnWidth({ dock: 440, viewport: 1024, sidebar: 264 })).toBe(400);
    expect(panelColumnWidth({ dock: 440, viewport: 900, sidebar: 264 })).toBe(300);
    expect(panelColumnWidth({ dock: 440, viewport: 900, sidebar: 0 })).toBe(440);
  });

  it('1440 wide, default panel: the row stays beside the caption buttons (the reported 280 > 277 is gone)', () => {
    const m = at(1440);
    expect(m.row - m.padLeft - CAPTION_W).toBe(278); // 440 − 8 (the card's gap) − 12 − 142
    expect(rowStacked(false, m, true)).toBe(false);
    // and a row that was down (a narrower window a moment ago) comes back up: it fits with the hysteresis to spare
    expect(rowStacked(true, m, true)).toBe(false);
  });

  it('temporary tabs never move the row: they are not in the measure at all; with no room for a strip they fold into 更多', () => {
    const m = at(1440);
    expect(tempsFolded(m, { stacked: false, caption: true })).toBe(true);
    // the browser (no caption buttons) has room for the strip at the same size
    expect(tempsFolded(m, { stacked: false, caption: false })).toBe(false);
    expect(m.row - m.padLeft - SIDE_PAD - m.fixed - m.controls - m.gaps - SEP_W).toBeGreaterThanOrEqual(MIN_STRIP);
  });

  it('only a really narrow panel moves the row down (1024 with the sidebar: 400px column); there the strip has room', () => {
    const m = at(1024);
    expect(rowStacked(false, m, true)).toBe(true);
    expect(tempsFolded(m, { stacked: true, caption: true })).toBe(false);
  });

  it('hysteresis: down stays down until it fits with STACK_HYSTERESIS to spare; up stays up until it does not fit', () => {
    const room = 277;
    const m = (fixed: number): RowMeasure => ({ row: room + 12 + CAPTION_W, padLeft: 12, fixed, controls: 58, gaps: 4 });
    const tight = room - 62 - STACK_HYSTERESIS / 2; // fits, but not with the margin
    expect(rowStacked(false, m(tight), true)).toBe(false);
    expect(rowStacked(true, m(tight), true)).toBe(true);
    expect(rowStacked(true, m(room - 62 - STACK_HYSTERESIS), true)).toBe(false);
    expect(rowStacked(false, m(room - 62 + 1), true)).toBe(true);
  });

  it('no caption buttons (browser, macOS): never stacked', () => {
    expect(rowStacked(false, at(700, 0, 300), false)).toBe(false);
    expect(rowStacked(true, at(1024), false)).toBe(false);
  });

  it('the 审阅 count: nothing for 0, the number up to 99, then 99+ (it has a fixed two-digit room either way)', () => {
    expect(countText(0)).toBe('');
    expect(countText(3)).toBe('3');
    expect(countText(42)).toBe('42');
    expect(countText(99)).toBe('99');
    expect(countText(1400)).toBe('99+');
  });

  it('the caption buttons sit over a head row in the default interface, a bar with the workbench tools', () => {
    const base = { settings: false, dockOpen: false, workbench: false, groupBar: false, chromeRow: false };
    expect(captionRow(base)).toBe('head'); // a session header, the home page, the automation page
    expect(captionRow({ ...base, dockOpen: true })).toBe('head'); // the default right panel's tab row
    expect(captionRow({ ...base, chromeRow: true })).toBe('bar'); // a tab strip (split view, a document in front)
    expect(captionRow({ ...base, workbench: true, groupBar: true, chromeRow: true })).toBe('bar'); // the group bar
    expect(captionRow({ ...base, workbench: true, groupBar: true, chromeRow: true, dockOpen: true })).toBe('bar'); // the panel's row under a group bar
    expect(captionRow({ ...base, workbench: true, chromeRow: true, dockOpen: true })).toBe('head'); // …without one it is a head row
    // the default panel's row stays a head row beside a group bar (two groups, the tools off)
    expect(captionRow({ ...base, groupBar: true, chromeRow: true, dockOpen: true })).toBe('head');
    // the settings page covers all of it: its drag strip is a head row whatever is under the page
    expect(captionRow({ ...base, settings: true, workbench: true, groupBar: true, chromeRow: true, dockOpen: true })).toBe('head');
  });

  it('their area ends where that row ends: never below it, the glyphs half a gap above the icons of the row', () => {
    const px = { gap: SHELL_GAP, head: 52, bar: 40 };
    expect(captionHeight('head', px)).toBe(60);
    expect(captionHeight('bar', px)).toBe(48);
    for (const row of ['head', 'bar'] as const) {
      const h = captionHeight(row, px), rowH = row === 'head' ? px.head : px.bar;
      expect(h).toBeLessThanOrEqual(px.gap + rowH); // what is under the row is never covered
      expect(px.gap + rowH / 2 - h / 2).toBe(px.gap / 2); // glyph centre vs the row's centre
    }
    expect(captionHeight('head', { ...px, gap: 4 })).toBe(56); // compact density
    expect(captionHeight('head', { ...px, gap: 0 })).toBe(52); // Linux: the card touches the window's edge
    // a stylesheet that has not loaded (NaN from parseFloat('')) gives the default, and a wild value is clamped
    expect(captionHeight('head', { gap: NaN, head: NaN, bar: NaN })).toBe(60);
    expect(captionHeight('head', { gap: 8, head: 400, bar: 40 })).toBe(80);
    expect(captionHeight('bar', { gap: 0, head: 52, bar: 10 })).toBe(32);
  });
});
