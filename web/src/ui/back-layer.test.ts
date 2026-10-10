import { describe, expect, it } from 'vitest';
import { createBackLayers, type BackHost } from './back-layer';

/**
 * A history like a browser's: entries and an index; pushState is synchronous and cuts off what was ahead; go() is
 * asynchronous (its popstate arrives on `flush()`). Pushing while a traversal is on its way is the thing Chromium
 * gets wrong (the new entry is dropped) — the fake throws, so a test fails if the code ever does it.
 */
function fakeHost(enabled = true) {
  const entries: unknown[] = [null];
  let index = 0;
  let listeners: (() => void)[] = [];
  const pendingGo: number[] = [];
  const deferred: (() => void)[] = [];
  const host: BackHost = {
    pushState: (d) => {
      if (pendingGo.length) throw new Error('pushState while a traversal is on its way');
      entries.length = index + 1;
      entries.push(d);
      index++;
    },
    go: (n) => { pendingGo.push(n); },
    get state() { return entries[index]; },
    onPop: (fn) => { listeners.push(fn); return () => { listeners = listeners.filter((l) => l !== fn); }; },
    defer: (fn) => { deferred.push(fn); },
    enabled: () => enabled,
  };
  const pop = (delta: number) => { index = Math.max(0, Math.min(entries.length - 1, index + delta)); for (const l of [...listeners]) l(); };
  /** run everything that was deferred and deliver every traversal, until nothing is left */
  const settle = () => {
    for (let i = 0; i < 50 && (deferred.length || pendingGo.length); i++) {
      while (deferred.length) deferred.shift()!();
      while (pendingGo.length) pop(pendingGo.shift()!);
    }
  };
  return {
    host,
    settle,
    /** only the deferred steps, traversals stay on their way */
    runDeferred: () => { while (deferred.length) deferred.shift()!(); },
    /** the user presses back / forward */
    userBack: () => pop(-1),
    userForward: () => pop(1),
    /** entries up to the current one */
    get index() { return index; },
    listening: () => listeners.length,
  };
}

describe('back layers', () => {
  it('each open layer has an entry; a back press closes the top layer and nothing else', () => {
    const h = fakeHost();
    const L = createBackLayers(h.host);
    const closed: string[] = [];
    L.push(() => closed.push('sheet'));
    L.push(() => closed.push('menu'));
    h.settle();
    expect(h.index).toBe(2);
    h.userBack();
    expect(closed).toEqual(['menu']);
    expect(L.depth).toBe(1);
    h.userBack();
    expect(closed).toEqual(['menu', 'sheet']);
    expect(L.depth).toBe(0);
    h.settle();
    expect(h.index).toBe(0);
  });

  it('a layer that closes by itself takes its entry back out, and that popstate closes nothing', () => {
    const h = fakeHost();
    const L = createBackLayers(h.host);
    const closed: string[] = [];
    L.push(() => closed.push('sheet'));
    const releaseMenu = L.push(() => closed.push('menu'));
    h.settle();
    releaseMenu();
    h.settle();
    expect(closed).toEqual([]);
    expect(L.depth).toBe(1);
    expect(h.index).toBe(1);
    h.userBack(); // the remaining layer still answers to back
    expect(closed).toEqual(['sheet']);
  });

  it('release after a back press does not go back a second time', () => {
    const h = fakeHost();
    const L = createBackLayers(h.host);
    let open = true;
    const release = L.push(() => { open = false; });
    h.settle();
    h.userBack();
    expect(open).toBe(false);
    release(); // the component unmounting after the close
    release();
    h.settle();
    expect(h.index).toBe(0);
  });

  it('one closes and another opens in the same commit: the entry is reused, nothing is pushed into a traversal', () => {
    const h = fakeHost();
    const L = createBackLayers(h.host);
    const closed: string[] = [];
    const releaseDrawer = L.push(() => closed.push('drawer'));
    h.settle();
    expect(h.index).toBe(1);
    releaseDrawer();                        // 账户 → 用量: the drawer shuts …
    L.push(() => closed.push('sheet'));     // … and the sheet comes up, before anything else runs
    h.settle();
    expect(h.index).toBe(1);                // still one entry: the sheet has it
    expect(closed).toEqual([]);
    h.userBack();
    expect(closed).toEqual(['sheet']);
    h.settle();
    expect(h.index).toBe(0);
  });

  it('a layer opened while our own traversal is on its way gets its entry once that has landed', () => {
    const h = fakeHost();
    const L = createBackLayers(h.host);
    const closed: string[] = [];
    const r = L.push(() => closed.push('a'));
    h.settle();
    r();
    h.runDeferred();                        // go(-1) is on its way now
    L.push(() => closed.push('b'));
    h.runDeferred();                        // must not push yet (the fake throws if it does)
    h.settle();
    expect(h.index).toBe(1);
    h.userBack();
    expect(closed).toEqual(['b']);
  });

  it('layers may close out of order', () => {
    const h = fakeHost();
    const L = createBackLayers(h.host);
    const closed: string[] = [];
    const releaseSheet = L.push(() => closed.push('sheet'));
    L.push(() => closed.push('menu'));
    h.settle();
    releaseSheet(); // the lower one goes first
    h.settle();
    expect(L.depth).toBe(1);
    expect(h.index).toBe(1);
    h.userBack();
    expect(closed).toEqual(['menu']);
  });

  it('a back press past several entries closes every layer above where it landed', () => {
    const h = fakeHost();
    const L = createBackLayers(h.host);
    const closed: string[] = [];
    L.push(() => closed.push('a'));
    L.push(() => closed.push('b'));
    h.settle();
    h.userBack();
    h.userBack();
    expect(closed).toEqual(['b', 'a']);
  });

  it('forward into an entry of ours with nothing open: it is taken back out, nothing is closed', () => {
    const h = fakeHost();
    const L = createBackLayers(h.host);
    const closed: string[] = [];
    L.push(() => closed.push('a'));
    h.settle();
    L.push(() => closed.push('b')); // keeps us listening
    h.settle();
    h.userBack();                   // closes b; its entry is ahead now
    expect(closed).toEqual(['b']);
    h.settle();
    h.userForward();                // back onto b's old entry
    h.settle();
    expect(closed).toEqual(['b']);
    expect(L.depth).toBe(1);
    expect(h.index).toBe(1);
  });

  it('marks its entry with the depth and stops listening once nothing is open', () => {
    const h = fakeHost();
    const L = createBackLayers(h.host);
    const release = L.push(() => {});
    h.settle();
    expect(h.host.state).toMatchObject({ cwLayer: 1 });
    expect(h.listening()).toBe(1);
    release();
    h.settle();
    expect(h.listening()).toBe(0);
    expect(h.index).toBe(0);
  });

  it('does nothing where it is not enabled (wide windows, the desktop app)', () => {
    const h = fakeHost(false);
    const L = createBackLayers(h.host);
    const release = L.push(() => { throw new Error('never'); });
    h.settle();
    expect(h.index).toBe(0);
    expect(L.depth).toBe(0);
    release();
    h.settle();
    expect(h.index).toBe(0);
  });
});
