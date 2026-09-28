import { describe, expect, it } from 'vitest';
import type { LedgerEntry } from '@shared';
import { hitRate, hitRates } from './ledger-stats';

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
