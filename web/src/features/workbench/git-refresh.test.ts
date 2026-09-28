import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coalesce, gitEventConcerns, pathUnder } from './git-refresh';

describe('pathUnder', () => {
  it('matches the base itself and anything below it, any slash style / case / trailing slash', () => {
    expect(pathUnder('C:\\Repo', ['c:/repo/'])).toBe(true);
    expect(pathUnder('C:\\Repo\\src\\a.ts', ['C:/repo'])).toBe(true);
    expect(pathUnder('C:\\Repo2\\a.ts', ['C:/repo'])).toBe(false); // a sibling sharing the prefix
    expect(pathUnder('C:\\other', [null, undefined, ''])).toBe(false);
  });
});

describe('gitEventConcerns (files-tab git badges)', () => {
  // a junction / symlinked workspace: fs events come in the cwd's form, git reports the resolved root
  const scope = { cwd: 'D:\\work\\proj', root: 'C:\\real\\proj' };

  it('git.changed for the resolved root, or for the cwd form', () => {
    expect(gitEventConcerns({ kind: 'git.changed', cwd: 'C:\\real\\proj' }, scope)).toBe(true);
    expect(gitEventConcerns({ kind: 'git.changed', cwd: 'D:\\work\\proj' }, scope)).toBe(true);
    expect(gitEventConcerns({ kind: 'git.changed', cwd: 'C:\\elsewhere' }, scope)).toBe(false);
  });

  it('fs.changed under either the cwd or the root', () => {
    expect(gitEventConcerns({ kind: 'fs.changed', path: 'D:\\work\\proj\\src\\a.ts', type: 'change' }, scope)).toBe(true);
    expect(gitEventConcerns({ kind: 'fs.changed', path: 'C:\\real\\proj\\README.md', type: 'change' }, scope)).toBe(true);
    expect(gitEventConcerns({ kind: 'fs.changed', path: 'D:\\work\\other\\a.ts', type: 'change' }, scope)).toBe(false);
  });

  it('before the first status (root unknown) the cwd alone decides; other events never match', () => {
    expect(gitEventConcerns({ kind: 'fs.changed', path: 'D:\\work\\proj\\a', type: 'change' }, { cwd: 'D:\\work\\proj', root: null })).toBe(true);
    expect(gitEventConcerns({ kind: 'sessions.changed' } as any, scope)).toBe(false);
  });
});

describe('coalesce', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('a burst runs once, after the quiet period', () => {
    const fn = vi.fn();
    const c = coalesce(fn, 400, 2000);
    c.trigger(); vi.advanceTimersByTime(200);
    c.trigger(); vi.advanceTimersByTime(399);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a steady stream of events still refreshes at least every maxWait', () => {
    const fn = vi.fn();
    const c = coalesce(fn, 400, 2000);
    for (let t = 0; t < 5000; t += 100) { c.trigger(); vi.advanceTimersByTime(100); }
    // events every 100 ms never leave 400 ms of quiet: without maxWait this would be 0
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(fn.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('cancel drops a pending run', () => {
    const fn = vi.fn();
    const c = coalesce(fn, 400, 2000);
    c.trigger(); c.cancel();
    vi.advanceTimersByTime(5000);
    expect(fn).not.toHaveBeenCalled();
  });
});
