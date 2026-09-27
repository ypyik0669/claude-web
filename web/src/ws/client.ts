import type { ClientRequest, ServerEvent, WireDown, WireUp } from '@shared';

type Listener = (e: ServerEvent) => void;

class WsClient {
  private ws: WebSocket | null = null;
  private seq = 0;
  private pending = new Map<string, { res: (v: unknown) => void; rej: (e: Error) => void }>();
  private listeners = new Set<Listener>();
  private backoff = 500;
  /** requests made while the socket was down; sent on (re)open. Their promises stay pending until then. */
  private queue: { id: string; raw: string }[] = [];
  connected = false;
  onStatus: ((c: boolean) => void) | null = null;

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const token = authToken();
    const ws = new WebSocket(`${proto}://${location.host}/ws${token ? `?token=${encodeURIComponent(token)}` : ''}`);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.backoff = 500;
      this.onStatus?.(true);
      for (const q of this.queue) ws.send(q.raw);
      this.queue = [];
    };
    ws.onclose = () => {
      this.connected = false;
      this.onStatus?.(false);
      // only fail what actually went out on this socket: a queued request was never sent, it is flushed on the
      // next open — rejecting it here as well would report a failure for a request the server then executes
      const queued = new Set(this.queue.map((q) => q.id));
      for (const [id, p] of this.pending) {
        if (queued.has(id)) continue;
        p.rej(new Error('connection closed'));
        this.pending.delete(id);
      }
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 8000);
    };
    ws.onmessage = (ev) => {
      const d: WireDown = JSON.parse(ev.data);
      if (d.type === 'reply') {
        const p = this.pending.get(d.reply.id);
        if (!p) return;
        this.pending.delete(d.reply.id);
        d.reply.ok ? p.res(d.reply.data) : p.rej(new Error(d.reply.error));
      } else {
        for (const l of this.listeners) l(d.event);
      }
    };
  }

  request<T = unknown>(req: ClientRequest): Promise<T> {
    const id = String(++this.seq);
    const up: WireUp = { type: 'request', request: { id, req } };
    const raw = JSON.stringify(up);
    return new Promise<T>((res, rej) => {
      this.pending.set(id, { res: res as (v: unknown) => void, rej });
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(raw);
      else this.queue.push({ id, raw });
    });
  }

  on(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

/** Access token: `?token=` on the page URL (desktop shell / dev) or the device token saved by the /pair page (phones). */
export function authToken(): string | null {
  const q = new URLSearchParams(location.search).get('token');
  if (q) { try { localStorage.setItem('cw.token', q); } catch { /* private mode */ } return q; }
  try { return localStorage.getItem('cw.token'); } catch { return null; }
}

export const ws = new WsClient();
