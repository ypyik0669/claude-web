// Outbound proxy. User report (2026-09-30): "挂了梯子，但是还是连接不上，没有开全局" — the provider test answered 403
// "Access from this region requires trusted account access". A ladder in rule / PAC mode (Clash, v2rayN…) only sets the
// *system* proxy: browsers follow it, Node never does (fetch and node:http ignore it; HTTP(S)_PROXY counts only when
// NODE_USE_ENV_PROXY is set before start), so this server's own requests — provider tests, model lists, usage, IM, the
// cache shim and the model gateway — and every CLI it starts (ccb, Codex, Gemini CLI) went out directly.
//
// Setting `network.proxy` (meta.json): 'system' (default) = the HTTP(S)_PROXY this process was started with, else the
// system proxy (Windows: Internet Settings, a PAC file's first PROXY; macOS: scutil) — used only while it accepts a
// connection (a crashed ladder leaves its setting behind); 'off' = direct, even when the environment names one; an
// http(s) URL = that proxy. Applied three ways: process.env (children inherit HTTP(S)_PROXY plus a NO_PROXY with
// loopback and the LAN), the global undici dispatcher (this process's fetch), and `proxyAgentFor()` for node:http / ws.
// Nothing polls: `refresh()` looks again only when its last look is over a minute old, and callers about to go out
// (a session start, a provider test, an IM start, a terminal) await it.
import { execFile } from 'node:child_process';
import net from 'node:net';
import type http from 'node:http';
import { Agent, Dispatcher, ProxyAgent, setGlobalDispatcher } from 'undici';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { ProxyStatus } from '../protocol.js';

type Env = Record<string, string | undefined>;

export type ProxySource = NonNullable<ProxyStatus['source']>;

export type { ProxyStatus };

/** Never through a proxy: loopback, the LAN (incl. Tailscale's 100.64/10), mDNS names. Also written into children's NO_PROXY. */
export const LOCAL_NO_PROXY = ['localhost', '127.0.0.1', '::1', '.local', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10'];

const PROXY_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'] as const;
const NO_PROXY_KEYS = ['NO_PROXY', 'no_proxy'] as const;
const RECHECK_MS = 60_000;

/** `host:port` or a URL → `http(s)://host:port` (userinfo kept only when `keepAuth`); SOCKS / other schemes → null. */
export function normalizeProxyUrl(raw: string, keepAuth = false): string | null {
  const t = raw.trim();
  if (!t) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `http://${t}`;
  let u: URL;
  try { u = new URL(withScheme); } catch { return null; }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname) return null;
  const auth = keepAuth && (u.username || u.password) ? `${u.username}${u.password ? `:${u.password}` : ''}@` : '';
  return `${u.protocol}//${auth}${u.host}`;
}

/** The password in a proxy URL replaced — for the UI and logs. */
export function maskProxy(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!u.username && !u.password) return `${u.protocol}//${u.host}`;
    return `${u.protocol}//${u.username ? decodeURIComponent(u.username) : ''}${u.password ? ':***' : ''}@${u.host}`;
  } catch { return url; }
}

/** Windows ProxyServer: `host:port`, a URL, or per scheme `http=h:p;https=h:p;socks=h:p` (SOCKS is no use here). */
export function parseProxyServer(v: string): string | null {
  const s = v.trim();
  if (!s) return null;
  if (!s.includes('=')) return normalizeProxyUrl(s.split(';')[0]);
  const parts = new Map<string, string>();
  for (const p of s.split(';')) {
    const i = p.indexOf('=');
    if (i > 0 && p.slice(i + 1).trim()) parts.set(p.slice(0, i).trim().toLowerCase(), p.slice(i + 1).trim());
  }
  const pick = parts.get('https') ?? parts.get('http');
  return pick ? normalizeProxyUrl(pick) : null;
}

/** `reg query <key>` output → value name → data (`0x1` for DWORDs, '' for empty strings). */
export function parseRegValues(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s+(\S+)\s+REG_\w+(?:\s+(.*?))?\s*$/.exec(line);
    if (m) out[m[1]] = m[2] ?? '';
  }
  return out;
}

