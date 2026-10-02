import http from 'node:http';
import os from 'node:os';
import dgram from 'node:dgram';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { MetaStore } from '../meta/store.js';
import type { DeviceInfo, RemotePairCode, RemoteStatus } from '../protocol.js';

const PAIR_TTL_MS = 10 * 60_000;
const MAX_TRIES = 5;

/**
 * `tokenHash` (hex sha256 of the device token) is key material: the device's 在外面也能用 room and its keys are
 * derived from it (remote/anywhere/core/keys.ts). Never log it; the diagnostics bundle masks it.
 */
export interface DeviceRecord { id: string; name: string; tokenHash: string; createdAt: number; lastSeenAt: number; ip?: string; ua?: string }

/**
 * LAN / phone access: a second HTTP listener on 0.0.0.0 whose clients authenticate with per-device tokens
 * handed out through a short-lived pairing code (shown as a QR in settings). Device tokens are stored hashed.
 * Events: `changed`; `paired(deviceId)` once a device is added; `revoked(deviceId)` once one is removed (the
 * 在外面也能用 service subscribes / drops that device's room and ends its links).
 */
export class RemoteService extends EventEmitter {
  /** The 在外面也能用 QR address for a new pairing code (AnywhereService sets it); without it there is none. */
  pairUrlHook: ((code: string) => Promise<string | null>) | null = null;
  private server: http.Server | null = null;
  /** every socket the listener accepted, upgraded (WebSocket) ones included: closeAllConnections() skips those */
  private sockets = new Set<Socket>();
  private pair: { code: string; expiresAt: number; tries: number } | null = null;
  private tokenCache = new Map<string, string>(); // token → device id (avoids hashing per request)
  port = 0;
  error = '';
  private primaryIp = '';
  constructor(private meta: MetaStore, private makeServer: () => http.Server, private host = '0.0.0.0') { super(); }

  /** The interface that carries the default route (a UDP connect sends nothing but picks the source address). */
  refreshPrimary(): Promise<string> {
    return new Promise((res) => {
      try {
        const s = dgram.createSocket('udp4');
        const done = (ip: string) => { try { s.close(); } catch { /* ignore */ } if (ip) this.primaryIp = ip; res(ip); };
        s.once('error', () => done(''));
        s.connect(53, '8.8.8.8', () => { try { done(s.address().address); } catch { done(''); } });
        setTimeout(() => done(''), 800).unref();
      } catch { res(''); }
    });
  }

  enabled() { return !!this.meta.settings()['remote.enabled']; }
  /** The listener is up (`port` is then the one it listens on). */
  isRunning() { return !!this.server; }
  configuredPort() { return Number(this.meta.settings()['remote.port'] ?? 3091) || 3091; }

  /** LAN IPv4 addresses (non-internal), best first. */
  addresses(): string[] {
    const out: { ip: string; score: number }[] = [];
    for (const [name, list] of Object.entries(os.networkInterfaces())) for (const i of list ?? []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      const n = name.toLowerCase();
      const score = /virtual|vmware|vbox|hyper-v|docker|wsl|tailscale|zerotier|loopback/.test(n) ? 1 : /wi-?fi|wlan|ethernet|eth|en\d/.test(n) ? 3 : 2;
      out.push({ ip: i.address, score });
    }
    const list = out.sort((a, b) => b.score - a.score).map((x) => x.ip);
    if (this.primaryIp && list.includes(this.primaryIp)) return [this.primaryIp, ...list.filter((ip) => ip !== this.primaryIp)];
    return list;
  }

  async start() {
    if (this.server || !this.enabled()) return;
    const port = this.configuredPort();
    await this.refreshPrimary();
    const srv = this.makeServer();
    const sockets = this.sockets;
    srv.on('connection', (sock) => {
      (sock as any).cwRemote = true;
      sockets.add(sock);
      sock.once('close', () => sockets.delete(sock));
    });
    await new Promise<void>((res) => {
      srv.once('error', (e: any) => { this.error = e.code === 'EADDRINUSE' ? `端口 ${port} 被占用` : e.message; this.server = null; res(); });
      srv.listen(port, this.host, () => { this.server = srv; this.port = (srv.address() as { port: number }).port; this.error = ''; res(); });
    });
    this.emit('changed');
  }

  /**
   * server.close() waits for every open socket; closeAllConnections() only closes HTTP ones — a connected
   * phone's or other machine's WebSocket (upgraded, so no longer the HTTP server's) would hold stop() — and a
   * Ctrl+C / SIGTERM shutdown, or turning remote access off — until that client went away by itself.
   */
  async stop() {
    const s = this.server;
    this.server = null;
    this.port = 0;
    const sockets = this.sockets;
    this.sockets = new Set();
    if (s) {
      await new Promise<void>((r) => {
        s.close(() => r());
        s.closeAllConnections();
        for (const sock of sockets) sock.destroy();
      });
    }
    this.emit('changed');
  }

  async set(patch: { enabled?: boolean; port?: number }) {
    if (patch.port !== undefined) await this.meta.setSetting('remote.port', Math.max(1, Math.min(65535, Math.floor(patch.port))));
    if (patch.enabled !== undefined) await this.meta.setSetting('remote.enabled', !!patch.enabled);
    await this.stop();
    if (this.enabled()) await this.start();
  }

  status(): RemoteStatus {
    return { enabled: this.enabled(), running: !!this.server, port: this.server ? this.port : this.configuredPort(), addresses: this.addresses(), error: this.error, devices: this.devices(), pair: this.pair && this.pair.expiresAt > Date.now() ? { code: this.pair.code, expiresAt: this.pair.expiresAt } : null };
  }

  devices(): DeviceInfo[] {
    return this.meta.devices().map(({ tokenHash: _h, ...d }) => d);
  }

