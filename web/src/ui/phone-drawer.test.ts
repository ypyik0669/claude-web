// The phone's sidebar drawer, end to end without a browser: the real store and the real controller on fake elements
// that record what is set on them. The sidebar is 「mounted」 the way App mounts it: while `sidebarOpen` or `held`.
// Store stubs as in store/store.test.ts.
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
  scrollLeft = 0;
  scrollWidth = 100;
  clientWidth = 100;
  overflowX = 'visible';
  width = 0;
  captured: number[] = [];
  constructor(public is: string[] = [], public parentElement: FakeEl | null = null) { super(); }
  matches(q: string) { return q.split(',').map((s) => s.trim()).some((s) => this.is.includes(s)); }
  closest(q: string): FakeEl | null {
    for (let el: FakeEl | null = this; el; el = el.parentElement) if (el.matches(q)) return el;
    return null;
  }
  getBoundingClientRect() { return { top: 0, height: 0, width: this.width }; }
  get offsetHeight() { return 0; }
  setPointerCapture(id: number) { this.captured.push(id); }
  releasePointerCapture() {}
}

const mem = new Map<string, string>();
let store: typeof import('@/store').useStore;
let drawer: typeof import('./phone-drawer');
let menus: typeof import('./menus');

const win = Object.assign(new FakeTarget(), { matchMedia: undefined, innerHeight: 800, innerWidth: 390 });
const root = { dataset: {} as Record<string, string>, style: { setProperty() {}, removeProperty() {} }, classList: { toggle() {}, add() {}, remove() {} } };
let overApp: unknown = null;

const sidebar = new FakeEl(['.sidebar']);
sidebar.width = 320;
const sbRow = new FakeEl(['.sb-row'], sidebar);
const sbSearch = new FakeEl(['input'], sidebar);
const backdrop = new FakeEl(['.drawer-backdrop']);
/** the app element: its sidebar is in the document while App would have it mounted */
class App extends FakeEl {
  querySelector(q: string) {
    if (q.includes('.drawer-backdrop')) return backdrop;
    return store.getState().sidebarOpen || drawer.usePhoneDrawer.getState().held ? sidebar : null;
  }
}
const app = new App(['.app']);
const layer = new FakeEl(['.pane-layer'], app);
const pane = new FakeEl(['.pane'], layer);
const chat = new FakeEl(['.chat'], pane);
const msg = new FakeEl(['.msg'], chat);
const pre = new FakeEl(['pre'], msg);
let uninstall = () => {};

beforeAll(async () => {
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', { addEventListener() {}, hasFocus: () => true, querySelector: () => overApp, documentElement: root });
  vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) });
  vi.stubGlobal('location', { search: '', protocol: 'http:', host: 'x' });
  vi.stubGlobal('Element', FakeEl);
  vi.stubGlobal('HTMLElement', FakeEl);
  vi.stubGlobal('Node', FakeEl);
  vi.stubGlobal('getComputedStyle', (el: { overflowX?: string }) => ({ getPropertyValue: (n: string) => (n === '--dur-base' ? '180ms' : ''), transform: 'none', overflowX: el?.overflowX ?? 'visible' }));
  ({ useStore: store } = await import('@/store'));
  drawer = await import('./phone-drawer');
  menus = await import('./menus');
});

const held = () => drawer.usePhoneDrawer.getState().held;
const slid = () => app.fire('transitionend', { target: sidebar, propertyName: 'transform' });
const listening = () => win.count('pointermove') > 0;

beforeEach(() => {
  store.setState({ mobile: true, sidebarOpen: false, sheetAt: 0, settingsOpen: null, paletteOpen: false, shortcutsOpen: false });
  uninstall = drawer.installPhoneDrawer(app as unknown as HTMLElement);
  for (const el of [sidebar, backdrop]) { el.transforms.length = 0; el.dataset = {}; el.style.opacity = ''; }
});
afterEach(() => {
  uninstall();
  vi.useRealTimers();
  delete root.dataset.reduceMotion;
  overApp = null;
  for (const el of [chat, pre]) { el.scrollWidth = 100; el.scrollLeft = 0; el.overflowX = 'visible'; }
});

const ptr = (x: number, y: number, t: number, more: Record<string, unknown> = {}) => ({ pointerId: 5, isPrimary: true, pointerType: 'touch', clientX: x, clientY: y, timeStamp: t, ...more });
/** a finger down on `on` at (x0, 400), then moved by each [dx, dy] (16ms apart); returns the time of the last move */
const swipe = (on: FakeEl, x0: number, moves: [number, number][], more: Record<string, unknown> = {}) => {
  app.fire('pointerdown', { ...ptr(x0, 400, 0, more), target: on });
  moves.forEach(([dx, dy], i) => win.fire('pointermove', ptr(x0 + dx, 400 + dy, 16 * (i + 1))));
  return 16 * moves.length;
};

