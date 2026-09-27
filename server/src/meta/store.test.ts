import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MetaStore } from './store.js';

const dirs: string[] = [];
async function tmpFile() {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'cw-meta-'));
  dirs.push(d);
  return path.join(d, 'meta.json');
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

describe('MetaStore', () => {
  it('keeps saving after one save fails', async () => {
    const file = await tmpFile();
    const m = new MetaStore(file);
    await m.load();
    // make the target a directory: this save fails
    await fs.mkdir(file);
    await expect(m.setSetting('a', 1)).rejects.toBeTruthy();
    await fs.rm(file, { recursive: true });
    // the next one must actually write, not inherit the earlier rejection
    await m.setSetting('b', 2);
    const disk = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(disk.settings).toEqual({ a: 1, b: 2 });
  });

  it('backs up an unparsable file instead of silently dropping it', async () => {
    const file = await tmpFile();
    await fs.writeFile(file, '{"workspaces": [ {"id": "x"', 'utf8');
    const m = new MetaStore(file);
    await m.load();
    const siblings = await fs.readdir(path.dirname(file));
    expect(siblings.some((f) => f.startsWith('meta.json.corrupt-'))).toBe(true);
  });

  it('round-trips through load', async () => {
    const file = await tmpFile();
    const a = new MetaStore(file);
    await a.addWorkspace(path.dirname(file));
    const b = new MetaStore(file);
    await b.load();
    expect(b.workspaces()).toHaveLength(1);
    expect((await fs.readdir(path.dirname(file))).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});
