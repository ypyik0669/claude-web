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

describe('poolWatch (I6)', () => {
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

  it("a 'closed' followed by a new runner under the same id (provider / agent swap) is not reported", async () => {
    const pool = fakePool();
    const states: string[] = [];
    poolWatch(pool as any, 's1', { state: (s) => states.push(s) }, 30);
    pool.emit('state', 's1', 'closed');
    pool.live.set('s1', { state: 'starting' });
    await wait(60);
    expect(states).toEqual([]);
  });

  it("a real close is reported after the grace period; errors immediately", async () => {
    const pool = fakePool();
    const states: string[] = [];
    poolWatch(pool as any, 's1', { state: (s) => states.push(s) }, 20);
    pool.emit('state', 's1', 'error', 'boom');
    pool.emit('state', 's1', 'closed');
    expect(states).toEqual(['error']);
    await wait(50);
    expect(states).toEqual(['error', 'closed']);
  });
});