/** The first HTTP proxy a PAC script hands out (`PROXY h:p` / `HTTPS h:p`). A heuristic — the script is not run. */
export function pacProxy(text: string): string | null {
  for (const m of text.matchAll(/\b(PROXY|HTTPS|HTTP)\s+(\[[0-9a-fA-F:.]+\]:\d{1,5}|[A-Za-z0-9.-]+:\d{1,5})/g)) {
    const u = normalizeProxyUrl(m[2]);
    if (u) return m[1] === 'HTTPS' ? u.replace(/^http:/, 'https:') : u;
  }
  return null;
}

/** Windows ProxyOverride (`localhost;127.*;*.corp.com;<local>`) → NO_PROXY entries (numeric wildcards are in LOCAL_NO_PROXY). */
export function overrideNoProxy(v: string): string[] {
  const out: string[] = [];
  for (const raw of v.split(';')) {
    const s = raw.trim();
    if (!s || s === '<local>' || /^[\d.*]+$/.test(s)) continue;
    if (s.startsWith('*.')) out.push(s.slice(1));
    else if (!s.includes('*')) out.push(s);
  }
  return out;
}

/** `scutil --proxy` (macOS) → the HTTPS (else HTTP) proxy, the PAC URL, the exceptions. */
export function parseScutil(out: string): { url: string | null; pacUrl: string | null; noProxy: string[] } {
  const kv: Record<string, string> = {};
  const exceptions: string[] = [];
  let inList = false;
  for (const line of out.split(/\r?\n/)) {
    const t = line.trim();
    if (/^ExceptionsList\s*:\s*<array>/.test(t)) { inList = true; continue; }
    if (inList) {
      if (t.startsWith('}')) { inList = false; continue; }
      const m = /^\d+\s*:\s*(.+)$/.exec(t);
      if (m) exceptions.push(m[1].trim());
      continue;
    }
    const m = /^(\w+)\s*:\s*(.*)$/.exec(t);
    if (m) kv[m[1]] = m[2].trim();
  }
  const pick = (p: 'HTTPS' | 'HTTP') => (kv[`${p}Enable`] === '1' && kv[`${p}Proxy`] && kv[`${p}Port`] ? normalizeProxyUrl(`${kv[`${p}Proxy`]}:${kv[`${p}Port`]}`) : null);
  const noProxy = exceptions.flatMap((e) => (e.startsWith('*.') ? [e.slice(1)] : e.includes('*') || /^[\d./]+$/.test(e) ? [] : [e]));
  return { url: pick('HTTPS') ?? pick('HTTP'), pacUrl: kv.ProxyAutoConfigEnable === '1' ? kv.ProxyAutoConfigURLString || null : null, noProxy };
}

/** The proxy named by the environment (https first), if it is one we can use. */
export function envProxy(env: Env): string | null {
  const raw = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy;
  return raw ? normalizeProxyUrl(raw, true) : null;
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
}

function inCidr(ip: string, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  if (net.isIPv4(ip) && net.isIPv4(base) && bits >= 0 && bits <= 32) {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
  }
  return false;
}

const isLocalIp = (ip: string) => {
  if (net.isIPv4(ip)) return ip.startsWith('127.') || ip.startsWith('169.254.') || LOCAL_NO_PROXY.some((e) => e.includes('/') && inCidr(ip, e));
  const v = ip.toLowerCase();
  return v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith('::ffff:127.');
};

/** Whether `target` goes direct: loopback / LAN / `.local` always, then NO_PROXY-style entries (`*`, hosts, `.domain`, CIDR, `:port`). */
export function bypasses(target: URL | string, noProxy: string[]): boolean {
  let u: URL;
  try { u = typeof target === 'string' ? new URL(target) : target; } catch { return true; }
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (net.isIP(host) && isLocalIp(host)) return true;
  const port = u.port || (u.protocol === 'https:' || u.protocol === 'wss:' ? '443' : '80');
  for (const raw of noProxy) {
    let e = raw.trim().toLowerCase();
    if (!e) continue;
    if (e === '*') return true;
    let ePort = '';
    const m = /^(\[.*\]|[^:]+):(\d+)$/.exec(e);
    if (m) { e = m[1].replace(/^\[|\]$/g, ''); ePort = m[2]; }
    if (ePort && ePort !== port) continue;
    if (e.includes('/')) { if (net.isIP(host) && inCidr(host, e)) return true; continue; }
    if (e.startsWith('*.')) e = e.slice(1);
    if (e.startsWith('.')) { if (host.endsWith(e) || host === e.slice(1)) return true; continue; }
    if (host === e || host.endsWith(`.${e}`)) return true;
  }
  return false;
}

