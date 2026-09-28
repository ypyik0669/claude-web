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
  const sent: { sessionId: string; text: string }[] = [];
  return {
    opened,
    sent,
    get: () => undefined,
    close: vi.fn(async () => {}),
    open: vi.fn((p: any) => {
      opened.push(p);
      return { sessionId: p.sessionId, info: { sessionId: p.sessionId, cwd: p.cwd, agent: p.agent }, getHistory: () => [], send: (text: string) => { sent.push({ sessionId: p.sessionId, text }); } };
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
    // the non-Claude target actually receives the briefing as its first message
    expect(pool.sent).toEqual([{ sessionId: r.sessionId, text: r.briefing }]);
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
    expect(pool.sent).toEqual([]); // Claude gets the briefing inside resumeEntries, not as a message
    expect(r.briefing).toBeUndefined();
  });

  it('a claude-web session (not imported) still swaps in place', async () => {
    await mods.transcripts.create({ sessionId: 'own-1', agent: 'codex', cwd: '/proj/own', title: 'own', createdAt: 1 });
    const r = await mods.swap.swapAgent(deps, 'own-1', 'gemini', undefined);
    expect(r.sessionId).toBe('own-1');
    expect(pool.sent).toHaveLength(1);
    expect(pool.sent[0].sessionId).toBe('own-1');
    expect(pool.sent[0].text).toBe(r.briefing);
  });
});

// A pool that holds live runners (info with model / provider), so swapProvider sees what it is replacing.
function livePool(initial: Record<string, any>) {
  const runners = new Map<string, any>(Object.entries(initial).map(([id, info]) => [id, { info: { sessionId: id, cwd: '/proj', agent: 'claude', ...info } }]));
  const opened: any[] = [];
  const events: string[] = [];
  return {
    opened, events,
    emit: () => true,
    get: (id: string) => runners.get(id),
    close: vi.fn(async (id: string) => { events.push(`close:${id}`); await new Promise((r) => setTimeout(r, 20)); runners.delete(id); }),
    open: vi.fn((p: any) => {
      events.push(`open:${p.sessionId}:${p.providerId ?? 'claude'}`);
      opened.push(p);
      const r = { sessionId: p.sessionId, info: { sessionId: p.sessionId, cwd: p.cwd, agent: p.agent, model: p.model, providerId: p.providerId }, getHistory: () => [], send: () => {} };
      runners.set(p.sessionId, r);
      return r;
    }),
  };
}

describe('swapProvider (model with the profile)', () => {
  let dir: string;
  let deps: any;
  let swap: any;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-swapp-'));
    const [{ MetaStore }, { CanonicalLog }, { AgentTranscripts }] = await Promise.all([import('../meta/store.js'), import('./canonical.js'), import('../agents/transcript.js')]);
    swap = await import('./swap.js');
    const meta = new MetaStore(path.join(dir, 'meta.json'));
    deps = { canonical: new CanonicalLog(), transcripts: new AgentTranscripts(), meta };
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

  it('another profile with a picked model → that model', async () => {
    const pool = livePool({ s1: { model: 'claude-opus-5', providerId: 'prov-a' } });
    await swap.swapProvider({ ...deps, pool }, 's1', 'prov-b', 'B', 'gpt-6-astra');
    expect(pool.opened[0]).toMatchObject({ providerId: 'prov-b', model: 'gpt-6-astra' });
  });
  it('another profile without a model → no model (the profile / login default), never the model of the old profile', async () => {
    const pool = livePool({ s1: { model: 'claude-opus-5', providerId: 'prov-a' } });
    await swap.swapProvider({ ...deps, pool }, 's1', 'prov-b', 'B');
    expect(pool.opened[0].model).toBeUndefined();
    const pool2 = livePool({ s2: { model: 'gpt-6-astra', providerId: 'prov-b' } });
    await swap.swapProvider({ ...deps, pool: pool2 }, 's2', undefined, 'Claude 账号');
    expect(pool2.opened[0].model).toBeUndefined();
  });
  it('the switch mark records where the session came from (usage attributes earlier turns to it)', async () => {
    const marks: any[] = [];
    const canonical = { ...deps.canonical, head: async () => null, mark: (_sid: string, e: any) => marks.push(e) };
    await swap.swapProvider({ ...deps, canonical, pool: livePool({ s1: { providerId: 'prov-a' } }) }, 's1', 'prov-b', 'B');
    await swap.swapProvider({ ...deps, canonical, pool: livePool({ s2: {} }) }, 's2', 'prov-b', 'B');
    expect(marks.map((m) => [m.providerId, m.fromProviderId])).toEqual([['prov-b', 'prov-a'], ['prov-b', 'claude']]);
  });
  it('the same profile without a model (a plain restart) keeps the current model', async () => {
    const pool = livePool({ s1: { model: 'claude-opus-5', providerId: 'prov-a' } });
    await swap.swapProvider({ ...deps, pool }, 's1', 'prov-a', 'A');
    expect(pool.opened[0].model).toBe('claude-opus-5');
  });
  it('two swaps of one session issued at once never interleave (the lock is inside swapProvider, whoever calls it)', async () => {
    const pool = livePool({ s1: { model: 'm', providerId: 'prov-a' } });
    await Promise.all([swap.swapProvider({ ...deps, pool }, 's1', 'prov-b', 'B'), swap.swapProvider({ ...deps, pool }, 's1', 'prov-c', 'C')]);
    expect(pool.events).toEqual(['close:s1', 'open:s1:prov-b', 'close:s1', 'open:s1:prov-c']);
  });
  it('without a live runner the remembered profile decides whether it changed', async () => {
    const pool = livePool({});
    await deps.meta.setSessionMeta('s3', { providerId: 'prov-a' });
    await swap.swapProvider({ ...deps, pool }, 's3', 'prov-b', 'B');
    expect(pool.opened[0].model).toBeUndefined();
  });
});

describe('per-session swap lock', () => {
  it('two swaps of one session run one after the other; other sessions are not held up', async () => {
    const { withSessionLock } = await import('./swap.js');
    const log: string[] = [];
    const task = (id: string, tag: string, ms: number) => withSessionLock(id, async () => { log.push(`start ${tag}`); await new Promise((r) => setTimeout(r, ms)); log.push(`end ${tag}`); return tag; });
    const all = await Promise.all([task('s', 'a', 40), task('s', 'b', 5), task('t', 'c', 5)]);
    expect(all).toEqual(['a', 'b', 'c']);
    expect(log.indexOf('end a')).toBeLessThan(log.indexOf('start b'));
    expect(log.indexOf('end c')).toBeLessThan(log.indexOf('end a'));
  });
  it('a failed swap does not wedge the next one', async () => {
    const { withSessionLock } = await import('./swap.js');
    await expect(withSessionLock('x', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(withSessionLock('x', async () => 'ok')).resolves.toBe('ok');
  });
});
