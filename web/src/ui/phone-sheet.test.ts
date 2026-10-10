// The phone's bottom sheet, end to end without a browser: the real store and the real controller on fake elements
// that record what is set on them (listeners, `data-drag`, the inline transform). Store stubs as in store/store.test.ts.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/ws/client', () => ({
  authToken: () => null,
  ws: { onStatus: null, connect() {}, on() { return () => {}; }, async request() { return null; } },
}));

type Fn = (e: any) => void;
class FakeTarget {
  private ls = new Map<string, Set<Fn>>();
  addEventListener(type: string, fn: Fn) { if (!this.ls.has(type)) this.ls.set(type, new Set()); this.ls.get(type)!.add(fn); }
  removeEventListener(type: string, fn: Fn) { this.ls.get(type)?.delete(fn); }
  dispatchEvent(e: { type: string }) { this.fire(e.type, e); return true; }
  /** the listeners get `e` itself (so a test can see what they did to it), with its type filled in */
  fire(type: string, e: object = {}) {
    const ev = e as { type?: string };
    if (ev.type !== type) ev.type = type;
    for (const fn of [...(this.ls.get(type) ?? [])]) fn(ev);
  }
  count(type: string) { return this.ls.get(type)?.size ?? 0; }
}
class FakeEl extends FakeTarget {
  dataset: Record<string, string> = {};
  transforms: string[] = [];
  style = (() => { const self = this; let t = ''; return { opacity: '', get transform() { return t; }, set transform(v: string) { t = v; self.transforms.push(v); } }; })();
  scrollTop = 0;
  scrollWidth = 100;
  clientWidth = 100;
  overflowX = 'visible';
  captured: number[] = [];
  constructor(public is: string[] = [], public parentElement: FakeEl | null = null) { super(); }
  closest(q: string): FakeEl | null {
    const want = q.split(',').map((s) => s.trim());
    for (let el: FakeEl | null = this; el; el = el.parentElement) if (el.is.some((s) => want.includes(s))) return el;
    return null;
  }
  getBoundingClientRect() { return { top: 0, height: 0, width: 0 }; }
  get offsetHeight() { return 0; }
  setPointerCapture(id: number) { this.captured.push(id); }
  releasePointerCapture() {}
}

const WINDOW_H = 800; // 半 = 496, 全 = 736
const mem = new Map<string, string>();
let store: typeof import('@/store').useStore;
let hideSheet: typeof import('@/store').hideSheet;
let sheet: typeof import('./phone-sheet');
let menus: typeof import('./menus');

/** the sheet: as tall as its detent says, its top where its transform puts it */
class Panel extends FakeEl {
  getBoundingClientRect() {
    const height = store.getState().sheetDetent === 'full' ? 736 : 496;
    const y = /translate3d\(0, (-?[\d.]+)px/.exec(this.style.transform)?.[1];
    return { top: WINDOW_H - height + (y ? Number(y) : 0), height, width: 390 };
  }
}

const win = Object.assign(new FakeTarget(), { matchMedia: undefined, innerHeight: WINDOW_H, innerWidth: 390 });
const root = { dataset: {} as Record<string, string>, style: { setProperty() {}, removeProperty() {} }, classList: { toggle() {}, add() {}, remove() {} } };
let overSheet: unknown = null; // what document.querySelector finds lying over the sheet
const panel = new Panel(['.rpanel']);
const backdrop = new FakeEl(['.sheet-backdrop']);
const grip = new FakeEl(['.sheet-grip'], panel);
const dock = new FakeEl(['.dock'], panel);
const tab = new FakeEl(['.tab'], new FakeEl(['.dock-tabs'], dock));
const body = new FakeEl(['.dock-body'], dock);
const list = new FakeEl(['.rv-list'], body); // a panel's scroller
const row = new FakeEl(['.rv-row'], list);
let uninstall = () => {};

beforeAll(async () => {
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', { addEventListener() {}, hasFocus: () => true, querySelector: () => overSheet, documentElement: root });
  vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) });
  vi.stubGlobal('location', { search: '', protocol: 'http:', host: 'x' });
  vi.stubGlobal('Element', FakeEl);
  vi.stubGlobal('HTMLElement', FakeEl);
  vi.stubGlobal('Node', FakeEl);
  vi.stubGlobal('getComputedStyle', (el: { overflowX?: string }) => ({ getPropertyValue: (n: string) => (n === '--dur-base' ? '180ms' : ''), transform: 'none', overflowX: el?.overflowX ?? 'visible' }));
  ({ useStore: store, hideSheet } = await import('@/store'));
  sheet = await import('./phone-sheet');
  menus = await import('./menus');
});

