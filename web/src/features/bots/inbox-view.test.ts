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

beforeAll(async () => {
  vi.stubGlobal('window', { matchMedia: undefined, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } });
  vi.stubGlobal('document', { addEventListener() {}, hasFocus: () => true, querySelector: () => null, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, classList: { toggle() {}, add() {}, remove() {} } } });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal('location', { search: '', protocol: 'http:', host: 'x' });
  ({ inboxActions, scopeDefaults, buildScope, answerInOrder } = await import('./Inbox'));
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
  it('nothing known: every field empty', () => expect(scopeDefaults({})).toEqual({ domains: '', channels: '', recipients: '', maxAmount: '', perDay: '' }));
});

describe('buildScope: never an empty scope', () => {
  const none = { domains: false, channels: false, recipients: false, maxAmount: false, perDay: false };
  const empty = { domains: '', channels: '', recipients: '', maxAmount: '', perDay: '' };
  it('the filled fields', () => expect(buildScope({ ...empty, domains: 'a.com，b.com', perDay: '5' }, none)).toEqual({ domains: ['a.com', 'b.com'], perDay: 5 }));
  it('nothing filled, nothing unlimited: no scope', () => expect(buildScope(empty, none)).toBeNull());
  it('nothing filled but 无限制 ticked: unlimited', () => expect(buildScope(empty, { ...none, domains: true })).toEqual({ unlimited: true }));
  it('a ticked field is left out even with text in it', () => expect(buildScope({ ...empty, domains: 'a.com', channels: 'C1' }, { ...none, domains: true })).toEqual({ channels: ['C1'] }));
  it('a number that is not one: no scope', () => expect(buildScope({ ...empty, maxAmount: 'abc' }, none)).toBeNull());
});

describe('answerInOrder: one after another, stop at the first refusal', () => {
  it('stops after the one that failed', async () => {
    const seen: string[] = [];
    const n = await answerInOrder(['a', 'b', 'c'], 'approve', async (a) => { seen.push(a.id); return a.id !== 'b'; });
    expect([n, seen]).toEqual([1, ['a', 'b']]);
  });
  it('all of them when none fails', async () => expect(await answerInOrder(['a', 'b'], 'archive', async () => true)).toBe(2));
});
