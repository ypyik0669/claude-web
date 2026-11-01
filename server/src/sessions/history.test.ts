import { describe, expect, it } from 'vitest';
import { pageOf, startsTurn, withTurnStats } from './history.js';
import type { LedgerEntry } from '../protocol.js';

const T = (min: number, sec = 0) => new Date(Date.UTC(2026, 9, 14, 10, min, sec)).toISOString();
const ms = (iso: string) => Date.parse(iso);
const user = (uuid: string, ts: string, content: unknown = 'hi') => ({ type: 'user', uuid, session_id: 's', timestamp: ts, parent_tool_use_id: null, message: { role: 'user', content } });
const answer = (uuid: string, ts: string, id: string, stop: string, usage: Record<string, number>, blocks: unknown[] = [{ type: 'text', text: 'ok' }]) =>
  ({ type: 'assistant', uuid, session_id: 's', timestamp: ts, parent_tool_use_id: null, message: { id, role: 'assistant', stop_reason: stop, usage, content: blocks } });
const toolResult = (uuid: string, ts: string) => user(uuid, ts, [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }]);
const row = (ts: string, o: Partial<LedgerEntry> = {}): LedgerEntry => ({ ts: ms(ts), sessionId: 's', model: 'claude-sonnet-5', durationMs: 27_100, input: 3, output: 1600, cacheRead: 0, cacheWrite: 211_000, costUsd: 1.09, ok: true, turns: 1, ...o });

describe('startsTurn: where the chat starts a turn', () => {
  it('a message a person typed; not a tool result, a meta line, a compaction summary, a command or a task notification', () => {
    expect(startsTurn(user('u', T(0)))).toBe(true);
    expect(startsTurn(toolResult('u', T(0)))).toBe(false);
    expect(startsTurn({ ...user('u', T(0)), isMeta: true })).toBe(false);
    expect(startsTurn({ ...user('u', T(0)), is_meta: true })).toBe(false);
    expect(startsTurn({ ...user('u', T(0)), isCompactSummary: true })).toBe(false);
    expect(startsTurn(user('u', T(0), '<task-notification>done</task-notification>'))).toBe(false);
    expect(startsTurn(user('u', T(0), [{ type: 'text', text: '<command-name>/compact</command-name>' }]))).toBe(false);
    expect(startsTurn({ ...user('u', T(0)), parent_tool_use_id: 'toolu_1' })).toBe(false);
  });
});

describe('withTurnStats: the line under each answer for turns that did not run in this window', () => {
  const convo = [
    user('u1', T(0)),
    answer('a1', T(0, 5), 'm1', 'tool_use', { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 5000, output_tokens: 40 }, [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }]),
    toolResult('r1', T(0, 6)),
    answer('a2', T(0, 20), 'm2', 'end_turn', { input_tokens: 4, cache_read_input_tokens: 5000, cache_creation_input_tokens: 100, output_tokens: 300 }),
    user('u2', T(20)),
    answer('a3', T(20, 27), 'm3', 'end_turn', { input_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 211_000, output_tokens: 1600 }),
  ];
  it('a turn the ledger recorded gets what the live line said (cost included); one it did not, the answers\' own usage and no cost', () => {
    const out = withTurnStats(convo, [row(T(20, 28))]);
    const results = out.filter((m) => m.type === 'result');
    expect(results).toHaveLength(2);
    // after each turn's last message, before the next turn
    expect(out.map((m) => m.type)).toEqual(['user', 'assistant', 'user', 'assistant', 'result', 'user', 'assistant', 'result']);
    expect(results[0]).toMatchObject({ cw_history: true, cw_cost_absent: true, cost_unknown: true, num_turns: 2, duration_ms: 20_000, usage: { input_tokens: 14, cache_read_input_tokens: 5000, cache_creation_input_tokens: 5100, output_tokens: 340 } });
    expect(results[1]).toMatchObject({ cw_history: true, num_turns: 1, duration_ms: 27_100, total_cost_usd: 1.09, usage: { input_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 211_000, output_tokens: 1600 } });
    expect(results[1].cw_cost_absent).toBeUndefined();
    expect(results[1].uuid).toBe('cw-turn-u2');
  });
  it('the turn in flight gets none: the conversation runs here, or its last answer stopped for a tool and nothing recorded it', () => {
    expect(withTurnStats(convo, [], { live: true }).filter((m) => m.type === 'result')).toHaveLength(1);
    const cut = convo.slice(0, 2);
    expect(withTurnStats(cut, []).filter((m) => m.type === 'result')).toHaveLength(0);
  });
  it('retries are not turns; one API call split into several entries counts once', () => {
    const split = [user('u1', T(0)), answer('a1', T(0, 1), 'm1', 'end_turn', { input_tokens: 5, output_tokens: 9 }), answer('a1b', T(0, 2), 'm1', 'end_turn', { input_tokens: 5, output_tokens: 20 })];
    const out = withTurnStats(split, [row(T(0, 3), { error: 'retry 529 overloaded', model: '' })]);
    const r = out.find((m) => m.type === 'result');
    expect(r).toMatchObject({ num_turns: 1, usage: { input_tokens: 5, output_tokens: 20 } });
    // an endpoint that reports no cache fields: none on the line either (0 % would claim it missed)
    expect('cache_read_input_tokens' in r.usage).toBe(false);
  });
  it('nothing a person typed: the messages as they were', () => {
    const only = [answer('a1', T(0), 'm1', 'end_turn', { input_tokens: 1, output_tokens: 1 })];
    expect(withTurnStats(only, [])).toBe(only);
  });
});

