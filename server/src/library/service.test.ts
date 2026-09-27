import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentKind, SessionSummary, SourceCaps, SourceStatus } from '../protocol.js';
import type { SessionSource } from './types.js';
import { LibraryIndex } from './index-db.js';
import { AgentTranscripts } from '../agents/transcript.js';
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
    status: vi.fn(async (): Promise<SourceStatus> => ({ kind, name, installed: true, detected: true, joined: false, dismissed: false, enabled: true })),
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

function fakeAgents(installed: AgentKind[]) {
  const defs = [
    { kind: 'claude' as AgentKind, name: 'Claude Code', protocol: 'claude' },
    { kind: 'codex' as AgentKind, name: 'Codex', protocol: 'codex' },
    { kind: 'opencode' as AgentKind, name: 'OpenCode', protocol: 'acp' },
    { kind: 'gemini' as AgentKind, name: 'Gemini CLI', protocol: 'acp' },
  ];
  return {
    defs: () => defs,
    list: vi.fn(async () => defs.map((d) => ({ ...d, installed: d.kind === 'claude' || installed.includes(d.kind) }))),
  };
}

describe('LibraryService', () => {
  let dir: string;
  let prevDir: string | undefined;
  let index: LibraryIndex;
  let transcripts: AgentTranscripts;
  let meta: MetaStore;
  let claude: ReturnType<typeof fakeSource>;
  let codex: ReturnType<typeof fakeSource>;
  let lib: LibraryService;

  const make = (installed: AgentKind[] = ['codex']) =>
    new LibraryService([claude, codex], index, transcripts, meta, { agents: fakeAgents(installed), makeSource: (k) => fakeSource(k, []), dataDirs: {}, trashDir: path.join(dir, 'library-trash') });

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-libsvc-'));
    prevDir = process.env.CLAUDE_WEB_DIR;
    process.env.CLAUDE_WEB_DIR = dir;
    index = new LibraryIndex(path.join(dir, 'library.db'));
    transcripts = new AgentTranscripts();
    meta = new MetaStore(path.join(dir, 'meta.json'));
    await meta.load();
    claude = fakeSource('claude', [item('c1', 'claude', 100), item('c2', 'claude', 300)], 'Claude Code');
    codex = fakeSource('codex', [item('codex-t1', 'codex', 200)]);
    lib = make();
  });

  afterEach(async () => {
    lib.dispose();
    index.close();
    if (prevDir === undefined) delete process.env.CLAUDE_WEB_DIR; else process.env.CLAUDE_WEB_DIR = prevDir;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('never lists or probes a source that has not been joined', async () => {
    const ids = (await lib.list()).map((s) => s.sessionId);
    expect(ids).toEqual(['c2', 'c1']);
    const st = await lib.sources();
    expect(st.find((s) => s.kind === 'codex')).toMatchObject({ joined: false, enabled: false, installed: true, detected: true, name: 'Codex' });
    expect(codex.list).not.toHaveBeenCalled();
    expect(codex.status).not.toHaveBeenCalled();
  });

  it('join adds the source (merged, sorted); leave removes it, closes it and drops its index rows', async () => {
    await lib.join('codex', true);
    expect(meta.settings()['library.joined']).toEqual(['codex']);
    expect((await lib.list()).map((s) => s.sessionId)).toEqual(['c2', 'codex-t1', 'c1']);
    index.upsert(item('codex-t1', 'codex', 200), 'codex words');
    await lib.join('codex', false);
    expect(codex.close).toHaveBeenCalled();
    expect((await lib.list()).map((s) => s.sessionId)).toEqual(['c2', 'c1']);
    expect(index.indexedAt('codex-t1')).toBeUndefined();
    expect(meta.settings()['library.joined']).toEqual([]);
  });

  it('claude cannot be left', async () => {
    await expect(lib.join('claude', false)).rejects.toThrow();
  });

  it('detect() returns installed, not joined, not dismissed sources only', async () => {
    lib = make(['codex', 'gemini']);
    expect((await lib.detect()).sort()).toEqual(['codex', 'gemini']);
    await lib.dismiss('gemini');
    expect(await lib.detect()).toEqual(['codex']);
    await lib.join('codex', true);
    expect(await lib.detect()).toEqual([]);
  });

  it('detect() also counts a source whose data dir exists', async () => {
    const d = path.join(dir, 'oc-data');
    fs.mkdirSync(d);
    lib = new LibraryService([claude, codex], index, transcripts, meta, { agents: fakeAgents([]), makeSource: (k) => fakeSource(k, []), dataDirs: { opencode: [d] }, trashDir: path.join(dir, 'library-trash') });
    expect(await lib.detect()).toEqual(['opencode']);
  });

  it('dedupes a claude-web session with the imported item it resumes', async () => {
    const srcCaps: SourceCaps = { resume: true, rename: false, archive: false, delete: true, fork: false };
    codex.items = [item('codex-t1', 'codex', 200, { caps: srcCaps, title: 'native title' })];
    await lib.join('codex', true);
    await transcripts.create({ sessionId: 'uuid-1', agent: 'codex', cwd: '/w', title: 'mine', createdAt: 1, nativeSessionId: 't1' });
    const mtime = fs.statSync(transcripts.file('uuid-1')).mtimeMs;
    const list = await lib.list();
    const hit = list.filter((s) => s.sessionId === 'uuid-1' || s.sessionId === 'codex-t1');
    expect(hit).toHaveLength(1);
    expect(hit[0].sessionId).toBe('uuid-1'); // claude-web's id
    expect(hit[0].caps).toEqual(srcCaps); // the source's caps
    expect(hit[0].lastModified).toBe(Math.max(200, mtime)); // the newer of the two (file mtime here)

    // and when the native side is newer, its lastModified wins
    const future = Date.now() + 3_600_000;
    codex.items = [item('codex-t1', 'codex', future, { caps: srcCaps })];
    lib.invalidate();
    expect((await lib.list()).find((s) => s.sessionId === 'uuid-1')?.lastModified).toBe(future);
  });

  it('lists archived sessions of archive-capable sources, flagged archived', async () => {
    codex.list.mockImplementation(async (o: { archived?: boolean }) => ({ items: o.archived ? [item('codex-old', 'codex', 50)] : codex.items }));
    await lib.join('codex', true);
    const list = await lib.list();
    expect(list.find((s) => s.sessionId === 'codex-old')?.archived).toBe(true);
    expect(list.find((s) => s.sessionId === 'codex-t1')?.archived).toBeUndefined();
    expect(codex.list).toHaveBeenCalledWith(expect.objectContaining({ archived: true }));
  });

  it('does not ask a source without archive caps for archived sessions', async () => {
    (codex as any).caps = { ...ALL, archive: false };
    await lib.join('codex', true);
    await lib.list();
    expect(codex.list).not.toHaveBeenCalledWith(expect.objectContaining({ archived: true }));
  });

  it('concurrent list() calls share one fetch per source', async () => {
    await lib.join('codex', true);
    await Promise.all([lib.list(), lib.list(), lib.list()]);
    expect(codex.list).toHaveBeenCalledTimes(2); // one live + one archived page, not 3x
  });

  it('leaving a source keeps index rows of claude-web sessions of that agent', async () => {
    await lib.join('codex', true);
    await transcripts.create({ sessionId: 'uuid-own', agent: 'codex', cwd: '/w', title: 'own', createdAt: 1 });
    await lib.list();
    index.upsert(item('uuid-own', 'codex', 1), 'own words');
    index.upsert(item('codex-t1', 'codex', 200), 'codex words');
    await lib.join('codex', false);
    expect(index.indexedAt('uuid-own')).toBe(1);
    expect(index.indexedAt('codex-t1')).toBeUndefined();
  });

  const bounded = () => new LibraryService([claude, codex], index, transcripts, meta, { agents: fakeAgents(['codex']), dataDirs: {}, trashDir: path.join(dir, 'library-trash'), listTimeoutMs: 50 });

  it('first load of a never-settling source: others still list, it is loading (not an error)', async () => {
    lib.dispose();
    lib = bounded();
    codex.list.mockImplementation(() => new Promise(() => {}));
    await lib.join('codex', true);
    const t0 = Date.now();
    expect((await lib.list()).map((s) => s.sessionId)).toEqual(['c2', 'c1']);
    expect(Date.now() - t0).toBeLessThan(2000);
    const st = (await lib.sources()).find((s) => s.kind === 'codex');
    expect(st?.loading).toBe(true);
    expect(st?.error).toBeUndefined();
  });

  it('callers joining the in-flight fetch are bounded too', async () => {
    lib.dispose();
    lib = bounded();
    codex.list.mockImplementation(() => new Promise(() => {}));
    await lib.join('codex', true);
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
    (codex as any).caps = { ...ALL, archive: false };
    let release!: () => void;
    codex.list.mockImplementation(() => new Promise((r) => { release = () => r({ items: codex.items }); }));
    await lib.join('codex', true);
    expect((await lib.list()).map((s) => s.sessionId)).toEqual(['c2', 'c1']);
    expect((await lib.sources()).find((s) => s.kind === 'codex')?.loading).toBe(true);
    const changed = new Promise<void>((r) => lib.once('changed', () => r()));
    release();
    await changed;
    expect((await lib.list()).map((s) => s.sessionId)).toEqual(['c2', 'codex-t1', 'c1']);
    const st = (await lib.sources()).find((s) => s.kind === 'codex');
    expect(st?.loading).toBeUndefined();
    expect(st?.error).toBeUndefined();
  });

  it('a timeout with a cached list is an error (cache served), cleared by the next success even from an older generation', async () => {
    lib.dispose();
    lib = bounded();
    (codex as any).caps = { ...ALL, archive: false };
    await lib.join('codex', true);
    expect((await lib.list()).map((s) => s.sessionId)).toEqual(['c2', 'codex-t1', 'c1']);
    let release!: () => void;
    codex.list.mockImplementation(() => new Promise((r) => { release = () => r({ items: codex.items }); }));
    lib.invalidate('codex');
    expect((await lib.list()).map((s) => s.sessionId)).toEqual(['c2', 'codex-t1', 'c1']);
    const st = (await lib.sources()).find((s) => s.kind === 'codex');
    expect(st?.error).toMatch(/超时/);
    expect(st?.loading).toBeUndefined();
    lib.invalidate('codex'); // the hung fetch is now an older generation
    const changed = new Promise<void>((r) => lib.once('changed', () => r()));
    release();
    await changed;
    expect((await lib.sources()).find((s) => s.kind === 'codex')?.error).toBeUndefined();
  });

  it('stale-while-revalidate: a cached source past its TTL is served at once and refreshed behind', async () => {
    lib.dispose();
    lib = new LibraryService([claude, codex], index, transcripts, meta, { agents: fakeAgents(['codex']), dataDirs: {}, trashDir: path.join(dir, 'library-trash'), listTtlMs: 0 });
    (codex as any).caps = { ...ALL, archive: false };
    await lib.join('codex', true);
    expect((await lib.list()).map((s) => s.sessionId)).toEqual(['c2', 'codex-t1', 'c1']);
    let release!: () => void;
    codex.list.mockImplementation(() => new Promise((r) => { release = () => r({ items: [item('codex-t9', 'codex', 250)] }); }));
    const t0 = Date.now();
    expect((await lib.list()).map((s) => s.sessionId)).toEqual(['c2', 'codex-t1', 'c1']); // cached, not waited for
    expect(Date.now() - t0).toBeLessThan(1000);
    expect((await lib.sources()).find((s) => s.kind === 'codex')?.error).toBeUndefined();
    const changed = new Promise<void>((r) => lib.once('changed', () => r()));
    release();
    await changed;
    codex.list.mockImplementation(async () => ({ items: [item('codex-t9', 'codex', 250)] }));
    expect((await lib.list()).map((s) => s.sessionId)).toEqual(['c2', 'codex-t9', 'c1']);
  });

  it('leaving a source while its fetch is in flight: a late success is not cached', async () => {
    lib.dispose();
    lib = bounded();
    (codex as any).caps = { ...ALL, archive: false };
    let release!: () => void;
    codex.list.mockImplementationOnce(() => new Promise((r) => { release = () => r({ items: [item('codex-old', 'codex', 1)] }); }));
    await lib.join('codex', true);
    await lib.list(); // first load outlives the bound
    await lib.join('codex', false);
    release();
    await new Promise((r) => setTimeout(r, 20));
    codex.list.mockImplementation(() => new Promise(() => {})); // after re-join: still loading
    await lib.join('codex', true);
    expect((await lib.list()).map((s) => s.sessionId)).toEqual(['c2', 'c1']);
    const st = (await lib.sources()).find((s) => s.kind === 'codex');
    expect(st?.count).toBeUndefined();
    expect(st?.loading).toBe(true);
  });

  it('leaving a source while its fetch is in flight: a late failure sets no error', async () => {
    lib.dispose();
    lib = bounded();
    (codex as any).caps = { ...ALL, archive: false };
    let fail!: () => void;
    codex.list.mockImplementationOnce(() => new Promise((_r, rej) => { fail = () => rej(new Error('late boom')); }));
    await lib.join('codex', true);
    await lib.list();
    await lib.join('codex', false);
    fail();
    await new Promise((r) => setTimeout(r, 20));
    codex.list.mockImplementation(() => new Promise(() => {}));
    await lib.join('codex', true);
    await lib.list();
    expect((await lib.sources()).find((s) => s.kind === 'codex')?.error).toBeUndefined();
  });

  it('file watchers run only for joined sources: started on join, stopped on leave', async () => {
    const claudeDir = path.join(dir, 'claude-projects');
    const codexDir = path.join(dir, 'codex-sessions');
    fs.mkdirSync(claudeDir);
    fs.mkdirSync(codexDir);
    lib.start({ claude: [claudeDir], codex: [codexDir] });
    const watched = () => [...((lib as any).watchers as Map<string, unknown>).keys()].sort();
    expect(watched()).toEqual(['claude']);
    await lib.join('codex', true);
    expect(watched()).toEqual(['claude', 'codex']);
    await lib.join('codex', false);
    expect(watched()).toEqual(['claude']);
  });

  it('a parent cycle folds nothing: every member stays visible', async () => {
    codex.items = [
      item('codex-a', 'codex', 200, { parentId: 'codex-b' }),
      item('codex-b', 'codex', 210, { parentId: 'codex-a' }),
    ];
    await lib.join('codex', true);
    const list = await lib.list();
    expect(list.map((s) => s.sessionId)).toEqual(['c2', 'codex-b', 'codex-a', 'c1']);
    expect(list.every((s) => !s.childCount)).toBe(true);
  });

  it('nested sub-agents fold transitively under the top-level ancestor', async () => {
    codex.items = [
      item('codex-root', 'codex', 200),
      item('codex-kid', 'codex', 210, { parentId: 'codex-root' }),
      item('codex-grandkid', 'codex', 220, { parentId: 'codex-kid' }),
      item('codex-orphan', 'codex', 230, { parentId: 'codex-missing' }),
    ];
    await lib.join('codex', true);
    const list = await lib.list();
    expect(list.map((s) => s.sessionId)).toEqual(['c2', 'codex-orphan', 'codex-root', 'c1']);
    expect(list.find((s) => s.sessionId === 'codex-root')?.childCount).toBe(2);
    expect(list.find((s) => s.sessionId === 'codex-orphan')?.childCount).toBeUndefined();
  });

  it('refreshIndex stamps indexedAt on a joined source with no sessions, not on a failed one', async () => {
    claude.items = [];
    codex.list.mockRejectedValue(new Error('app-server crashed'));
    await lib.join('codex', true);
    await lib.refreshIndex();
    const st = await lib.sources();
    const cl = st.find((s) => s.kind === 'claude');
    expect(cl?.count).toBe(0);
    expect(typeof cl?.indexedAt).toBe('number');
    expect(st.find((s) => s.kind === 'codex')?.indexedAt).toBeUndefined();
  });

  it('refreshIndex prunes ids that no longer exist', async () => {
    index.upsert(item('gone', 'claude', 1), 'stale');
    await lib.refreshIndex();
    expect(index.indexedAt('gone')).toBeUndefined();
  });

  it('refreshIndex keeps the index rows of a source whose fetch failed', async () => {
    await lib.join('codex', true);
    await lib.refreshIndex();
    expect(index.indexedAt('codex-t1')).toBe(200);
    // a fresh service (e.g. after a restart) has no last good list for codex, and codex fails
    lib.dispose();
    codex.list.mockRejectedValue(new Error('app-server crashed'));
    lib = make();
    await lib.refreshIndex();
    expect(index.indexedAt('codex-t1')).toBe(200);
    expect(index.indexedAt('c1')).toBe(100);
  });

  it('invalidate() during an in-flight fetch starts a new fetch; the stale one is not cached as fresh', async () => {
    (codex as any).caps = { ...ALL, archive: false };
    await lib.join('codex', true);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    codex.list.mockImplementationOnce(async () => { await gate; return { items: [item('codex-old', 'codex', 1)] }; });
    const first = lib.list();
    await new Promise((r) => setTimeout(r, 10));
    lib.invalidate('codex');
    codex.items = [item('codex-new', 'codex', 2)];
    const second = lib.list();
    release();
    await first;
    expect((await second).map((s) => s.sessionId)).toContain('codex-new');
    expect(codex.list).toHaveBeenCalledTimes(2);
    // the pre-invalidation result must not have become the fresh cache
    expect((await lib.list()).map((s) => s.sessionId)).toContain('codex-new');
    expect(codex.list).toHaveBeenCalledTimes(2);
  });

  it('search uses the fallback until the first index pass has finished', async () => {
    const fallback = vi.fn(async () => [{ session: item('fb', 'claude', 1) }]);
    lib = new LibraryService([claude, codex], index, transcripts, meta, { agents: fakeAgents([]), fallbackSearch: fallback, dataDirs: {}, trashDir: path.join(dir, 'library-trash') });
    index.upsert(item('c1', 'claude', 100), 'hello partial'); // partially indexed, no pass finished
    expect((await lib.search('hello', 10)).map((h) => h.session.sessionId)).toEqual(['fb']);
    expect(fallback).toHaveBeenCalledWith('hello', 10);
    await lib.refreshIndex();
    fallback.mockClear();
    expect((await lib.search('hello', 10)).map((h) => h.session.sessionId).sort()).toEqual(['c1', 'c2']);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('routes a prefixed gemini id to the gemini source without any prior list()', async () => {
    const gem = fakeSource('gemini', [item('gemini-g1', 'gemini', 10)]);
    lib = new LibraryService([claude, codex], index, transcripts, meta, { agents: fakeAgents(['gemini']), makeSource: (k) => (k === 'gemini' ? gem : null), dataDirs: {}, trashDir: path.join(dir, 'library-trash') });
    await lib.join('gemini', true);
    expect(await lib.kindOf('gemini-g1')).toBe('gemini');
    await lib.read('gemini-g1');
    expect(gem.read).toHaveBeenCalledWith('g1', expect.anything());
  });

  it('folds children under their parent', async () => {
    claude.items = [item('p', 'claude', 100), item('k', 'claude', 200, { parentId: 'p' })];
    const list = await lib.list();
    expect(list.map((s) => s.sessionId)).toEqual(['p']);
    expect(list[0].childCount).toBe(1);
  });

  it('a failing source does not break the others and reports its error', async () => {
    await lib.join('codex', true);
    await lib.list();
    codex.list.mockRejectedValue(new Error('boom'));
    lib.invalidate();
    const ids = (await lib.list()).map((s) => s.sessionId);
    expect(ids).toContain('c1');
    expect(ids).toContain('codex-t1'); // last good result
    const st = (await lib.sources()).find((s) => s.kind === 'codex');
    expect(st?.error).toContain('boom');
    expect(st?.joined).toBe(true);
  });

  it('remove: a failed export keeps the session', async () => {
    await lib.join('codex', true);
    await lib.list();
    codex.exportAll.mockRejectedValue(new Error('export failed'));
    const r = await lib.remove(['codex-t1', 'c1']);
    expect(r.failed.map((f) => f.id)).toEqual(['codex-t1']);
    expect(codex.remove).not.toHaveBeenCalled();
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

  it('prepareResume creates an imported head once', async () => {
    await lib.join('codex', true);
    const spy = vi.spyOn(transcripts, 'create');
    expect(await lib.prepareResume('codex-t1')).toEqual({ agent: 'codex', cwd: '/w' });
    const head = await transcripts.head('codex-t1');
    expect(head).toMatchObject({ nativeSessionId: 't1', agent: 'codex', imported: true });
    await lib.prepareResume('codex-t1');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('imported sessions read from the source, not the local transcript', async () => {
    await lib.join('codex', true);
    await lib.prepareResume('codex-t1');
    const r = await lib.read('codex-t1');
    expect(codex.read).toHaveBeenCalledWith('t1', expect.anything());
    expect(r.messages[0].message.content).toBe('hello from t1');
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

  it('search uses the index and fills in summaries', async () => {
    await lib.refreshIndex();
    const hits = await lib.search('hello', 10);
    expect(hits.map((h) => h.session.sessionId).sort()).toEqual(['c1', 'c2']);
  });

  it('rename / fork dispatch by caps and refuse when unsupported', async () => {
    await lib.rename('c1', 'new');
    expect(claude.rename).toHaveBeenCalledWith('c1', 'new');
    expect(await lib.fork('c1')).toEqual({ sessionId: 'forked' });
    (codex as any).caps = { ...ALL, rename: false };
    await lib.join('codex', true);
    await lib.list();
    await expect(lib.rename('codex-t1', 'x')).rejects.toThrow('该来源不支持此操作');
  });
});
