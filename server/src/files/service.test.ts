import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FilesService, appleScriptEscape } from './service.js';

describe('files', () => {
  it('escapes paths for an AppleScript string literal', () => {
    expect(appleScriptEscape('/Users/a/x"y')).toBe('/Users/a/x\\"y');
    // a trailing backslash must not swallow the closing quote
    expect(appleScriptEscape('/tmp/a\\')).toBe('/tmp/a\\\\');
  });

  it('concurrent watch() of one path shares a single watcher', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cw-files-'));
    const svc = new FilesService();
    try {
      await Promise.all([svc.watch(dir), svc.watch(dir)]);
      const w = (svc as any).watchers.get(dir);
      expect(w.refs).toBe(2);
      expect(w.w.listenerCount('error')).toBeGreaterThan(0);
      await svc.unwatch(dir);
      expect((svc as any).watchers.has(dir)).toBe(true);
      await svc.unwatch(dir);
      expect((svc as any).watchers.has(dir)).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