describe('pageOf: the newest page of a long conversation', () => {
  const big = 'x'.repeat(1000);
  const turn = (n: number) => [user(`u${n}`, T(n), big), answer(`a${n}`, T(n, 1), `m${n}`, 'end_turn', { input_tokens: 1, output_tokens: 1 }, [{ type: 'text', text: big }])];
  const msgs = [...turn(1), ...turn(2), ...turn(3), ...turn(4)];
  /** room for two turns, not three */
  const two = msgs.slice(4).reduce((n, m) => n + JSON.stringify(m).length, 0) + 10;
  it('all of it when it fits', () => {
    expect(pageOf(msgs, undefined, 1e9)).toEqual({ messages: msgs });
  });
  it('whole turns within the budget, then the page before it from the cursor, to the start', () => {
    const p1 = pageOf(msgs, undefined, two);
    expect(p1.messages.map((m) => m.uuid)).toEqual(['u3', 'a3', 'u4', 'a4']);
    expect(p1.next).toBe('4:u3');
    const p2 = pageOf(msgs, p1.next, two);
    expect(p2.messages.map((m) => m.uuid)).toEqual(['u1', 'a1', 'u2', 'a2']);
    expect(p2.next).toBeUndefined();
  });
  it('the cursor finds its message again when the list before it changed', () => {
    const p1 = pageOf(msgs, undefined, two);
    const shifted = [user('u0', T(0)), ...msgs];
    expect(pageOf(shifted, p1.next, 1e9).messages.map((m) => m.uuid)).toEqual(['u0', 'u1', 'a1', 'u2', 'a2']);
  });
  it('a cursor that finds nothing gives nothing older — never the newest page again', () => {
    for (const bad of ['abc', '-3:', '999999:nope', '2:nope', '999999:']) expect(pageOf(msgs, bad, 1e9), bad).toEqual({ messages: [] });
  });
  it('a newest turn over the budget: the whole turn (up to 4×), else from the start of an API call', () => {
    const long = [...turn(1), user('u2', T(2)), answer('a2', T(2, 1), 'm2', 'tool_use', { input_tokens: 1, output_tokens: 1 }, [{ type: 'text', text: big }]), toolResult('r2', T(2, 2)), answer('a2b', T(2, 3), 'm2b', 'end_turn', { input_tokens: 1, output_tokens: 1 }, [{ type: 'text', text: big }])];
    expect(pageOf(long, undefined, 1500).messages[0].uuid).toBe('u2');
    const huge = [...turn(1), user('u2', T(2)), ...Array.from({ length: 12 }, (_, i) => [answer(`a${i}`, T(2, i), `m${i}`, 'tool_use', { input_tokens: 1, output_tokens: 1 }, [{ type: 'text', text: big }]), toolResult(`r${i}`, T(2, i))]).flat()];
    const p = pageOf(huge, undefined, 2500);
    expect(p.messages[0].type).toBe('assistant');
    expect(p.messages.length).toBeLessThan(huge.length);
    expect(p.next).toBeDefined();
  });
});
