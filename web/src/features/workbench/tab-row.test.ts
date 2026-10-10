import { describe, expect, it } from 'vitest';
import { CAPTION_W, MIN_STRIP, SEP_W, SHELL_GAP, SIDE_PAD, STACK_HYSTERESIS, captionHeight, captionHeightAt, captionRow, captionWidth, countText, fixedShort, ICON_TAB_W, panelColumnWidth, rowStacked, shortFixedWidth, tempTabWidth, tempsFolded, TEMP_TAB_CHROME, type RowMeasure } from './tab-row';

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

  it('界面缩放: the caption buttons keep their size in the window, so in the page they take 1 / zoom of the row', () => {
    expect(captionWidth()).toBe(CAPTION_W);
    expect(captionWidth(1)).toBe(CAPTION_W);
    expect(captionWidth(2)).toBe(CAPTION_W / 2);
    expect(captionWidth(0.5)).toBe(CAPTION_W * 2);
    expect(captionWidth(0)).toBe(CAPTION_W); // an unreadable factor is 100%
    // the area's height goes to the shell in the window's pixels: the row is `zoom` times as tall there
    const px = { gap: SHELL_GAP, head: 52, bar: 40 };
    expect(captionHeightAt(1, 'head', px)).toBe(60);
    expect(captionHeightAt(1.5, 'head', px)).toBe(90);
    expect(captionHeightAt(2, 'bar', px)).toBe(96);
    expect(captionHeightAt(0.5, 'head', px)).toBe(30);
    // a row that fits beside the buttons at 100% fits with room to spare zoomed in (the same window is fewer page
    // pixels wide, but that is the caller's `row`), and may have to move down zoomed out
    const m: RowMeasure = { row: 420, padLeft: 12, fixed: 201, controls: 62, gaps: 4 };
    expect(rowStacked(false, m, true, 1)).toBe(true); // 420 − 12 − 142 = 266 < 267
    expect(rowStacked(false, m, true, 1.25)).toBe(false); // 420 − 12 − 113.6 = 294.4
    expect(rowStacked(false, { ...m, row: 480 }, true, 1)).toBe(false);
    expect(rowStacked(false, { ...m, row: 480 }, true, 0.67)).toBe(true); // 480 − 12 − 211.9 = 256.1
    expect(rowStacked(false, m, false, 0.5)).toBe(false); // no caption buttons (a browser, macOS): never
    // the temporary strip gets what the buttons do not take
    const wide: RowMeasure = { ...m, row: 480 };
    expect(tempsFolded(wide, { stacked: false, caption: true, zoom: 1 })).toBe(true); // 480 − 12 − 142 − 267 − 13 = 46 < 56
    expect(tempsFolded(wide, { stacked: false, caption: true, zoom: 2 })).toBe(false); // 71 more
  });
});

