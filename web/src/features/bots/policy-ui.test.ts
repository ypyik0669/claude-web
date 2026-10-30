// The Bot detail's pure helpers (risk sentences, default levels, cadence) and how its edits are built: from the store
// at the moment they are sent, changing only the routine / field touched, never carrying `unleashed`.
// The transport and browser globals are stubbed as in state.test.ts.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionClass, BotStatus, Routine } from '@shared';

const sent: any[] = [];
vi.mock('@/ws/client', () => ({
  authToken: () => null,
  ws: { onStatus: null, connect() {}, on() { return () => {}; }, async request(req: any) { sent.push(req); return null; } },
}));

const mem = new Map<string, string>();
let state: typeof import('./state');
let fields: typeof import('./fields');
let policy: typeof import('./PolicyEditor');
let routines: typeof import('./RoutineTable');

beforeAll(async () => {
  vi.stubGlobal('window', { matchMedia: undefined, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } });
  vi.stubGlobal('document', { addEventListener() {}, hasFocus: () => true, querySelector: () => null, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, classList: { toggle() {}, add() {}, remove() {} } } });
  vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) });
  vi.stubGlobal('location', { search: '', protocol: 'http:', host: 'x' });
  state = await import('./state');
  fields = await import('./fields');
  policy = await import('./PolicyEditor');
  routines = await import('./RoutineTable');
});

const routine = (id: string, extra: Partial<Routine> = {}): Routine => ({ id, name: id, prompt: 'p', everyMinutes: 30, enabled: true, acceptance: { kind: 'none' }, onFail: 'inbox', ...extra });
const bot = (rs: Routine[]): BotStatus => ({
  id: 'b1', name: 'B', charter: { role: 'r', sources: [] }, cwd: '/', tier: 'balanced', policy: { rules: [], unleashed: true }, budget: {}, routines: rs, outputs: [{ kind: 'inbox' }],
  createdAt: 0, updatedAt: 0, state: 'idle', todayUsd: 0, weekUsd: 0, pendingInbox: 0, trust: {},
});

describe('pure helpers', () => {
  it('doRisk has a sentence for exactly send / pay / delete', () => {
    const all: ActionClass[] = ['read', 'write_local', 'browser', 'send', 'pay', 'delete', 'install'];
    expect(all.filter((c) => fields.doRisk(c))).toEqual(['send', 'pay', 'delete']);
    // 做了告诉我 runs it unasked too: the same question, naming that level; 先问我 / 禁止 ask nothing
    expect(all.filter((c) => fields.doRisk(c, 'do_tell'))).toEqual(['send', 'pay', 'delete']);
    expect(fields.doRisk('send', 'do_tell')).toContain('做了告诉我');
    expect(fields.doRisk('pay', 'do')).toContain('直接做');
    expect([fields.doRisk('send', 'ask'), fields.doRisk('delete', 'deny')]).toEqual([null, null]);
  });
  it('DEFAULT_LEVEL is spec §5: read / write / browser just do it, install tells, send / pay / delete ask', () => {
    expect(policy.DEFAULT_LEVEL).toEqual({ read: 'do', write_local: 'do', browser: 'do', install: 'do_tell', send: 'ask', pay: 'ask', delete: 'ask' });
    expect(policy.CLASSES).toHaveLength(7);
  });
  it('cadenceText: every N minutes, cron, or manual only', () => {
    expect(routines.cadenceText({ everyMinutes: 15 })).toBe('每 15 分钟');
    expect(routines.cadenceText({ cron: '0 9 * * *' })).toBe('cron 0 9 * * *');
    expect(routines.cadenceText({})).toBe('只手动');
  });
  it('policyPatch drops unleashed', () => {
    expect(fields.policyPatch({ rules: [], unleashed: true, signOff: false })).toEqual({ rules: [], signOff: false });
  });
});

describe('edits are built from the latest state', () => {
  beforeEach(() => { sent.length = 0; });

  it('patchRoutines changes one routine of the list as stored when sent, keeping the scheduler bookkeeping', async () => {
    state.useBots.setState({ bots: [bot([routine('a'), routine('b')])] });
    // the scheduler wrote back meanwhile
    state.useBots.setState({ bots: [bot([routine('a', { lastRunAt: 5, failures: 2 }), routine('b', { nextRunAt: 9 })])] });
    await routines.patchRoutines('b1', (cur) => cur.map((x) => (x.id === 'b' ? { ...x, name: 'B2' } : x)));
    const req = sent.find((r) => r.kind === 'bots.update');
    expect(req.patch.routines).toEqual([routine('a', { lastRunAt: 5, failures: 2 }), routine('b', { nextRunAt: 9, name: 'B2' })]);
    expect(Object.keys(req.patch)).toEqual(['routines']);
  });
});