const up = () => store.getState().dispatchLayout({ t: 'dock.show', panel: 'files' });
const slid = () => panel.fire('transitionend', { target: panel, propertyName: 'transform' });
const leaving = () => sheet.useSheetLeaving.getState().leaving;

beforeEach(() => {
  store.setState({ mobile: true, sheetAt: 0, sheetDetent: 'half', settingsOpen: null, paletteOpen: false, shortcutsOpen: false });
  uninstall = sheet.installPhoneSheet(panel as unknown as HTMLElement, () => backdrop as unknown as HTMLElement);
  up();
  panel.transforms.length = 0;
});
afterEach(() => {
  uninstall();
  vi.useRealTimers();
  delete root.dataset.reduceMotion;
  overSheet = null;
  for (const el of [list, row]) { el.scrollTop = 0; el.scrollWidth = 100; el.overflowX = 'visible'; }
});

describe('the detent lives in the store', () => {
  it('up: 半; put away from 全: 半 again', () => {
    expect(store.getState()).toMatchObject({ sheetDetent: 'half' });
    expect(store.getState().sheetAt).toBeGreaterThan(0);
    store.setState({ sheetDetent: 'full' });
    hideSheet();
    expect(store.getState()).toMatchObject({ sheetAt: 0, sheetDetent: 'half' });
  });
  it('a tap on the handle: 半 ⇄ 全, the sheet sliding from where its top edge was', () => {
    sheet.toggleSheetDetent(panel as unknown as HTMLElement);
    expect(store.getState().sheetDetent).toBe('full');
    // its top was at 304 (800 − 496); 全 has it at 64: it starts 240px lower and slides up from there
    expect(panel.transforms).toContain('translate3d(0, 240px, 0)');
    expect(panel.style.transform).toBe('');
    expect(panel.dataset.drag).toBeUndefined();
    sheet.toggleSheetDetent(panel as unknown as HTMLElement);
    expect(store.getState().sheetDetent).toBe('half');
    expect(panel.transforms).toContain('translate3d(0, -240px, 0)');
    hideSheet();
    sheet.toggleSheetDetent(panel as unknown as HTMLElement); // down: nothing to resize
    expect(store.getState().sheetDetent).toBe('half');
  });
});

describe('sliding out', () => {
  it('put away, it stays displayed until its slide has ended', () => {
    expect(leaving()).toBe(false);
    hideSheet();
    expect(leaving()).toBe(true);
    panel.fire('transitionend', { target: grip, propertyName: 'transform' }); // something inside it
    panel.fire('transitionend', { target: panel, propertyName: 'opacity' });
    expect(leaving()).toBe(true);
    slid();
    expect(leaving()).toBe(false);
  });
  it('a window that is not being drawn: a timer lets go instead', () => {
    vi.useFakeTimers();
    hideSheet();
    vi.advanceTimersByTime(200);
    expect(leaving()).toBe(true);
    vi.advanceTimersByTime(200);
    expect(leaving()).toBe(false);
  });
  it('brought back up on its way out: it is up, not leaving', () => {
    hideSheet();
    up();
    expect(leaving()).toBe(false);
  });
  it('the slide up that has just ended is not the end of a slide out', () => {
    slid();
    hideSheet();
    expect(leaving()).toBe(true);
  });
  it('nothing slides with 减少动态效果, nor under the settings page', () => {
    root.dataset.reduceMotion = '1';
    hideSheet();
    expect(leaving()).toBe(false);
    delete root.dataset.reduceMotion;
    up();
    store.setState({ settingsOpen: { section: 'general' } as never });
    hideSheet();
    expect(leaving()).toBe(false);
  });
});

