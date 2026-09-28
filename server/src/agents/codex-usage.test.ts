import { describe, expect, it } from 'vitest';
import { CodexUsageMeter } from './codex-usage.js';

const bd = (input: number, cached: number, output: number, cacheWrite = 0) => ({ totalTokens: input + output, inputTokens: input, cachedInputTokens: cached, cacheWriteInputTokens: cacheWrite, outputTokens: output, reasoningOutputTokens: 0 });
const add = (a: ReturnType<typeof bd>, b: ReturnType<typeof bd>) => bd(a.inputTokens + b.inputTokens, a.cachedInputTokens + b.cachedInputTokens, a.outputTokens + b.outputTokens, a.cacheWriteInputTokens + b.cacheWriteInputTokens);

describe('CodexUsageMeter', () => {
  it('cached (and cache-write) tokens are inside inputTokens: input excludes them', () => {
    const m = new CodexUsageMeter();
    m.beginTurn();
    const call = bd(20_000, 17_000, 50, 1_000);
    m.update({ total: call, last: call });
    expect(m.turn()).toEqual({ input: 2_000, cacheRead: 17_000, cacheWrite: 1_000, output: 50 });
  });

  it('a turn is the whole turn (total at end minus total at start), not the last call', () => {
    const m = new CodexUsageMeter();
    const c1 = bd(10_000, 0, 20);
    const c2 = bd(10_500, 9_900, 30);
    const c3 = bd(11_000, 10_400, 40);
    m.beginTurn();
    let total = c1;
    m.update({ total, last: c1 });
    total = add(total, c2);
    m.update({ total, last: c2 });
    m.update({ total, last: c2 }); // re-sent unchanged (rate-limit refresh): must not count twice
    expect(m.turn()).toEqual({ input: 10_600, cacheRead: 9_900, cacheWrite: 0, output: 50 });
    m.beginTurn();
    total = add(total, c3);
    m.update({ total, last: c3 });
    expect(m.turn()).toEqual({ input: 600, cacheRead: 10_400, cacheWrite: 0, output: 40 });
  });

  it('a resumed thread (first update carries earlier turns in total) starts from total − last', () => {
    const m = new CodexUsageMeter();
    const before = bd(500_000, 450_000, 9_000);
    const c1 = bd(30_000, 28_000, 100);
    const c2 = bd(31_000, 29_500, 60);
    m.beginTurn();
    m.update({ total: add(before, c1), last: c1 });
    m.update({ total: add(add(before, c1), c2), last: c2 });
    expect(m.turn()).toEqual({ input: 3_500, cacheRead: 57_500, cacheWrite: 0, output: 160 });
  });

  it('no update in a turn = zero usage; missing fields count as 0', () => {
    const m = new CodexUsageMeter();
    m.beginTurn();
    expect(m.turn()).toEqual({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
    m.update({ total: { inputTokens: 7, outputTokens: 1 } as any, last: { inputTokens: 7, outputTokens: 1 } as any });
    expect(m.turn()).toEqual({ input: 7, cacheRead: 0, cacheWrite: 0, output: 1 });
  });

  it('servers that only send `last` still add up per call', () => {
    const m = new CodexUsageMeter();
    m.beginTurn();
    m.update({ last: bd(100, 60, 5) });
    m.update({ last: bd(120, 90, 5) });
    expect(m.turn()).toEqual({ input: 70, cacheRead: 150, cacheWrite: 0, output: 10 });
  });
});
