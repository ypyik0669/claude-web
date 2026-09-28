import { describe, expect, it } from 'vitest';
import { authChecker } from './auth-check';

describe('welcome login check', () => {
  const setup = () => {
    let t = 0;
    const asked: boolean[] = [];
    const seen: unknown[] = [];
    const c = authChecker({ request: async (force) => { asked.push(force); return { loggedIn: force }; }, onResult: (r) => seen.push(r), focusGapMs: 30_000, now: () => t });
    return { c, asked, seen, at: (ms: number) => { t = ms; } };
  };

  it('mount asks without force (the server may answer from its cache)', async () => {
    const { c, asked, seen } = setup();
    await c.check();
    expect(asked).toEqual([false]);
    expect(seen).toEqual([{ loggedIn: false }]);
  });

  it('重新检查 always forces', async () => {
    const { c, asked } = setup();
    await c.check();
    await c.check(true);
    await c.check(true);
    expect(asked).toEqual([false, true, true]);
  });

  it('coming back to the window forces a fresh check (a /login in a terminal), at most once per focusGapMs', async () => {
    const { c, asked, at } = setup();
    await c.check();
    at(10_000);
    await c.onFocus(); // too soon after the last check
    at(31_000);
    await c.onFocus();
    at(40_000);
    await c.onFocus();
    expect(asked).toEqual([false, true]);
  });

  it('a failed request reports an error result instead of throwing', async () => {
    const seen: unknown[] = [];
    const c = authChecker({ request: async () => { throw new Error('closed'); }, onResult: (r) => seen.push(r), focusGapMs: 1, now: () => 0 });
    await c.check();
    expect(seen).toEqual([{ loggedIn: false, error: true }]);
  });
});