/** NO_PROXY lists merged, first spelling of each entry kept. */
export function mergeNoProxy(...lists: (string | string[] | undefined)[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of lists) {
    for (const e of (Array.isArray(l) ? l : (l ?? '').split(',')).map((x) => x.trim()).filter(Boolean)) {
      if (seen.has(e.toLowerCase())) continue;
      seen.add(e.toLowerCase());
      out.push(e);
    }
  }
  return out.join(',');
}

export interface SystemProxy { url: string; noProxy: string[]; source: 'system' | 'pac' }

/** The setting as stored → what it means. Throws on an address that is not an http(s) proxy. */
export function parseProxySetting(v: unknown): { mode: 'system' } | { mode: 'off' } | { mode: 'custom'; url: string } {
  if (v === undefined || v === null || v === '' || v === 'system') return { mode: 'system' };
  if (v === 'off') return { mode: 'off' };
  if (typeof v !== 'string') throw new Error('代理设置无效');
  if (/^socks/i.test(v.trim())) throw new Error('暂不支持 SOCKS 代理：请填梯子的 HTTP 代理端口（Clash 的混合端口也可以）');
  const url = normalizeProxyUrl(v, true);
  if (!url) throw new Error('代理地址无效：填 http://127.0.0.1:7890 这样的地址');
  return { mode: 'custom', url };
}

export interface ProxyDeps {
  env: Env;
  platform: NodeJS.Platform;
  /** The system proxy (Windows Internet Settings / macOS scutil), or null. */
  detect: () => Promise<{ proxy: SystemProxy | null; note?: string }>;
  /** Whether the proxy accepts a TCP connection. */
  reachable: (url: string) => Promise<boolean>;
  /** Called with the dispatcher state whenever it changes. */
  onDispatcher?: (via: string | null, noProxy: string[]) => void;
}

/**
 * Decides, applies and remembers. One per process (`proxy` below); tests build their own with fake deps and a
 * plain object as the environment.
 */
export class ProxyManager {
  private readonly baseline: Env;
  private setting: () => unknown = () => undefined;
  private state: ProxyStatus = { setting: 'system', active: null, checkedAt: 0 };
  private noProxy: string[] = [...LOCAL_NO_PROXY];
  private inflight: Promise<ProxyStatus> | null = null;
  private agents = new Map<string, HttpsProxyAgent<string>>();

  constructor(private readonly d: ProxyDeps) {
    this.baseline = Object.fromEntries([...PROXY_KEYS, ...NO_PROXY_KEYS].map((k) => [k, d.env[k]]));
  }

  configure(setting: () => unknown) { this.setting = setting; }

  status(): ProxyStatus { return this.state; }

  /** The proxy URL in use (with credentials), or null. */
  get url(): string | null { return this.activeUrl; }
  private activeUrl: string | null = null;

  /** Look again (when the last look is over a minute old, or `force`) and apply. Concurrent callers share one look. */
  refresh(force = false): Promise<ProxyStatus> {
    if (!force && this.state.checkedAt && Date.now() - this.state.checkedAt < RECHECK_MS) return Promise.resolve(this.state);
    if (this.inflight && !force) return this.inflight;
    const run = this.look().finally(() => { if (this.inflight === run) this.inflight = null; });
    this.inflight = run;
    return run;
  }

