import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { JsonRpcProcess } from '../agents/jsonrpc.js';
import { LazyRpc } from './lazy-rpc.js';

function fakeRpc() {
  const e = new EventEmitter() as EventEmitter & { exited: boolean; kill: ReturnType<typeof vi.fn>; request: ReturnType<typeof vi.fn> };
  e.exited = false;
  e.kill = vi.fn(() => { e.exited = true; });
  e.request = vi.fn(async (method: string) => ({ ok: method }));
  return e;
}

describe('LazyRpc', () => {
  it('close() while the process is still starting kills it when init finishes (no adopted orphan)', async () => {
    const procs: ReturnType<typeof fakeRpc>[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let first = true;
    const lazy = new LazyRpc(() => { const p = fakeRpc(); procs.push(p); return p as unknown as JsonRpcProcess; }, async () => { if (first) { first = false; await gate; } });
    const req = lazy.request('thread/list', {});
    await new Promise((r) => setTimeout(r, 5));
    await lazy.close();
    release();
    await expect(req).rejects.toThrow(/close\(\)/);
    expect(procs[0].kill).toHaveBeenCalled();
    expect(procs[0].request).not.toHaveBeenCalled();
    // and the next request starts a fresh process
    expect(await lazy.request('thread/list', {})).toEqual({ ok: 'thread/list' });
    expect(procs).toHaveLength(2);
    await lazy.close();
    expect(procs[1].kill).toHaveBeenCalled();
  });
});
