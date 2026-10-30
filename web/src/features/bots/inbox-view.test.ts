// The inbox's pure parts: which buttons an item gets, what the scope form starts with, the scope it sends (never an
// empty one), and the batch that stops at the first refusal. Browser globals / transport stubbed as in policy-ui.test.ts.
import { beforeAll, describe, it, expect, vi } from 'vitest';

vi.mock('@/ws/client', () => ({
  authToken: () => null,
  ws: { onStatus: null, connect() {}, on() { return () => {}; }, async request() { return null; } },
}));

let inboxActions: typeof import('./Inbox').inboxActions;
let scopeDefaults: typeof import('./Inbox').scopeDefaults;
let buildScope: typeof import('./Inbox').buildScope;
let answerInOrder: typeof import('./Inbox').answerInOrder;
let scopeFields: typeof import('./Inbox').scopeFields;
let parseUntil: typeof import('./Inbox').parseUntil;
let batchConfirm: typeof import('./Inbox').batchConfirm;

beforeAll(async () => {
  vi.stubGlobal('window', { matchMedia: undefined, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } });
  vi.stubGlobal('document', { addEventListener() {}, hasFocus: () => true, querySelector: () => null, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, classList: { toggle() {}, add() {}, remove() {} } } });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal('location', { search: '', protocol: 'http:', host: 'x' });
  ({ inboxActions, scopeDefaults, buildScope, answerInOrder, scopeFields, parseUntil, batchConfirm } = await import('./Inbox'));
});

describe('inboxActions', () => {
  it('approval: approve, approve_scope (needs scope), reject', () => expect(inboxActions({ id: '1', kind: 'approval', botId: 'b', at: 1, title: 't' }).map((a) => [a.id, !!a.needsScope])).toEqual([['approve', false], ['approve_scope', true], ['reject', false]]));
  it('draft: send, archive', () => expect(inboxActions({ id: '1', kind: 'draft', botId: 'b', at: 1, title: 't' }).map((a) => a.id)).toEqual(['send', 'archive']));
  it('proposal: adopt, archive', () => expect(inboxActions({ id: '1', kind: 'proposal', botId: 'b', at: 1, title: 't' }).map((a) => a.id)).toEqual(['adopt', 'archive']));
  it('finding: archive', () => expect(inboxActions({ id: '1', kind: 'finding', botId: 'b', at: 1, title: 't' }).map((a) => a.id)).toEqual(['archive']));
});

describe('scopeDefaults: the scope form starts from what the call goes to', () => {
  it('hosts of the URLs in a command', () => {
    expect(scopeDefaults({ toolName: 'Bash', input: { command: 'curl -X POST https://API.example.com/x -d a=1; curl http://b.org' } }).domains).toBe('api.example.com, b.org');
  });
  it('channel and recipients inside ExecuteExtraTool params', () => {
    const d = scopeDefaults({ toolName: 'ExecuteExtraTool', input: { tool_name: 'mcp__slack__send_message', params: { channel: 'C1', to: ['a@x.com'], cc: 'c@x.com' } } });
    expect([d.channels, d.recipients, d.domains]).toEqual(['C1', 'a@x.com, c@x.com', '']);
  });
  it('nothing known: every field empty', () => expect(scopeDefaults({})).toEqual({ domains: '', channels: '', recipients: '', maxAmount: '', perDay: '', until: '' }));
});

