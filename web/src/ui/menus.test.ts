// One anchored menu at a time (re-review N2): opening a menu closes every other one, never itself.
import { afterEach, describe, expect, it } from 'vitest';
import { claimMenu, closeAnchoredMenus } from './menus';

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