describe('sheetEnter', () => {
  const tap = () => win.fire('pointerdown', { isTrusted: true });
  const typed = () => win.fire('keydown', { isTrusted: true });
  const enter = () => { panel.transforms.length = 0; sheet.sheetEnter(panel as unknown as HTMLElement); return panel.transforms; };
  it('brought up by a tap it starts below the screen and slides up — once', () => {
    hideSheet();
    slid();
    tap();
    up();
    expect(enter()).toEqual(['translate3d(0, 100%, 0)', '']);
    expect(panel.dataset.drag).toBeUndefined();
    expect(enter()).toEqual([]);
  });
  it('not when it is brought back while still sliding out, nor when the keyboard (or a script) brought it up', () => {
    tap();
    hideSheet();
    up(); // still on screen: its own transition turns it round
    expect(enter()).toEqual([]);
    hideSheet();
    slid();
    typed();
    up();
    expect(enter()).toEqual([]);
  });
  it('not with 减少动态效果', () => {
    hideSheet();
    slid();
    root.dataset.reduceMotion = '1';
    tap();
    up();
    expect(enter()).toEqual([]);
  });
});

const ptr = (y: number, t: number, more: Record<string, unknown> = {}) => ({ pointerId: 7, isPrimary: true, pointerType: 'touch', button: 0, clientX: 195, clientY: y, timeStamp: t, ...more });
/** press on `on` at y0 and move through `ys` (16ms apart) */
const dragFrom = (on: FakeEl, y0: number, ys: number[]) => {
  panel.fire('pointerdown', { ...ptr(y0, 0), target: on });
  ys.forEach((y, i) => win.fire('pointermove', ptr(y, 16 * (i + 1))));
  return 16 * ys.length;
};

