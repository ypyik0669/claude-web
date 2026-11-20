import { describe, expect, it } from 'vitest';
import { movedLines, showMovedNotice } from './moved-notice';

describe('「东西搬到哪了」', () => {
  it('shows once to someone who used Claude Web before, never to a fresh install, never after dismissing', () => {
    const base = { metaLoaded: true, seen: false, onboarded: true, projects: 2 };
    expect(showMovedNotice(base)).toBe(true);
    expect(showMovedNotice({ ...base, onboarded: false })).toBe(true); // an old install that skipped the wizard
    expect(showMovedNotice({ ...base, onboarded: false, projects: 0 })).toBe(false); // a fresh install
    expect(showMovedNotice({ ...base, seen: true })).toBe(false);
    expect(showMovedNotice({ ...base, metaLoaded: false })).toBe(false); // settings not in yet: nothing flashes up
  });

  it('names no keyboard shortcut on a phone', () => {
    const phone = movedLines(true).map((l) => `${l.from} ${l.to}`).join('\n');
    expect(phone).not.toMatch(/Ctrl|Alt|Tab|Enter/);
    expect(movedLines(false).some((l) => /Ctrl K/.test(l.to))).toBe(true);
  });

  it('every line has its own id', () => {
    const ids = movedLines(false).map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