describe('a swipe to the right on the conversation', () => {
  it('after 15px the sidebar is mounted and under the finger; the backdrop comes with it', () => {
    swipe(msg, 100, [[10, 1]]);
    expect(held()).toBe(false);
    win.fire('pointermove', ptr(120, 402, 32));
    expect(held()).toBe(true);
    expect(store.getState().sidebarOpen).toBe(false); // not open until the release says so
    expect(sidebar.dataset.drag).toBe('');
    expect(sidebar.style.transform).toBe('translate3d(-320px, 0, 0)'); // it starts out of sight, where the finger took over
    expect(app.captured).toContain(5);
    win.fire('pointermove', ptr(220, 404, 48));
    expect(sidebar.style.transform).toBe('translate3d(-220px, 0, 0)');
    expect(Number(backdrop.style.opacity)).toBeCloseTo(100 / 320);
  });
  it('let go past 50px: open, with no transform left on it', () => {
    swipe(msg, 100, [[20, 0], [120, 3]]);
    win.fire('pointerup', ptr(220, 403, 2000));
    expect(store.getState().sidebarOpen).toBe(true);
    expect(held()).toBe(false);
    expect(sidebar.style.transform).toBe('');
    expect(sidebar.dataset.drag).toBeUndefined();
    expect(backdrop.style.opacity).toBe('');
    expect(backdrop.dataset.drag).toBeUndefined();
    expect(listening()).toBe(false);
  });
  it('let go before 50px: it slides back out, and is unmounted when it has', () => {
    swipe(msg, 100, [[20, 0], [40, 0]]);
    win.fire('pointerup', ptr(140, 400, 2000));
    expect(store.getState().sidebarOpen).toBe(false);
    expect(sidebar.style.transform).toBe('');
    expect(held()).toBe(true);
    slid();
    expect(held()).toBe(false);
  });
  it('a quick short swipe opens it', () => {
    const t = swipe(msg, 100, [[18, 0], [30, 0], [42, 0]]);
    win.fire('pointerup', ptr(146, 400, t + 4));
    expect(store.getState().sidebarOpen).toBe(true);
  });
  it('taken away mid-swipe (the browser scrolled after all): back out', () => {
    swipe(msg, 100, [[20, 0], [200, 0]]);
    win.fire('pointercancel', ptr(300, 400, 80));
    expect(store.getState().sidebarOpen).toBe(false);
    expect(sidebar.style.transform).toBe('');
    expect(listening()).toBe(false);
  });
  it('not from the left edge (the system’s back gesture), not up-and-down, not to the left', () => {
    swipe(msg, 20, [[60, 0]]);
    expect(listening()).toBe(false);
    swipe(msg, 100, [[4, 30]]);
    expect(listening()).toBe(false); // a scroll: given up
    swipe(msg, 100, [[-30, 0]]);
    expect(listening()).toBe(false);
    expect(held()).toBe(false);
  });
  it('a long press that then moves is selecting text, not swiping', () => {
    app.fire('pointerdown', { ...ptr(100, 400, 0), target: msg });
    win.fire('pointermove', ptr(103, 401, 300)); // the finger trembles in place
    win.fire('pointermove', ptr(160, 400, 600));
    expect(held()).toBe(false);
    expect(listening()).toBe(false);
    // …but a swipe that merely starts slowly is still a swipe
    app.fire('pointerdown', { ...ptr(100, 400, 1000), target: msg });
    win.fire('pointermove', ptr(110, 400, 1350));
    win.fire('pointermove', ptr(130, 400, 1700));
    expect(held()).toBe(true);
    win.fire('pointercancel', ptr(130, 400, 1710));
  });
  it('touch only, and only on the conversation with nothing over it', () => {
    const none = (on: FakeEl, more: Record<string, unknown> = {}) => { swipe(on, 100, [[60, 0]], more); expect(held()).toBe(false); expect(listening()).toBe(false); };
    none(msg, { pointerType: 'mouse' });
    none(msg, { isPrimary: false });
    none(new FakeEl(['textarea'], pane)); // typing
    none(new FakeEl(['.xterm'], pane));
    none(new FakeEl(['.starters'], pane));
    none(new FakeEl(['.auto-page'], layer));
    none(new FakeEl(['.rpanel'], app)); // not the conversation
    for (const over of [{ settingsOpen: { section: 'general' } as never }, { paletteOpen: true }, { shortcutsOpen: true }, { sheetAt: 5 }]) {
      store.setState(over);
      none(msg);
      store.setState({ settingsOpen: null, paletteOpen: false, shortcutsOpen: false, sheetAt: 0 });
    }
    overApp = {}; // a dialog
    none(msg);
    overApp = null;
    const release = menus.claimMenu(() => {});
    none(msg);
    release();
  });
  it('a code block that scrolls sideways keeps the browser’s panning; a conversation that does is panned by the swipe', () => {
    pre.scrollWidth = 900;
    pre.overflowX = 'auto';
    swipe(pre, 100, [[60, 0]]);
    expect(listening()).toBe(false);
    expect(held()).toBe(false);
    pre.scrollWidth = 100;
    chat.scrollWidth = 900; // a table wider than the window
    chat.overflowX = 'auto';
    chat.scrollLeft = 200;
    swipe(msg, 100, [[-20, 0], [-80, 2]]);
    expect(chat.scrollLeft).toBe(260);
    win.fire('pointermove', ptr(160, 400, 64));
    expect(chat.scrollLeft).toBe(120);
    expect(held()).toBe(false);
    win.fire('pointerup', ptr(160, 400, 80));
    expect(listening()).toBe(false);
    expect(store.getState().sidebarOpen).toBe(false);
  });
});