  /** New 6-digit pairing code; replaces the previous one. `anywhereUrl`: the 在外面也能用 QR address, null while that is off. */
  async newPairCode(): Promise<RemotePairCode> {
    void this.refreshPrimary();
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = Date.now() + PAIR_TTL_MS;
    this.pair = { code, expiresAt, tries: 0 };
    const ip = this.addresses()[0] ?? '127.0.0.1';
    this.emit('changed');
    const url = `http://${ip}:${this.server ? this.port : this.configuredPort()}/pair#${code}`;
    const anywhereUrl = this.pairUrlHook ? await this.pairUrlHook(code).catch(() => null) : null;
    return { code, expiresAt, url, anywhereUrl };
  }

  /** The pairing code in force, if any. */
  currentPair(): { code: string; expiresAt: number } | null {
    const p = this.pair;
    return p && p.expiresAt > Date.now() ? { code: p.code, expiresAt: p.expiresAt } : null;
  }

  /** Exchange a pairing code for a device token. */
  async redeem(code: string, name: string, req: IncomingMessage): Promise<{ token: string; device: DeviceInfo } | { error: string }> {
    const p = this.pair;
    if (!p || p.expiresAt < Date.now()) return { error: '配对码已过期，请在电脑上重新生成' };
    if (p.tries >= MAX_TRIES) { this.pair = null; return { error: '尝试次数过多，请重新生成配对码' }; }
    if (code.trim() !== p.code) { p.tries++; return { error: '配对码不对' }; }
    this.pair = null;
    const token = randomBytes(32).toString('base64url');
    const rec: DeviceRecord = { id: randomBytes(6).toString('hex'), name: (name || '').trim().slice(0, 60) || guessName(req.headers['user-agent'] ?? ''), tokenHash: hash(token), createdAt: Date.now(), lastSeenAt: Date.now(), ip: clientIp(req), ua: (req.headers['user-agent'] ?? '').slice(0, 200) };
    await this.meta.addDevice(rec);
    this.tokenCache.set(token, rec.id);
    this.emit('paired', rec.id);
    this.emit('changed');
    const { tokenHash: _h, ...device } = rec;
    return { token, device };
  }

  /** Is this a valid device token? Returns the device id and bumps lastSeen. */
  authenticate(token: string | null, req?: IncomingMessage): string | null {
    if (!token) return null;
    let id = this.tokenCache.get(token);
    if (!id) {
      const h = hash(token);
      id = this.meta.devices().find((d) => d.tokenHash === h)?.id;
      if (!id) return null;
      this.tokenCache.set(token, id);
    }
    const d = this.meta.devices().find((x) => x.id === id);
    if (!d) { this.tokenCache.delete(token); return null; }
    if (Date.now() - d.lastSeenAt > 60_000) { void this.meta.touchDevice(id, req ? clientIp(req) : undefined).catch(() => {}); }
    return id;
  }

  /** Removes the device; its tunneled (在外面也能用) links end at once through `revoked`. */
  async revoke(id: string) {
    await this.meta.removeDevice(id);
    for (const [t, d] of this.tokenCache) if (d === id) this.tokenCache.delete(t);
    this.emit('revoked', id);
    this.emit('changed');
  }

  async rename(id: string, name: string) { await this.meta.renameDevice(id, name.trim().slice(0, 60)); this.emit('changed'); }
}

export function hash(s: string) { return createHash('sha256').update(s).digest('hex'); }
export function clientIp(req: IncomingMessage) { return (req.socket.remoteAddress ?? '').replace(/^::ffff:/, ''); }
function guessName(ua: string) {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android 手机';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows 电脑';
  return '设备';
}

/** The /pair page: reads the code from the URL fragment, asks for a device name, stores the token and opens the app. */
export function pairPage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>配对 · Claude Web</title>
<style>body{margin:0;font:16px system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;background:#1f1e1a;color:#ece9e2;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{width:min(420px,92vw);background:#2a2925;border:1px solid #3a3934;border-radius:16px;padding:26px 22px}h1{font-size:20px;margin:0 0 6px}p{color:#a8a49b;margin:0 0 18px;font-size:14px}
label{display:block;font-size:13px;color:#a8a49b;margin:12px 0 6px}input{width:100%;box-sizing:border-box;font:inherit;padding:12px;border-radius:10px;border:1px solid #3a3934;background:#1f1e1a;color:#ece9e2}
input.code{font-size:26px;letter-spacing:8px;text-align:center;font-family:ui-monospace,Menlo,monospace}button{margin-top:18px;width:100%;font:inherit;font-weight:600;padding:13px;border:0;border-radius:10px;background:#d97757;color:#fff}
.err{color:#e0655c;font-size:13px;margin-top:10px;min-height:18px}</style></head><body><div class="card"><h1>✱ 配对这台设备</h1><p>输入电脑上 Claude Web「远程访问」里显示的 6 位配对码。</p>
<form id="f"><label>配对码</label><input class="code" id="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" required><label>设备名称</label><input id="name" placeholder="例如 我的手机"><button>配对并打开</button><div class="err" id="err"></div></form></div>
<script>const c=location.hash.slice(1);if(/^\\d{6}$/.test(c))document.getElementById('code').value=c;
document.getElementById('f').onsubmit=async(e)=>{e.preventDefault();const err=document.getElementById('err');err.textContent='';
try{const r=await fetch('/api/pair',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:document.getElementById('code').value,name:document.getElementById('name').value})});const j=await r.json();
if(!r.ok||j.error){err.textContent=j.error||('失败 '+r.status);return;}localStorage.setItem('cw.token',j.token);location.replace('/');}catch(x){err.textContent=String(x);}};</script></body></html>`;
}
