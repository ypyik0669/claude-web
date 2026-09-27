// Store-level regressions. The store touches browser globals at import time, so they are stubbed first and the
// ws client is replaced by a scripted fake.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (req: any) => unknown;
const fake = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  listeners: new Set<(e: any) => void>(),
  sent: [] as any[],
}));

vi.mock('@/ws/client', () => ({
  authToken: () => null,
  ws: {
    onStatus: null as null | ((c: boolean) => void),
    connect() { /* no socket in tests */ },
    on(l: (e: any) => void) { fake.listeners.add(l); return () => fake.listeners.delete(l); },
    async request(req: any) {
      fake.sent.push(req);
      const h = fake.handlers.get(req.kind);
      if (!h) return null;
      return h(req);
    },
  },
}));

const mem = new Map<string, string>();
let useStore: typeof import('./index').useStore;
let ws: typeof import('@/ws/client').ws;

beforeAll(async () => {
  vi.stubGlobal('window', { matchMedia: undefined });
  vi.stubGlobal('document', { addEventListener() {}, hasFocus: () => true, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, classList: { toggle() {}, add() {}, remove() {} } } });
  vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) });
  vi.stubGlobal('location', { search: '', protocol: 'http:', host: 'x' });
  ({ useStore } = await import('./index'));
  ({ ws } = await import('@/ws/client'));
  useStore.getState().init();
});

const emit = (e: any) => { for (const l of fake.listeners) l(e); };

beforeEach(async () => {
  fake.handlers.clear();
  fake.sent.length = 0;
  const { createConversation } = await import('@/model/conversation');
  useStore.setState({
    sessions: [{ sessionId: 's1', cwd: '/w', title: 't', lastModified: 0 } as any],
    open: { s1: { sessionId: 's1', cwd: '/w', conv: createConversation(), version: 0, state: 'idle', pending: [], loading: false, queue: [], draft: '', feedback: {} } },
    settings: {},
    toasts: [],
  });
});

describe('send', () => {
  it('stamps turnStartedAt on the local echo (the SDK never echoes the user message)', async () => {
    await useStore.getState().send('s1', 'hi');
    const o = useStore.getState().open.s1;
    expect(o.state).toBe('running');
    expect(typeof o.conv.turnStartedAt).toBe('number');
    const t0 = o.conv.turnStartedAt!;
    // a steer mid-turn joins the running turn: the clock keeps counting from the first message
    await new Promise((r) => setTimeout(r, 5));
    await useStore.getState().send('s1', 'also this', undefined, true);
    expect(useStore.getState().open.s1.conv.turnStartedAt).toBe(t0);
  });
});

describe('stopAndRun', () => {
  it('keeps the other queued messages and sends at once when the interrupt already landed', async () => {
    useStore.setState((s) => ({ open: { ...s.open, s1: { ...s.open.s1, state: 'running', queue: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }, { id: 'c', text: 'C' }] } } }));
    // the runner reports idle before the interrupt request resolves
    fake.handlers.set('session.interrupt', () => { emit({ kind: 'session.state', sessionId: 's1', state: 'idle' }); return null; });
    await useStore.getState().stopAndRun('s1', 'b');
    const o = useStore.getState().open.s1;
    expect(fake.sent.filter((r) => r.kind === 'session.send').map((r) => r.params.text)).toEqual(['B']);
    expect(o.queue.map((q) => q.text)).toEqual(['A', 'C']);
  });

  it('puts the chosen message first when the turn is still winding down', async () => {
    useStore.setState((s) => ({ open: { ...s.open, s1: { ...s.open.s1, state: 'running', queue: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] } } }));
    await useStore.getState().stopAndRun('s1', 'b');
    expect(useStore.getState().open.s1.queue.map((q) => q.text)).toEqual(['B', 'A']);
    expect(fake.sent.some((r) => r.kind === 'session.send')).toBe(false);
  });
});

describe('respondPermission', () => {
  it('drops a card whose request was already answered elsewhere', async () => {
    useStore.setState((s) => ({ open: { ...s.open, s1: { ...s.open.s1, state: 'waiting', pending: [{ requestId: 'r1', sessionId: 's1', toolName: 'Bash', input: {} } as any] } } }));
    fake.handlers.set('permission.respond', () => { throw new Error('permission request not found (already answered?)'); });
    await useStore.getState().respondPermission('r1', { behavior: 'allow' });
    expect(useStore.getState().open.s1.pending).toEqual([]);
  });
});

