import { describe, expect, it } from 'vitest';
import { viewerTakesEsc, type EscScene } from './viewer-esc';

const open: EscScene = { key: 'Escape', defaultPrevented: false, composing: false, menuOpen: false, dialogAbove: false, topmost: true };

describe('viewerTakesEsc: the full-window viewer and Esc, innermost first (issue #17)', () => {
  it('a plain Esc closes the viewer on top', () => {
    expect(viewerTakesEsc(open)).toBe(true);
  });
  it('other keys, and an Esc someone already took, are not its', () => {
    expect(viewerTakesEsc({ ...open, key: 'Enter' })).toBe(false);
    expect(viewerTakesEsc({ ...open, defaultPrevented: true })).toBe(false);
  });
  it('the Esc that cancels pinyin belongs to the input method', () => {
    expect(viewerTakesEsc({ ...open, composing: true })).toBe(false);
  });
  it('a dropdown open on a card closes first; a dialog over the viewer has the key', () => {
    expect(viewerTakesEsc({ ...open, menuOpen: true })).toBe(false);
    expect(viewerTakesEsc({ ...open, dialogAbove: true })).toBe(false);
  });
  it('a viewer under another one leaves it to that one', () => {
    expect(viewerTakesEsc({ ...open, topmost: false })).toBe(false);
  });
});
