import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { poolWatch } from './runtime.js';

/** A pool: events carry the session id; `get` says which runner currently holds it. */
function fakePool() {
  const pool = new EventEmitter() as EventEmitter & { live: Map<string, { state: string }>; get(id: string): { state: string } | undefined };
  pool.live = new Map();
  pool.get = (id) => pool.live.get(id);
  return pool;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('poolWatch (I6 / N5)', () => {
  it('delivers events by session id, whichever runner emits them', () => {
    const pool = fakePool();
    const got: unknown[] = [];
    const off = poolWatch(pool as any, 's1', { message: (m) => got.push(m) }, 10);
    pool.emit('message', 's2', 'other');
    pool.emit('message', 's1', 'from runner A');
    pool.emit('message', 's1', 'from runner B'); // hot-swapped runner, same id
    off();
    pool.emit('message', 's1', 'after off');
    expect(got).toEqual(['from runner A', 'from runner B']);
  });

  it("a hot swap (announced with 'swapping') is a handover, not a close — and is reported as swapped", async () => {
    const pool = fakePool();
    const states: string[] = [];
    let swapped = 0;
    poolWatch(pool as any, 's1', { state: (s) => states.push(s), swapped: () => { swapped++; } }, 30);
    pool.emit('swapping', 's1');
    pool.emit('state', 's1', 'closed');
    pool.live.set('s1', { state: 'starting' });
    await wait(60);
    expect(states).toEqual([]);
    expect(swapped).toBe(1);
  });

  it('a close without the swap signal counts right away, even if the same id is reopened quickly', async () => {
    const pool = fakePool();
    const states: string[] = [];
    poolWatch(pool as any, 's1', { state: (s) => states.push(s) }, 30);
    pool.emit('state', 's1', 'closed');
    pool.live.set('s1', { state: 'starting' }); // e.g. the user reopening it from the sidebar
    expect(states).toEqual(['closed']);
  });

  it('a swap that never produces a new runner still ends as closed; errors are immediate', async () => {
    const pool = fakePool();
    const states: string[] = [];
    poolWatch(pool as any, 's1', { state: (s) => states.push(s) }, 20);
    pool.emit('state', 's1', 'error', 'boom');
    pool.emit('swapping', 's1');
    pool.emit('state', 's1', 'closed');
    expect(states).toEqual(['error']);
    await wait(50);
    expect(states).toEqual(['error', 'closed']);
  });
});
