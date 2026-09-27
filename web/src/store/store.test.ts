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
