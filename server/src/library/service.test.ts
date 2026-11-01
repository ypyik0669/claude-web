import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentKind, SessionSummary, SourceCaps, SourceStatus } from '../protocol.js';
import type { SessionSource } from './types.js';
import { LibraryIndex } from './index-db.js';
import { MetaStore } from '../meta/store.js';
import { LibraryService } from './service.js';

const ALL: SourceCaps = { resume: true, rename: true, archive: true, delete: true, fork: true };

function item(id: string, kind: AgentKind, lastModified: number, patch: Partial<SessionSummary> = {}): SessionSummary {
  return { sessionId: id, title: id, cwd: '/w', lastModified, agent: kind, caps: ALL, ...patch };
}

/** A fake SessionSource whose list/read/etc are spies; `items` can be swapped between calls. */
function fakeSource(kind: AgentKind, items: SessionSummary[], name = kind) {
  const src = {
    kind,
    caps: ALL,
    items,
    status: vi.fn(async (): Promise<SourceStatus> => ({ kind, name, installed: true, detected: true, joined: false, enabled: true })),
    list: vi.fn(async (_o: { cursor?: string; limit: number }) => ({ items: src.items })),
    read: vi.fn(async (nativeId: string, _o: { cursor?: string; limit: number }) => ({ messages: [{ type: 'user', message: { role: 'user', content: `hello from ${nativeId}` } }] })),
    rename: vi.fn(async () => {}),
    archive: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    fork: vi.fn(async () => 'forked'),
    exportAll: vi.fn(async (nativeId: string) => ({ nativeId, turns: [] })),
    close: vi.fn(async () => {}),
  };
  return src as typeof src & SessionSource;
}