  private async look(): Promise<ProxyStatus> {
    const now = Date.now();
    let s: ReturnType<typeof parseProxySetting>;
    try { s = parseProxySetting(this.setting()); } catch { s = { mode: 'system' }; } // settings.set refuses bad values; a hand-edited meta.json falls back
    const envUrl = envProxy(this.baseline);
    let url: string | null = null;
    let source: ProxySource | undefined;
    let detected: string | null = null;
    let note: string | undefined;
    let extra: string[] = [];
    if (s.mode === 'custom') {
      url = s.url;
      source = 'setting';
      if (!(await this.d.reachable(url))) note = `连不上 ${maskProxy(url)}：梯子开着吗？`;
    } else if (s.mode === 'system') {
      if (envUrl) {
        url = envUrl;
        source = 'env';
        detected = envUrl;
      } else {
        const found = await this.d.detect().catch(() => ({ proxy: null, note: undefined }));
        note = found.note;
        if (found.proxy) {
          detected = found.proxy.url;
          if (await this.d.reachable(found.proxy.url)) {
            url = found.proxy.url;
            source = found.proxy.source;
            extra = found.proxy.noProxy;
          } else {
            note = `系统代理 ${maskProxy(found.proxy.url)} 连不上（梯子可能已经退出），现在直连`;
          }
        }
      }
    } else {
      detected = envUrl;
    }
    this.apply(s.mode, url, source, extra);
    this.state = { setting: s.mode, ...(s.mode === 'custom' ? { custom: maskProxy(s.url)! } : {}), active: maskProxy(url), ...(source ? { source } : {}), detected: maskProxy(detected), ...(note ? { note } : {}), checkedAt: now };
    return this.state;
  }

  private apply(mode: 'system' | 'off' | 'custom', url: string | null, source: ProxySource | undefined, extra: string[]) {
    const env = this.d.env;
    const set = (k: string, v: string | undefined) => { if (v === undefined) delete env[k]; else env[k] = v; };
    const baseNo = this.baseline.NO_PROXY ?? this.baseline.no_proxy;
    if (url && source !== 'env') {
      for (const k of PROXY_KEYS) set(k, url);
      const no = mergeNoProxy(baseNo, LOCAL_NO_PROXY, extra);
      for (const k of NO_PROXY_KEYS) set(k, no);
    } else if (url) {
      // the environment's own proxy: children keep it as given; loopback / the LAN are added so a CLI reaching the
      // local cache shim or gateway never sends that through it
      for (const k of PROXY_KEYS) set(k, this.baseline[k]);
      const no = mergeNoProxy(baseNo, LOCAL_NO_PROXY);
      for (const k of NO_PROXY_KEYS) set(k, no);
    } else {
      for (const k of PROXY_KEYS) set(k, mode === 'off' ? undefined : this.baseline[k]);
      for (const k of NO_PROXY_KEYS) set(k, this.baseline[k]);
    }
    const noProxy = [...LOCAL_NO_PROXY, ...(baseNo ?? '').split(',').map((x) => x.trim()).filter(Boolean), ...extra];
    const changed = url !== this.activeUrl || (!!url && noProxy.join() !== this.noProxy.join());
    this.activeUrl = url;
    this.noProxy = noProxy;
    if (changed) {
      for (const a of this.agents.values()) a.destroy();
      this.agents.clear();
      this.d.onDispatcher?.(url, noProxy);
    }
  }

  /** An agent for node:http / https / ws requests to `target`, or undefined = direct (use the caller's own agent). */
  agentFor(target: string | URL): http.Agent | undefined {
    const url = this.activeUrl;
    if (!url || bypasses(target, this.noProxy)) return undefined;
    let a = this.agents.get(url);
    if (!a) { a = new HttpsProxyAgent(url, { keepAlive: true }); this.agents.set(url, a); }
    return a;
  }
}

// ---- the real system ----

function run(file: string, args: string[], timeout = 4000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout, encoding: 'utf8' }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

async function fetchPac(url: string): Promise<string | null> {
  // the PAC file is served by the ladder on this machine: always direct
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2500), dispatcher: directAgent() } as RequestInit);
    return r.ok ? (await r.text()).slice(0, 512 * 1024) : null;
  } catch { return null; }
}

