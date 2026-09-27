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
    await lib.join('codex', true);
    await transcripts.create({ sessionId: 'uuid-1', agent: 'codex', cwd: '/w', title: 'mine', createdAt: 1, nativeSessionId: 't1' });
    const list = await lib.list();
    const hit = list.filter((s) => s.sessionId === 'uuid-1' || s.sessionId === 'codex-t1');
    expect(hit).toHaveLength(1);
    expect(hit[0].sessionId).toBe('uuid-1');
    expect(hit[0].caps).toEqual(ALL);
    expect(hit[0].lastModified).toBeGreaterThan(200); // the transcript file mtime is newer than 200 ms-epoch
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