describe('setDraft', () => {
  it('does not create an entry for a session that is not open', () => {
    useStore.getState().setDraft('nope', 'x');
    expect(useStore.getState().open.nope).toBeUndefined();
  });
});

describe('reconnect', () => {
  it('re-syncs state from the runner and flushes the queue when the turn ended during the outage', async () => {
    useStore.setState((s) => ({ open: { ...s.open, s1: { ...s.open.s1, state: 'running', queue: [{ id: 'q', text: 'next' }] } } }));
    fake.handlers.set('sessions.list', () => [{ sessionId: 's1', cwd: '/w', title: 't', lastModified: 0, live: 'idle' }]);
    fake.handlers.set('session.info', () => ({ info: { sessionId: 's1', state: 'idle' }, pending: [] }));
    fake.handlers.set('transcript.load', () => []);
    fake.handlers.set('session.open', () => ({ sessionId: 's1', info: { sessionId: 's1', state: 'idle' }, history: [], pending: [] }));
    fake.handlers.set('settings.get', () => ({}));
    ws.onStatus!(true);
    await vi.waitFor(() => expect(fake.sent.some((r) => r.kind === 'session.send')).toBe(true));
    const o = useStore.getState().open.s1;
    expect(o.queue).toEqual([]);
    expect(fake.sent.find((r) => r.kind === 'session.send').params.text).toBe('next');
  });
});

