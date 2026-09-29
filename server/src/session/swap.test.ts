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

describe('openOnProvider (session.open of an existing conversation with an explicit provider)', () => {
  let dir: string;
  let prevDir: string | undefined;
  let swap: any;
  let meta: any;
  let canonical: any;
  const nameOf = (id: string) => (id === 'claude' ? 'Claude 账号' : `name-${id}`);
  const switches = async (sid: string) => (await canonical.load(sid)).filter((e: any) => e.kind === 'switch');
  /** the hub's open: pool.open (hands back a live runner as it is) */
  const hooksFor = (pool: ReturnType<typeof livePool>, extra: { onRecorded?: () => void; before?: () => Promise<void> } = {}) => ({
    open: async (p: any) => { await extra.before?.(); const r = pool.open(p); return { opened: r.info.providerId ?? 'claude' }; },
    swapped: (r: any) => ({ swapped: r.info.providerId ?? 'claude' }),
    onRecorded: extra.onRecorded,
  });
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-openp-'));
    prevDir = process.env.CLAUDE_WEB_DIR;
    process.env.CLAUDE_WEB_DIR = dir; // the canonical mirror lives under the data dir: never the real ~/.claude-web
    const [{ MetaStore }, { CanonicalLog }] = await Promise.all([import('../meta/store.js'), import('./canonical.js')]);
    swap = await import('./swap.js');
    meta = new MetaStore(path.join(dir, 'meta.json'));
    await meta.load();
    canonical = new CanonicalLog();
  });
  afterEach(() => {
    if (prevDir === undefined) delete process.env.CLAUDE_WEB_DIR; else process.env.CLAUDE_WEB_DIR = prevDir;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('A: the account picked on a conversation recorded on p1, not running → SessionMeta cleared, one switch line from p1', async () => {
    await meta.setSessionMeta('h1', { providerId: 'p1' });
    const pool = livePool({});
    let recorded = 0;
    const r = await swap.openOnProvider({ pool, meta, canonical }, { sessionId: 'h1', cwd: '/proj', providerId: 'claude' }, nameOf, hooksFor(pool, { onRecorded: () => recorded++ }));
    expect(r).toEqual({ opened: 'claude' });
    expect(pool.opened.map((p: any) => p.providerId)).toEqual(['claude']);
    expect(meta.sessionMeta('h1').providerId).toBeUndefined();
    const sw = await switches('h1');
    expect(sw).toHaveLength(1);
    expect(sw[0]).toMatchObject({ fromProviderId: 'p1', providerName: 'Claude 账号' });
    expect(sw[0].providerId).toBeUndefined();
    expect(recorded).toBe(1);
  });
  it('B: p1 → p2, not running → SessionMeta p2 and a switch line p1 → p2 (the usage timeline reads it)', async () => {
    await meta.setSessionMeta('h2', { providerId: 'p1' });
    const pool = livePool({});
    await swap.openOnProvider({ pool, meta, canonical }, { sessionId: 'h2', cwd: '/proj', providerId: 'p2' }, nameOf, hooksFor(pool));
    expect(meta.sessionMeta('h2').providerId).toBe('p2');
    const sw = await switches('h2');
    expect(sw.map((e: any) => [e.providerId, e.fromProviderId, e.providerName])).toEqual([['p2', 'p1', 'name-p2']]);
  });
  it('nothing recorded = the account: picking a provider records a switch from claude', async () => {
    const pool = livePool({});
    await swap.openOnProvider({ pool, meta, canonical }, { sessionId: 'h3', cwd: '/proj', providerId: 'p2' }, nameOf, hooksFor(pool));
    expect(meta.sessionMeta('h3').providerId).toBe('p2');
    expect((await switches('h3')).map((e: any) => e.fromProviderId)).toEqual(['claude']);
  });
  it('running on another provider → the same as session.setProvider: swapped (closed, reopened on it), recorded (re-review m-3)', async () => {
    await meta.setSessionMeta('live', { providerId: 'p1' });
    await canonical.ensure('live', '/proj'); // it ran here: it has a mirror
    const pool = livePool({ live: { providerId: 'p1', model: 'm1' } });
    let recorded = 0;
    const r = await swap.openOnProvider({ pool, meta, canonical }, { sessionId: 'live', cwd: '/proj', providerId: 'p3' }, nameOf, hooksFor(pool, { onRecorded: () => recorded++ }));
    expect(r).toEqual({ swapped: 'p3' });
    expect(pool.events).toEqual(['close:live', 'open:live:p3']);
    expect(pool.opened[0].model).toBeUndefined(); // another profile: its default, not the old profile's model
    expect(meta.sessionMeta('live').providerId).toBe('p3');
    expect((await switches('live')).map((e: any) => [e.providerId, e.fromProviderId])).toEqual([['p3', 'p1']]);
    expect(recorded).toBe(1);
  });
  it('running on the account, the meta still naming a relay (older data), the account asked → a plain reattach, nothing recorded', async () => {
    await meta.setSessionMeta('acct', { providerId: 'p1' });
    const pool = livePool({ acct: {} });
    const r = await swap.openOnProvider({ pool, meta, canonical }, { sessionId: 'acct', cwd: '/proj', providerId: 'claude' }, nameOf, hooksFor(pool));
    expect(r).toEqual({ opened: 'claude' });
    expect(pool.events).toEqual(['open:acct:claude']); // the live pool hands its runner back in the hub
    expect(await switches('acct')).toEqual([]);
  });
  it('two opens racing on one idle conversation end with SessionMeta = the provider its process runs on (re-review m-3)', async () => {
    await meta.setSessionMeta('h4', { providerId: 'p1' });
    const pool = livePool({});
    const d = { pool, meta, canonical };
    const slow = { before: () => new Promise<void>((r) => setTimeout(r, 20)) };
    const [a, b] = await Promise.all([
      swap.openOnProvider(d, { sessionId: 'h4', cwd: '/proj', providerId: 'p2' }, nameOf, hooksFor(pool, slow)),
      swap.openOnProvider(d, { sessionId: 'h4', cwd: '/proj', providerId: 'p3' }, nameOf, hooksFor(pool, slow)),
    ]);
    expect([a, b]).toEqual([{ opened: 'p2' }, { swapped: 'p3' }]);
    expect(pool.get('h4').info.providerId).toBe('p3');
    expect(meta.sessionMeta('h4').providerId).toBe('p3');
    expect((await switches('h4')).map((e: any) => [e.providerId, e.fromProviderId])).toEqual([['p2', 'p1'], ['p3', 'p2']]);
  });
  it('the same provider twice at once: one open records, the second finds it running on it and just reattaches', async () => {
    await meta.setSessionMeta('h5', { providerId: 'p1' });
    const pool = livePool({});
    const d = { pool, meta, canonical };
    await Promise.all([
      swap.openOnProvider(d, { sessionId: 'h5', cwd: '/proj', providerId: 'p2' }, nameOf, hooksFor(pool)),
      swap.openOnProvider(d, { sessionId: 'h5', cwd: '/proj', providerId: 'p2' }, nameOf, hooksFor(pool)),
    ]);
    expect(meta.sessionMeta('h5').providerId).toBe('p2');
    expect(await switches('h5')).toHaveLength(1);
  });
  it('an open that throws records nothing: SessionMeta and the canonical log keep the old provider (re-review n-3)', async () => {
    await meta.setSessionMeta('h6', { providerId: 'p1' });
    const pool = livePool({});
    const hooks = { open: async () => { throw new Error('密钥解不开'); }, swapped: (r: any) => r };
    await expect(swap.openOnProvider({ pool, meta, canonical }, { sessionId: 'h6', cwd: '/proj', providerId: 'p2' }, nameOf, hooks)).rejects.toThrow('密钥解不开');
    expect(meta.sessionMeta('h6').providerId).toBe('p1');
    expect(await switches('h6')).toEqual([]);
  });
  it('no record: the same provider, no explicit provider, a fork / rewind, a new conversation', async () => {
    await meta.setSessionMeta('same', { providerId: 'p1' });
    await meta.setSessionMeta('fork', { providerId: 'p1' });
    const pool = livePool({});
    const d = { pool, meta, canonical };
    await swap.openOnProvider(d, { sessionId: 'same', cwd: '/proj', providerId: 'p1' }, nameOf, hooksFor(pool));
    await swap.openOnProvider(d, { sessionId: 'same', cwd: '/proj' }, nameOf, hooksFor(pool));
    await swap.openOnProvider(d, { sessionId: 'fork', cwd: '/proj', providerId: 'p2', fork: true }, nameOf, hooksFor(pool));
    await swap.openOnProvider(d, { sessionId: 'fork', cwd: '/proj', providerId: 'p2', resumeAt: 'u1' }, nameOf, hooksFor(pool));
    await swap.openOnProvider(d, { cwd: '/proj', providerId: 'p2' }, nameOf, hooksFor(pool));
    expect([meta.sessionMeta('same').providerId, meta.sessionMeta('fork').providerId]).toEqual(['p1', 'p1']);
    for (const id of ['same', 'fork']) expect(await switches(id)).toEqual([]);
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
