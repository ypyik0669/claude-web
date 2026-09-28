import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { ClientRequest, ServerEvent, WireDown } from '../protocol.js';
import { SERVER_ID_CONFLICT, type PeerState } from './types.js';

/** Where to reach the peer right now. SSH peers resolve this by (re)opening their tunnel. */
export interface PeerEndpoint { url: string; token: string }

export interface PeerClientOptions {
  /** This server's id: sent as `?peer=` (the remote then never echoes peer-derived events back) and compared with the remote's hello. */
  selfId: string;
  /** This process's bootId: same serverId + other bootId in the hello = a copied data dir, not ourselves. */
  selfBootId?: string;
  resolve: () => Promise<PeerEndpoint>;
  heartbeatMs?: number;
  pongTimeoutMs?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  helloTimeoutMs?: number;
  fetch?: typeof fetch;
}

interface Pending { res: (v: unknown) => void; rej: (e: Error) => void; timer: NodeJS.Timeout }

/**
 * One connection to another machine's claude-web: its `/ws` as an ordinary (token-carrying) client.
 * Requests go out with our loop-guard `via`; replies resolve them by id; every broadcast is re-emitted
 * as 'event'. Heartbeat: a ws ping every 30s (the pong's round trip is the latency; no pong within
 * 10s = dead link). Reconnects with exponential backoff 1s → 30s, except when the remote rejects our
 * token (revoked): that is `unauthorized` and waits for a re-pair.
 */
export class PeerClient extends EventEmitter {
  state: PeerState = 'connecting';
  error = '';
  latencyMs: number | undefined;
  lastSeenAt: number | undefined;
  remote: { serverId?: string; name?: string; version?: string } = {};
  private ws: WebSocket | null = null;
  private seq = 0;
  private pending = new Map<string, Pending>();
  private attempt = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private beat: NodeJS.Timeout | null = null;
  private pongTimer: NodeJS.Timeout | null = null;
  private pingAt = 0;
  private stopped = true;
  private epoch = 0;
  private readonly o: Required<Omit<PeerClientOptions, 'fetch' | 'selfBootId'>> & { fetch: typeof fetch; selfBootId?: string };

  constructor(opts: PeerClientOptions) {
    super();
    this.o = { heartbeatMs: 30_000, pongTimeoutMs: 10_000, backoffMinMs: 1_000, backoffMaxMs: 30_000, helloTimeoutMs: 10_000, fetch: globalThis.fetch.bind(globalThis), ...opts };
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.setState('connecting', '');
    void this.connect();
  }

  stop(state: PeerState = 'disabled') {
    this.stopped = true;
    this.epoch++;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.teardown(new Error('连接已关闭'));
    this.setState(state, state === 'disabled' ? '' : this.error);
  }