describe('session library', () => {
  it('library.changed refetches the session list once, without a limit', async () => {
    fake.handlers.set('sessions.list', () => []);
    emit({ kind: 'library.changed' });
    await new Promise((r) => setTimeout(r, 0));
    const reqs = fake.sent.filter((r) => r.kind === 'sessions.list');
    expect(reqs.length).toBe(1);
    expect(reqs[0].limit).toBeUndefined();
  });

  it('imported sessions load through library.read and page older history with loadOlder', async () => {
    useStore.setState({ sessions: [{ sessionId: 'codex-abc', cwd: '/w', title: 'c', lastModified: 0, agent: 'codex' } as any], open: {} });
    const user = (uuid: string, text: string) => ({ type: 'user', uuid, message: { role: 'user', content: text } });
    fake.handlers.set('library.read', (req) => (req.cursor === 'c1' ? { messages: [user('u1', 'old')], next: undefined } : { messages: [user('u2', 'new')], next: 'c1' }));
    await useStore.getState().loadHistory('codex-abc', { focus: false });
    expect(fake.sent.some((r) => r.kind === 'transcript.load')).toBe(false);
    expect(useStore.getState().open['codex-abc'].historyCursor).toBe('c1');
    expect(await useStore.getState().loadOlder('codex-abc')).toBe(false);
    expect(useStore.getState().open['codex-abc'].conv.items.map((i) => i.id)).toEqual(['u1', 'u2']);
    fake.sent.length = 0;
    // no `next` → nothing more to fetch, and no request goes out
    expect(await useStore.getState().loadOlder('codex-abc')).toBe(false);
    expect(fake.sent.filter((r) => r.kind === 'library.read').length).toBe(0);
  });

  it('loadOlder returns true while there is more', async () => {
    useStore.setState((s) => ({ open: { ...s.open, s1: { ...s.open.s1, historyCursor: 'p1' } } }));
    fake.handlers.set('library.read', () => ({ messages: [], next: 'p2' }));
    expect(await useStore.getState().loadOlder('s1')).toBe(true);
    expect(fake.sent.find((r) => r.kind === 'library.read')).toMatchObject({ sessionId: 's1', cursor: 'p1' });
  });

  it('two concurrent loadOlder calls send one request and share its result', async () => {
    useStore.setState((s) => ({ open: { ...s.open, s1: { ...s.open.s1, historyCursor: 'p1' } } }));
    let release!: (v: unknown) => void;
    fake.handlers.set('library.read', () => new Promise((r) => { release = r; }));
    const a = useStore.getState().loadOlder('s1');
    const b = useStore.getState().loadOlder('s1');
    release({ messages: [], next: 'p2' });
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(fake.sent.filter((r) => r.kind === 'library.read').length).toBe(1);
  });

  it('a history reload while loadOlder is in flight discards the stale page', async () => {
    useStore.setState((s) => ({ open: { ...s.open, s1: { ...s.open.s1, historyCursor: 'p1' } } }));
    let release!: (v: unknown) => void;
    fake.handlers.set('library.read', () => new Promise((r) => { release = r; }));
    const p = useStore.getState().loadOlder('s1');
    // loadHistory replaced the conversation and minted a new cursor meanwhile
    useStore.setState((s) => ({ open: { ...s.open, s1: { ...s.open.s1, historyCursor: 'fresh' } } }));
    release({ messages: [{ type: 'user', uuid: 'old', message: { role: 'user', content: 'stale' } }], next: 'p0' });
    await p;
    const o = useStore.getState().open.s1;
    expect(o.conv.items.length).toBe(0);
    expect(o.historyCursor).toBe('fresh');
  });

  it('loadOlder rejects on failure and a later call can retry', async () => {
    useStore.setState((s) => ({ open: { ...s.open, s1: { ...s.open.s1, historyCursor: 'p1' } } }));
    fake.handlers.set('library.read', () => Promise.reject(new Error('boom')));
    await expect(useStore.getState().loadOlder('s1')).rejects.toThrow('boom');
    fake.handlers.set('library.read', () => ({ messages: [], next: undefined }));
    expect(await useStore.getState().loadOlder('s1')).toBe(false);
    expect(fake.sent.filter((r) => r.kind === 'library.read').length).toBe(2);
  });

  it('library.changed and library.discovered refresh the library sources', async () => {
    fake.handlers.set('sessions.list', () => []);
    fake.handlers.set('library.sources', () => [{ kind: 'codex', name: 'Codex', installed: true, detected: true, joined: false, dismissed: false, enabled: false }]);
    emit({ kind: 'library.discovered', kinds: ['codex'] });
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.sent.filter((r) => r.kind === 'library.sources').length).toBe(1);
    expect(useStore.getState().librarySources.map((x) => x.kind)).toEqual(['codex']);
    emit({ kind: 'library.changed' });
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.sent.filter((r) => r.kind === 'library.sources').length).toBe(2);
  });

  it('an open session that vanishes on library.changed is marked deleted — unless its source was just left', async () => {
    useStore.setState({ deletedSessions: {}, sessions: [{ sessionId: 's1', cwd: '/w', title: 't', lastModified: 0 } as any, { sessionId: 'codex-z', cwd: '/w', title: 'z', lastModified: 0, agent: 'codex' } as any] });
    useStore.setState((s) => ({ open: { ...s.open, 'codex-z': { ...s.open.s1, sessionId: 'codex-z' } } }));
    fake.handlers.set('sessions.list', () => []);
    fake.handlers.set('library.sources', () => [{ kind: 'codex', name: 'Codex', installed: true, detected: true, joined: false, dismissed: false, enabled: false }]);
    emit({ kind: 'library.changed' });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(useStore.getState().deletedSessions).toEqual({ s1: true });
  });

  it('a failed history load keeps the reason in loadError (the chat shows it with a retry)', async () => {
    useStore.setState({ sessions: [{ sessionId: 'codex-e', cwd: '/w', title: 'c', lastModified: 0, agent: 'codex' } as any], open: {} });
    fake.handlers.set('library.read', () => Promise.reject(new Error('thread not found')));
    await useStore.getState().loadHistory('codex-e', { focus: false });
    expect(useStore.getState().open['codex-e'].loadError).toBe('thread not found');
    fake.handlers.set('library.read', () => ({ messages: [], next: undefined }));
    await useStore.getState().loadHistory('codex-e', { focus: false });
    expect(useStore.getState().open['codex-e'].loadError).toBeUndefined();
  });

  it('libraryOp sends library.<op> with the payload; sources and filter live on the store', async () => {
    fake.handlers.set('library.rename', () => ({ ok: true }));
    await useStore.getState().libraryOp('rename', { sessionId: 's1', title: 'x' });
    expect(fake.sent.find((r) => r.kind === 'library.rename')).toMatchObject({ sessionId: 's1', title: 'x' });
    fake.handlers.set('library.sources', () => [{ kind: 'codex', name: 'Codex', installed: true, detected: true, joined: false, dismissed: false, enabled: false }]);
    await useStore.getState().loadLibrarySources();
    expect(useStore.getState().librarySources.map((x) => x.kind)).toEqual(['codex']);
    expect(useStore.getState().sourceFilter).toBe('all');
    useStore.getState().setSourceFilter('codex');
    expect(useStore.getState().sourceFilter).toBe('codex');
  });
});
