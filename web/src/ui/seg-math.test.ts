import { describe, expect, it } from 'vitest';
import { segIndex, segStep, segVars } from './seg-math';

describe('segIndex: which option the thumb sits under', () => {
  it('the position of the value among the options', () => {
    expect(segIndex(['low', 'medium', 'high'], 'medium')).toBe(1);
    expect(segIndex(['low', 'medium', 'high'], 'low')).toBe(0);
  });
  it('nothing chosen, or a value the control does not offer: no thumb (−1)', () => {
    expect(segIndex(['low', 'medium'], null)).toBe(-1);
    expect(segIndex(['low', 'medium'], undefined)).toBe(-1);
    expect(segIndex(['low', 'medium'], 'max')).toBe(-1);
    expect(segIndex([], 'low')).toBe(-1);
  });
});

describe('segVars: what the stylesheet slides the thumb with', () => {
  it('the number of options and the chosen index', () => {
    expect(segVars(5, 2)).toEqual({ '--seg-n': 5, '--seg-i': 2 });
  });
  it('no choice parks the thumb under the first option (it is hidden then, and must not slide in from outside)', () => {
    expect(segVars(4, -1)).toEqual({ '--seg-n': 4, '--seg-i': 0 });
  });
  it('never divides by zero', () => {
    expect(segVars(0, -1)['--seg-n']).toBe(1);
  });
});

describe('segStep: the arrow keys of a radio group', () => {
  const all = [true, true, true, true];
  it('→ / ↓ go to the next option, ← / ↑ to the one before, both wrap', () => {
    expect(segStep(1, 'ArrowRight', all)).toBe(2);
    expect(segStep(3, 'ArrowRight', all)).toBe(0);
    expect(segStep(1, 'ArrowLeft', all)).toBe(0);
    expect(segStep(0, 'ArrowLeft', all)).toBe(3);
    expect(segStep(1, 'ArrowDown', all)).toBe(2);
    expect(segStep(1, 'ArrowUp', all)).toBe(0);
  });
  it('Home / End go to the first / last option', () => {
    expect(segStep(2, 'Home', all)).toBe(0);
    expect(segStep(1, 'End', all)).toBe(3);
  });
  it('disabled options are stepped over', () => {
    expect(segStep(0, 'ArrowRight', [true, false, false, true])).toBe(3);
    expect(segStep(3, 'ArrowRight', [false, true, true, true])).toBe(1);
    expect(segStep(2, 'Home', [false, true, true])).toBe(1);
    expect(segStep(0, 'End', [true, true, false])).toBe(1);
  });
  it('nothing chosen yet: → starts at the first option, ← at the last', () => {
    expect(segStep(-1, 'ArrowRight', all)).toBe(0);
    expect(segStep(-1, 'ArrowLeft', all)).toBe(3);
  });
  it('any other key, or nothing to move to: not ours', () => {
    expect(segStep(1, 'Enter', all)).toBeNull();
    expect(segStep(1, 'a', all)).toBeNull();
    expect(segStep(0, 'ArrowRight', [true])).toBeNull();
    expect(segStep(0, 'ArrowRight', [true, false])).toBeNull();
    expect(segStep(0, 'ArrowRight', [])).toBeNull();
  });
});
