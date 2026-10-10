import { describe, expect, it } from 'vitest';
import { foldClass, foldSettle, foldShown, foldTo, type FoldPhase } from './fold-phase';

const ALL: FoldPhase[] = ['closed', 'pre', 'opening', 'open', 'closing'];

describe('foldTo', () => {
  it('opening with an animation: laid out collapsed first, then it grows', () => {
    expect(foldTo('closed', true, true)).toBe('pre');
    expect(foldSettle('pre')).toBe('opening');
    expect(foldSettle('opening')).toBe('open');
  });
  it('closing with an animation: stays in the page until it has shrunk', () => {
    expect(foldTo('open', false, true)).toBe('closing');
    expect(foldShown('closing')).toBe(true);
    expect(foldSettle('closing')).toBe('closed');
    expect(foldShown('closed')).toBe(false);
  });
  it('without an animation it is open or closed at once, from any phase', () => {
    for (const p of ALL) {
      expect(foldTo(p, true, false)).toBe('open');
      expect(foldTo(p, false, false)).toBe('closed');
    }
  });
  it('a change of mind half way turns around instead of starting over', () => {
    expect(foldTo('closing', true, true)).toBe('opening');
    expect(foldTo('opening', false, true)).toBe('closing');
    // not laid out yet: nothing to shrink
    expect(foldTo('pre', false, true)).toBe('closed');
  });
  it('asking for the state it is already in (or on its way to) changes nothing', () => {
    expect(foldTo('open', true, true)).toBe('open');
    expect(foldTo('opening', true, true)).toBe('opening');
    expect(foldTo('pre', true, true)).toBe('pre');
    expect(foldTo('closed', false, true)).toBe('closed');
    expect(foldTo('closing', false, true)).toBe('closing');
  });
  it('a phase at rest stays as it is when its time is up', () => {
    expect(foldSettle('open')).toBe('open');
    expect(foldSettle('closed')).toBe('closed');
  });
});

describe('foldClass', () => {
  it('collapsed while it has no height, clipping while it moves, nothing at rest', () => {
    expect(foldClass('pre')).toBe('shut moving');
    expect(foldClass('closing')).toBe('shut moving');
    expect(foldClass('opening')).toBe('moving');
    expect(foldClass('open')).toBe('');
    expect(foldClass('closed')).toBe('');
  });
});
