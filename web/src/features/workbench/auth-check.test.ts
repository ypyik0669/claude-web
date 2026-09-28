import { describe, expect, it } from 'vitest';
import { authChecker } from './auth-check';

describe('welcome login check', () => {
  const setup = (o: { loggedIn?: boolean; providers?: number } = {}) => {
    let t = 0;
    let providers = o.providers ?? 0;
    const asked: boolean[] = [];
    const seen: unknown[] = [];
    const c = authChecker({
      request: async (force) => { asked.push(force); return { loggedIn: o.loggedIn ?? false }; },
      onResult: (r) => seen.push(r),
      // what Welcome passes: only a "not logged in, and nothing else to use" screen is worth a fresh engine start
      recheckOnFocus: (last) => !!last && (last as { loggedIn?: boolean }).loggedIn === false && providers === 0,
      focusGapMs: 30_000,
      now: () => t,
    });
    return { c, asked, seen, at: (ms: number) => { t = ms; }, setProviders: (n: number) => { providers = n; } };
  };

  it('mount asks without force (the server may answer from its cache)', async () => {
    const { c, asked, seen } = setup();
    await c.check();
    expect(asked).toEqual([false]);
    expect(seen).toEqual([{ loggedIn: false }]);
  });

  it('重新检查 always forces', async () => {
    const { c, asked } = setup({ loggedIn: true });
    await c.check();
    await c.check(true);
    await c.check(true);
    expect(asked).toEqual([false, true, true]);
  });

  it('back in the window while logged out with no provider profile: a forced check, at most once per focusGapMs', async () => {
    const { c, asked, at } = setup({ loggedIn: false, providers: 0 });
    await c.check();
    at(10_000);
    await c.onFocus(); // too soon after the last check
    at(31_000);
    await c.onFocus();
    at(40_000);
    await c.onFocus();
    expect(asked).toEqual([false, true]);
  });

  it('no forced check on focus when logged in, or when a provider profile makes login irrelevant', async () => {
    const a = setup({ loggedIn: true });
    await a.c.check();
    a.at(60_000);
    await a.c.onFocus();
    expect(a.asked).toEqual([false]);

    const b = setup({ loggedIn: false, providers: 2 });
    await b.c.check();
    b.at(60_000);
    await b.c.onFocus();
    expect(b.asked).toEqual([false]);
    b.setProviders(0); // the last profile was deleted meanwhile
    b.at(120_000);
    await b.c.onFocus();
    expect(b.asked).toEqual([false, true]);
  });

  it('no forced check on focus before the first answer arrived', async () => {
    const { c, asked, at } = setup();
    at(60_000);
    await c.onFocus();
    expect(asked).toEqual([]);
  });

  it('a failed request reports an error result instead of throwing', async () => {
    const seen: unknown[] = [];
    const c = authChecker({ request: async () => { throw new Error('closed'); }, onResult: (r) => seen.push(r), recheckOnFocus: () => true, focusGapMs: 1, now: () => 0 });
    await c.check();
    expect(seen).toEqual([{ loggedIn: false, error: true }]);
  });
});
