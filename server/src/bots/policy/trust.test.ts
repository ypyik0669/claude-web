// server/src/bots/policy/trust.test.ts
import { describe, it, expect } from 'vitest';
import { recordApproval, recordCorrection, demoteRule, scopeFromKey, TRUST_THRESHOLD } from './trust.js';

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
    const t = recordApproval(recordApproval({}, 'send', 'x', 1).trust, 'send', 'x', 2).trust;
    expect(recordCorrection(t, 'send', 'x')['send|x']).toBeUndefined();
  });
  it('demoteRule drops the scoped do-rule that covered the key, leaving other rules', () => {
    const p = { rules: [{ cls: 'send' as const, level: 'do' as const, scope: { channels: ['C1'] } }, { cls: 'send' as const, level: 'do' as const, scope: { channels: ['C2'] } }, { cls: 'read' as const, level: 'do' as const }] };
    expect(demoteRule(p, 'send', 'channel:C1').rules).toEqual([p.rules[1], p.rules[2]]);
  });
  it('scopeFromKey', () => {
    expect(scopeFromKey('channel:C1')).toEqual({ channels: ['C1'] });
    expect(scopeFromKey('domain:a.com')).toEqual({ domains: ['a.com'] });
    expect(scopeFromKey('recipient:me@x')).toEqual({ recipients: ['me@x'] });
    expect(scopeFromKey('*')).toEqual({});
  });
});