describe('buildScope: exactly what was confirmed, nothing blank means unlimited', () => {
  const NOW = new Date(2026, 9, 30, 12).getTime();
  const DAY = 24 * 60 * 60 * 1000;
  const none = { domains: false, channels: false, recipients: false, maxAmount: false, perDay: false, until: false };
  const full = { domains: 'a.com，b.com', channels: 'C1', recipients: 'x@y.com', maxAmount: '50', perDay: '5', until: '7' };
  let send: ReturnType<typeof scopeFields>, pay: ReturnType<typeof scopeFields>;
  beforeAll(() => { send = scopeFields('send'); pay = scopeFields('pay'); });
  const ok = (r: ReturnType<typeof buildScope>) => ('scope' in r ? r.scope : null);
  it('every field filled: all of them, until as a timestamp days from now', () =>
    expect(ok(buildScope(full, none, send, NOW))).toEqual({ domains: ['a.com', 'b.com'], channels: ['C1'], recipients: ['x@y.com'], perDay: 5, until: NOW + 7 * DAY }));
  it('a blank list field without its 无限制: refused', () => expect(ok(buildScope({ ...full, channels: '' }, none, send, NOW))).toBeNull());
  it('a blank list field with its 无限制 ticked: left out, the rest stays', () =>
    expect(ok(buildScope({ ...full, channels: '', recipients: '' }, { ...none, channels: true, recipients: true }, send, NOW))).toEqual({ domains: ['a.com', 'b.com'], perDay: 5, until: NOW + 7 * DAY }));
  it('one 无限制 ticked with nothing else filled never widens to unlimited', () =>
    expect(ok(buildScope({ domains: '', channels: '', recipients: '', maxAmount: '', perDay: '', until: '' }, { ...none, domains: true }, send, NOW))).toBeNull());
  it('numbers only (every list ticked 无限制): refused — it would match every destination', () =>
    expect(ok(buildScope(full, { ...none, domains: true, channels: true, recipients: true }, send, NOW))).toBeNull());
  it('every shown field ticked 无限制: unlimited', () =>
    expect(ok(buildScope(full, { domains: true, channels: true, recipients: true, maxAmount: false, perDay: true, until: true }, send, NOW))).toEqual({ unlimited: true }));
  it('pay: 金额上限 is required unless ticked; with it, sent', () => {
    expect(ok(buildScope({ ...full, maxAmount: '' }, none, pay, NOW))).toBeNull();
    expect(ok(buildScope(full, none, pay, NOW))?.maxAmount).toBe(50);
    expect(ok(buildScope({ ...full, maxAmount: '' }, { ...none, maxAmount: true }, pay, NOW))?.maxAmount).toBeUndefined();
  });
  it('pay: unlimited only when 金额上限 is ticked too', () =>
    expect(ok(buildScope(full, { domains: true, channels: true, recipients: true, maxAmount: false, perDay: true, until: true }, pay, NOW))).toBeNull());
  it('每天最多: a whole number ≥ 1; 金额上限 ≥ 0', () => {
    for (const perDay of ['0', '1.5', '-1', 'abc']) expect(ok(buildScope({ ...full, perDay }, none, send, NOW)), perDay).toBeNull();
    expect(ok(buildScope({ ...full, maxAmount: '-1' }, none, pay, NOW))).toBeNull();
    expect(ok(buildScope({ ...full, maxAmount: '0' }, none, pay, NOW))?.maxAmount).toBe(0);
  });
  it('有效期: blank refused, 0 days refused, a past date refused, a future date = its end of day', () => {
    expect(ok(buildScope({ ...full, until: '' }, none, send, NOW))).toBeNull();
    expect(ok(buildScope({ ...full, until: '0' }, none, send, NOW))).toBeNull();
    expect(ok(buildScope({ ...full, until: '2026-10-01' }, none, send, NOW))).toBeNull();
    expect(ok(buildScope({ ...full, until: '2026-12-31' }, none, send, NOW))?.until).toBe(new Date(2026, 11, 31, 23, 59, 59, 999).getTime());
    expect(ok(buildScope({ ...full, until: '' }, { ...none, until: true }, send, NOW))?.until).toBeUndefined();
  });
  it('parseUntil: no invalid dates', () => { expect(parseUntil('2026-02-30', NOW)).toBeNull(); expect(parseUntil('soon', NOW)).toBeNull(); });
});

describe('batchConfirm', () => {
  const it0 = (extra: object) => ({ id: '1', kind: 'approval' as const, botId: 'b', at: 1, title: 't', ...extra });
  it('plain approvals: a count, not danger', () => expect(batchConfirm([it0({ cls: 'browser' }), it0({})], 'approve')).toEqual({ title: '批准这 2 条？', message: undefined, danger: false }));
  it('says how many cannot be undone / go out, and is danger', () => {
    const c = batchConfirm([it0({ cls: 'send', undoable: false }), it0({ cls: 'pay' }), it0({ cls: 'read' })], 'approve');
    expect(c.danger).toBe(true);
    expect(c.message).toContain('1');
    expect(c.message).toContain('2');
  });
});

describe('answerInOrder: one after another, stop at the first refusal', () => {
  it('stops after the one that failed', async () => {
    const seen: string[] = [];
    const n = await answerInOrder(['a', 'b', 'c'], 'approve', async (a) => { seen.push(a.id); return a.id !== 'b'; });
    expect([n, seen]).toEqual([1, ['a', 'b']]);
  });
  it('all of them when none fails', async () => expect(await answerInOrder(['a', 'b'], 'archive', async () => true)).toBe(2));
});

describe('the phone opens on the inbox, but openBots(id) shows that bot', () => {
  it('openBots(id) turns the inbox tab off; openBots() keeps it', async () => {
    const st = await import('./state');
    st.useBots.setState({ phoneInbox: true });
    st.openBots();
    expect(st.useBots.getState().phoneInbox).toBe(true);
    st.openBots('b_1');
    expect([st.useBots.getState().phoneInbox, st.useBots.getState().selected]).toEqual([false, 'b_1']);
  });
});