// structure round 2: 浏览器 is a fifth fixed tab — five names do not fit beside the caption buttons of a 440px panel,
// so the fixed tabs have a short form (only the one in front named) before the row ever moves down
describe('the fixed tabs\' short form', () => {
  // five tabs as measured in the default look: 审阅 (with its count's room) 54, 文件 40, 终端 40, 浏览器 52, 任务 40; the group pads 2 + 2
  const tabs = [54, 40, 40, 52, 40];
  const fixed = tabs.reduce((a, b) => a + b, 0) + 4;
  const measure = (row: number): RowMeasure => ({ row, padLeft: 12, fixed, fixedShort: shortFixedWidth(fixed, tabs), controls: 58, gaps: 4 });

  it('short = the widest name plus an icon for each of the others (whichever tab is in front needs no more)', () => {
    expect(shortFixedWidth(fixed, tabs)).toBe(4 + 54 + 4 * ICON_TAB_W);
    expect(shortFixedWidth(100, [96])).toBe(100);
    expect(shortFixedWidth(0, [])).toBe(0);
  });
  it('1440 with the default 440 panel on Windows: short, and still beside the caption buttons', () => {
    const m = measure(440 - SHELL_GAP);
    const stacked = rowStacked(false, m, true);
    expect(stacked).toBe(false);
    expect(fixedShort(false, m, { stacked, caption: true })).toBe(true);
  });
  it('a wide panel names all five; the same panel in a browser (no caption buttons) too', () => {
    const wide = measure(560 - SHELL_GAP);
    expect(fixedShort(false, wide, { stacked: false, caption: true })).toBe(false);
    const web = measure(440 - SHELL_GAP);
    expect(fixedShort(false, web, { stacked: false, caption: false })).toBe(false);
  });
  it('the row moves down only when even the short form does not fit; down there the names are back if they fit', () => {
    const m = measure(360 - SHELL_GAP);
    expect(rowStacked(false, m, true)).toBe(true);
    expect(fixedShort(false, m, { stacked: true, caption: true })).toBe(false);
    const tiny = measure(300 - SHELL_GAP);
    expect(fixedShort(false, tiny, { stacked: true, caption: true })).toBe(true);
  });
  it('does not flip on a pixel: once short it needs the hysteresis to spare to name them all again', () => {
    const need = fixed + 58 + 4;
    const at = (room: number) => measure(room + 12 + SIDE_PAD);
    expect(fixedShort(false, at(need), { stacked: false, caption: false })).toBe(false);
    expect(fixedShort(true, at(need), { stacked: false, caption: false })).toBe(true);
    expect(fixedShort(true, at(need + STACK_HYSTERESIS), { stacked: false, caption: false })).toBe(false);
  });
  it('the strip of temporary tabs is judged with the form the fixed tabs are in', () => {
    const m = measure(440 - SHELL_GAP);
    expect(tempsFolded(m, { stacked: false, caption: true, short: true })).toBe(true);
    expect(tempsFolded(m, { stacked: false, caption: false, short: false })).toBe(tempsFolded({ ...m, fixedShort: undefined }, { stacked: false, caption: false }));
  });
  it('a row with no short form (one measured without it) behaves as before', () => {
    const m: RowMeasure = { row: 432, padLeft: 12, fixed: 194, controls: 58, gaps: 4 };
    expect(fixedShort(false, m, { stacked: false, caption: true })).toBe(false);
    expect(rowStacked(false, m, true)).toBe(false);
  });
});

describe('a strip too narrow for one whole tab', () => {
  it('a tab is its name plus what is around it: full-width characters one em, the rest a little over half', () => {
    expect(tempTabWidth('目标')).toBe(26 + TEMP_TAB_CHROME);
    expect(tempTabWidth('配置中心')).toBe(52 + TEMP_TAB_CHROME);
    expect(tempTabWidth('Android')).toBe(Math.ceil(7 * 13 * 0.6) + TEMP_TAB_CHROME);
    expect(tempTabWidth('配置中心', 15)).toBe(60 + TEMP_TAB_CHROME);
    expect(tempTabWidth('Issue 与 PR')).toBeGreaterThan(tempTabWidth('配置中心'));
  });
  it('folds instead of showing the tab cut off at the left (「配置中心」 in a 72px strip)', () => {
    // a browser window, five named tabs (300) in a 470px panel: 470 − 12 − 8 − 300 − 62 − 4 − 13 = 71 for the strip
    const m: RowMeasure = { row: 470, padLeft: 12, fixed: 300, controls: 62, gaps: 4 };
    expect(tempsFolded(m, { stacked: false, caption: false })).toBe(false); // ≥ MIN_STRIP: the old rule showed it
    expect(tempsFolded(m, { stacked: false, caption: false, need: tempTabWidth('目标') })).toBe(false); // 64 fits
    expect(tempsFolded(m, { stacked: false, caption: false, need: tempTabWidth('配置中心') })).toBe(true); // 90 does not
    // with room for it, it is a tab of the strip again
    expect(tempsFolded({ ...m, row: 490 }, { stacked: false, caption: false, need: tempTabWidth('配置中心') })).toBe(false);
  });
  it('never asks for less than MIN_STRIP', () => {
    const m: RowMeasure = { row: 440, padLeft: 12, fixed: 300, controls: 62, gaps: 4 }; // 41 for the strip
    expect(tempsFolded(m, { stacked: false, caption: false, need: 0 })).toBe(true);
    expect(MIN_STRIP).toBeGreaterThan(41);
  });
});
