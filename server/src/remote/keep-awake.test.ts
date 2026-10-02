import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { keepAwakeWanted as desktopRule } from '../../../desktop/src/keep-awake.js';
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

  it('agrees with the desktop copy on every input', () => {
    for (const remoteEnabled of [true, false])
      for (const keepAwake of [true, false, undefined])
        expect(keepAwakeWanted({ remoteEnabled, keepAwake })).toBe(desktopRule({ remoteEnabled, keepAwake }));
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

  it('a post that throws does not fail the save, and the answer is sent again on the next save', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const meta = fakeMeta({});
      const sent: boolean[] = [];
      let broken = false;
      reportKeepAwake(meta, (on) => {
        if (broken) throw new Error('channel closed');
        sent.push(on);
      });
      broken = true;
      expect(() => meta.set('remote.enabled', true)).not.toThrow();
      expect(warn).toHaveBeenCalledTimes(1);
      broken = false;
      meta.set('drafts.x', 'hi');
      expect(sent).toEqual([false, true]);
    } finally {
      warn.mockRestore();
    }
  });
});
