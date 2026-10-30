// The Bot page's store: it is a section (one page open at a time), and the server's pushes land in it — the inbox
// with its pending count, each bot's runs. The transport and browser globals are stubbed as in automation/state.test.ts.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const listeners: ((e: any) => void)[] = [];
const sent: any[] = [];
/** what the next requests answer (null by default) */
let reply: any = null;
vi.mock('@/ws/client', () => ({
  authToken: () => null,
  ws: { onStatus: null, connect() {}, on(l: (e: any) => void) { listeners.push(l); return () => {}; }, async request(req: any) { sent.push(req); return reply; } },
}));

const mem = new Map<string, string>();
let bots: typeof import('./state');
let currentSection: typeof import('@/features/sections/pages').currentSection;
const push = (e: any) => { for (const l of listeners) l(e); };

beforeAll(async () => {
  vi.stubGlobal('window', { matchMedia: undefined, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } });
  vi.stubGlobal('document', { addEventListener() {}, hasFocus: () => true, querySelector: () => null, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, classList: { toggle() {}, add() {}, remove() {} } } });
  vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) });
  vi.stubGlobal('location', { search: '', protocol: 'http:', host: 'x' });
  bots = await import('./state');
  ({ currentSection } = await import('@/features/sections/pages'));
  bots.installBots();
});

describe('bots page state', () => {
  beforeEach(() => bots.useBots.setState({ open: false, seen: false, bots: [], inbox: [], runs: {}, pending: 0, selected: undefined }));

  it('registers as a section: opening it is the current section, closing goes back to chat', () => {
    bots.openBots(); expect(currentSection()).toBe('bots'); expect(bots.useBots.getState().seen).toBe(true);
    bots.closeBots(); expect(currentSection()).toBe('chat'); expect(bots.useBots.getState().seen).toBe(true);
  });

  it('openBots(id) selects that bot', () => { bots.openBots('b_1'); expect(bots.useBots.getState().selected).toBe('b_1'); });

  it('hello asks for the bots, the inbox, the load and the templates', () => {
    sent.length = 0;
    push({ kind: 'hello' });
    expect(sent.map((r) => r.kind).sort()).toEqual(['bots.inbox.list', 'bots.list', 'bots.load', 'bots.templates']);
  });

  it('an inbox push replaces the same id or goes first, and the pending count follows', () => {
    push({ kind: 'bots.inbox', item: { id: 'a', kind: 'draft', botId: 'b', at: 1, title: 'A' } });
    push({ kind: 'bots.inbox', item: { id: 'c', kind: 'approval', botId: 'b', at: 2, title: 'C' } });
    expect(bots.useBots.getState().inbox.map((i) => i.id)).toEqual(['c', 'a']);
    expect(bots.useBots.getState().pending).toBe(2);
    push({ kind: 'bots.inbox', item: { id: 'a', kind: 'draft', botId: 'b', at: 1, title: 'A', done: { at: 3, answer: 'archive' } } });
    expect(bots.useBots.getState().inbox.map((i) => i.id)).toEqual(['c', 'a']);
    expect(bots.useBots.getState().pending).toBe(1);
  });

  it('a run push lands under its bot: the same id replaces, a new one goes first, at most 200', () => {
    const run = (id: string, ok?: boolean) => ({ id, botId: 'b', routineId: 'r', at: 1, trigger: 'cron', ok });
    for (let i = 0; i < 205; i++) push({ kind: 'bots.run', run: run(`r${i}`) });
    let list = bots.useBots.getState().runs.b;
    expect(list).toHaveLength(200);
    expect(list[0].id).toBe('r204');
    push({ kind: 'bots.run', run: run('r204', true) });
    list = bots.useBots.getState().runs.b;
    expect(list).toHaveLength(200);
    expect(list[0]).toMatchObject({ id: 'r204', ok: true });
  });

  it('stop: a forwarded stop (not the server on duty) is said in a toast; a direct one says nothing', async () => {
    const { useStore } = await import('@/store');
    const toasts: string[] = [];
    const orig = useStore.getState().toast;
    useStore.setState({ toast: (t: string) => void toasts.push(t) } as any);
    try {
      sent.length = 0;
      reply = { requested: true, note: 'asked the one on duty' };
      await bots.stopBot('b1');
      await bots.stopAll();
      expect(sent.map((r) => [r.kind, r.id])).toEqual([['bots.stop', 'b1'], ['bots.stopAll', undefined]]);
      expect(toasts).toEqual(['asked the one on duty', 'asked the one on duty']);
      reply = null;
      await bots.stopAll();
      expect(toasts).toHaveLength(2);
    } finally { reply = null; useStore.setState({ toast: orig } as any); }
  });

  it('a phone: picking a bot leaves the inbox tab, opening the page without one goes back to it', async () => {
    const { useStore } = await import('@/store');
    useStore.setState({ mobile: true } as any);
    try {
      bots.useBots.setState({ phoneInbox: true });
      bots.selectBot('b_2');
      expect(bots.useBots.getState().phoneInbox).toBe(false);
      bots.openBots();
      expect(bots.useBots.getState().phoneInbox).toBe(true);
    } finally { useStore.setState({ mobile: false } as any); }
  });

  it('changed / load pushes replace the bots and the load', () => {
    push({ kind: 'bots.changed', bots: [{ id: 'x', name: 'X', state: 'idle' }] });
    push({ kind: 'bots.load', load: { running: 1, queued: 2, todayUsd: 0.5, weekEstimateUsd: 3, concurrency: 2 } });
    expect(bots.useBots.getState().bots.map((b) => b.id)).toEqual(['x']);
    expect(bots.useBots.getState().load.queued).toBe(2);
  });
});
