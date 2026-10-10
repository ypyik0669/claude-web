import { describe, expect, it } from 'vitest';
import { floatBox, ghostClass } from './ghost-box';

describe('floatBox: a leaving card taken out of the flow, where it was', () => {
  it('anchored by its distance from the bottom of its offset parent (what is under it — the composer — stays put)', () => {
    // a 150px card 40px from the top of a 300px box: 110px of composer under it
    expect(floatBox({ offsetLeft: 0, offsetTop: 40, offsetWidth: 720, offsetHeight: 150 }, 300)).toEqual({ left: 0, bottom: 110, width: 720 });
  });
  it('never below the box', () => {
    expect(floatBox({ offsetLeft: 12, offsetTop: 200, offsetWidth: 300, offsetHeight: 150 }, 300)).toEqual({ left: 12, bottom: 0, width: 300 });
  });
});

describe('ghostClass: what the leaving copy is called', () => {
  it('adds the leaving class', () => {
    expect(ghostClass('menu cm perm-menu', { className: 'leaving' })).toBe('menu cm perm-menu leaving');
  });
  it('renames the class the page looks things up by, so the copy is never taken for the real thing', () => {
    expect(ghostClass('pdock tool', { className: 'leaving', rename: ['pdock', 'pdock-out'] })).toBe('pdock-out tool leaving');
    // only the whole class name, not a part of another one
    expect(ghostClass('pdock-x pdock', { className: 'leaving', rename: ['pdock', 'pdock-out'] })).toBe('pdock-x pdock-out leaving');
  });
});
