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

  it('serializes concurrent writes to the same file (no lost update, no leftover bytes)', async () => {
    fs.writeFileSync(cfg, '# keep me\nmodel = "a-very-long-model-name-that-is-longer"\n');
    await Promise.all([
      store.writeChecked('codex', cfg, (t) => setTomlTopLevel(t, 'model', 'b'), 'one'),
      store.writeChecked('codex', cfg, (t) => setTomlTopLevel(t, 'approval_policy', 'never'), 'two'),
      store.guard('codex', cfg, 'cli', async () => { const t = fs.readFileSync(cfg, 'utf8'); await new Promise((r) => setTimeout(r, 30)); fs.writeFileSync(cfg, setTomlTopLevel(t, 'sandbox_mode', 'read-only')); }),
      // same file through a differently spelled path: still the same lock
      store.writeChecked('codex', path.join(path.dirname(cfg), '.', 'config.toml'), (t) => setTomlTopLevel(t, 'model_reasoning_effort', 'high'), 'four'),
    ]);
    expect(fs.readFileSync(cfg, 'utf8')).toBe('# keep me\nmodel = "b"\napproval_policy = "never"\nsandbox_mode = "read-only"\nmodel_reasoning_effort = "high"\n');
    expect(fs.readdirSync(path.dirname(cfg)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('backs up and rolls back bytes exactly (BOM, CRLF, invalid UTF-8 in a comment)', async () => {
    const orig = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# caf'), Buffer.from([0xe9]), Buffer.from('\r\nmodel = "a"\r\n')]);
    fs.writeFileSync(cfg, orig);
    await expect(store.writeChecked('codex', cfg, () => 'model = ', 'broken')).rejects.toThrow(/回滚/);
    expect(fs.readFileSync(cfg).equals(orig)).toBe(true);
    const [b] = await store.list('codex');
    expect(fs.readFileSync(path.join(dir, 'config-backups', b.id)).equals(orig)).toBe(true);
  });

  it('keeps each file\'s first backup forever when pruning', async () => {
    const small = new BackupStore(path.join(dir, 'small'), { keep: 2 });
    for (const v of ['b', 'c', 'd', 'e', 'f']) await small.writeChecked('codex', cfg, (t) => setTomlTopLevel(t, 'model', v), v);
    const list = await small.list('codex');
    expect(list).toHaveLength(3);
    const first = list.find((e) => e.first)!;
    expect(fs.readFileSync(path.join(dir, 'small', first.id), 'utf8')).toBe('# keep me\nmodel = "a"\n');
    expect(list.filter((e) => !e.first).map((e) => e.reason)).toEqual(['f', 'e']);
  });

  it.skipIf(process.platform === 'win32')('backup dir is 0700 and copies 0600', async () => {
    const b = await store.writeChecked('codex', cfg, (t) => setTomlTopLevel(t, 'model', 'b'), 'm');
    expect(fs.statSync(path.join(dir, 'config-backups', 'codex')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dir, 'config-backups', b!.id)).mode & 0o777).toBe(0o600);
  });

  it('guard: a failing CLI that left a broken file is rolled back and its error surfaces', async () => {
    await expect(store.guard('codex', cfg, 'cli', async () => { fs.writeFileSync(cfg, '[[['); throw new Error('cli exit 1'); })).rejects.toThrow('cli exit 1');
    expect(fs.readFileSync(cfg, 'utf8')).toBe('# keep me\nmodel = "a"\n');
  });

  it('guard: fix() corrects the CLI result in the same lock; a throwing fix rolls back', async () => {
    await store.guard('codex', cfg, 'cli', async () => fs.writeFileSync(cfg, 'model = "cli"\n'), (t) => setTomlTopLevel(t, 'model', 'fixed'));
    expect(fs.readFileSync(cfg, 'utf8')).toBe('model = "fixed"\n');
    await expect(store.guard('codex', cfg, 'cli', async () => fs.writeFileSync(cfg, 'model = "zzz"\n'), () => { throw new Error('nope'); })).rejects.toThrow(/纠正失败/);
    expect(fs.readFileSync(cfg, 'utf8')).toBe('model = "fixed"\n');
  });

  it('rejects ids that try to leave the backup directory', async () => {
    await expect(store.restore('codex/../../etc')).rejects.toThrow(/无效/);
    await expect(store.restore('evil/x.toml')).rejects.toThrow(/无效/);
    await expect(store.restore('codex/index.jsonl')).rejects.toThrow(/无效/);
  });
});