describe('a swipe to the left on the open drawer or its backdrop', () => {
  beforeEach(() => { store.setState({ sidebarOpen: true }); });
  it('follows the finger; past 30% of its width it closes, sliding out before it is unmounted', () => {
    swipe(sbRow, 200, [[-20, 0], [-140, 2]]);
    expect(sidebar.dataset.drag).toBe('');
    expect(sidebar.style.transform).toBe('translate3d(-120px, 0, 0)');
    expect(Number(backdrop.style.opacity)).toBeCloseTo(200 / 320);
    win.fire('pointerup', ptr(60, 402, 2000));
    expect(store.getState().sidebarOpen).toBe(false);
    expect(held()).toBe(true);
    expect(sidebar.style.transform).toBe('');
    expect(sidebar.dataset.drag).toBeUndefined();
    slid();
    expect(held()).toBe(false);
  });
  it('a short push: it comes back', () => {
    swipe(backdrop, 360, [[-20, 0], [-60, 0]]);
    win.fire('pointerup', ptr(300, 400, 2000));
    expect(store.getState().sidebarOpen).toBe(true);
    expect(held()).toBe(false);
    expect(sidebar.style.transform).toBe('');
  });
  it('scrolling its list, a text field, an open menu: not a swipe', () => {
    swipe(sbRow, 200, [[-3, 40]]);
    expect(listening()).toBe(false);
    swipe(sbSearch, 200, [[-60, 0]]);
    expect(listening()).toBe(false);
    const release = menus.claimMenu(() => {});
    swipe(sbRow, 200, [[-60, 0]]);
    expect(listening()).toBe(false);
    release();
    expect(sidebar.transforms).toEqual([]);
  });
});

describe('closed by anything else', () => {
  beforeEach(() => { store.setState({ sidebarOpen: true }); });
  it('it stays mounted until it has slid out', () => {
    store.setState({ sidebarOpen: false }); // the backdrop, a row picked, the back gesture
    expect(held()).toBe(true);
    app.fire('transitionend', { target: sbRow, propertyName: 'transform' });
    app.fire('transitionend', { target: sidebar, propertyName: 'opacity' });
    expect(held()).toBe(true);
    slid();
    expect(held()).toBe(false);
  });
  it('a window that is not being drawn: a timer lets go instead', () => {
    vi.useFakeTimers();
    store.setState({ sidebarOpen: false });
    vi.advanceTimersByTime(200);
    expect(held()).toBe(true);
    vi.advanceTimersByTime(200);
    expect(held()).toBe(false);
  });
  it('opened again on its way out: mounted by being open, nothing held', () => {
    store.setState({ sidebarOpen: false });
    store.setState({ sidebarOpen: true });
    expect(held()).toBe(false);
  });
  it('not with 减少动态效果, and not on a desktop', () => {
    root.dataset.reduceMotion = '1';
    store.setState({ sidebarOpen: false });
    expect(held()).toBe(false);
    delete root.dataset.reduceMotion;
    store.setState({ mobile: false, sidebarOpen: true });
    store.setState({ sidebarOpen: false });
    expect(held()).toBe(false);
  });
});

describe('drawerEnter', () => {
  const tap = () => win.fire('pointerdown', { isTrusted: true });
  it('a drawer a tap opened slides in from the left and ends with no transform', () => {
    store.setState({ sidebarOpen: true });
    tap();
    drawer.drawerEnter(sidebar as unknown as HTMLElement);
    expect(sidebar.transforms).toEqual(['translate3d(-100%, 0, 0)', '']);
    expect(sidebar.dataset.drag).toBeUndefined();
  });
  it('not one a swipe is pulling in, not on a desktop, not with 减少动态效果', () => {
    tap();
    drawer.drawerEnter(sidebar as unknown as HTMLElement); // a peek: sidebarOpen is still false
    store.setState({ mobile: false, sidebarOpen: true });
    drawer.drawerEnter(sidebar as unknown as HTMLElement);
    store.setState({ mobile: true });
    root.dataset.reduceMotion = '1';
    drawer.drawerEnter(sidebar as unknown as HTMLElement);
    expect(sidebar.transforms).toEqual([]);
  });
});
