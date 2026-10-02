import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { keepAwakeWanted, reportKeepAwake } from './keep-awake.js';

/** The two things reportKeepAwake reads from MetaStore: settings, and 'changed' after every (non-quiet) save. */
function fakeMeta(settings: Record<string, unknown>) {
  const m = new EventEmitter() as EventEmitter & { settings(): Record<string, unknown>; set(k: string, v: unknown): void };
  m.settings = () => settings;
  m.set = (k, v) => { settings[k] = v; m.emit('changed'); };
  return m;
}

describe('keepAwakeWanted (same rule as desktop/src/keep-awake.ts)', () => {
  it('remote access on and the setting not turned off', () => {
    expect(keepAwakeWanted({ remoteEnabled: true, keepAwake: undefined })).toBe(true);
    expect(keepAwakeWanted({ remoteEnabled: true, keepAwake: true })).toBe(true);
    expect(keepAwakeWanted({ remoteEnabled: true, keepAwake: false })).toBe(false);
    expect(keepAwakeWanted({ remoteEnabled: false, keepAwake: undefined })).toBe(false);
  });
});

describe('reportKeepAwake', () => {
  it('reports once at startup, then only when the answer flips', () => {
    const meta = fakeMeta({ 'remote.enabled': true });
    const sent: boolean[] = [];
    reportKeepAwake(meta, (on) => sent.push(on));
    expect(sent).toEqual([true]);
    meta.set('drafts.x', 'hi'); // unrelated save
    meta.set('remote.keepAwake', true); // same answer
    expect(sent).toEqual([true]);
    meta.set('remote.keepAwake', false);
    expect(sent).toEqual([true, false]);
    meta.set('remote.keepAwake', undefined);
    meta.set('remote.enabled', false);
    expect(sent).toEqual([true, false, true, false]);
  });

  it('remote access off at startup reports off; the returned function stops listening', () => {
    const meta = fakeMeta({});
    const sent: boolean[] = [];
    const stop = reportKeepAwake(meta, (on) => sent.push(on));
    expect(sent).toEqual([false]);
    stop();
    meta.set('remote.enabled', true);
    expect(sent).toEqual([false]);
  });
});
