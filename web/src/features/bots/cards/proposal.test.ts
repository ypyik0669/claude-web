// A policy proposal's risks before it is adopted. Browser globals / transport stubbed as in approval-menu.test.ts.
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/ws/client', () => ({
  authToken: () => null,
  ws: { onStatus: null, connect() {}, on() { return () => {}; }, async request() { return null; } },
}));

let m: typeof import('./proposal');

beforeAll(async () => {
  vi.stubGlobal('window', { matchMedia: undefined, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } });
  vi.stubGlobal('document', { addEventListener() {}, hasFocus: () => true, querySelector: () => null, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, classList: { toggle() {}, add() {}, remove() {} } } });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal('location', { search: '', protocol: 'http:', host: 'x' });
  (await import('@i18n')).setLocale('zh');
  m = await import('./proposal');
});

describe('proposalRisks', () => {
  it('send / pay / delete let run, and any unlimited rule, ask first; deny / ask / a scoped read do not', () => {
    expect(m.proposalRisks([{ cls: 'send', level: 'deny' }, { cls: 'pay', level: 'ask' }, { cls: 'read', level: 'do', scope: { domains: ['a.com'] } }])).toEqual([]);
    const r = m.proposalRisks([{ cls: 'pay', level: 'do', scope: { unlimited: true } }, { cls: 'send', level: 'do_tell', scope: { channels: ['C1'] } }, { cls: 'send', level: 'do', scope: { channels: ['C2'] } }]);
    expect(r).toHaveLength(4); // pay, unlimited pay, send at each of its two levels
    expect(r.some((s) => s.includes('花钱'))).toBe(true);
    expect(r.some((s) => s.includes('不限范围'))).toBe(true);
    expect(m.proposalRisks([{ cls: 'browser', level: 'do', scope: { unlimited: true } }])).toHaveLength(1);
  });
  it('scopeWords shows until', () => {
    expect(m.scopeWords({ channels: ['C1'], until: new Date(2026, 10, 7).getTime() })).toMatch(/^C1、到 .+ 为止$/);
  });
});

describe('rulesWords (the 规矩 card)', () => {
  it('the defaults: send / pay / delete ask first; reading and local writes run', () => {
    const w = m.rulesWords({ rules: [] });
    expect(w.ask).toEqual(['对外发送', '付款交易', '不可恢复删除']);
    expect(w.own).toContain('读'); expect(w.own).toContain('写本地');
    expect(w.never).toEqual([]); expect(w.scoped).toBe(0);
  });
  it('an unscoped rule or a deny moves a class; scoped rules are counted; 全自动 runs everything', () => {
    const w = m.rulesWords({ rules: [{ cls: 'send', level: 'do', scope: { channels: ['C1'] } }, { cls: 'pay', level: 'deny' }, { cls: 'read', level: 'ask' }] });
    expect(w.ask).toEqual(['对外发送', '不可恢复删除', '读']);
    expect(w.never).toEqual(['付款交易']);
    expect(w.scoped).toBe(1);
    expect(m.rulesWords({ rules: [], unleashed: true }).ask).toEqual([]);
  });
});