describe('a drag on the handle or the tab row', () => {
  it('a press that barely moves is a tap: nothing is dragged, the click goes through', () => {
    dragFrom(grip, 310, [314, 318]);
    expect(panel.dataset.drag).toBeUndefined();
    win.fire('pointerup', ptr(318, 400));
    expect(panel.transforms).toEqual([]);
    expect(win.count('click')).toBe(0);
    expect(win.count('pointermove')).toBe(0);
  });
  it('past 10px up-or-down it follows the finger, the backdrop with it; sideways it does not', () => {
    panel.fire('pointerdown', { ...ptr(310, 0), target: tab });
    win.fire('pointermove', ptr(312, 16, { clientX: 260 })); // along the tab row
    expect(panel.dataset.drag).toBeUndefined();
    win.fire('pointermove', ptr(330, 32));
    expect(panel.dataset.drag).toBe('');
    expect(backdrop.dataset.drag).toBe('');
    expect(panel.captured).toContain(7);
    win.fire('pointermove', ptr(430, 48));
    expect(panel.style.transform).toBe('translate3d(0, 100px, 0)');
    expect(Number(backdrop.style.opacity)).toBeCloseTo(396 / 496);
    win.fire('pointercancel', ptr(430, 64)); // taken away: back where it was
    expect(panel.style.transform).toBe('');
    expect(panel.dataset.drag).toBeUndefined();
    expect(backdrop.style.opacity).toBe('');
    expect(store.getState().sheetAt).toBeGreaterThan(0);
  });
  it('let go more than 70px down from 半: put away — and the release is not a click on the tab it began on', () => {
    vi.useFakeTimers();
    dragFrom(tab, 310, [330, 380, 430]);
    win.fire('pointerup', ptr(430, 2000));
    expect(store.getState().sheetAt).toBe(0);
    expect(leaving()).toBe(true);
    expect(panel.style.transform).toBe('');
    expect(panel.dataset.drag).toBeUndefined();
    expect(backdrop.dataset.drag).toBeUndefined();
    expect(win.count('click')).toBe(1);
    vi.advanceTimersByTime(400);
    expect(win.count('click')).toBe(0);
    // (pointerup keeps the one listener ui/input-intent.ts has there for good)
    expect(win.count('pointermove') + win.count('pointercancel')).toBe(0);
  });
  it('let go 40px down: back to 半', () => {
    dragFrom(grip, 310, [330, 370]);
    win.fire('pointerup', ptr(370, 2000));
    expect(store.getState()).toMatchObject({ sheetDetent: 'half' });
    expect(store.getState().sheetAt).toBeGreaterThan(0);
    expect(panel.style.transform).toBe('');
  });
  it('let go more than 50px up: 全, sliding on from where the finger left it', () => {
    dragFrom(grip, 310, [296, 236]); // the drag begins at 296: 60px up
    expect(panel.style.transform).toBe('translate3d(0, -60px, 0)');
    win.fire('pointerup', ptr(236, 2000));
    expect(store.getState().sheetDetent).toBe('full');
    // top edge at 304 − 60 = 244; 全 rests at 64
    expect(panel.transforms[panel.transforms.length - 2]).toBe('translate3d(0, 180px, 0)');
    expect(panel.style.transform).toBe('');
  });
  it('a quick flick down from 全 goes to 半, not all the way', () => {
    store.setState({ sheetDetent: 'full' });
    const t = dragFrom(grip, 70, [84, 100, 120]);
    win.fire('pointerup', ptr(130, t + 8));
    expect(store.getState().sheetDetent).toBe('half');
    expect(store.getState().sheetAt).toBeGreaterThan(0);
  });
  it('not while the settings page covers it, and a mouse only with its main button', () => {
    panel.fire('pointerdown', { ...ptr(310, 0, { pointerType: 'mouse', button: 2 }), target: grip });
    expect(win.count('pointermove')).toBe(0);
    store.setState({ settingsOpen: { section: 'general' } as never });
    panel.fire('pointerdown', { ...ptr(310, 0), target: grip });
    expect(win.count('pointermove')).toBe(0);
  });
  it('put away from elsewhere mid-drag: the drag is over', () => {
    dragFrom(grip, 310, [330, 360]);
    hideSheet();
    expect(panel.dataset.drag).toBeUndefined();
    expect(panel.style.transform).toBe('');
    expect(win.count('pointermove')).toBe(0);
  });
});

const touch = (y: number, t: number, more: Record<string, unknown> = {}) => {
  const f = { identifier: 3, clientX: 195, clientY: y };
  const e = { touches: [f], changedTouches: [f], cancelable: true, timeStamp: t, prevented: 0, preventDefault() { e.prevented++; }, ...more };
  return e;
};
/** a finger down on `on` at 400, then moved to each of `ys`; returns the move events */
const pull = (on: FakeEl, ys: number[], more: Record<string, unknown> = {}) => {
  panel.fire('touchstart', { ...touch(400, 0), target: on });
  return ys.map((y, i) => { const e = touch(y, 16 * (i + 1), more); panel.fire('touchmove', e); return e; });
};

