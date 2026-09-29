import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLOSE_MENUS } from '@/ui/menus';
import { aboveCover, coverApp } from './cover';

/** Just enough of an element for coverApp: classes, attributes, children, focus. */
class El {
  nodeType = 1;
  attrs = new Map<string, string>();
  children: El[] = [];
  parentElement: El | null = null;
  focused = 0;
  constructor(public cls: string[] = []) {}
  add(...kids: El[]) { for (const k of kids) { k.parentElement = this; this.children.push(k); } return this; }
  /** class selectors only: `.a.b, .c`, and `:scope > .x.y` for querySelector */
  matches(sel: string): boolean {
    return sel.split(',').some((one) => one.trim().split('.').filter(Boolean).every((c) => this.cls.includes(c)));
  }
  querySelector(sel: string): El | null {
    const inner = sel.replace(/^:scope\s*>\s*/, '');
    return this.children.find((k) => k.matches(inner)) ?? null;
  }
  contains(x: El): boolean { return x === this || this.children.some((k) => k.contains(x)); }
  hasAttribute(n: string) { return this.attrs.has(n); }
  setAttribute(n: string, v: string) { this.attrs.set(n, v); }
  removeAttribute(n: string) { this.attrs.delete(n); }
  get isConnected(): boolean { let e: El | null = this; while (e?.parentElement) e = e.parentElement; return e === app.parentElement || e === app; }
  focus() { this.focused++; }
}

/** MutationObserver stand-in: the test delivers the records. */
class FakeMO {
  static last: FakeMO | null = null;
  dead = false;
  constructor(public cb: (recs: { addedNodes: El[] }[]) => void) { FakeMO.last = this; }
  observe() {}
  disconnect() { this.dead = true; }
  add(parent: El, el: El) { parent.add(el); if (!this.dead) this.cb([{ addedNodes: [el] }]); }
}

let app: El;
const g = globalThis as any;
const saved = { MutationObserver: g.MutationObserver, document: g.document, window: g.window };
beforeEach(() => {
  g.MutationObserver = FakeMO;
  g.document = { body: new El(['body']) };
  g.window = new EventTarget();
  app = new El(['app']);
});
afterEach(() => { g.MutationObserver = saved.MutationObserver; g.document = saved.document; g.window = saved.window; });

describe('coverApp: the settings page takes the app underneath out of reach, and gives it back', () => {
  it('layers above the page stay usable: dialogs, palette, the shortcut sheet, toasts, viewer, crash cards, onboarding — the phone drawer does not', () => {
    for (const cls of [['modal-bg', 'dialog-bg'], ['palette-bg'], ['modal-bg', 'shortcuts-bg'], ['toast-wrap'], ['viewer'], ['err-boundary', 'floating']]) expect(aboveCover(new El(cls) as any), cls.join('.')).toBe(true);
    expect(aboveCover(new El(['modal-bg']).add(new El(['modal', 'onboarding'])) as any)).toBe(true);
    // fixed at z-index 60 on phones, but a live layer over the page is exactly what must not happen
    for (const cls of [['sidebar', 'has-resizer'], ['drawer-backdrop'], ['modal-bg'], ['center'], ['rpanel'], ['err-boundary']]) expect(aboveCover(new El(cls) as any), cls.join('.')).toBe(false);
  });

  it('inerts the other children of .app (also ones inserted while open), then removes exactly its own and restores focus', () => {
    const sidebar = new El(['sidebar']);
    const center = new El(['center']);
    const composer = new El(['textarea']);
    center.add(composer);
    const already = new El(['rpanel']);
    already.setAttribute('inert', ''); // somebody else's inert stays theirs
    const toasts = new El(['toast-wrap']);
    const page = new El(['modal', 'settings', 'sp']);
    app.add(sidebar, center, already, toasts, page);
    let menus = 0;
    (g.window as EventTarget).addEventListener(CLOSE_MENUS, () => menus++);

    const undo = coverApp(page as any, composer as any);
    expect(menus, 'open anchored menus are told to close').toBe(1);
    expect([sidebar, center, already].every((e) => e.hasAttribute('inert'))).toBe(true);
    expect(toasts.hasAttribute('inert')).toBe(false);
    expect(page.hasAttribute('inert')).toBe(false);

    // Ctrl+B while open: the sidebar is swapped for a placeholder, then back — both new nodes are covered
    const placeholder = new El(['sidebar']);
    FakeMO.last!.add(app, placeholder);
    expect(placeholder.hasAttribute('inert')).toBe(true);
    const drawer = new El(['sidebar', 'has-resizer']);
    FakeMO.last!.add(app, drawer);
    expect(drawer.hasAttribute('inert')).toBe(true);
    // a dialog asked for from inside the page is not
    const dialog = new El(['modal-bg', 'dialog-bg']);
    FakeMO.last!.add(app, dialog);
    expect(dialog.hasAttribute('inert')).toBe(false);

    undo();
    expect([sidebar, center, placeholder, drawer].some((e) => e.hasAttribute('inert'))).toBe(false);
    expect(already.hasAttribute('inert'), 'inert it did not set is left alone').toBe(true);
    expect(composer.focused).toBe(1);
    // after close nothing new is covered
    const late = new El(['sidebar']);
    FakeMO.last!.add(app, late);
    expect(late.hasAttribute('inert')).toBe(false);
  });

  it('does not hand focus back to an element that left the document, or to <body>', () => {
    const page = new El(['modal', 'settings', 'sp']);
    const gone = new El(['menu']); // a portal menu row: closed when the page opened
    app.add(new El(['center']), page);
    coverApp(page as any, gone as any)();
    expect(gone.focused).toBe(0);
    const body = g.document.body as El;
    coverApp(page as any, body as any)();
    expect(body.focused).toBe(0);
  });
});
