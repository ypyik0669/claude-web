import { describe, expect, it } from 'vitest';
import { authSignal } from './auth-signal.js';

describe('authSignal (own-login conversations → is the Claude login broken?)', () => {
  it('an auth failure in the stream marks it broken', () => {
    expect(authSignal({ type: 'assistant', error: 'authentication_failed', message: { content: [{ type: 'text', text: 'Failed to authenticate.' }] } })?.kind).toBe('bad');
    expect(authSignal({ type: 'assistant', isApiErrorMessage: true, message: { content: [{ type: 'text', text: 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth access token has been revoked."}}' }] } })).toMatchObject({ kind: 'bad' });
    expect(authSignal({ type: 'result', is_error: true, subtype: 'success', result: 'OAuth token has expired. Please obtain a new token or refresh your existing token.' })?.kind).toBe('bad');
    expect(authSignal({ type: 'result', is_error: true, subtype: 'error_during_execution', api_error_status: 401, result: '' })?.kind).toBe('bad');
    expect(authSignal({ type: 'result', is_error: true, subtype: 'success', result: 'Not logged in · Please run /login' })?.kind).toBe('bad');
  });
  it('a turn that went through clears it; other errors say nothing', () => {
    expect(authSignal({ type: 'result', is_error: false, subtype: 'success', result: 'done' })).toEqual({ kind: 'ok' });
    expect(authSignal({ type: 'result', is_error: true, subtype: 'success', result: 'API Error: 529 overloaded' })).toBeNull();
    expect(authSignal({ type: 'result', is_error: true, subtype: 'error_max_turns' })).toBeNull();
    expect(authSignal({ type: 'assistant', message: { content: [{ type: 'text', text: 'the token has been revoked in our docs' }] } })).toBeNull();
    expect(authSignal(null)).toBeNull();
  });
});
