// `claude auth status` reads the credentials file: a token the server has revoked, or one that expired and could not be
// refreshed, still says loggedIn: true — the page showed the account as fine while every turn failed (2026-11-05 user
// report: 「登录过期了，这里是不会显示的，有时候就是卡着了」). What the conversations on the own login answer is the
// real signal: an auth failure marks the account expired, a turn that went through clears it.

const AUTH_TEXT = /oauth (?:access )?token (?:has )?(?:expired|been revoked)|token has been revoked|invalid authentication credentials|authentication_error|not logged in|please run \/login|invalid bearer token|\b401\b.*(?:auth|token|credential)/i;

export type AuthSignal = { kind: 'bad'; message: string } | { kind: 'ok' } | null;

const textOf = (c: unknown): string => typeof c === 'string' ? c : Array.isArray(c) ? c.map((b: any) => (typeof b?.text === 'string' ? b.text : '')).join(' ') : '';

/** One SDK message of a conversation on the own Claude login → whether it says the login is broken or working. */
export function authSignal(m: any): AuthSignal {
  if (!m || typeof m !== 'object') return null;
  if (m.type === 'assistant') {
    const text = textOf(m.message?.content);
    if (m.error === 'authentication_failed' || (m.isApiErrorMessage && AUTH_TEXT.test(text))) return { kind: 'bad', message: text.slice(0, 300) || 'authentication_failed' };
    return null;
  }
  if (m.type === 'result') {
    const text = typeof m.result === 'string' ? m.result : '';
    if (m.is_error && (m.api_error_status === 401 || AUTH_TEXT.test(text) || (Array.isArray(m.errors) && m.errors.some((e: unknown) => AUTH_TEXT.test(String(e)))))) {
      return { kind: 'bad', message: (text || (Array.isArray(m.errors) ? m.errors.join(' ') : '')).slice(0, 300) || '401' };
    }
    // a turn that reached the model and got an answer: the login works
    if (!m.is_error && m.subtype === 'success') return { kind: 'ok' };
  }
  return null;
}
