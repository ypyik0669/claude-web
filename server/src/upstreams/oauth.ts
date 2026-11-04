// The mechanics behind generic provider logins: PKCE, a loopback authorization-code receiver, the device-code
// polling loop, and the two post-token exchanges we actually know (GitHub → Copilot; the identity inside an OIDC
// id_token). No module here logs a token; transient tokens only live in memory until the account is encrypted by
// SecretService through AccountStore.
import crypto from 'node:crypto';
import http from 'node:http';
import { tr } from '../i18n/index.js';
import type { DeviceLoginConfig, OAuthLoginConfig } from './oauth-registry.js';

export interface PkcePair { verifier: string; challenge: string }
export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  idToken?: string;
  scope?: string;
  tokenType?: string;
}

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** epoch ms */
  expiresAt: number;
  intervalMs: number;
}

type Fetch = typeof fetch;
const nowMs = () => Date.now();

const base64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** RFC 7636 S256. A caller may pass the verifier (tests / deterministic runs). */
export function createPkce(verifier = base64url(crypto.randomBytes(48))): PkcePair {
  if (verifier.length < 43 || verifier.length > 128) throw new Error('PKCE verifier must be 43–128 characters');
  return { verifier, challenge: base64url(crypto.createHash('sha256').update(verifier).digest()) };
}

export function createState(bytes = 32): string {
  return base64url(crypto.randomBytes(bytes));
}

