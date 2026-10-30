// server/src/bots/policy/trust.test.ts
import { describe, it, expect } from 'vitest';
import { recordApproval, recordCorrection, demoteRule, scopeFromKey, TRUST_THRESHOLD } from './trust.js';
import { decide, scopeKey } from './rules.js';
import type { BotPolicy } from '../../protocol.js';

describe('trust', () => {
  it('proposes an upgrade exactly when the Nth approval lands', () => {
    let t = {};
    let r = recordApproval(t, 'send', 'channel:C1', 1); expect(r.propose).toBe(false); t = r.trust;
    r = recordApproval(t, 'send', 'channel:C1', 2); expect(r.propose).toBe(false); t = r.trust;
    r = recordApproval(t, 'send', 'channel:C1', 3); expect(r.propose).toBe(TRUST_THRESHOLD === 3); t = r.trust;
    r = recordApproval(t, 'send', 'channel:C1', 4); expect(r.propose).toBe(false);
    expect(t['send|channel:C1']).toEqual({ approvals: 3, lastAt: 3 });
  });
  it('a correction resets the counter', () => {
    const t = recordApproval(recordApproval({}, 'send', 'channel:x', 1).trust, 'send', 'channel:x', 2).trust;
    expect(t['send|channel:x']).toEqual({ approvals: 2, lastAt: 2 });
    expect(recordCorrection(t, 'send', 'channel:x')['send|channel:x']).toBeUndefined();
  });
  it('scopeFromKey', () => {
    expect(scopeFromKey('channel:C1')).toEqual({ channels: ['C1'] });
    expect(scopeFromKey('domain:a.com')).toEqual({ domains: ['a.com'] });
    expect(scopeFromKey('recipient:me@x')).toEqual({ recipients: ['me@x'] });
    expect(scopeFromKey('domain:a.com,b.com')).toEqual({ domains: ['a.com', 'b.com'] });
    expect(scopeFromKey('*')).toEqual({});
  });
});

// Review fixes (spec §5 governs).
describe('trust: upgrades are always scoped, corrections remove the rule that let it through', () => {
  it('C4: approvals on the unscoped key "*" are never counted and never propose an upgrade', () => {
    let t = {};
    for (let i = 1; i <= 5; i++) { const r = recordApproval(t, 'send', scopeKey(undefined, {}), i); expect(r.propose).toBe(false); t = r.trust; }
    expect(t).toEqual({});
    expect(recordApproval({}, 'send', 'nonsense', 1).trust).toEqual({});
  });
  it('a multi-host key upgrades to exactly those hosts', () => {
    const key = scopeKey(undefined, { domains: ['b.com', 'a.com'] });
    let t = {}; let r = { trust: t, propose: false };
    for (let i = 1; i <= TRUST_THRESHOLD; i++) { r = recordApproval(t, 'send', key, i); t = r.trust; }
    expect(r.propose).toBe(true);
    const p: BotPolicy = { rules: [{ cls: 'send', level: 'do', scope: scopeFromKey(key) }] };
    expect(decide(p, 'send', { domains: ['a.com', 'b.com'] }, 0, 0).level).toBe('do');
    expect(decide(p, 'send', { domains: ['a.com', 'c.com'] }, 0, 0).level).toBe('ask');
  });
  it('I3: demotion removes the exact scoped rule that allowed the action, even when the key names another kind', () => {
    const allow = { cls: 'send' as const, level: 'do' as const, scope: { domains: ['mail.example.com'] } };
    const other = { cls: 'send' as const, level: 'do' as const, scope: { channels: ['C2'] } };
    const p: BotPolicy = { rules: [allow, other, { cls: 'read', level: 'do' }] };
    const d = decide(p, 'send', { domains: ['mail.example.com'], recipients: ['boss@x.com'] }, 0, 0);
    expect(d.rule).toBe(allow);
    const after = demoteRule(p, d.rule);
    expect(after.rules).toEqual([other, { cls: 'read', level: 'do' }]);
    expect(decide(after, 'send', { domains: ['mail.example.com'] }, 0, 0).level).toBe('ask');
  });
  it('I3: a plain (unscoped) do / do_tell rule goes back to ask', () => {
    const p: BotPolicy = { rules: [{ cls: 'send', level: 'do' }] };
    const d = decide(p, 'send', { channels: ['C1'] }, 0, 0);
    const after = demoteRule(p, d.rule);
    expect(after.rules).toEqual([{ cls: 'send', level: 'ask' }]);
    expect(decide(after, 'send', { channels: ['C1'] }, 0, 0).level).toBe('ask');
  });
  it('the rule is found by value after the policy was reloaded', () => {
    const p: BotPolicy = { rules: [{ cls: 'send', level: 'do', scope: { channels: ['C1'] } }] };
    const d = decide(p, 'send', { channels: ['C1'] }, 0, 0);
    const reloaded: BotPolicy = JSON.parse(JSON.stringify(p));
    expect(demoteRule(reloaded, d.rule).rules).toEqual([]);
  });
  it('defaults, ask / deny rules, autopilot and unleashed are left alone', () => {
    const p: BotPolicy = { rules: [{ cls: 'send', level: 'ask', scope: { channels: ['C1'] } }] };
    expect(demoteRule(p, decide({ rules: [] }, 'write_local', {}, 0, 0).rule)).toBe(p);
    expect(demoteRule(p, p.rules[0])).toBe(p);
    expect(demoteRule(p, undefined)).toBe(p);
  });
});
