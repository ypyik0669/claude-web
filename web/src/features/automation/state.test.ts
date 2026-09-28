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
let auto: typeof import('./state');

beforeAll(async () => {
  vi.stubGlobal('window', { matchMedia: undefined });
  vi.stubGlobal('document', { addEventListener() {}, hasFocus: () => true, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, classList: { toggle() {}, add() {}, remove() {} } } });
  vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) });
  vi.stubGlobal('location', { search: '', protocol: 'http:', host: 'x' });
  ({ useStore: store } = await import('@/store'));
  auto = await import('./state');
  auto.installAutomation();
});

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

  it('a phone: the sidebar drawer gets out of the way', () => {
    store.setState({ mobile: true, sidebarOpen: true });
    auto.openAutomation('schedules');
    expect(store.getState().sidebarOpen).toBe(false);
    store.setState({ mobile: false, sidebarOpen: true });
  });

  it('新建 is one signal per click, per tab', () => {
    const before = auto.useAutomation.getState().newAt.goals;
    auto.newInAutomation('goals');
    expect(auto.useAutomation.getState().newAt.goals).toBeGreaterThanOrEqual(before);
    expect(auto.useAutomation.getState().newAt.goals).toBeGreaterThan(0);
  });
});
