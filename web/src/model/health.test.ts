import { describe, expect, it } from 'vitest';
import { classifyError, compactionNotice, deriveStall, STALL_NO_MODEL_MS, STALL_QUIET_MS } from './health';

describe('classifyError', () => {
  it.each([
    [{ error: 'rate_limit' }, 'throttled'],
    [{ status: 429 }, 'throttled'],
    [{ text: 'Too many requests' }, 'throttled'],
    [{ rateLimitStatus: 'rejected' }, 'quota'],
    [{ terminalReason: 'blocking_limit' }, 'quota'],
    [{ error: 'billing_error' }, 'quota'],
    // a relay account out of money (seen on real relays): not a window that resets
    [{ status: 403, text: 'API Error: 403 {"error":{"code":"INSUFFICIENT_BALANCE","message":"Insufficient account balance"}}' }, 'balance'],
    [{ status: 402, text: '402 {"error":{"message":"Insufficient balance"}}' }, 'balance'],
    [{ text: '用户余额不足' }, 'balance'],
    [{ text: 'Your credit balance is too low to access the Anthropic API' }, 'balance'],
    [{ error: 'authentication_failed' }, 'credential'],
    [{ status: 401, text: 'API Error: 401' }, 'credential'],
    [{ terminalReason: 'prompt_too_long' }, 'context'],
    [{ text: 'prompt is too long: 210000 tokens' }, 'context'],
    [{ error: 'max_output_tokens' }, 'output_cap'],
    [{ error: 'overloaded' }, 'server'],
    [{ status: 503 }, 'server'],
    [{ status: null, text: 'fetch failed' }, 'network'],
    [{ text: 'ECONNRESET' }, 'network'],
    [{ text: 'API Error: Connection lost before a response was produced. Try again.' }, 'network'],
    // a stream broken halfway (a provider's turn ends with it: no non-streaming re-send, 2026-11-17)
    [{ text: 'API Error: Content block not found' }, 'stream'],
    [{ text: 'API Error: Stream idle timeout - partial response received' }, 'stream'],
    [{ text: 'API Error: The response stream was malformed and no response was produced. Try again.' }, 'stream'],
    [{ status: null, text: 'Error streaming (non-streaming fallback disabled): event referenced an unstarted content block' }, 'stream'],
    [{ terminalReason: 'aborted_streaming' }, 'aborted'],
    [{ terminalReason: 'api_error' }, 'server'],
    [{}, 'unknown'],
  ] as const)('%o → %s', (sig, kind) => {
    expect(classifyError(sig as any)).toBe(kind);
  });
  it('quota beats throttled when both signals are present', () => {
    expect(classifyError({ status: 429, rateLimitStatus: 'rejected' })).toBe('quota');
  });
});

describe('deriveStall', () => {
  const t0 = 1_000_000;
  it('waiting wins', () => {
    expect(deriveStall({ state: 'waiting', now: t0 })).toEqual({ kind: 'waiting' });
  });
  it('idle → null', () => {
    expect(deriveStall({ state: 'idle', now: t0, lastEventAt: 0 })).toBeNull();
  });
  it('compacting', () => {
    expect(deriveStall({ state: 'running', now: t0, compacting: true })).toEqual({ kind: 'compacting' });
  });
  it('running tool with elapsed', () => {
    expect(deriveStall({ state: 'running', now: t0 + 7000, runningTool: { name: 'Bash', since: t0, elapsed: 7 }, lastEventAt: t0 + 6000 })).toEqual({ kind: 'tool', tool: 'Bash', seconds: 7 });
  });
  it('quiet after 15s without events', () => {
    expect(deriveStall({ state: 'running', now: t0 + STALL_QUIET_MS - 1, lastEventAt: t0 })).toBeNull();
    expect(deriveStall({ state: 'running', now: t0 + STALL_QUIET_MS, lastEventAt: t0 })).toEqual({ kind: 'quiet', seconds: 15 });
  });
  it('no model call for 3 minutes (and no tool running)', () => {
    const r = deriveStall({ state: 'running', now: t0 + STALL_NO_MODEL_MS, lastEventAt: t0 + STALL_NO_MODEL_MS - 1000, lastModelCallAt: t0 });
    expect(r).toEqual({ kind: 'no_model', minutes: 3, seconds: 180 });
  });
  it('a turn the model never answered: counted from the turn start (an upstream that never replies used to show only a timer)', () => {
    expect(deriveStall({ state: 'running', now: t0 + STALL_NO_MODEL_MS - 1, turnStartedAt: t0, lastEventAt: t0 + STALL_NO_MODEL_MS - 1 })).toBeNull();
    expect(deriveStall({ state: 'running', now: t0 + STALL_NO_MODEL_MS, turnStartedAt: t0, lastEventAt: t0 + 5000 })).toEqual({ kind: 'no_reply', minutes: 3, seconds: 180 });
  });
  it("a previous turn's model call does not count against a new turn, nor for it", () => {
    const start = t0 + 10 * 60_000;
    // the last model call was 10 minutes ago, in the previous turn: a fresh turn is not "stuck"
    expect(deriveStall({ state: 'running', now: start + 5000, turnStartedAt: start, lastEventAt: start + 4000, lastModelCallAt: t0 })).toBeNull();
    // …and it does not hide a new turn that never got a reply either
    expect(deriveStall({ state: 'running', now: start + STALL_NO_MODEL_MS, turnStartedAt: start, lastEventAt: start + 1000, lastModelCallAt: t0 })).toMatchObject({ kind: 'no_reply', minutes: 3 });
    // once the model answered in this turn, the usual rule
    expect(deriveStall({ state: 'running', now: start + 60_000 + STALL_NO_MODEL_MS, turnStartedAt: start, lastEventAt: start + 60_000 + STALL_NO_MODEL_MS - 1000, lastModelCallAt: start + 60_000 })).toMatchObject({ kind: 'no_model', minutes: 3 });
  });
});

describe('compactionNotice', () => {
  it('percent freed', () => {
    expect(compactionNotice({ trigger: 'auto', pre_tokens: 120_000, post_tokens: 30_000 })).toBe('上下文已自动压缩 · 释放 75%（120K → 30K）');
  });
  it('manual without post', () => {
    expect(compactionNotice({ trigger: 'manual', pre_tokens: 5_000 })).toBe('上下文已压缩（5K tok）');
  });
});

describe('an empty text block in the history', () => {
  it('is its own kind (the server repairs it; a retry goes through), not 未知错误', async () => {
    const { classifyError, ERROR_LABEL } = await import('./health');
    expect(classifyError({ status: 400, text: 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.18.content.1.text: cache_control cannot be set for empty text blocks"}}' })).toBe('history');
    expect(classifyError({ text: 'messages: text content blocks must be non-empty' })).toBe('history');
    // another vendor's blank thinking, the conversation switched to Claude (2026-10-19)
    expect(classifyError({ status: 400, text: 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.179.content.0.thinking: each thinking block must contain non-whitespace thinking"},"request_id":"req_011CgBFTYeFCxNiPHoaRoY5U"}' })).toBe('history');
    // …and its unsigned thinking (the next real turn on Opus)
    expect(classifyError({ status: 400, text: 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.3.content.0: Invalid `signature` in `thinking` block"},"request_id":"req_011CgBgGgwBErAmFwvT6i2cw"}' })).toBe('history');
    expect(ERROR_LABEL.history).toBe('对话记录有误');
  });
});