  /** Send a request; rejects at once when not connected. `via` is the loop guard chain (ours appended by the caller). */
  request<T = unknown>(req: ClientRequest, via: string[], timeoutMs = 60_000): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || this.state !== 'online') return Promise.reject(new Error(this.error || '机器离线'));
    const id = `f${++this.seq}`;
    return new Promise<T>((res, rej) => {
      const timer = setTimeout(() => { this.pending.delete(id); rej(new Error(`远端 ${timeoutMs / 1000}s 没有回应（${req.kind}）`)); }, timeoutMs);
      this.pending.set(id, { res: res as (v: unknown) => void, rej, timer });
      ws.send(JSON.stringify({ type: 'request', request: { id, req, via } }), (err) => {
        if (!err) return;
        const p = this.pending.get(id);
        if (p) { clearTimeout(p.timer); this.pending.delete(id); p.rej(err); }
      });
    });
  }

  private setState(state: PeerState, error: string) {
    if (this.state === state && this.error === error) return;
    this.state = state;
    this.error = error;
    this.emit('state', state);
  }

  private teardown(err: Error) {
    if (this.beat) clearInterval(this.beat);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.beat = this.pongTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) { ws.removeAllListeners(); ws.on('error', () => {}); try { ws.terminate(); } catch { /* ignore */ } }
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.rej(err); }
    this.pending.clear();
  }

  private scheduleRetry() {
    if (this.stopped) return;
    const delay = Math.min(this.o.backoffMaxMs, this.o.backoffMinMs * 2 ** this.attempt);
    this.attempt++;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.connect(); }, delay);
    this.retryTimer.unref?.();
  }

  /** Why did the socket fail? The upgrade handler just destroys the socket, so ask existing endpoints:
   *  `/api/health` answers → the machine is up; `/api/file?token=` 403 → our token is not accepted. */
  private async diagnose(ep: PeerEndpoint): Promise<'unauthorized' | 'offline'> {
    const get = (p: string) => this.o.fetch(`${ep.url}${p}`, { signal: AbortSignal.timeout(3000) });
    try {
      const h = await get('/api/health');
      if (!h.ok) return 'offline';
      const f = await get(`/api/file?token=${encodeURIComponent(ep.token)}`);
      return f.status === 403 ? 'unauthorized' : 'offline';
    } catch {
      return 'offline';
    }
  }

  private async connect() {
    if (this.stopped) return;
    const epoch = ++this.epoch;
    let ep: PeerEndpoint;
    try {
      ep = await this.o.resolve();
    } catch (e: any) {
      if (epoch !== this.epoch) return;
      this.setState('offline', e?.message ?? String(e));
      this.scheduleRetry();
      return;
    }
    if (epoch !== this.epoch) return;
    const wsUrl = `${ep.url.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(ep.token)}&peer=${encodeURIComponent(this.o.selfId)}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl, { handshakeTimeout: 10_000 });
    } catch (e: any) {
      this.setState('offline', e?.message ?? String(e));
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    let opened = false;
    let greeted = false;
    const helloTimer = setTimeout(() => { if (!greeted) ws.terminate(); }, this.o.helloTimeoutMs);
    ws.on('open', () => { opened = true; });
    ws.on('message', (raw) => {
      let m: WireDown;
      try { m = JSON.parse(String(raw)); } catch { return; }
      this.lastSeenAt = Date.now();
      if (m.type === 'reply') {
        const p = this.pending.get(m.reply.id);
        if (!p) return;
        this.pending.delete(m.reply.id);
        clearTimeout(p.timer);
        if (m.reply.ok) p.res(m.reply.data);
        else p.rej(new Error(m.reply.error ?? '远端出错'));
        return;
      }
      if (m.type !== 'event') return;
      const e = m.event as ServerEvent;
      if (!greeted && e.kind === 'hello') {
        greeted = true;
        clearTimeout(helloTimer);
        this.remote = { serverId: e.serverId, name: e.name, version: e.version };
        if (e.serverId && e.serverId === this.o.selfId) {
          // pairing with ourselves (our own LAN address): every request would loop straight back —
          // unless it's a different process with our serverId (a copied ~/.claude-web): say so
          const conflict = !!e.bootId && !!this.o.selfBootId && e.bootId !== this.o.selfBootId;
          this.stop('offline');
          this.setState('offline', conflict ? SERVER_ID_CONFLICT : '这个地址就是本机');
          return;
        }
        this.attempt = 0;
        this.setState('online', '');
        this.emit('hello', this.remote);
        this.startHeartbeat(ws);
        return;
      }
      this.emit('event', e);
    });
    ws.on('pong', () => {
      if (this.pongTimer) clearTimeout(this.pongTimer);
      this.pongTimer = null;
      if (this.pingAt) { this.latencyMs = Date.now() - this.pingAt; this.lastSeenAt = Date.now(); this.emit('latency', this.latencyMs); }
    });
    ws.on('error', () => { /* 'close' follows */ });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (this.ws !== ws) return; // superseded / stopped
      this.teardown(new Error('与远端的连接断开了'));
      if (this.stopped) return;
      if (opened) {
        this.setState('offline', '连接断开，正在重连');
        this.scheduleRetry();
        return;
      }
      void this.diagnose(ep).then((why) => {
        if (epoch !== this.epoch || this.stopped) return;
        if (why === 'unauthorized') { this.stopped = true; this.setState('unauthorized', '令牌失效，请重新配对'); return; }
        this.setState('offline', '连不上这台机器');
        this.scheduleRetry();
      });
    });
  }

  private startHeartbeat(ws: WebSocket) {
    const ping = () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      this.pingAt = Date.now();
      try { ws.ping(); } catch { return; }
      if (this.pongTimer) clearTimeout(this.pongTimer);
      this.pongTimer = setTimeout(() => { try { ws.terminate(); } catch { /* ignore */ } }, this.o.pongTimeoutMs);
    };
    ping(); // first latency sample right away
    this.beat = setInterval(ping, this.o.heartbeatMs);
    this.beat.unref?.();
  }
}
