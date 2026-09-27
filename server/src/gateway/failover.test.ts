import { describe, expect, it } from 'vitest';
import { BACKOFF_MAX_MS, MemberStates, classify, cooldownFromHeaders, mapModel, parseDuration } from './failover.js';
import { passthroughHeaders, replaceTopLevelString } from './upstream.js';
import type { GatewayGroup } from './types.js';

const g = (over: Partial<GatewayGroup> = {}): GatewayGroup => ({ id: 'g1', name: 'G', strategy: 'failover', members: [{ providerId: 'a' }, { providerId: 'b' }, { providerId: 'c' }], ...over });

describe('classify', () => {
  it('429 with retry-after cools down for that long', () => {
    expect(classify(429, { 'retry-after': '30' }, '', 0)).toEqual({ action: 'switch', kind: 'rate', cooldownMs: 30_000 });
  });
  it('429 without hints backs off from 60s, doubling, capped at 30 min', () => {
    expect(classify(429, {}, '', 0)).toMatchObject({ cooldownMs: 60_000 });
    expect(classify(429, {}, '', 2)).toMatchObject({ cooldownMs: 240_000 });
    expect(classify(429, {}, '', 20)).toMatchObject({ cooldownMs: BACKOFF_MAX_MS });
  });
  it('quota text counts as rate even on 400 / 403', () => {
    expect(classify(400, {}, '{"error":{"message":"额度已用尽"}}', 0)).toMatchObject({ kind: 'rate' });
    expect(classify(403, {}, 'You exceeded your current quota', 0)).toMatchObject({ kind: 'rate' });
  });
  it('5xx / 529 switch, 401/403 disable, other 4xx are final', () => {
    expect(classify(529, {}, 'overloaded', 0)).toEqual({ action: 'switch', kind: 'transient' });
    expect(classify(500, {}, '', 0)).toEqual({ action: 'switch', kind: 'transient' });
    expect(classify(401, {}, 'invalid x-api-key', 0)).toEqual({ action: 'switch', kind: 'auth' });
    expect(classify(400, {}, 'messages: field required', 0)).toEqual({ action: 'final' });
    expect(classify(404, {}, 'model not found', 0)).toEqual({ action: 'final' });
  });
  it('reset headers: anthropic RFC3339 (exhausted one wins) and openai durations', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(cooldownFromHeaders({ 'anthropic-ratelimit-requests-reset': '2026-01-01T00:00:10Z', 'anthropic-ratelimit-requests-remaining': '5', 'anthropic-ratelimit-tokens-reset': '2026-01-01T00:02:00Z', 'anthropic-ratelimit-tokens-remaining': '0' }, now)).toBe(120_000);
    expect(cooldownFromHeaders({ 'x-ratelimit-reset-requests': '1m30s', 'x-ratelimit-remaining-requests': '0' }, now)).toBe(90_000);
    expect(parseDuration('20ms')).toBe(20);
    expect(cooldownFromHeaders({}, now)).toBeNull();
  });
});

describe('MemberStates', () => {
  it('failover order skips cooling and disabled members, recovers after the cooldown', () => {
    const s = new MemberStates();
    const grp = g();
    s.fail('g1', 'a', { action: 'switch', kind: 'rate', cooldownMs: 1000 }, 429, 'rl', 0);
    s.fail('g1', 'b', { action: 'switch', kind: 'auth' }, 401, 'bad key', 0);
    expect(s.order(grp, 500).map((m) => m.providerId)).toEqual(['c']);
    expect(s.order(grp, 1500).map((m) => m.providerId)).toEqual(['a', 'c']);
    expect(s.nextAvailable(grp)).toEqual({ at: 1000, rate: true });
    s.ok('g1', 'a');
    expect(s.get('g1', 'a').strikes).toBe(0);
    s.reset('g1', 'b');
    expect(s.order(grp, 1500).map((m) => m.providerId)).toEqual(['a', 'b', 'c']);
  });
  it('smooth weighted round-robin', () => {
    const s = new MemberStates();
    const grp = g({ strategy: 'round-robin', members: [{ providerId: 'a', weight: 2 }, { providerId: 'b' }] });
    const firsts = Array.from({ length: 6 }, () => s.order(grp)[0].providerId);
    expect(firsts.filter((x) => x === 'a')).toHaveLength(4);
    expect(firsts.filter((x) => x === 'b')).toHaveLength(2);
    expect(s.order(grp)).toHaveLength(2); // the rest stays available as fallback
  });
});

describe('mapModel', () => {
  it('member pin > exact map > wildcard > unchanged', () => {
    const grp = g({ modelMap: { 'claude-sonnet-4-5': 'gpt-4.1', 'claude-*haiku*': 'gpt-4.1-mini' } });
    expect(mapModel(grp, { providerId: 'a', model: 'pinned' }, 'claude-sonnet-4-5')).toBe('pinned');
    expect(mapModel(grp, { providerId: 'a' }, 'claude-sonnet-4-5')).toBe('gpt-4.1');
    expect(mapModel(grp, { providerId: 'a' }, 'claude-3-5-haiku-latest')).toBe('gpt-4.1-mini');
    expect(mapModel(grp, { providerId: 'a' }, 'other')).toBe('other');
  });
});

describe('passthrough helpers', () => {
  it('replaceTopLevelString only touches the top-level model value', () => {
    const body = '{"model":"a","messages":[{"role":"user","content":[{"type":"tool_use","input":{"model":"a"}}]}],"x":"\\"model\\":\\"a\\""}';
    expect(replaceTopLevelString(body, 'model', 'b')).toBe(body.replace('{"model":"a"', '{"model":"b"'));
    const late = '{"messages":[{"model":"x"}],  "model" : "old" , "z":1}';
    expect(replaceTopLevelString(late, 'model', 'new')).toBe('{"messages":[{"model":"x"}],  "model" : "new" , "z":1}');
    expect(replaceTopLevelString('{"messages":[]}', 'model', 'x')).toBeNull();
  });
  it('headers keep order / case / fingerprint, swap the credential in the client\'s style', () => {
    const raw = ['Host', '127.0.0.1:3090', 'User-Agent', 'claude-cli/2.1.300 (external, cli)', 'X-Api-Key', 'cwg-local', 'anthropic-version', '2023-06-01', 'anthropic-beta', 'claude-code-20250219,oauth-2025-04-20', 'Content-Length', '12', 'Connection', 'keep-alive', 'Cookie', 'cw_token=secret', 'x-app', 'cli'];
    const h = passthroughHeaders(raw, 'anthropic', 'sk-member');
    expect(Object.keys(h)).toEqual(['User-Agent', 'anthropic-version', 'anthropic-beta', 'x-app', 'x-api-key']);
    expect(h['User-Agent']).toBe('claude-cli/2.1.300 (external, cli)');
    expect(h['x-api-key']).toBe('sk-member');
    const bearer = passthroughHeaders(['authorization', 'Bearer cwg-local', 'user-agent', 'ua'], 'anthropic', 'sk-member');
    expect(bearer).toEqual({ 'user-agent': 'ua', authorization: 'Bearer sk-member' });
    expect(passthroughHeaders(['x-goog-api-key', 'cwg'], 'gemini', 'AIza')).toEqual({ 'x-goog-api-key': 'AIza' });
  });
});
