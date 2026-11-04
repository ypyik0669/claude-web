// Grok: a grok.com sign-in (its `sso` cookie) → the Grok CLI's OAuth tokens, so the account talks to xAI's CLI
// endpoint (cli-chat-proxy.grok.com) with the current models (Grok 4.7 …) and native tool calling, instead of the
// grok.com web chat. The flow is xAI's own device authorization for the Grok CLI client, walked with the cookie the
// way a browser would (accounts.x.ai → device code → verify → consent → token). Protocol read off Wei-Shaw/sub2api
// (pkg/xai/sso_device.go, LGPL-3.0 — reimplemented, not copied) and router-for-me/CLIProxyAPI (MIT).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { tr } from '../i18n/index.js';

export const XAI_ISSUER = 'https://auth.x.ai';
export const XAI_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
export const XAI_SCOPES = ['openid', 'profile', 'email', 'offline_access', 'grok-cli:access', 'api:access'];
export const GROK_CLI_BASE = 'https://cli-chat-proxy.grok.com/v1';
/** cli-chat-proxy refuses clients older than its floor (HTTP 426); the version the Grok CLI ships now */
export const GROK_CLI_VERSION = '1.0.46';
export const GROK_CLI_HEADERS: Record<string, string> = {
  'X-XAI-Token-Auth': 'xai-grok-cli',
  'x-grok-client-version': GROK_CLI_VERSION,
  'x-grok-client-identifier': 'grok-shell',
  'x-authenticateresponse': 'authenticate-response',
  'user-agent': `xai-grok-workspace/${GROK_CLI_VERSION}`,
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

/** The `sso` value out of what the user pasted: the bare value, `sso=…`, or a whole Cookie header. */
export function ssoFrom(raw: string): string {
  let v = String(raw ?? '').trim().replace(/^cookie:\s*/i, '');
  for (const part of v.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && /^(sso|sso-rw)$/i.test(part.slice(0, i).trim())) return part.slice(i + 1).trim();
  }
  if (v.includes(';')) v = v.split(';')[0].trim();
  return /^[\w.\-]+$/.test(v) && v.length < 16_384 ? v : '';
}

const xaiHost = (u: string) => { try { const p = new URL(u); return p.protocol === 'https:' && (p.hostname === 'x.ai' || p.hostname.endsWith('.x.ai')) ? p : null; } catch { return null; } };

/** A cookie jar enough for one walk across *.x.ai: host-only cookies, or a Domain one for the whole site. */
class Jar {
  private items: { name: string; value: string; domain: string; hostOnly: boolean }[] = [];
  set(name: string, value: string, domain: string, hostOnly: boolean) {
    this.items = this.items.filter((c) => !(c.name === name && c.domain === domain));
    if (value) this.items.push({ name, value, domain, hostOnly });
  }
  take(url: URL, setCookies: string[]) {
    for (const sc of setCookies) {
      const [pair, ...attrs] = sc.split(';');
      const i = pair.indexOf('=');
      if (i <= 0) continue;
      const dom = attrs.map((a) => /^\s*domain\s*=\s*(.+)$/i.exec(a)?.[1]?.trim().replace(/^\./, '').toLowerCase()).find(Boolean);
      const expired = attrs.some((a) => /^\s*max-age\s*=\s*0\b/i.test(a));
      this.set(pair.slice(0, i).trim(), expired ? '' : pair.slice(i + 1).trim(), dom ?? url.hostname, !dom);
    }
  }
  header(url: URL): string {
    const h = url.hostname;
    return this.items.filter((c) => (c.hostOnly ? h === c.domain : h === c.domain || h.endsWith(`.${c.domain}`))).sort((a, b) => a.name.localeCompare(b.name)).map((c) => `${c.name}=${c.value}`).join('; ');
  }
}

/**
 * accounts.x.ai sits behind a Cloudflare rule that refuses Node's own TLS (403 to fetch, a normal redirect to curl —
 * checked 2026-11-05), so the cookie walk goes through the system's curl (Windows 10+ and macOS ship one). Only the
 * walk: auth.x.ai's token endpoint and cli-chat-proxy answer Node fine. HTTP(S)_PROXY reaches curl through the env.
 */
