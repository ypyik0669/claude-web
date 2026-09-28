import { describe, expect, it } from 'vitest';
import { OrchImBridge } from './handlers.js';

function fakeSvc() {
  const calls: string[] = [];
  const run = { id: 'run1', name: 'R', nodes: { a: { sessionIds: ['s-a'] }, gate: { sessionIds: [] } } } as any;
  return {
    calls,
    get: (id: string) => { if (id !== 'run1') throw new Error('运行记录不存在'); return run; },
    approve: async (runId: string, nodeId: string, decision: string, comment?: string) => { calls.push(`${runId}/${nodeId}/${decision}/${comment ?? ''}`); return run; },
  };
}

describe('OrchImBridge (M1 / M2)', () => {
  it('button ids are short tokens (Telegram callback_data ≤ 64 bytes)', () => {
    const b = new OrchImBridge(fakeSvc() as any);
    const [ok, no] = b.buttons('run1', 'a-very-long-node-id-that-would-not-fit-in-telegram-callback-data');
    expect(ok.id.length).toBeLessThanOrEqual(20);
    expect(ok.id.startsWith('orch:')).toBe(true);
    expect(no.id.endsWith(':r')).toBe(true);
  });

  it('only a bound chat of this run can decide, and only approve / reject are accepted', async () => {
    const svc = fakeSvc();
    const b = new OrchImBridge(svc as any);
    const [ok] = b.buttons('run1', 'gate');
    const token = ok.id.split(':')[1];
    expect(await b.handle([token, 'a'], undefined)).toMatch(/没有绑定/);
    expect(await b.handle([token, 'a'], 's-other')).toMatch(/不属于/);
    expect(await b.handle([token, 'x'], 's-a')).toMatch(/不认识/);
    expect(await b.handle(['nope', 'a'], 's-a')).toMatch(/失效/);
    expect(svc.calls).toEqual([]);
    expect(await b.handle([token, 'r'], 's-a')).toMatch(/驳回/);
    expect(svc.calls).toEqual(['run1/gate/reject/在 IM 上驳回']);
  });
});
