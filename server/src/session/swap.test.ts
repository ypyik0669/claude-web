// Hand-over (session.switchAgent) of IMPORTED library sessions: always a new session seeded from the
// library history, cwd from the library summary, the imported session left untouched.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentKind, SessionSummary, SourceCaps } from '../protocol.js';
import type { SessionSource } from '../library/types.js';

const ALL: SourceCaps = { resume: true, rename: false, archive: false, delete: false, fork: false };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function source(kind: AgentKind, items: SessionSummary[]): SessionSource {
  return {
    kind, caps: ALL,
    status: async () => ({ kind, name: kind, installed: true, detected: true, joined: true, dismissed: false, enabled: true }),
    list: async () => ({ items }),
    read: async (nativeId: string) => ({ messages: [
      { type: 'user', message: { role: 'user', content: `native question from ${nativeId}` } },
      { type: 'assistant', message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'native answer' }] } },
    ] }),
    close: async () => {},
  };
}

function fakePool() {
  const opened: any[] = [];
  return {
    opened,
    get: () => undefined,
    close: vi.fn(async () => {}),
    open: vi.fn((p: any) => {
      opened.push(p);
      return { sessionId: p.sessionId, info: { sessionId: p.sessionId, cwd: p.cwd, agent: p.agent }, getHistory: () => [] };
    }),
  };
}

describe('swapAgent / handOver of imported sessions', () => {
  let dir: string;
  let prevDir: string | undefined;
  let mods: any;
  let lib: any;
  let deps: any;
  let pool: ReturnType<typeof fakePool>;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-swap-'));
    prevDir = process.env.CLAUDE_WEB_DIR;
    process.env.CLAUDE_WEB_DIR = dir;
    const [{ LibraryService }, { LibraryIndex }, { AgentTranscripts }, { MetaStore }, { CanonicalLog }, swap] = await Promise.all([
      import('../library/service.js'), import('../library/index-db.js'), import('../agents/transcript.js'),
      import('../meta/store.js'), import('./canonical.js'), import('./swap.js'),
    ]);
    const meta = new MetaStore(path.join(dir, 'meta.json'));
    await meta.load();
    await meta.setSetting('library.joined', ['codex']);
    const transcripts = new AgentTranscripts();
    const codex = source('codex', [{ sessionId: 'codex-t1', title: 'imported one', cwd: '/proj/imported', lastModified: 5, agent: 'codex', caps: ALL }]);
    const claude = source('claude', []);
    lib = new LibraryService([claude, codex], new LibraryIndex(path.join(dir, 'library.db')), transcripts, meta, { dataDirs: {}, trashDir: path.join(dir, 'trash') });
    pool = fakePool();
    deps = { pool, canonical: new CanonicalLog(), transcripts, meta, readAll: (id: string) => lib.readAll(id), imported: (id: string) => lib.importedInfo(id) };
    mods = { swap, transcripts };
  });

  afterEach(async () => {
    await lib.close();
    if (prevDir === undefined) delete process.env.CLAUDE_WEB_DIR; else process.env.CLAUDE_WEB_DIR = prevDir;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('a never-opened imported session → new session, cwd from the library summary, imported row still listed', async () => {
    const r = await mods.swap.swapAgent(deps, 'codex-t1', 'gemini', undefined);
    expect(r.sessionId).not.toBe('codex-t1');
    expect(pool.opened).toHaveLength(1);
    expect(pool.opened[0]).toMatchObject({ sessionId: r.sessionId, cwd: '/proj/imported', agent: 'gemini' });
    expect(await mods.transcripts.head(r.sessionId)).toMatchObject({ agent: 'gemini', cwd: '/proj/imported' });
    expect(r.briefing).toContain('native question from t1');
    expect(await mods.transcripts.head('codex-t1')).toBeNull(); // untouched
    expect((await lib.list()).map((s: SessionSummary) => s.sessionId)).toContain('codex-t1');
    expect(pool.close).not.toHaveBeenCalledWith('codex-t1');
  });

  it('a previously opened imported session (imported head exists) → same: new session, head untouched', async () => {
    await lib.prepareResume('codex-t1');
    const before = await mods.transcripts.head('codex-t1');
    const r = await mods.swap.swapAgent(deps, 'codex-t1', 'gemini', undefined);
    expect(r.sessionId).not.toBe('codex-t1');
    expect(pool.opened[0]).toMatchObject({ cwd: '/proj/imported', agent: 'gemini' });
    expect(await mods.transcripts.head('codex-t1')).toEqual(before);
    expect((await lib.list()).map((s: SessionSummary) => s.sessionId)).toContain('codex-t1');
  });

  it('hand-over to Claude from a codex- id creates a UUID session resumed from synthesized entries', async () => {
    const r = await mods.swap.swapAgent(deps, 'codex-t1', 'claude', undefined);
    expect(r.sessionId).toMatch(UUID_RE);
    const p = pool.opened[0];
    expect(p).toMatchObject({ sessionId: r.sessionId, cwd: '/proj/imported', agent: 'claude' });
    expect(JSON.stringify(p.resumeEntries)).toContain('native question from t1');
    expect(await mods.transcripts.head(r.sessionId)).toBeNull(); // Claude keeps its own jsonl
  });

  it('a claude-web session (not imported) still swaps in place', async () => {
    await mods.transcripts.create({ sessionId: 'own-1', agent: 'codex', cwd: '/proj/own', title: 'own', createdAt: 1 });
    const r = await mods.swap.swapAgent(deps, 'own-1', 'gemini', undefined);
    expect(r.sessionId).toBe('own-1');
  });
});
