import { describe, expect, it } from 'vitest';
import { GROK_CLI_BASE, XAI_CLIENT_ID, ssoFrom, ssoToGrokTokens } from './grok-sso.js';
import { loginDef, validateLoginDefs } from './oauth-registry.js';
import { refreshProviderCredential } from './provider-login.js';

describe('grok sso cookie', () => {
  it('takes the bare value, sso=…, or a whole Cookie header', () => {
    expect(ssoFrom('abc.DEF-1')).toBe('abc.DEF-1');
    expect(ssoFrom('Cookie: x=1; sso=tok; sso-rw=tok')).toBe('tok');
    expect(ssoFrom('sso-rw=rw')).toBe('rw');
    expect(ssoFrom('')).toBe('');
  });
});

/** A fake xAI: accounts page, device code, verify → consent page, approve → done, then the token after one pending. */
function fakeXai(o: { signedOut?: boolean } = {}) {
  const seen: { url: string; method: string; cookie?: string; body?: string }[] = [];
  let polls = 0;
  const res = (status: number, body = '', headers: Record<string, string> = {}) => new Response(body, { status, headers });
  const f = (async (url: string, init: any = {}) => {
    seen.push({ url, method: init.method ?? 'GET', cookie: init.headers?.cookie, body: init.body });
    const u = new URL(url);
    if (u.pathname === '/sign-in') return res(200, 'sign in');
    if (u.hostname === 'accounts.x.ai') return o.signedOut ? res(302, '', { location: 'https://accounts.x.ai/sign-in' }) : res(200, '<html>account</html>', { 'set-cookie': 'xsess=1; Domain=x.ai; Path=/' });
    if (u.pathname === '/oauth2/device/code') return res(200, JSON.stringify({ device_code: 'DC', user_code: 'UC-1', verification_uri_complete: 'https://auth.x.ai/device?user_code=UC-1', interval: 1, expires_in: 600 }));
    if (u.pathname === '/device') return res(200, 'device page');
    if (u.pathname === '/oauth2/device/verify') return res(303, '', { location: 'https://auth.x.ai/consent?x=1' });
    if (u.pathname === '/consent') return res(200, '<form><input type="hidden" name="consent_token" value="CT9"></form>');
    if (u.pathname === '/oauth2/device/approve') return res(302, '', { location: 'https://auth.x.ai/done' });
    if (u.pathname === '/done') return res(200, 'done');
    if (u.pathname === '/oauth2/token') {
      const p = new URLSearchParams(init.body);
      if (p.get('grant_type') === 'refresh_token') return res(200, JSON.stringify({ access_token: 'A2', expires_in: 3600 }));
      return ++polls === 1 ? res(400, JSON.stringify({ error: 'authorization_pending' })) : res(200, JSON.stringify({ access_token: 'A1', refresh_token: 'R1', expires_in: 21600 }));
    }
    return res(404);
  }) as unknown as typeof fetch;
  return { f, seen };
}

describe('sso → Grok CLI tokens', () => {
  it('walks the device authorization with the cookie and returns the tokens', async () => {
    const { f, seen } = fakeXai();
    const t = await ssoToGrokTokens('sso=S1', { fetch: f, sleep: async () => {}, now: () => 1000 });
    expect(t).toMatchObject({ accessToken: 'A1', refreshToken: 'R1', expiresAt: 1000 + 21600_000 });
    expect(seen[0].cookie).toBe('sso=S1; sso-rw=S1');
    // a Domain=x.ai cookie set by accounts.x.ai rides along to auth.x.ai
    expect(seen.find((s) => s.url.endsWith('/oauth2/device/code'))?.cookie).toContain('xsess=1');
    const approve = seen.find((s) => s.url.endsWith('/oauth2/device/approve'))!;
    expect(new URLSearchParams(approve.body).get('consent_token')).toBe('CT9');
    expect(new URLSearchParams(seen.find((s) => s.url.endsWith('/oauth2/device/code'))!.body).get('client_id')).toBe(XAI_CLIENT_ID);
  });

  it('a signed-out cookie says so', async () => {
    const { f } = fakeXai({ signedOut: true });
    await expect(ssoToGrokTokens('sso=bad', { fetch: f, sleep: async () => {} })).rejects.toThrow(/sso cookie/);
  });
});

describe('the Grok login', () => {
  it('is a device-code login (plus the cookie paste) onto the CLI endpoint, chat completions with the CLI identity', () => {
    const d = loginDef('grok')!;
    expect(d.available).toBe(true);
    expect(d.device?.clientId).toBe(XAI_CLIENT_ID);
    expect(d.paste?.convert).toBe('grok-sso');
    expect(d.account).toMatchObject({ protocol: 'openai', baseUrl: GROK_CLI_BASE, chatPath: '/chat/completions', credentialKind: 'oauth', usable: true });
    expect(d.account?.headers?.['X-XAI-Token-Auth']).toBe('xai-grok-cli');
    expect(validateLoginDefs()).toEqual([]);
  });

  it('refreshes at the device login\'s token endpoint', async () => {
    const { f, seen } = fakeXai();
    const r = await refreshProviderCredential(f, 'grok', { kind: 'oauth', accessToken: 'A1', refreshToken: 'R1', expiresAt: 0 }, 5000);
    expect(r).toMatchObject({ accessToken: 'A2', refreshToken: 'R1', expiresAt: 5000 + 3600_000 });
    expect(new URLSearchParams(seen[0].body).get('client_id')).toBe(XAI_CLIENT_ID);
  });
});

describe('curl -i output', () => {
  it('skips a proxy CONNECT head and 100 Continue, keeps every Set-Cookie', async () => {
    const { parseCurlOutput } = await import('./grok-sso.js');
    const raw = 'HTTP/1.1 200 Connection established\r\n\r\nHTTP/1.1 100 Continue\r\n\r\nHTTP/2 307\r\nlocation: /sign-in\r\nset-cookie: a=1; Path=/\r\nset-cookie: b=2; Path=/\r\n\r\nbody';
    const r = parseCurlOutput(raw)!;
    expect(r.status).toBe(307);
    expect(r.headers.get('location')).toBe('/sign-in');
    expect(r.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/']);
    expect(r.body).toBe('body');
    expect(parseCurlOutput('garbage')).toBeNull();
  });
});