export const curlFetch = ((url: string, init: any = {}) => new Promise<Response>((resolve, reject) => {
  const exe = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'curl.exe') : 'curl';
  const args = ['-s', '-i', '--max-time', '30', '-X', String(init.method ?? 'GET')];
  // header names as a browser writes them on HTTP/1.1: Cloudflare refuses `user-agent:` and passes `User-Agent:`
  const canon = (k: string) => k.split('-').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join('-');
  for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) args.push('-H', `${canon(k)}: ${v}`);
  if (init.body !== undefined) args.push('--data-binary', '@-');
  args.push(url);
  const child = spawn(exe, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const out: Buffer[] = [];
  let err = '';
  child.stdout.on('data', (c: Buffer) => out.push(c));
  child.stderr.on('data', (c: Buffer) => { err += c; });
  child.on('error', reject);
  child.stdin.end(init.body ?? undefined);
  child.on('close', (code) => {
    const raw = Buffer.concat(out).toString('utf8');
    if (code !== 0 && !raw) { reject(new Error(`curl ${code}: ${err.trim().slice(0, 200)}`)); return; }
    const parsed = parseCurlOutput(raw);
    if (!parsed) { reject(new Error('curl: no HTTP status')); return; }
    resolve(new Response(parsed.status === 204 || parsed.status === 304 ? null : parsed.body, { status: parsed.status, headers: parsed.headers }));
  });
})) as unknown as typeof fetch;

const STATUS = /^HTTP\/[\d.]+\s+(\d{3})/;

/** `curl -i` output → the final answer: a proxy's "200 Connection established" and any 1xx head come first. */
export function parseCurlOutput(raw: string): { status: number; headers: Headers; body: string } | null {
  let head = '';
  let body = raw;
  for (;;) {
    const m = /\r?\n\r?\n/.exec(body);
    if (!m) { head = body; body = ''; break; }
    head = body.slice(0, m.index);
    body = body.slice(m.index + m[0].length);
    const st = Number(STATUS.exec(head)?.[1] ?? 0);
    const interim = st === 100 || (st === 200 && /connection established/i.test(head));
    if (!interim || !STATUS.test(body)) break;
  }
  const status = Number(STATUS.exec(head)?.[1] ?? 0);
  if (!status) return null;
  const headers = new Headers();
  for (const line of head.split(/\r?\n/).slice(1)) {
    const j = line.indexOf(':');
    if (j > 0) headers.append(line.slice(0, j).trim(), line.slice(j + 1).trim());
  }
  return { status, headers, body };
}

export interface GrokTokens { accessToken: string; refreshToken?: string; idToken?: string; expiresAt?: number; scope?: string }

/**
 * Walk the device authorization with the grok.com cookie and return the CLI's tokens. Throws a sentence the user can
 * act on (signed out, region, a step xAI changed).
 */
