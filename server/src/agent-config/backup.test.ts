import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackupStore } from './backup.js';
import { setTomlTopLevel } from './edit.js';

describe('BackupStore', () => {
  let dir: string;
  let store: BackupStore;
  let cfg: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-bk-'));
    store = new BackupStore(path.join(dir, 'config-backups'));
    cfg = path.join(dir, 'codex', 'config.toml');
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    fs.writeFileSync(cfg, '# keep me\nmodel = "a"\n');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('backs up before writing and lists the copy with its origin', async () => {
    const b = await store.writeChecked('codex', cfg, (t) => setTomlTopLevel(t, 'model', 'b'), 'model');
    expect(b?.id).toMatch(/^codex\/\d{8}T\d{9}-config\.toml$/);
    expect(fs.readFileSync(cfg, 'utf8')).toBe('# keep me\nmodel = "b"\n');
    expect(fs.readFileSync(path.join(dir, 'config-backups', b!.id), 'utf8')).toBe('# keep me\nmodel = "a"\n');
    const list = await store.list('codex');
    expect(list).toHaveLength(1);
    expect(list[0].path).toBe(cfg);
  });

  it('rolls back when the written file does not parse', async () => {
    await expect(store.writeChecked('codex', cfg, () => 'model = ', 'broken')).rejects.toThrow(/回滚/);
    expect(fs.readFileSync(cfg, 'utf8')).toBe('# keep me\nmodel = "a"\n');
  });

  it('guard() rolls back a CLI that left a broken file, and removes a file that did not exist before', async () => {
    await expect(store.guard('codex', cfg, 'cli', async () => { fs.writeFileSync(cfg, '[[['); })).rejects.toThrow(/回滚/);
    expect(fs.readFileSync(cfg, 'utf8')).toBe('# keep me\nmodel = "a"\n');
    const fresh = path.join(dir, 'gemini', 'settings.json');
    await expect(store.guard('gemini', fresh, 'cli', async () => { fs.mkdirSync(path.dirname(fresh), { recursive: true }); fs.writeFileSync(fresh, '{'); })).rejects.toThrow();
    expect(fs.existsSync(fresh)).toBe(false);
  });

  it('restore() puts the old text back and backs up the current one first', async () => {
    const b = await store.writeChecked('codex', cfg, (t) => setTomlTopLevel(t, 'model', 'b'), 'model');
    await store.restore(b!.id);
    expect(fs.readFileSync(cfg, 'utf8')).toBe('# keep me\nmodel = "a"\n');
    const list = await store.list('codex');
    expect(list).toHaveLength(2);
    expect(fs.readFileSync(path.join(dir, 'config-backups', list[0].id), 'utf8')).toContain('model = "b"');
  });

  it('rejects ids that try to leave the backup directory', async () => {
    await expect(store.restore('codex/../../etc')).rejects.toThrow(/无效/);
    await expect(store.restore('evil/x.toml')).rejects.toThrow(/无效/);
    await expect(store.restore('codex/index.jsonl')).rejects.toThrow(/无效/);
  });
});
