import { describe, expect, it } from 'vitest';
import type { LedgerEntry } from '@shared';
import { hitRate, hitRates, pickRows, profileName } from './ledger-stats';

const row = (p: Partial<LedgerEntry>): LedgerEntry => ({ ts: 1, sessionId: 's', model: 'm', durationMs: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, ok: true, ...p });
const names: Record<string, string> = { ds: 'DeepSeek 中转', a: 'super-nb' };
const nameOf = (id?: string) => (id ? names[id] ?? id : 'Claude 账号');

describe('hitRates (provider × model)', () => {
  it('groups by profile and model, hit = cacheRead / (input + cacheRead + cacheWrite)', () => {
    const rows = [
      row({ providerId: 'ds', model: 'deepseek-v4', input: 1_000, cacheRead: 9_000 }),
      row({ providerId: 'ds', model: 'deepseek-v4', input: 1_000, cacheRead: 9_000 }),
      row({ providerId: 'a', model: 'claude-opus-4-5', input: 100, cacheRead: 700, cacheWrite: 200 }),
      row({ model: 'claude-opus-4-5', input: 50, cacheRead: 50 }),
    ];
    const out = hitRates(rows, nameOf);
    expect(out.map((r) => [r.provider, r.model, r.calls, Math.round(r.hit * 100)])).toEqual([
      ['DeepSeek 中转', 'deepseek-v4', 2, 90],
      ['super-nb', 'claude-opus-4-5', 1, 70],
      ['Claude 账号', 'claude-opus-4-5', 1, 50],
    ]);
  });
  it('gateway / shim rows count under the member that answered; rows with no tokens (retries, errors) are skipped', () => {
    const rows = [
      row({ kind: 'gateway', providerId: 'ds', model: 'deepseek-v4', input: 10, cacheRead: 30, gateway: { group: 'G', inbound: 'anthropic', member: 'DeepSeek 中转', memberId: 'ds', switches: 0, stream: true } }),
      row({ ok: false, error: 'retry 529', model: '' }),
    ];
    const out = hitRates(rows, nameOf);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ provider: 'DeepSeek 中转', calls: 1, input: 10, cacheRead: 30 });
  });
  it('hitRate of nothing is 0', () => {
    expect(hitRate({ input: 0, cacheRead: 0, cacheWrite: 0 })).toBe(0);
  });
});

describe('pickRows (ledger source filter)', () => {
  const shim = (sessionId: string | undefined, input: number) => row({ kind: 'gateway', sessionId: sessionId as string, input, gateway: { group: '缓存垫片', inbound: 'openai-chat', member: 'DeepSeek 中转', memberId: 'ds', switches: 0, stream: true, via: 'shim' } as any });
  const rows = [
    row({ sessionId: 'a', providerId: 'ds', input: 100 }), // the session's own result row (whole turn)
    shim('a', 60), // the same turn, per call through the cache shim
    shim('a', 40),
    shim('b', 70), // a session whose result rows are not in this window
    shim(undefined, 5), // an outside client straight through the gateway
  ];
  it('全部: a session\'s gateway / shim rows are dropped when its own rows are there — each call counted once', () => {
    const { rows: out, dropped } = pickRows(rows, 'all');
    expect(out.map((r) => [r.kind ?? 'session', r.sessionId, r.input])).toEqual([['session', 'a', 100], ['gateway', 'b', 70], ['gateway', undefined, 5]]);
    expect(dropped).toBe(2);
  });
  it('会话 / 网关 keep their own kind, nothing dropped', () => {
    expect(pickRows(rows, 'session').rows).toHaveLength(1);
    expect(pickRows(rows, 'gateway')).toMatchObject({ dropped: 0 });
    expect(pickRows(rows, 'gateway').rows).toHaveLength(4);
  });
});

describe('profileName', () => {
  const providers = [{ id: 'ds', name: 'DeepSeek 中转' }];
  it('the account, a profile, a deleted profile', () => {
    expect(profileName(providers, undefined)).toBe('Claude 账号');
    expect(profileName(providers, 'ds')).toBe('DeepSeek 中转');
    expect(profileName(providers, 'gone-1')).toBe('已删除的供应商');
  });
});
