// The Bot page's store: it is a section (one page open at a time), and the server's pushes land in it — the inbox
// with its pending count, each bot's runs. The transport and browser globals are stubbed as in automation/state.test.ts.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const listeners: ((e: any) => void)[] = [];
const sent: any[] = [];
/** what the next requests answer (null by default; a function answers per request) */
let reply: any = null;
vi.mock('@/ws/client', () => ({
  authToken: () => null,
  ws: { onStatus: null, connect() {}, on(l: (e: any) => void) { listeners.push(l); return () => {}; }, async request(req: any) { sent.push(req); return typeof reply === 'function' ? reply(req) : reply; } },
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

  it('a phone: the roster first; opened on a bot, or with only one bot besides the manager, its conversation', async () => {
    const { useStore } = await import('@/store');
    useStore.setState({ mobile: true } as any);
    try {
      bots.useBots.setState({ phoneScreen: 'thread', selected: undefined, bots: [{ id: 'm', manager: true }, { id: 'a' }, { id: 'b' }] as any });
      bots.openBots();
      expect(bots.useBots.getState().phoneScreen).toBe('roster');
      bots.openBots('b');
      expect([bots.useBots.getState().phoneScreen, bots.useBots.getState().selected, bots.useBots.getState().view]).toEqual(['thread', 'b', 'thread']);
      bots.useBots.setState({ phoneScreen: 'roster', selected: undefined, bots: [{ id: 'm', manager: true }, { id: 'a' }] as any });
      bots.openBots();
      expect([bots.useBots.getState().phoneScreen, bots.useBots.getState().selected]).toEqual(['thread', 'a']);
    } finally { useStore.setState({ mobile: false } as any); }
  });

  it('a phone: the profile is its own screen; leaving it goes back to the conversation, the roster closes it', async () => {
    const { useStore } = await import('@/store');
    useStore.setState({ mobile: true } as any);
    try {
      bots.useBots.setState({ phoneScreen: 'thread', profileOpen: false });
      bots.showProfile(true, 'routines');
      expect([bots.useBots.getState().phoneScreen, bots.useBots.getState().profileOpen, bots.useBots.getState().profileSection]).toEqual(['profile', true, 'routines']);
      bots.showProfile(false);
      expect([bots.useBots.getState().phoneScreen, bots.useBots.getState().profileOpen]).toEqual(['thread', false]);
      bots.setPhoneScreen('profile');
      bots.setPhoneScreen('roster');
      expect([bots.useBots.getState().phoneScreen, bots.useBots.getState().profileOpen]).toEqual(['roster', false]);
    } finally { useStore.setState({ mobile: false } as any); }
  });

  it('showNewBot opens the page on the New Bot page and puts the profile away', () => {
    bots.useBots.setState({ open: false, view: 'thread', profileOpen: true });
    bots.showNewBot();
    expect([bots.useBots.getState().open, bots.useBots.getState().view, bots.useBots.getState().profileOpen]).toEqual([true, 'new', false]);
    bots.useBots.setState({ view: 'thread' });
  });

  it('changed / load pushes replace the bots and the load', () => {
    push({ kind: 'bots.changed', bots: [{ id: 'x', name: 'X', state: 'idle' }] });
    push({ kind: 'bots.load', load: { running: 1, queued: 2, todayUsd: 0.5, weekEstimateUsd: 3, concurrency: 2 } });
    expect(bots.useBots.getState().bots.map((b) => b.id)).toEqual(['x']);
    expect(bots.useBots.getState().load.queued).toBe(2);
  });
});

describe('bots timeline and the main conversation', () => {
  const entry = (id: string, at: number, p: any = {}) => ({ id, botId: 'b', at, kind: 'system', text: id, ...p });
  const ids = (botId = 'b') => (bots.useBots.getState().timeline[botId] ?? []).map((e) => e.id);
  beforeEach(() => { reply = null; sent.length = 0; bots.useBots.setState({ bots: [], timeline: {}, selected: undefined, view: 'thread' }); });

  it('a timeline push: the same id replaces in place, a new one goes in by time (oldest first)', () => {
    push({ kind: 'bots.timeline', entry: entry('a', 1) });
    push({ kind: 'bots.timeline', entry: entry('c', 3) });
    push({ kind: 'bots.timeline', entry: entry('b', 2) });
    expect(ids()).toEqual(['a', 'b', 'c']);
    push({ kind: 'bots.timeline', entry: entry('b', 2, { text: 'B' }) });
    expect(ids()).toEqual(['a', 'b', 'c']);
    expect(bots.useBots.getState().timeline.b[1].text).toBe('B');
  });

  it('a push for one bot keeps the other bots\' arrays (stable references for selectors)', () => {
    push({ kind: 'bots.timeline', entry: entry('a', 1, { botId: 'x' }) });
    const before = bots.useBots.getState().timeline.x;
    push({ kind: 'bots.timeline', entry: entry('a', 1) });
    expect(bots.useBots.getState().timeline.x).toBe(before);
  });

  it('loadTimeline: the newest page replaces, an older page (before) goes in front, without doubles', async () => {
    reply = () => [entry('c', 3), entry('d', 4)];
    await bots.loadTimeline('b');
    expect(sent.at(-1)).toMatchObject({ kind: 'bots.timeline.list', id: 'b' });
    expect(ids()).toEqual(['c', 'd']);
    reply = () => [entry('a', 1), entry('b', 2), entry('c', 3)];
    await bots.loadTimeline('b', 3);
    expect(sent.at(-1)).toMatchObject({ kind: 'bots.timeline.list', id: 'b', before: 3 });
    expect(ids()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('openThread: open the thread, open it as a conversation outside the layout, mark it seen, load the timeline', async () => {
    const { useStore } = await import('@/store');
    const orig = useStore.getState().openSession;
    const opened: any[] = [];
    useStore.setState({ openSession: async (p: any, target: any) => { opened.push([p, target]); return p.sessionId; } } as any);
    bots.useBots.setState({ bots: [{ id: 'b', name: 'B', cwd: '/w', state: 'idle', unseen: 2 } as any], view: 'new' });
    reply = (r: any) => (r.kind === 'bots.thread.open' ? { sessionId: 's1' } : r.kind === 'bots.timeline.list' ? [entry('a', 1)] : null);
    try {
      expect(await bots.openThread('b')).toBe('s1');
      expect(sent.map((r) => r.kind)).toEqual(['bots.thread.open', 'bots.thread.seen', 'bots.timeline.list']);
      expect(opened).toEqual([[{ sessionId: 's1', cwd: '/w' }, 'none']]);
      const s = bots.useBots.getState();
      expect(s).toMatchObject({ selected: 'b', view: 'thread', phoneScreen: 'thread' });
      // a phase-1 bot gets its thread now: the id is there before the server's bots.changed
      expect(s.bots[0]).toMatchObject({ threadId: 's1', unseen: 0 });
      expect(ids()).toEqual(['a']);
    } finally { useStore.setState({ openSession: orig } as any); }
  });

  it('openThread: a failure is toasted and opens nothing', async () => {
    const { useStore } = await import('@/store');
    const orig = { openSession: useStore.getState().openSession, toast: useStore.getState().toast };
    const toasts: string[] = []; let opened = 0;
    useStore.setState({ openSession: async () => { opened++; return ''; }, toast: (t: string) => void toasts.push(t) } as any);
    bots.useBots.setState({ bots: [{ id: 'b', name: 'B', cwd: '/w', state: 'idle', unseen: 0 } as any] });
    reply = () => { throw new Error('nope'); };
    try {
      expect(await bots.openThread('b')).toBeNull();
      expect(opened).toBe(0);
      expect(toasts).toHaveLength(1);
    } finally { useStore.setState(orig as any); }
  });

  it('startBot: bots.start, then the new bot\'s thread is opened', async () => {
    const { useStore } = await import('@/store');
    const orig = useStore.getState().openSession;
    useStore.setState({ openSession: async (p: any) => p.sessionId } as any);
    const made = { id: 'n', name: 'N', cwd: '/w', state: 'idle', unseen: 0, threadId: 's2' };
    reply = (r: any) => (r.kind === 'bots.start' ? made : r.kind === 'bots.thread.open' ? { sessionId: 's2' } : r.kind === 'bots.timeline.list' ? [] : null);
    try {
      const b = await bots.startBot({ name: 'N', cwd: '/w', templateId: 't' });
      expect(b?.id).toBe('n');
      expect(sent[0]).toEqual({ kind: 'bots.start', name: 'N', cwd: '/w', templateId: 't' });
      expect(sent.map((r) => r.kind)).toEqual(['bots.start', 'bots.thread.open', 'bots.thread.seen', 'bots.timeline.list']);
      expect(bots.useBots.getState()).toMatchObject({ selected: 'n', view: 'thread' });
      expect(bots.useBots.getState().bots.map((x) => x.id)).toEqual(['n']);
    } finally { useStore.setState({ openSession: orig } as any); }
  });

  it('markSeen tells the server and clears the count here', async () => {
    bots.useBots.setState({ bots: [{ id: 'b', name: 'B', state: 'idle', unseen: 4 } as any] });
    await bots.markSeen('b');
    expect(sent).toEqual([{ kind: 'bots.thread.seen', id: 'b' }]);
    expect(bots.useBots.getState().bots[0].unseen).toBe(0);
  });

  it('__cwBots.inject takes a timeline too', () => {
    (window as any).__cwBots.inject({ timeline: [entry('a', 1), entry('z', 2, { botId: 'y' })] });
    expect(ids()).toEqual(['a']);
    expect(ids('y')).toEqual(['z']);
  });

  it('the profile column and the phone screen have defaults', () => {
    const s = bots.useBots.getInitialState();
    expect([s.profileOpen, s.profileSection, s.phoneScreen, s.view]).toEqual([false, 'profile', 'roster', 'thread']);
  });
});
