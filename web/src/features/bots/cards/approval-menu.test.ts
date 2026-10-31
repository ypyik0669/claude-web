// 允许 ▾'s choices. Browser globals / transport stubbed as in inbox-view.test.ts (scope-form reaches the store).
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { InboxItem } from '@shared';

vi.mock('@/ws/client', () => ({
  authToken: () => null,
  ws: { onStatus: null, connect() {}, on() { return () => {}; }, async request() { return null; } },
}));

let approvalChoices: typeof import('./approval-menu').approvalChoices;
let RUN_SCOPE_MS: number;
let doneText: typeof import('./approval-menu').doneText;

beforeAll(async () => {
  vi.stubGlobal('window', { matchMedia: undefined, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } });
  vi.stubGlobal('document', { addEventListener() {}, hasFocus: () => true, querySelector: () => null, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, classList: { toggle() {}, add() {}, remove() {} } } });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal('location', { search: '', protocol: 'http:', host: 'x' });
  ({ approvalChoices, RUN_SCOPE_MS, doneText } = await import('./approval-menu'));
});

const item = (p: Partial<InboxItem>): InboxItem => ({ id: 'i1', kind: 'approval', botId: 'b1', at: 1, title: 't', ...p });

describe('approvalChoices', () => {
  it('an opaque target gets only 仅这次 and 总是', () => {
    const c = approvalChoices(item({ cls: 'write_local', toolName: 'Write', input: { file_path: 'a.txt' } }), 1000);
    expect(c.map((x) => x.id)).toEqual(['once', 'always']);
    expect(c[0]).toMatchObject({ answer: 'approve' });
    expect(c[1]).toMatchObject({ answer: 'approve_scope', editor: 'unlimited' });
  });

  it('a target gets every choice, the narrowest first; 这次运行内 has until', () => {
    const now = 1_000_000;
    const c = approvalChoices(item({ cls: 'send', toolName: 'mcp__im__send', input: { channel: 'C1', text: 'hi' } }), now);
    expect(c.map((x) => x.id)).toEqual(['once', 'run', 'target', 'always']);
    const run = c.find((x) => x.id === 'run')!;
    expect(run.answer).toBe('approve_scope');
    expect(run.scope).toEqual({ channels: ['C1'], until: now + RUN_SCOPE_MS });
    expect(c.find((x) => x.id === 'target')).toMatchObject({ editor: 'target' });
  });

  it('a payment needs 金额上限: its 这次运行内 goes through the form, not straight out', () => {
    const c = approvalChoices(item({ cls: 'pay', toolName: 'pay', input: { to: 'shop@x.com', amount: 5 } }), 0);
    const run = c.find((x) => x.id === 'run')!;
    expect(run.scope).toBeUndefined();
    expect(run.editor).toBe('run');
    expect(run.amountRequired).toBe(true);
    expect(c.find((x) => x.id === 'target')?.amountRequired).toBe(true);
  });
});

describe('doneText', () => {
  const t = () => '9:42';
  beforeAll(async () => { (await import('@i18n')).setLocale('zh'); });
  it('only an approval reads 已允许; archived 已收起, rejected 已拒绝, closed with a note 已过期, anything else 已关闭', () => {
    expect(doneText({ at: 1, answer: 'approve' }, t)).toBe('已允许 · 9:42');
    expect(doneText({ at: 1, answer: 'approve_scope' }, t)).toBe('已允许 · 9:42');
    expect(doneText({ at: 1, answer: 'reject' }, t)).toBe('已拒绝');
    expect(doneText({ at: 1, answer: 'archive' }, t)).toBe('已收起');
    expect(doneText({ at: 1, answer: 'archive', note: '已过期' }, t)).toBe('已过期');
    expect(doneText({ at: 1, answer: 'send' }, t)).toBe('已关闭');
  });
});