export async function ssoToGrokTokens(raw: string, o: { fetch?: typeof fetch; walk?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => number } = {}): Promise<GrokTokens> {
  const f = o.fetch ?? fetch;
  const walk = o.walk ?? (o.fetch ? o.fetch : curlFetch);
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const sso = ssoFrom(raw);
  if (!sso) throw new Error(tr('没认出 sso cookie：粘贴 grok.com 的 sso 值，或整段 Cookie'));
  const jar = new Jar();
  for (const d of ['accounts.x.ai', 'auth.x.ai']) { jar.set('sso', sso, d, true); jar.set('sso-rw', sso, d, true); }

  const step = async (method: 'GET' | 'POST', url: string, form?: Record<string, string>, extra: Record<string, string> = {}) => {
    let cur = url; let m = method; let body = form ? new URLSearchParams(form).toString() : undefined;
    for (let hop = 0; hop <= 8; hop++) {
      const u = xaiHost(cur);
      if (!u) throw new Error(`xAI sign-in went to an unexpected address: ${cur}`);
      const headers: Record<string, string> = { accept: 'application/json, text/html;q=0.9, */*;q=0.8', 'accept-language': 'en-US,en;q=0.9', 'user-agent': UA, ...(hop === 0 ? extra : {}) };
      const cookie = jar.header(u);
      if (cookie) headers.cookie = cookie;
      if (body !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded';
      const r = await walk(cur, { method: m, headers, body, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
      jar.take(u, (r.headers as any).getSetCookie?.() ?? []);
      const text = await r.text().catch(() => '');
      if (r.status < 300 || r.status > 399) return { status: r.status, url: cur, text };
      const loc = r.headers.get('location');
      if (!loc) throw new Error('xAI sign-in: a redirect without a Location');
      cur = new URL(loc, cur).toString();
      // signed out: the sign-in page itself is not needed (and Cloudflare guards it)
      if (/\/sign-(in|up)/.test(new URL(cur).pathname)) return { status: r.status, url: cur, text: '' };
      if (r.status === 303 || ((r.status === 301 || r.status === 302) && m !== 'GET')) { m = 'GET'; body = undefined; }
    }
    throw new Error('xAI sign-in: too many redirects');
  };

  const acc = await step('GET', 'https://accounts.x.ai/');
  if (acc.status === 401 || /sign-in|sign-up/.test(acc.url)) throw new Error(tr('grok.com 的 sso cookie 无效或已过期：在浏览器里重新登录 grok.com 后再复制'));
  if (acc.status >= 400) throw new Error(tr('xAI 账号页打不开（HTTP {status}），可能是所在地区用不了 Grok', { status: acc.status }));

  const dev = await step('POST', `${XAI_ISSUER}/oauth2/device/code`, { client_id: XAI_CLIENT_ID, scope: XAI_SCOPES.join(' ') });
  let d: any; try { d = JSON.parse(dev.text); } catch { d = null; }
  if (dev.status >= 300 || !d?.device_code || !d?.user_code || !xaiHost(String(d.verification_uri_complete ?? ''))) throw new Error(`xAI device code: HTTP ${dev.status} ${dev.text.slice(0, 160)}`);

  const page = await step('GET', d.verification_uri_complete);
  if (page.status >= 400) throw new Error(`xAI device page: HTTP ${page.status}`);
  const ver = await step('POST', `${XAI_ISSUER}/oauth2/device/verify`, { user_code: d.user_code });
  if (ver.status >= 400 || !/consent/.test(ver.url)) throw new Error(`xAI device verify: HTTP ${ver.status} (${ver.url})`);
  const consent = /<input[^>]*name=["']consent_token["'][^>]*>/i.exec(ver.text)?.[0];
  const consentToken = consent ? /value=["']([^"']*)["']/i.exec(consent)?.[1] : undefined;
  const origin = new URL(ver.url);
  const ok = await step('POST', `${XAI_ISSUER}/oauth2/device/approve`, { user_code: d.user_code, action: 'allow', principal_type: 'User', principal_id: '', ...(consentToken ? { consent_token: consentToken } : {}) }, { origin: `${origin.protocol}//${origin.host}`, referer: ver.url });
  if (ok.status >= 400 || !/done/.test(ok.url)) throw new Error(`xAI device approve: HTTP ${ok.status} (${ok.url})`);

  let interval = Math.max(1, Number(d.interval) || 5) * 1000;
  const deadline = now() + Math.min(Math.max(30, Number(d.expires_in) || 1800), 75) * 1000;
  while (now() < deadline) {
    await sleep(interval);
    const t = await f(`${XAI_ISSUER}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': UA },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: XAI_CLIENT_ID, device_code: d.device_code }).toString(),
      signal: AbortSignal.timeout(30_000),
    });
    let j: any = {}; try { j = await t.json(); } catch { /* below */ }
    if (t.ok && j.access_token) {
      return { accessToken: j.access_token, ...(j.refresh_token ? { refreshToken: j.refresh_token } : {}), ...(j.id_token ? { idToken: j.id_token } : {}), expiresAt: now() + (Number(j.expires_in) || 6 * 3600) * 1000, ...(j.scope ? { scope: j.scope } : {}) };
    }
    if (j.error === 'authorization_pending') continue;
    if (j.error === 'slow_down') { interval += 5000; continue; }
    throw new Error(`xAI token: ${j.error_description ?? j.error ?? `HTTP ${t.status}`}`);
  }
  throw new Error('xAI token: timed out');
}