/** Constant-time comparison for the OAuth state (both sides are our own random strings). */
export function stateMatches(a: string, b: string): boolean {
  if (!a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function authorizeUrl(cfg: OAuthLoginConfig, o: { redirectUri: string; state: string; challenge: string }): string {
  const u = new URL(cfg.authorizationUrl);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('redirect_uri', o.redirectUri);
  u.searchParams.set('scope', cfg.scopes.join(' '));
  u.searchParams.set('state', o.state);
  u.searchParams.set('code_challenge', o.challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  for (const [k, v] of Object.entries(cfg.extraAuthParams ?? {})) u.searchParams.set(k, v);
  return u.toString();
}

const html = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:15px/1.6 system-ui,sans-serif;margin:48px;max-width:560px;color:#222}code{background:#f2f2f2;padding:2px 5px;border-radius:4px}</style>
</head><body><h2>${title}</h2><p>${body}</p></body></html>`;

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export interface LoopbackOptions {
  /** 0 / unset = a random free port (the normal case). */
  port?: number;
  path: string;
  state: string;
  timeoutMs?: number;
  /** 'localhost' when the vendor registered that spelling; the socket still binds 127.0.0.1. */
  host?: string;
}

export interface LoopbackReceiver {
  redirectUri: string;
  /** resolves with the code; rejects on state mismatch, an OAuth error, timeout, or close(). */
  code: Promise<string>;
  close(): Promise<void>;
}

/**
 * One loopback listener for one login. Binds 127.0.0.1 only (random port unless the vendor registered a fixed one),
 * answers the callback with a self-contained page, and never reflects a token into the page or a log.
 */
export async function startLoopbackReceiver(opts: LoopbackOptions): Promise<LoopbackReceiver> {
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  let resolveCode!: (v: string) => void;
  let rejectCode!: (e: Error) => void;
  const code = new Promise<string>((res, rej) => { resolveCode = res; rejectCode = rej; });
  // A cancel before anyone awaits `code` must not become an unhandled rejection.
  code.catch(() => {});

  let settled = false;
  const finish = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); fn(); };
  const timer = setTimeout(() => {
    finish(() => rejectCode(new Error(tr('登录超时（{minutes} 分钟）', { minutes: Math.round(timeoutMs / 60_000) }))));
  }, timeoutMs);
  timer.unref?.();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== opts.path) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }
    const err = url.searchParams.get('error');
    if (err) {
      const desc = url.searchParams.get('error_description') || err;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html(tr('登录没有完成'), escapeHtml(desc)));
      finish(() => rejectCode(new Error(tr('授权被拒绝：{error}', { error: desc.slice(0, 200) }))));
      return;
    }
    const state = url.searchParams.get('state') ?? '';
    if (!stateMatches(state, opts.state)) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(html(tr('登录没有完成'), tr('state 不匹配，已拒绝这次回调。')));
      finish(() => rejectCode(new Error(tr('回调 state 不匹配'))));
      return;
    }
    const c = url.searchParams.get('code') ?? '';
    if (!c) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(html(tr('登录没有完成'), tr('回调里没有授权码。')));
      finish(() => rejectCode(new Error(tr('回调里没有授权码'))));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html(tr('登录完成'), tr('可以关闭这个窗口，回到 claude-web。')));
    finish(() => resolveCode(c));
  });

  const port = opts.port && opts.port > 0 ? opts.port : 0;
  await new Promise<void>((resolve, reject) => {
    const onError = (e: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      reject(new Error(e.code === 'EADDRINUSE' ? tr('端口 {port} 被占用了，关掉占用它的程序再试。', { port: String(port) }) : e.message));
    };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  }).catch((e) => { finish(() => rejectCode(e as Error)); throw e; });

  const address = server.address();
  const realPort = typeof address === 'object' && address ? address.port : port;
  const host = opts.host === 'localhost' ? 'localhost' : '127.0.0.1';
  return {
    redirectUri: `http://${host}:${realPort}${opts.path}`,
    code,
    close: async () => {
      finish(() => rejectCode(new Error(tr('登录已取消'))));
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export interface FormResult { status: number; ok: boolean; json: any; text: string }

export async function postForm(fetchImpl: Fetch, url: string, params: Record<string, string>, headers: Record<string, string> = {}): Promise<FormResult> {
  const body = new URLSearchParams(params).toString();
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', ...headers },
      body,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e: any) {
    throw new Error(tr('连接登录服务失败：{message}', { message: e?.message ?? String(e) }));
  }
  const text = await res.text().catch(() => '');
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* form-encoded error from an older endpoint */ }
  if (!json && text.includes('=')) {
    try { json = Object.fromEntries(new URLSearchParams(text)); } catch { /* not a query string either */ }
  }
  return { status: res.status, ok: res.ok, json, text };
}

const tokenError = (r: FormResult): string => {
  const message = r.json?.error_description || r.json?.error?.message || r.json?.error || r.json?.message || r.text.slice(0, 200) || `HTTP ${r.status}`;
  return String(message).replace(/\s+/g, ' ').slice(0, 240);
};

export function tokensFrom(j: any, now: number): TokenSet {
  const accessToken = j?.access_token ?? j?.accessToken;
  if (typeof accessToken !== 'string' || !accessToken) throw new Error(tr('登录服务没有返回 access_token'));
  const expiresIn = Number(j?.expires_in);
  const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : undefined;
  return {
    accessToken,
    ...(typeof (j?.refresh_token ?? j?.refreshToken) === 'string' ? { refreshToken: j.refresh_token ?? j.refreshToken } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(typeof j?.id_token === 'string' ? { idToken: j.id_token } : {}),
    ...(typeof j?.scope === 'string' ? { scope: j.scope } : {}),
    ...(typeof j?.token_type === 'string' ? { tokenType: j.token_type } : {}),
  };
}

export async function exchangeCode(fetchImpl: Fetch, cfg: OAuthLoginConfig, o: { code: string; redirectUri: string; verifier: string }, now = nowMs()): Promise<TokenSet> {
  const params: Record<string, string> = {
    grant_type: 'authorization_code',
    code: o.code,
    redirect_uri: o.redirectUri,
    client_id: cfg.clientId,
    code_verifier: o.verifier,
    ...(cfg.extraTokenParams ?? {}),
  };
  const headers: Record<string, string> = {};
  if (cfg.clientSecret) {
    if (cfg.tokenAuth === 'basic') headers.authorization = `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}`;
    else params.client_secret = cfg.clientSecret;
  }
  const r = await postForm(fetchImpl, cfg.tokenUrl, params, headers);
  if (!r.ok || r.json?.error) throw new Error(tr('换取令牌失败：{error}', { error: tokenError(r) }));
  return tokensFrom(r.json, now);
}

export async function startDeviceAuthorization(fetchImpl: Fetch, cfg: DeviceLoginConfig, now = nowMs()): Promise<DeviceAuthorization> {
  const r = await postForm(fetchImpl, cfg.deviceAuthorizationUrl, { client_id: cfg.clientId, scope: cfg.scopes.join(' '), ...(cfg.extraTokenParams ?? {}) }, cfg.headers);
  if (!r.ok || !r.json?.device_code || !r.json?.user_code) throw new Error(tr('设备码登录没有开始：{error}', { error: tokenError(r) }));
  const interval = Math.max(1, Number(r.json.interval) || 5);
  const expiresIn = Math.max(30, Number(r.json.expires_in) || 900);
  return {
    deviceCode: String(r.json.device_code),
    userCode: String(r.json.user_code),
    // the complete URI carries the code: one click instead of typing it (GitHub sends none)
    verificationUri: String(r.json.verification_uri_complete ?? r.json.verification_uri ?? r.json.verification_url ?? ''),
    expiresAt: now + expiresIn * 1000,
    intervalMs: interval * 1000,
  };
}

export class DeviceLoginError extends Error {
  constructor(message: string, readonly terminal = true) { super(message); }
}

/**
 * Poll `tokenUrl` until GitHub (or another device-flow vendor) says the user finished. `authorization_pending` keeps
 * waiting; `slow_down` raises the interval as the spec asks; every other OAuth error stops with a readable message.
 */
export async function pollDeviceToken(
  fetchImpl: Fetch,
  cfg: DeviceLoginConfig,
  device: DeviceAuthorization,
  o: { signal?: AbortSignal; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<TokenSet> {
  const now = o.now ?? nowMs;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  }));
  let interval = device.intervalMs;
  while (true) {
    if (o.signal?.aborted) throw new DeviceLoginError(tr('登录已取消'));
    if (now() > device.expiresAt) throw new DeviceLoginError(tr('设备码已过期，请重新开始'));
    await sleep(interval);
    if (o.signal?.aborted) throw new DeviceLoginError(tr('登录已取消'));
    const r = await postForm(fetchImpl, cfg.tokenUrl, {
      client_id: cfg.clientId,
      device_code: device.deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      ...(cfg.clientSecret ? { client_secret: cfg.clientSecret } : {}),
      ...(cfg.extraTokenParams ?? {}),
    }, cfg.headers);
    if (r.ok && !r.json?.error && (r.json?.access_token ?? r.json?.accessToken)) return tokensFrom(r.json, now());
    const error = String(r.json?.error ?? '');
    if (error === 'authorization_pending') continue;
    if (error === 'slow_down') { interval += 5_000; continue; }
    if (error === 'access_denied') throw new DeviceLoginError(tr('登录被拒绝'));
    if (error === 'expired_token') throw new DeviceLoginError(tr('设备码已过期，请重新开始'));
    if (!r.ok && !r.json?.error) throw new DeviceLoginError(tr('设备码登录失败：{error}', { error: tokenError(r) }));
    throw new DeviceLoginError(tr('设备码登录失败：{error}', { error: tokenError(r) }), !['authorization_pending', 'slow_down'].includes(error));
  }
}

/** GitHub OAuth token → the short-lived Copilot token every Copilot client uses. */
export async function exchangeCopilotToken(fetchImpl: Fetch, githubToken: string, headers: Record<string, string> = {}, now = nowMs()): Promise<{ token: string; expiresAt?: number }> {
  let res: Response;
  try {
    res = await fetchImpl('https://api.github.com/copilot_internal/v2/token', {
      headers: { accept: 'application/json', authorization: `Bearer ${githubToken}`, ...headers },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e: any) {
    throw new Error(tr('连接 GitHub 失败：{message}', { message: e?.message ?? String(e) }));
  }
  const text = await res.text().catch(() => '');
  let j: any = null;
  try { j = JSON.parse(text); } catch { /* not json */ }
  const token = j?.token;
  if (!res.ok || typeof token !== 'string' || !token) {
    const message = j?.message || j?.error || text.slice(0, 200) || `HTTP ${res.status}`;
    throw new Error(tr('换取 Copilot 令牌失败：{error}', { error: String(message).slice(0, 240) }));
  }
  const expires = Number(j?.expires_at);
  return { token, ...(Number.isFinite(expires) && expires > 0 ? { expiresAt: expires * 1000 } : {}) };
}

/** Read claims out of an OIDC id_token without verifying it (it came from the token endpoint over TLS). */
export function idTokenClaims(idToken: string | undefined): Record<string, any> {
  if (!idToken) return {};
  const part = idToken.split('.')[1];
  if (!part) return {};
  try {
    const base = part.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(base, 'base64').toString('utf8'));
  } catch { return {}; }
}

export function identityFromIdToken(idToken: string | undefined): { email?: string; accountId?: string } {
  const c = idTokenClaims(idToken);
  const auth = c['https://api.openai.com/auth'] ?? {};
  return {
    ...(typeof c.email === 'string' ? { email: c.email } : {}),
    ...(typeof (auth.chatgpt_account_id ?? c.chatgpt_account_id) === 'string' ? { accountId: auth.chatgpt_account_id ?? c.chatgpt_account_id } : {}),
  };
}

export async function fetchIdentity(fetchImpl: Fetch, url: string, token: string, headers: Record<string, string> = {}): Promise<{ email?: string; name?: string }> {
  try {
    const r = await fetchImpl(url, { headers: { accept: 'application/json', authorization: `Bearer ${token}`, ...headers }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return {};
    const j: any = await r.json().catch(() => null);
    const email = [j?.email, j?.login, j?.preferred_username].find((x) => typeof x === 'string' && x.includes('@')) ?? (typeof j?.login === 'string' ? j.login : undefined);
    return { ...(email ? { email } : {}), ...(typeof j?.name === 'string' ? { name: j.name } : {}) };
  } catch { return {}; }
}
