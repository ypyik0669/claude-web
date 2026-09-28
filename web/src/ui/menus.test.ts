// One anchored menu at a time (re-review N2): opening a menu closes every other one, never itself.
import { afterEach, describe, expect, it } from 'vitest';
import { anchoredMenuOpen, claimMenu, closeAnchoredMenus } from './menus';

// the node test environment has no window: a bare EventTarget stands in for it
const g = globalThis as unknown as { window?: EventTarget };
const hadWindow = 'window' in g;
if (!hadWindow) g.window = new EventTarget();

describe('claimMenu', () => {
  const offs: (() => void)[] = [];
  afterEach(() => { while (offs.length) offs.pop()!(); });

  it('the menu that opens closes the one already open, not itself', () => {
    const closed: string[] = [];
    offs.push(claimMenu(() => closed.push('a')));
    expect(closed).toEqual([]);
    offs.push(claimMenu(() => closed.push('b')));
    expect(closed).toEqual(['a']);
  });

  it('a menu that is gone (unsubscribed) is not called', () => {
    const closed: string[] = [];
    const off = claimMenu(() => closed.push('a'));
    off();
    offs.push(claimMenu(() => closed.push('b')));
    expect(closed).toEqual([]);
  });

  it('covering the app closes whichever menu is open', () => {
    const closed: string[] = [];
    offs.push(claimMenu(() => closed.push('a')));
    closeAnchoredMenus();
    expect(closed).toEqual(['a']);
  });
});

// polish P1: one Esc does one thing — while a menu is claimed the sidebar's multi-select leaves the key alone
describe('anchoredMenuOpen', () => {
  it('is true from the claim until the release, and a double release is harmless', () => {
    expect(anchoredMenuOpen()).toBe(false);
    const off = claimMenu(() => {});
    expect(anchoredMenuOpen()).toBe(true);
    off();
    expect(anchoredMenuOpen()).toBe(false);
    off();
    expect(anchoredMenuOpen()).toBe(false);
  });

  it('stays true while the next menu takes over (the first one is told to close, then releases)', () => {
    let releaseA = () => {};
    releaseA = claimMenu(() => releaseA());
    const offB = claimMenu(() => {});
    expect(anchoredMenuOpen()).toBe(true);
    offB();
    expect(anchoredMenuOpen()).toBe(false);
  });

  it('a menu that is told to close but has not released yet still counts (its Esc is not the sidebar’s)', () => {
    const off = claimMenu(() => {});
    closeAnchoredMenus();
    expect(anchoredMenuOpen()).toBe(true);
    off();
    expect(anchoredMenuOpen()).toBe(false);
  });
});
