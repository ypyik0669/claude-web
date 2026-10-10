import { describe, expect, it } from 'vitest';
import { MAX_TOASTS, mergeToasts, stackToasts, type ToastEntry } from './toast-stack';

const t = (id: number, text = `t${id}`, ok?: boolean) => ({ id, text, ok });

describe('mergeToasts: what is on screen = the store\'s toasts + the ones still leaving', () => {
  it('new toasts are appended in the store\'s order', () => {
    expect(mergeToasts([], [t(1), t(2)])).toEqual([t(1), t(2)]);
    expect(mergeToasts([t(1)], [t(1), t(2)])).toEqual([t(1), t(2)]);
  });
  it('a toast gone from the store stays where it was, marked as leaving', () => {
    const next = mergeToasts([t(1), t(2), t(3)], [t(1), t(3)]);
    expect(next).toEqual([t(1), { ...t(2), out: true }, t(3)]);
  });
  it('one already leaving stays leaving; a new one comes after it', () => {
    const prev: ToastEntry[] = [{ ...t(1), out: true }, t(2)];
    expect(mergeToasts(prev, [t(2), t(3)])).toEqual([{ ...t(1), out: true }, t(2), t(3)]);
  });
  it('nothing changed: the same list object (no re-render)', () => {
    const prev: ToastEntry[] = [t(1), { ...t(2), out: true }];
    expect(mergeToasts(prev, [t(1)])).toBe(prev);
  });
  it('a toast the store rewrote (same id — a keyed one: 界面缩放 110% → 125%) shows the new text where it is', () => {
    const prev: ToastEntry[] = [t(1), t(2, '界面缩放 110%', true), t(3)];
    const next = mergeToasts(prev, [t(1), t(2, '界面缩放 125%', true), t(3)]);
    expect(next).toEqual([t(1), t(2, '界面缩放 125%', true), t(3)]);
    expect(next).not.toBe(prev);
    expect(next[0]).toBe(prev[0]); // the others are the same objects
    // …and one that is already leaving keeps what it said
    const leaving: ToastEntry[] = [{ ...t(2, '界面缩放 110%'), out: true }];
    expect(mergeToasts(leaving, [])).toBe(leaving);
  });
});

describe('stackToasts: at most three on screen, older ones higher and smaller', () => {
  it('the newest is at depth 0, each older one a step further back', () => {
    expect(stackToasts([t(1), t(2), t(3)])).toEqual([{ depth: 2, hidden: false }, { depth: 1, hidden: false }, { depth: 0, hidden: false }]);
  });
  it(`more than ${MAX_TOASTS}: the oldest are not shown (they come back when newer ones go)`, () => {
    const s = stackToasts([t(1), t(2), t(3), t(4)]);
    expect(s.map((x) => x.hidden)).toEqual([true, false, false, false]);
    expect(s.map((x) => x.depth)).toEqual([3, 2, 1, 0]);
  });
  it('a leaving toast does not push the others back: the ones behind it step forward at once', () => {
    const s = stackToasts([t(1), t(2), { ...t(3), out: true }]);
    expect(s).toEqual([{ depth: 1, hidden: false }, { depth: 0, hidden: false }, { depth: 0, hidden: false }]);
    // …so a fourth one that was hidden shows as soon as a newer one starts to leave
    expect(stackToasts([t(1), t(2), { ...t(3), out: true }, t(4)]).map((x) => x.hidden)).toEqual([false, false, false, false]);
  });
  it('a leaving toast keeps the depth it has among the live ones after it', () => {
    expect(stackToasts([{ ...t(1), out: true }, t(2), t(3)])[0]).toEqual({ depth: 2, hidden: false });
    expect(stackToasts([{ ...t(1), out: true }, t(2), t(3), t(4)])[0]).toEqual({ depth: 3, hidden: true });
  });
  it('empty in, empty out', () => expect(stackToasts([])).toEqual([]));
});
