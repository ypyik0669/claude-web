// The automation page over the main area (redesign phase 7): it opens on the tab shown last, its tab bodies are
// mounted once and kept, and it gets out of the way when the main area is sent somewhere — also when the conversation
// asked for is already in front (a no-op for the layout). Store stubs as in store/store.test.ts.
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/ws/client', () => ({
  authToken: () => null,
  ws: { onStatus: null, connect() {}, on() { return () => {}; }, async request() { return null; } },
}));

const mem = new Map<string, string>();
let store: typeof import('@/store').useStore;
let answering: typeof import('@/store').answering;
let auto: typeof import('./state');
let runCommand: typeof import('@/features/workbench/commands').runCommand;

beforeAll(async () => {
  vi.stubGlobal('window', { matchMedia: undefined, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } });
  vi.stubGlobal('document', { addEventListener() {}, hasFocus: () => true, querySelector: () => null, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, classList: { toggle() {}, add() {}, remove() {} } } });
  vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) });
  vi.stubGlobal('location', { search: '', protocol: 'http:', host: 'x' });
  ({ useStore: store, answering } = await import('@/store'));
  auto = await import('./state');
  ({ runCommand } = await import('@/features/workbench/commands'));
  auto.installAutomation();
});

const tiles = () => {
  const l = store.getState().layout;
  const g = l.groups.find((x) => x.id === l.activeGroupId)!;
  return Object.values(g.panes).flatMap((p) => p.tiles.map((t) => (t.kind === 'chat' ? `chat:${t.sessionId ?? ''}` : t.kind)));
};

describe('the automation page', () => {
  it('opens on the tab asked for, else the one shown last; tabs once shown stay mounted', () => {
    expect(auto.openAutomation('goals')).toBe(true);
    expect(auto.useAutomation.getState()).toMatchObject({ open: true, tab: 'goals', seen: ['goals'] });
    auto.showAutomationTab('schedules');
    auto.closeAutomation();
    auto.openAutomation();
    expect(auto.useAutomation.getState()).toMatchObject({ open: true, tab: 'schedules', seen: ['schedules', 'goals'] });
  });

  it('closes when the main area goes elsewhere — even to the conversation already in front — not for the right panel', () => {
    auto.openAutomation('orchestra');
    store.getState().dispatchLayout({ t: 'dock.show', panel: 'tasks' });
    expect(auto.useAutomation.getState().open).toBe(true);
    store.getState().openInPane('s1', 'replace');
    expect(auto.useAutomation.getState().open).toBe(false);
    auto.openAutomation();
    store.getState().openInPane('s1', 'replace'); // already in front: the layout does not change, the page still closes
    expect(auto.useAutomation.getState().open).toBe(false);
    expect(auto.useAutomation.getState().seen).toContain('orchestra');
  });

  it('a late answer does not close what was opened after its request (review 7 M2)', () => {
    const sent = Date.now() - 5000;
    auto.openAutomation('goals'); // opened after the request was sent
    answering(sent, () => store.getState().dispatchLayout({ t: 'session.assign', paneId: store.getState().layout.groups[0].focusedPaneId, tileId: 'x', sessionId: 's9' }));
    expect(auto.useAutomation.getState().open).toBe(true);
    // a request sent after the page was opened (the sidebar's 新建 worktree conversation, say): its answer goes there
    answering(Date.now() + 5000, () => store.getState().openInPane('s2', 'replace'));
    expect(auto.useAutomation.getState().open).toBe(false);
  });

  it('keys meant for the tabs under the page do not act on them unseen (review 7 I3)', () => {
    const term = { id: 'term-1', kind: 'term', cwd: '', title: 't' } as const;
    store.getState().openTile(term, 'tab');
    const before = tiles();
    expect(before).toContain('term');
    auto.openAutomation('schedules');
    runCommand('tile.close'); // Alt+W / Ctrl+W: closes the page, not the terminal under it
    expect(auto.useAutomation.getState().open).toBe(false);
    expect(tiles()).toEqual(before);
    auto.openAutomation();
    runCommand('tile.next'); // the page gets out of the way first
    expect(auto.useAutomation.getState().open).toBe(false);
  });

  it('a phone: the sidebar drawer and the bottom drawer get out of the way (review 7 I2)', () => {
    store.setState({ mobile: true, sidebarOpen: true });
    store.getState().dispatchLayout({ t: 'dock.show', panel: 'tasks' });
    expect(store.getState().sheetAt).toBeGreaterThan(0);
    auto.openAutomation('schedules');
    expect(store.getState().sidebarOpen).toBe(false);
    expect(store.getState().sheetAt).toBe(0);
    // going somewhere in the main area from inside the drawer (a file, a conversation) puts it away too
    store.getState().dispatchLayout({ t: 'dock.show', panel: 'files' });
    expect(store.getState().sheetAt).toBeGreaterThan(0);
    store.getState().openInPane('s3', 'replace');
    expect(store.getState().sheetAt).toBe(0);
    store.setState({ mobile: false, sidebarOpen: true });
  });

  it('新建 is one signal per click, per tab', () => {
    const before = auto.useAutomation.getState().newAt.goals;
    auto.newInAutomation('goals');
    expect(auto.useAutomation.getState().newAt.goals).toBeGreaterThanOrEqual(before);
    expect(auto.useAutomation.getState().newAt.goals).toBeGreaterThan(0);
  });
});
