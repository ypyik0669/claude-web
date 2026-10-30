// server/src/bots/policy/rules.test.ts
import { describe, it, expect } from 'vitest';
import { DEFAULT_RULES, decide, scopeMatches, scopeKey } from './rules.js';
import type { BotPolicy } from '../../protocol.js';

const empty: BotPolicy = { rules: [] };
describe('decide', () => {
  it('defaults: read / local / browser do, install do_tell, send / pay / delete ask', () => {
    expect(DEFAULT_RULES.find((r) => r.cls === 'read')!.level).toBe('do');
    expect(decide(empty, 'write_local', {}, 0, 0)).toEqual({ level: 'do', basis: 'rule', rule: DEFAULT_RULES.find((r) => r.cls === 'write_local') });
    expect(decide(empty, 'install', {}, 0, 0).level).toBe('do_tell');
    expect(decide(empty, 'send', {}, 0, 0).level).toBe('ask');
    expect(decide(empty, 'pay', {}, 0, 0).level).toBe('ask');
    expect(decide(empty, 'delete', {}, 0, 0).level).toBe('ask');
  });
  it('a scoped rule beats the default only when the target is inside the scope', () => {
    const p: BotPolicy = { rules: [{ cls: 'send', level: 'do', scope: { channels: ['C1'], until: 100 } }] };
    expect(decide(p, 'send', { channel: 'C1' }, 50, 0).level).toBe('do');
    expect(decide(p, 'send', { channel: 'C2' }, 50, 0).level).toBe('ask');
    expect(decide(p, 'send', { channel: 'C1' }, 200, 0).level).toBe('ask');
  });
  it('maxAmount and perDay are limits, unlimited matches everything', () => {
    expect(scopeMatches({ maxAmount: 50 }, { amount: 30 }, 0, 0)).toBe(true);
    expect(scopeMatches({ maxAmount: 50 }, { amount: 80 }, 0, 0)).toBe(false);
    expect(scopeMatches({ maxAmount: 50 }, {}, 0, 0)).toBe(false);
    expect(scopeMatches({ perDay: 3 }, {}, 0, 3)).toBe(false);
    expect(scopeMatches({ unlimited: true }, { amount: 1e9 }, 0, 999)).toBe(true);
  });
  it('autoPilot and unleashed say do with their own basis', () => {
    expect(decide({ rules: [], autoPilot: { on: true, scope: { domains: ['a.com'] } } }, 'send', { domain: 'a.com' }, 0, 0)).toMatchObject({ level: 'do', basis: 'autopilot' });
    expect(decide({ rules: [], autoPilot: { on: true, scope: { domains: ['a.com'] } } }, 'send', { domain: 'b.com' }, 0, 0).level).toBe('ask');
    expect(decide({ rules: [], unleashed: true }, 'pay', {}, 0, 0)).toMatchObject({ level: 'do', basis: 'unleashed' });
  });
  it('an explicit deny stays deny even with autoPilot', () => {
    expect(decide({ rules: [{ cls: 'pay', level: 'deny' }], autoPilot: { on: true, scope: { unlimited: true } } }, 'pay', {}, 0, 0).level).toBe('deny');
  });
  it('scopeKey names what trust is counted on', () => {
    expect(scopeKey(undefined, { channel: 'C1' })).toBe('channel:C1');
    expect(scopeKey(undefined, { domain: 'a.com' })).toBe('domain:a.com');
    expect(scopeKey(undefined, {})).toBe('*');
  });
});