export async function detectSystemProxy(platform: NodeJS.Platform = process.platform): Promise<{ proxy: SystemProxy | null; note?: string }> {
  if (platform === 'win32') {
    const out = await run('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings']);
    if (!out) return { proxy: null };
    const v = parseRegValues(out);
    const noProxy = overrideNoProxy(v.ProxyOverride ?? '');
    if (/^0x0*1$/i.test(v.ProxyEnable ?? '')) {
      const url = parseProxyServer(v.ProxyServer ?? '');
      if (url) return { proxy: { url, noProxy, source: 'system' } };
      if (v.ProxyServer) return { proxy: null, note: '系统代理只有 SOCKS：请在这里填梯子的 HTTP 代理地址' };
    }
    if (v.AutoConfigURL) {
      const pac = await fetchPac(v.AutoConfigURL);
      const url = pac ? pacProxy(pac) : null;
      if (url) return { proxy: { url, noProxy, source: 'pac' } };
      return { proxy: null, note: pac ? 'PAC 脚本里没有 HTTP 代理（可能只有 SOCKS）：请在这里填梯子的 HTTP 代理地址' : '读不到系统设置的 PAC 脚本' };
    }
    return { proxy: null };
  }
  if (platform === 'darwin') {
    const out = await run('scutil', ['--proxy']);
    if (!out) return { proxy: null };
    const s = parseScutil(out);
    if (s.url) return { proxy: { url: s.url, noProxy: s.noProxy, source: 'system' } };
    if (s.pacUrl) {
      const pac = await fetchPac(s.pacUrl);
      const url = pac ? pacProxy(pac) : null;
      if (url) return { proxy: { url, noProxy: s.noProxy, source: 'pac' } };
    }
    return { proxy: null };
  }
  return { proxy: null }; // Linux: desktops disagree on where it lives; people there set HTTP(S)_PROXY
}

export function canConnect(url: string, ms = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    let u: URL;
    try { u = new URL(url); } catch { resolve(false); return; }
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    const s = net.connect({ host: u.hostname.replace(/^\[|\]$/g, ''), port });
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.setTimeout(ms, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

let direct: Agent | null = null;
const directAgent = () => (direct ??= new Agent());

/** fetch (this process) routed by origin: bypassed / no proxy → a plain agent, the rest → the proxy. */
class RoutingDispatcher extends Dispatcher {
  via: ProxyAgent | null = null;
  viaUrl: string | null = null;
  noProxy: string[] = [];
  dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    const origin = opts.origin ? String(opts.origin) : '';
    const useDirect = !this.via || !origin || bypasses(origin, this.noProxy);
    return (useDirect ? directAgent() : this.via!).dispatch(opts, handler);
  }
  close(...args: any[]): any { const cb = typeof args[0] === 'function' ? args[0] : null; const p = Promise.all([this.via?.close(), direct?.close()]).then(() => {}); if (cb) { void p.then(() => cb()); return; } return p; }
  destroy(...args: any[]): any { const cb = args.find((a) => typeof a === 'function'); const p = Promise.all([this.via?.destroy(), direct?.destroy()]).then(() => {}); if (cb) { void p.then(() => cb()); return; } return p; }
}

let routing: RoutingDispatcher | null = null;

function setDispatcher(via: string | null, noProxy: string[]) {
  if (!via && !routing) return; // never needed a proxy: leave Node's own dispatcher alone
  if (!routing) { routing = new RoutingDispatcher(); setGlobalDispatcher(routing); }
  if (routing.viaUrl !== via) {
    const old = routing.via;
    routing.via = via ? new ProxyAgent({ uri: via }) : null;
    routing.viaUrl = via;
    void old?.close().catch(() => {});
  }
  routing.noProxy = noProxy;
}

export const proxy = new ProxyManager({
  env: process.env,
  platform: process.platform,
  detect: () => detectSystemProxy(),
  reachable: (u) => canConnect(u),
  onDispatcher: setDispatcher,
});

/** node:http / ws callers: the agent for `target` (a proxy tunnel), or undefined = direct. */
export const proxyAgentFor = (target: string | URL) => proxy.agentFor(target);