describe('pulling down inside a panel', () => {
  it('scrolled to its top: the pull takes the sheet with it, and the browser does not scroll', () => {
    const [a, b] = pull(row, [404, 430, 530]);
    expect(a.prevented).toBe(0); // within the slop: not decided yet
    expect(b.prevented).toBe(1);
    expect(panel.dataset.drag).toBe('');
    expect(panel.style.transform).toBe('translate3d(0, 100px, 0)'); // from where the drag began (430)
    panel.fire('touchend', touch(530, 2000));
    expect(store.getState().sheetAt).toBe(0);
  });
  it('not scrolled to the top: an ordinary scroll', () => {
    list.scrollTop = 40;
    const [, b] = pull(row, [404, 460]);
    expect(b.prevented).toBe(0);
    expect(panel.dataset.drag).toBeUndefined();
  });
  it('upwards, or more sideways than down: not a pull', () => {
    pull(row, [360]);
    expect(panel.dataset.drag).toBeUndefined();
    panel.fire('touchend', touch(360, 100));
    panel.fire('touchstart', { ...touch(400, 0), target: row });
    const sideways = touch(412, 16, { touches: [{ identifier: 3, clientX: 260, clientY: 412 }] });
    panel.fire('touchmove', sideways);
    expect(sideways.prevented).toBe(0);
    expect(panel.dataset.drag).toBeUndefined();
  });
  it('never from the terminal, a text field, or something that scrolls sideways', () => {
    for (const cls of ['.xterm', '.monaco-editor', 'textarea', 'input', '.term-keys']) {
      const [e] = pull(new FakeEl([cls], body), [460]);
      expect(e.prevented, cls).toBe(0);
      panel.fire('touchend', touch(460, 100));
    }
    list.scrollWidth = 900;
    list.overflowX = 'auto'; // a diff scrolling sideways
    const [e] = pull(row, [460]);
    expect(e.prevented).toBe(0);
    expect(panel.dataset.drag).toBeUndefined();
  });
  it('a long press that then moves is selecting text, not pulling', () => {
    panel.fire('touchstart', { ...touch(400, 0), target: row });
    const late = touch(460, 600);
    panel.fire('touchmove', late);
    expect(late.prevented).toBe(0);
    expect(panel.dataset.drag).toBeUndefined();
  });
  it('the browser already scrolls with this touch: it stays the browser’s', () => {
    const [e] = pull(row, [460], { cancelable: false });
    expect(e.prevented).toBe(0);
    expect(panel.dataset.drag).toBeUndefined();
  });
  it('not from the handle strip or the tab row (those are the pointer’s)', () => {
    const [e] = pull(tab, [460]);
    expect(e.prevented).toBe(0);
  });
});

describe('sheetTakesEscape', () => {
  const key = (target: unknown, more: Record<string, unknown> = {}) => ({ key: 'Escape', defaultPrevented: false, target, ...more }) as unknown as KeyboardEvent;
  const composer = new FakeEl(['textarea'], new FakeEl(['.composer']));
  it('Esc puts the sheet away — from the composer under it too', () => {
    expect(sheet.sheetTakesEscape(key(null))).toBe(true);
    expect(sheet.sheetTakesEscape(key(composer))).toBe(true);
    expect(sheet.sheetTakesEscape(key(row))).toBe(true);
    expect(sheet.sheetTakesEscape(key(composer, { key: 'Enter' }))).toBe(false);
  });
  it('not the terminal’s Esc, nor a field’s inside the sheet, nor the input method’s', () => {
    expect(sheet.sheetTakesEscape(key(new FakeEl(['.xterm'], body)))).toBe(false);
    expect(sheet.sheetTakesEscape(key(new FakeEl(['textarea'], body)))).toBe(false);
    expect(sheet.sheetTakesEscape(key(composer, { isComposing: true }))).toBe(false);
    expect(sheet.sheetTakesEscape(key(composer, { keyCode: 229 }))).toBe(false);
    expect(sheet.sheetTakesEscape(key(composer, { defaultPrevented: true }))).toBe(false);
  });
  it('a dialog or a menu over the sheet takes it first', () => {
    overSheet = {};
    expect(sheet.sheetTakesEscape(key(composer))).toBe(false);
    overSheet = null;
    const release = menus.claimMenu(() => {});
    expect(sheet.sheetTakesEscape(key(composer))).toBe(false);
    release();
    expect(sheet.sheetTakesEscape(key(composer))).toBe(true);
  });
});
