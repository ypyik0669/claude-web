import { describe, expect, it } from 'vitest';
import { KeepAwake, keepAwakeWanted } from './keep-awake';

describe('when the PC is kept awake', () => {
  it('only while remote access is on, unless the setting is turned off (unset means on)', () => {
    expect(keepAwakeWanted({ remoteEnabled: true, keepAwake: undefined })).toBe(true);
    expect(keepAwakeWanted({ remoteEnabled: true, keepAwake: true })).toBe(true);
    expect(keepAwakeWanted({ remoteEnabled: true, keepAwake: false })).toBe(false);
    expect(keepAwakeWanted({ remoteEnabled: false, keepAwake: undefined })).toBe(false);
    expect(keepAwakeWanted({ remoteEnabled: false, keepAwake: true })).toBe(false);
  });
});

/** Stands in for Electron's powerSaveBlocker: increasing ids, records every call. */
function fakeBlocker() {
  let next = 1;
  const running = new Set<number>();
  const calls = { start: [] as string[], stop: [] as number[] };
  return {
    calls,
    running,
    start(type: string) { calls.start.push(type); const id = next++; running.add(id); return id; },
    stop(id: number) { calls.stop.push(id); running.delete(id); },
    isStarted(id: number) { return running.has(id); },
  };
}

describe('KeepAwake', () => {
  it('a second set(true) does not start a second blocker; set(false) stops the one it holds', () => {
    const api = fakeBlocker();
    const k = new KeepAwake(api);
    k.set(true);
    k.set(true);
    expect(api.calls.start).toEqual(['prevent-app-suspension']);
    k.set(false);
    expect(api.calls.stop).toEqual([1]);
    expect(api.running.size).toBe(0);
    k.set(false); // nothing held any more
    expect(api.calls.stop).toEqual([1]);
  });

  it('set(false) with nothing started is a no-op', () => {
    const api = fakeBlocker();
    new KeepAwake(api).set(false);
    expect(api.calls).toEqual({ start: [], stop: [] });
  });

  it('a blocker stopped from elsewhere is started again on the next set(true)', () => {
    const api = fakeBlocker();
    const k = new KeepAwake(api);
    k.set(true);
    api.running.clear();
    k.set(true);
    expect(api.calls.start).toEqual(['prevent-app-suspension', 'prevent-app-suspension']);
    k.set(false);
    expect(api.calls.stop).toEqual([2]);
  });
});
