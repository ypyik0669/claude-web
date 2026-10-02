import { describe, expect, it } from 'vitest';
import { listsOf, memoryDevices, type DeviceRec } from './devices';

const rec = (id: string, at: number, lastAt?: number): DeviceRec => ({ id, pcName: `pc-${id}`, token: `tok-${id}`, pairedAt: at, ...(lastAt ? { lastAt } : {}) });

describe("a PC's lists on its record (F2)", () => {
  it('are kept with the record (a later connect, lastAt and all, keeps them) and are what its dials use', async () => {
    const s = memoryDevices();
    const brokers = [{ name: 'cn', url: 'wss://mqtt.example.cn:8084/mqtt', relay: true }];
    await s.put({ ...rec('a', 1), brokers, stun: [] });
    const [got] = await s.list();
    await s.put({ ...got, lastAt: 5 });
    const [again] = await s.list();
    expect(listsOf(again)).toEqual({ brokers, stun: [] });
    // a record from before lists existed, or of a PC on the defaults: none (the defaults)
    expect(listsOf(rec('b', 1))).toEqual({});
  });
});

describe('memoryDevices', () => {
  it('puts, lists (most recently used first), replaces by id and removes', async () => {
    const s = memoryDevices();
    expect(await s.list()).toEqual([]);
    await s.put(rec('a', 100));
    await s.put(rec('b', 200));
    expect((await s.list()).map((d) => d.id)).toEqual(['b', 'a']);
    // connected later: first, by lastAt over pairedAt
    await s.put(rec('a', 100, 300));
    expect((await s.list()).map((d) => d.id)).toEqual(['a', 'b']);
    expect((await s.list()).length).toBe(2);
    await s.remove('a');
    expect((await s.list()).map((d) => d.id)).toEqual(['b']);
    await s.remove('nope');
    expect((await s.list()).map((d) => d.id)).toEqual(['b']);
  });

  it('hands out copies: changing what list() gave does not change the store', async () => {
    const s = memoryDevices();
    const d = rec('a', 1);
    await s.put(d);
    d.pcName = 'changed';
    const [got] = await s.list();
    expect(got.pcName).toBe('pc-a');
    got.token = 'x';
    expect((await s.list())[0].token).toBe('tok-a');
  });
});