describe('LibraryService', () => {
  let dir: string;
  let prevDir: string | undefined;
  let index: LibraryIndex;
  let meta: MetaStore;
  let claude: ReturnType<typeof fakeSource>;
  let cai: ReturnType<typeof fakeSource>;
  let lib: LibraryService;

  const make = () => new LibraryService([claude, cai], index, meta, { trashDir: path.join(dir, 'library-trash') });

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-libsvc-'));
    prevDir = process.env.CLAUDE_WEB_DIR;
    process.env.CLAUDE_WEB_DIR = dir;
    index = new LibraryIndex(path.join(dir, 'library.db'));
    meta = new MetaStore(path.join(dir, 'meta.json'));
    await meta.load();
    claude = fakeSource('claude', [item('c1', 'claude', 100), item('c2', 'claude', 300)], 'Claude Code');
    cai = fakeSource('claudeai', [item('claudeai-t1', 'claudeai', 200)]);
    lib = make();
  });

  afterEach(async () => {
    lib.dispose();
    index.close();
    if (prevDir === undefined) delete process.env.CLAUDE_WEB_DIR; else process.env.CLAUDE_WEB_DIR = prevDir;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('never lists a source that has not been joined (a cheap status look only)', async () => {
    const ids = (await lib.list()).map((s) => s.sessionId);
    expect(ids).toEqual(['c2', 'c1']);
    const st = await lib.sources();
    expect(st.find((s) => s.kind === 'claudeai')).toMatchObject({ joined: false, enabled: false, installed: true, detected: true, name: 'claude.ai' });
    expect(cai.list).not.toHaveBeenCalled();
  });

  it('join adds the source (merged, sorted); leave removes it, closes it and drops its index rows', async () => {
    await lib.join('claudeai', true);
    expect(meta.settings()['library.joined']).toEqual(['claudeai']);
    expect((await lib.list()).map((s) => s.sessionId)).toEqual(['c2', 'claudeai-t1', 'c1']);
    index.upsert(item('claudeai-t1', 'claudeai', 200), 'claude.ai words');
    await lib.join('claudeai', false);
    expect(cai.close).toHaveBeenCalled();
    expect((await lib.list()).map((s) => s.sessionId)).toEqual(['c2', 'c1']);
    expect(index.indexedAt('claudeai-t1')).toBeUndefined();
    expect(meta.settings()['library.joined']).toEqual([]);
  });

  it('claude cannot be left', async () => {
    await expect(lib.join('claude', false)).rejects.toThrow();
  });

  it('lists archived sessions of archive-capable sources, flagged archived', async () => {
    cai.list.mockImplementation(async (o: { archived?: boolean }) => ({ items: o.archived ? [item('claudeai-old', 'claudeai', 50)] : cai.items }));
    await lib.join('claudeai', true);
    const list = await lib.list();
    expect(list.find((s) => s.sessionId === 'claudeai-old')?.archived).toBe(true);
    expect(list.find((s) => s.sessionId === 'claudeai-t1')?.archived).toBeUndefined();
    expect(cai.list).toHaveBeenCalledWith(expect.objectContaining({ archived: true }));
  });

  it('does not ask a source without archive caps for archived sessions', async () => {
    (cai as any).caps = { ...ALL, archive: false };
    await lib.join('claudeai', true);
    await lib.list();
    expect(cai.list).not.toHaveBeenCalledWith(expect.objectContaining({ archived: true }));
  });

  it('concurrent list() calls share one fetch per source', async () => {
    await lib.join('claudeai', true);
    await Promise.all([lib.list(), lib.list(), lib.list()]);
    expect(cai.list).toHaveBeenCalledTimes(2); // one live + one archived page, not 3x
  });

  const bounded = () => new LibraryService([claude, cai], index, meta, { trashDir: path.join(dir, 'library-trash'), listTimeoutMs: 50 });

  it('first load of a never-settling source: others still list, it is loading (not an error)', async () => {
    lib.dispose();
    lib = bounded();
    cai.list.mockImplementation(() => new Promise(() => {}));
    await lib.join('claudeai', true);
    const t0 = Date.now();
    expect((await lib.list()).map((s) => s.sessionId)).toEqual(['c2', 'c1']);
    expect(Date.now() - t0).toBeLessThan(2000);
    const st = (await lib.sources()).find((s) => s.kind === 'claudeai');
    expect(st?.loading).toBe(true);
    expect(st?.error).toBeUndefined();
  });

  it('callers joining the in-flight fetch are bounded too', async () => {
    lib.dispose();
    lib = bounded();
    cai.list.mockImplementation(() => new Promise(() => {}));
    await lib.join('claudeai', true);
    const t0 = Date.now();
    const [a, b] = await Promise.all([lib.list(), lib.list()]);
    expect(a.map((s) => s.sessionId)).toEqual(['c2', 'c1']);
    expect(b.map((s) => s.sessionId)).toEqual(['c2', 'c1']);
    expect(Date.now() - t0).toBeLessThan(2000);
    // and a later caller that joins the still-hung fetch
    expect((await lib.list()).map((s) => s.sessionId)).toEqual(['c2', 'c1']);
  });

  it('a first load that lands after the bound clears loading and announces the change', async () => {
    lib.dispose();
    lib = bounded();
    (cai as any).caps = { ...ALL, archive: false };
    let release!: () => void;
    cai.list.mockImplementation(() => new Promise((r) => { release = () => r({ items: cai.items }); }));
    await lib.join('claudeai', true);
    expect((await lib.list()).map((s) => s.sessionId)).toEqual(['c2', 'c1']);
    expect((await lib.sources()).find((s) => s.kind === 'claudeai')?.loading).toBe(true);
    const changed = new Promise<void>((r) => lib.once('changed', () => r()));
    release();
    await changed;
    expect((await lib.list()).map((s) => s.sessionId)).toEqual(['c2', 'claudeai-t1', 'c1']);
    const st = (await lib.sources()).find((s) => s.kind === 'claudeai');
    expect(st?.loading).toBeUndefined();
    expect(st?.error).toBeUndefined();
  });

  it('a timeout with a cached list is an error (cache served), cleared by the next success even from an older generation', async () => {
    lib.dispose();
    lib = bounded();
    (cai as any).caps = { ...ALL, archive: false };
    await lib.join('claudeai', true);
    expect((await lib.list()).map((s) => s.sessionId)).toEqual(['c2', 'claudeai-t1', 'c1']);
    let release!: () => void;
    cai.list.mockImplementation(() => new Promise((r) => { release = () => r({ items: cai.items }); }));
    lib.invalidate('claudeai');
    expect((await lib.list()).map((s) => s.sessionId)).toEqual(['c2', 'claudeai-t1', 'c1']);
    const st = (await lib.sources()).find((s) => s.kind === 'claudeai');
    expect(st?.error).toMatch(/超时/);
    expect(st?.loading).toBeUndefined();
    lib.invalidate('claudeai'); // the hung fetch is now an older generation
    const changed = new Promise<void>((r) => lib.once('changed', () => r()));
    release();
    await changed;
    expect((await lib.sources()).find((s) => s.kind === 'claudeai')?.error).toBeUndefined();
  });

  it('stale-while-revalidate: a cached source past its TTL is served at once and refreshed behind', async () => {
    lib.dispose();
    lib = new LibraryService([claude, cai], index, meta, { trashDir: path.join(dir, 'library-trash'), listTtlMs: 0 });
    (cai as any).caps = { ...ALL, archive: false };
    await lib.join('claudeai', true);
    expect((await lib.list()).map((s) => s.sessionId)).toEqual(['c2', 'claudeai-t1', 'c1']);
    let release!: () => void;
    cai.list.mockImplementation(() => new Promise((r) => { release = () => r({ items: [item('claudeai-t9', 'claudeai', 250)] }); }));
    const t0 = Date.now();
    expect((await lib.list()).map((s) => s.sessionId)).toEqual(['c2', 'claudeai-t1', 'c1']); // cached, not waited for
    expect(Date.now() - t0).toBeLessThan(1000);
    expect((await lib.sources()).find((s) => s.kind === 'claudeai')?.error).toBeUndefined();
    const changed = new Promise<void>((r) => lib.once('changed', () => r()));
    release();
    await changed;
    cai.list.mockImplementation(async () => ({ items: [item('claudeai-t9', 'claudeai', 250)] }));
    expect((await lib.list()).map((s) => s.sessionId)).toEqual(['c2', 'claudeai-t9', 'c1']);
  });

  it('leaving a source while its fetch is in flight: a late success is not cached', async () => {
    lib.dispose();
    lib = bounded();
    (cai as any).caps = { ...ALL, archive: false };
    let release!: () => void;
    cai.list.mockImplementationOnce(() => new Promise((r) => { release = () => r({ items: [item('claudeai-old', 'claudeai', 1)] }); }));
    await lib.join('claudeai', true);
    await lib.list(); // first load outlives the bound
    await lib.join('claudeai', false);
    release();
    await new Promise((r) => setTimeout(r, 20));
    cai.list.mockImplementation(() => new Promise(() => {})); // after re-join: still loading
    await lib.join('claudeai', true);
    expect((await lib.list()).map((s) => s.sessionId)).toEqual(['c2', 'c1']);
    const st = (await lib.sources()).find((s) => s.kind === 'claudeai');
    expect(st?.count).toBeUndefined();
    expect(st?.loading).toBe(true);
  });

  it('leaving a source while its fetch is in flight: a late failure sets no error', async () => {
    lib.dispose();
    lib = bounded();
    (cai as any).caps = { ...ALL, archive: false };
    let fail!: () => void;
    cai.list.mockImplementationOnce(() => new Promise((_r, rej) => { fail = () => rej(new Error('late boom')); }));
    await lib.join('claudeai', true);
    await lib.list();
    await lib.join('claudeai', false);
    fail();
    await new Promise((r) => setTimeout(r, 20));
    cai.list.mockImplementation(() => new Promise(() => {}));
    await lib.join('claudeai', true);
    await lib.list();
    expect((await lib.sources()).find((s) => s.kind === 'claudeai')?.error).toBeUndefined();
  });

  it('file watchers run only for joined sources: started on join, stopped on leave', async () => {
    const claudeDir = path.join(dir, 'claude-projects');
    const caiDir = path.join(dir, 'claudeai-sessions');
    fs.mkdirSync(claudeDir);
    fs.mkdirSync(caiDir);
    lib.start({ claude: [claudeDir], claudeai: [caiDir] });
    const watched = () => [...((lib as any).watchers as Map<string, unknown>).keys()].sort();
    expect(watched()).toEqual(['claude']);
    await lib.join('claudeai', true);
    expect(watched()).toEqual(['claude', 'claudeai']);
    await lib.join('claudeai', false);
    expect(watched()).toEqual(['claude']);
  });

  it('a parent cycle folds nothing: every member stays visible', async () => {
    cai.items = [
      item('claudeai-a', 'claudeai', 200, { parentId: 'claudeai-b' }),
      item('claudeai-b', 'claudeai', 210, { parentId: 'claudeai-a' }),
    ];
    await lib.join('claudeai', true);
    const list = await lib.list();
    expect(list.map((s) => s.sessionId)).toEqual(['c2', 'claudeai-b', 'claudeai-a', 'c1']);
    expect(list.every((s) => !s.childCount)).toBe(true);
  });

  it('nested sub-agents fold transitively under the top-level ancestor', async () => {
    cai.items = [
      item('claudeai-root', 'claudeai', 200),
      item('claudeai-kid', 'claudeai', 210, { parentId: 'claudeai-root' }),
      item('claudeai-grandkid', 'claudeai', 220, { parentId: 'claudeai-kid' }),
      item('claudeai-orphan', 'claudeai', 230, { parentId: 'claudeai-missing' }),
    ];
    await lib.join('claudeai', true);
    const list = await lib.list();
    expect(list.map((s) => s.sessionId)).toEqual(['c2', 'claudeai-orphan', 'claudeai-root', 'c1']);
    expect(list.find((s) => s.sessionId === 'claudeai-root')?.childCount).toBe(2);
    expect(list.find((s) => s.sessionId === 'claudeai-orphan')?.childCount).toBeUndefined();
  });

  it('refreshIndex stamps indexedAt on a joined source with no sessions, not on a failed one', async () => {
    claude.items = [];
    cai.list.mockRejectedValue(new Error('app-server crashed'));
    await lib.join('claudeai', true);
    await lib.refreshIndex();
    const st = await lib.sources();
    const cl = st.find((s) => s.kind === 'claude');
    expect(cl?.count).toBe(0);
    expect(typeof cl?.indexedAt).toBe('number');
    expect(st.find((s) => s.kind === 'claudeai')?.indexedAt).toBeUndefined();
  });

  it('refreshIndex prunes ids that no longer exist', async () => {
    index.upsert(item('gone', 'claude', 1), 'stale');
    await lib.refreshIndex();
    expect(index.indexedAt('gone')).toBeUndefined();
  });

  it('refreshIndex keeps the index rows of a source whose fetch failed', async () => {
    await lib.join('claudeai', true);
    await lib.refreshIndex();
    expect(index.indexedAt('claudeai-t1')).toBe(200);
    // a fresh service (e.g. after a restart) has no last good list for claude.ai, and it fails
    lib.dispose();
    cai.list.mockRejectedValue(new Error('app-server crashed'));
    lib = make();
    await lib.refreshIndex();
    expect(index.indexedAt('claudeai-t1')).toBe(200);
    expect(index.indexedAt('c1')).toBe(100);
  });

  it('invalidate() during an in-flight fetch starts a new fetch; the stale one is not cached as fresh', async () => {
    (cai as any).caps = { ...ALL, archive: false };
    await lib.join('claudeai', true);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    cai.list.mockImplementationOnce(async () => { await gate; return { items: [item('claudeai-old', 'claudeai', 1)] }; });
    const first = lib.list();
    await new Promise((r) => setTimeout(r, 10));
    lib.invalidate('claudeai');
    cai.items = [item('claudeai-new', 'claudeai', 2)];
    const second = lib.list();
    release();
    await first;
    expect((await second).map((s) => s.sessionId)).toContain('claudeai-new');
    expect(cai.list).toHaveBeenCalledTimes(2);
    // the pre-invalidation result must not have become the fresh cache
    expect((await lib.list()).map((s) => s.sessionId)).toContain('claudeai-new');
    expect(cai.list).toHaveBeenCalledTimes(2);
  });

  it('search uses the fallback until the first index pass has finished', async () => {
    const fallback = vi.fn(async () => [{ session: item('fb', 'claude', 1) }]);
    lib = new LibraryService([claude, cai], index, meta, { fallbackSearch: fallback, trashDir: path.join(dir, 'library-trash') });
    index.upsert(item('c1', 'claude', 100), 'hello partial'); // partially indexed, no pass finished
    expect((await lib.search('hello', 10)).map((h) => h.session.sessionId)).toEqual(['fb']);
    expect(fallback).toHaveBeenCalledWith('hello', 10);
    await lib.refreshIndex();
    fallback.mockClear();
    expect((await lib.search('hello', 10)).map((h) => h.session.sessionId).sort()).toEqual(['c1', 'c2']);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('folds children under their parent', async () => {
    claude.items = [item('p', 'claude', 100), item('k', 'claude', 200, { parentId: 'p' })];
    const list = await lib.list();
    expect(list.map((s) => s.sessionId)).toEqual(['p']);
    expect(list[0].childCount).toBe(1);
  });

  it('a failing source does not break the others and reports its error', async () => {
    await lib.join('claudeai', true);
    await lib.list();
    cai.list.mockRejectedValue(new Error('boom'));
    lib.invalidate();
    const ids = (await lib.list()).map((s) => s.sessionId);
    expect(ids).toContain('c1');
    expect(ids).toContain('claudeai-t1'); // last good result
    const st = (await lib.sources()).find((s) => s.kind === 'claudeai');
    expect(st?.error).toContain('boom');
    expect(st?.joined).toBe(true);
  });

  it('remove: a failed export keeps the session', async () => {
    await lib.join('claudeai', true);
    await lib.list();
    cai.exportAll.mockRejectedValue(new Error('export failed'));
    const r = await lib.remove(['claudeai-t1', 'c1']);
    expect(r.failed.map((f) => f.id)).toEqual(['claudeai-t1']);
    expect(cai.remove).not.toHaveBeenCalled();
    expect(r.removed).toEqual(['c1']);
    expect(claude.remove).toHaveBeenCalledWith('c1');
    expect(fs.existsSync(path.join(dir, 'library-trash', 'c1.json'))).toBe(true);
  });

  it('cleanTrash drops backups older than 30 days', async () => {
    const t = path.join(dir, 'library-trash');
    fs.mkdirSync(t);
    fs.writeFileSync(path.join(t, 'old.json'), '{}');
    fs.writeFileSync(path.join(t, 'new.json'), '{}');
    const old = (Date.now() - 31 * 86_400_000) / 1000;
    fs.utimesSync(path.join(t, 'old.json'), old, old);
    await lib.cleanTrash();
    expect(fs.readdirSync(t)).toEqual(['new.json']);
  });

  it('cleanTrash also drops raw-copy backup directories older than 30 days', async () => {
    const t = path.join(dir, 'library-trash');
    fs.mkdirSync(path.join(t, 'old-dir', 'proj'), { recursive: true });
    fs.writeFileSync(path.join(t, 'old-dir', 'proj', 'x.jsonl'), '{}');
    fs.mkdirSync(path.join(t, 'new-dir'));
    const old = (Date.now() - 31 * 86_400_000) / 1000;
    fs.utimesSync(path.join(t, 'old-dir'), old, old);
    await lib.cleanTrash();
    expect(fs.readdirSync(t)).toEqual(['new-dir']);
  });

  it('remove: a source with backupTo gets a raw copy dir; a failed copy keeps the session', async () => {
    const backupTo = vi.fn(async (_n: string, dest: string) => { fs.writeFileSync(path.join(dest, 'raw.jsonl'), 'raw'); });
    (claude as any).backupTo = backupTo;
    const r = await lib.remove(['c1']);
    expect(r.removed).toEqual(['c1']);
    expect(fs.readFileSync(path.join(dir, 'library-trash', 'c1', 'raw.jsonl'), 'utf8')).toBe('raw');
    expect(fs.existsSync(path.join(dir, 'library-trash', 'c1', 'backup.json'))).toBe(true);
    expect(claude.exportAll).not.toHaveBeenCalled();
    backupTo.mockRejectedValueOnce(new Error('copy failed'));
    const r2 = await lib.remove(['c2']);
    expect(r2.failed.map((f) => f.id)).toEqual(['c2']);
    expect(claude.remove).toHaveBeenCalledTimes(1);
  });

  it('readAll concatenates pages oldest first', async () => {
    claude.read.mockImplementation(async (_id: string, o: { cursor?: string }) =>
      o.cursor ? { messages: [{ n: 1 }, { n: 2 }] } : { messages: [{ n: 3 }], next: 'older' });
    expect(await lib.readAll('c1')).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it('refreshIndex skips sessions whose lastModified has not changed', async () => {
    await lib.refreshIndex();
    expect(claude.read).toHaveBeenCalledTimes(2);
    expect(index.indexedAt('c1')).toBe(100);
    claude.read.mockClear();
    claude.items = [item('c1', 'claude', 100), item('c2', 'claude', 301)];
    lib.invalidate();
    await lib.refreshIndex();
    expect(claude.read).toHaveBeenCalledTimes(1);
    expect(claude.read).toHaveBeenCalledWith('c2', expect.anything());
  });

  it('indexing stops reading older pages once 20 000 chars of text are collected', async () => {
    claude.items = [item('c1', 'claude', 100)];
    const big = 'x'.repeat(15_000);
    claude.read.mockImplementation(async (_id: string, o: { cursor?: string }) => {
      const n = Number(o.cursor ?? 0);
      return { messages: [{ type: 'user', message: { role: 'user', content: `${big} page ${n}` } }], next: n < 9 ? String(n + 1) : undefined };
    });
    await lib.refreshIndex();
    expect(claude.read).toHaveBeenCalledTimes(2);
    expect(index.indexedAt('c1')).toBe(100);
    // readAll without a budget still reads every page
    claude.read.mockClear();
    expect(await lib.readAll('c1')).toHaveLength(10);
  });

  it('the index pass does not re-list a source only because its TTL ran out (a watcher event does)', async () => {
    lib.dispose();
    lib = new LibraryService([claude, cai], index, meta, { trashDir: path.join(dir, 'library-trash'), listTtlMs: 0 });
    await lib.join('claudeai', true);
    await lib.list();
    const before = cai.list.mock.calls.length;
    await lib.refreshIndex();
    await lib.refreshIndex();
    expect(cai.list.mock.calls.length).toBe(before);
    // a watcher saw claude.ai's data change: the next pass revalidates it (behind the cache)
    const changed = new Promise<void>((r) => lib.once('changed', () => r()));
    lib.invalidate('claudeai', { soft: true });
    await lib.refreshIndex();
    await changed;
    expect(cai.list.mock.calls.length).toBeGreaterThan(before);
    // …and once refetched, age alone doesn't refetch again
    const after = cai.list.mock.calls.length;
    await lib.refreshIndex();
    expect(cai.list.mock.calls.length).toBe(after);
    // a client's list() still revalidates on the TTL
    await lib.list();
    expect(cai.list.mock.calls.length).toBeGreaterThan(after);
  });

  it('a Claude session with a full index text: only its summary follows while it is written, the text is re-read once quiet', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const t0 = 1_800_000_000_000;
      vi.setSystemTime(t0);
      let head = 'EARLY';
      claude.read.mockImplementation(async () => ({ messages: [{ type: 'user', message: { role: 'user', content: `${head} ${'y'.repeat(25_000)}` } }] }));
      claude.items = [item('c1', 'claude', t0 - 10 * 60_000)];
      await lib.refreshIndex();
      expect(claude.read).toHaveBeenCalledTimes(1);
      expect(index.textLength('c1')).toBe(20_000);
      claude.read.mockClear();
      const retry = vi.spyOn(lib, 'scheduleIndex');
      // being written (and compacted: the chain now starts elsewhere)
      head = 'LATE';
      vi.setSystemTime(t0 + 5_000);
      claude.items = [item('c1', 'claude', t0 + 4_000, { title: 'renamed' })];
      lib.invalidate();
      await lib.refreshIndex();
      expect(claude.read).not.toHaveBeenCalled();
      expect(index.indexedAt('c1')).toBe(t0 - 10 * 60_000); // touch keeps the old stamp
      expect(index.search('renamed', { limit: 5 }).map((h) => h.id)).toEqual(['c1']);
      expect(retry.mock.calls.at(-1)?.[1]).toEqual({ unlessSooner: true });
      expect(retry.mock.calls.at(-1)?.[0]).toBeGreaterThan(170_000);
      // quiet for 3 min: read once, the new start replaces the old
      vi.setSystemTime(t0 + 4_000 + 3 * 60_000 + 1);
      await lib.refreshIndex();
      expect(claude.read).toHaveBeenCalledTimes(1);
      expect(index.indexedAt('c1')).toBe(t0 + 4_000);
      expect(index.search('LATE', { limit: 5 }).map((h) => h.id)).toEqual(['c1']);
      expect(index.search('EARLY', { limit: 5 })).toEqual([]);
      await lib.refreshIndex();
      expect(claude.read).toHaveBeenCalledTimes(1); // and not again
    } finally {
      vi.useRealTimers();
    }
  });

  it('an index text with characters outside the BMP still counts as full', () => {
    index.upsert(item('c9', 'claude', 1), `😀${'x'.repeat(25_000)}`);
    expect(index.textLength('c9')).toBe(20_000);
  });

  it("a pass's retry for a live session does not push back a pass that is already due sooner", async () => {
    const run = vi.spyOn(lib, 'refreshIndex').mockResolvedValue();
    vi.useFakeTimers();
    try {
      lib.scheduleIndex(5_000);
      lib.scheduleIndex(171_000, { unlessSooner: true });
      await vi.advanceTimersByTimeAsync(5_100);
      expect(run).toHaveBeenCalledTimes(1);
      // …but it does replace a later one, and a plain request still debounces
      lib.scheduleIndex(60_000);
      lib.scheduleIndex(10_000, { unlessSooner: true });
      await vi.advanceTimersByTimeAsync(10_100);
      expect(run).toHaveBeenCalledTimes(2);
      lib.scheduleIndex(5_000);
      await vi.advanceTimersByTimeAsync(4_000);
      lib.scheduleIndex(5_000);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(run).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1_100);
      expect(run).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a session still being written is re-read at most every 3 minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const t0 = 1_800_000_000_000;
      vi.setSystemTime(t0);
      claude.items = [item('c1', 'claude', t0 - 1_000)];
      await lib.refreshIndex();
      expect(claude.read).toHaveBeenCalledTimes(1);
      const retry = vi.spyOn(lib, 'scheduleIndex');
      vi.setSystemTime(t0 + 10_000);
      claude.items = [item('c1', 'claude', t0 + 9_000)];
      lib.invalidate();
      await lib.refreshIndex();
      expect(claude.read).toHaveBeenCalledTimes(1); // skipped: indexed 10 s ago and still changing
      expect(index.indexedAt('c1')).toBe(t0 - 1_000);
      expect(retry).toHaveBeenCalledWith(expect.any(Number), { unlessSooner: true });
      expect(retry.mock.calls[0][0]).toBeGreaterThan(160_000);
      vi.setSystemTime(t0 + 3 * 60_000 + 1);
      await lib.refreshIndex();
      expect(claude.read).toHaveBeenCalledTimes(2);
      expect(index.indexedAt('c1')).toBe(t0 + 9_000);
      // changed again 2 s after that read: skipped while it is live, read once it has been quiet for 3 min
      claude.items = [item('c1', 'claude', t0 + 9_500)];
      vi.setSystemTime(t0 + 3 * 60_000 + 2_000);
      lib.invalidate();
      await lib.refreshIndex();
      expect(claude.read).toHaveBeenCalledTimes(2);
      vi.setSystemTime(t0 + 20 * 60_000);
      await lib.refreshIndex();
      expect(claude.read).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('…but one indexed while still empty (a new conversation before its first turn) is re-read right away', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const t0 = 1_800_000_000_000;
      vi.setSystemTime(t0);
      claude.read.mockImplementationOnce(async () => ({ messages: [] }));
      claude.items = [item('c1', 'claude', t0 - 1_000)];
      await lib.refreshIndex();
      vi.setSystemTime(t0 + 10_000);
      claude.items = [item('c1', 'claude', t0 + 9_000)];
      lib.invalidate();
      await lib.refreshIndex();
      expect(claude.read).toHaveBeenCalledTimes(2); // not 3 minutes later
      expect((await lib.search('hello', 10)).map((h) => h.session.sessionId)).toContain('c1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('search uses the index and fills in summaries', async () => {
    await lib.refreshIndex();
    const hits = await lib.search('hello', 10);
    expect(hits.map((h) => h.session.sessionId).sort()).toEqual(['c1', 'c2']);
  });

  it('rename / fork dispatch by caps and refuse when unsupported', async () => {
    await lib.rename('c1', 'new');
    expect(claude.rename).toHaveBeenCalledWith('c1', 'new');
    expect(await lib.fork('c1')).toEqual({ sessionId: 'forked' });
    (cai as any).caps = { ...ALL, rename: false };
    await lib.join('claudeai', true);
    await lib.list();
    await expect(lib.rename('claudeai-t1', 'x')).rejects.toThrow('该来源不支持此操作');
  });
});
