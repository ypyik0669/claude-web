import type { ClientRequest, ServerEvent, WireDown, WireUp } from '@shared';
import { tunnelHost } from './tunnel';

type Listener = (e: ServerEvent) => void;

/**
 * The part of a WebSocket the client uses; the phone shell's TunnelSocket (./tunnel) fits it too.
 * `readyState` is a plain number here (the DOM types it 0 | 1 | 2 | 3, a TunnelSocket says number).
 */
export type WebSocketLike = Pick<WebSocket, 'send' | 'close' | 'onopen' | 'onclose' | 'onmessage'> & { readonly readyState: number };

/** WebSocket.OPEN, written out: a TunnelSocket and the node tests have no global WebSocket */
const OPEN = 1;

/** The computer's /ws on this page's own host, with the access token when there is one. */
function openWebSocket(): WebSocketLike {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const token = authToken();
  return new WebSocket(`${proto}://${location.host}/ws${token ? `?token=${encodeURIComponent(token)}` : ''}`);
}

export class WsClient {
  private ws: WebSocketLike | null = null;
  private seq = 0;
  private pending = new Map<string, { res: (v: unknown) => void; rej: (e: Error) => void }>();
  private listeners = new Set<Listener>();
  private backoff = 500;
  /** requests made while the socket was down; sent on (re)open. Their promises stay pending until then. */
  private queue: { id: string; raw: string }[] = [];
  connected = false;
  onStatus: ((c: boolean) => void) | null = null;

  /** `open` makes one socket per (re)connect: a WebSocket to this host by default, a tunnel stream in the phone shell */
  constructor(private readonly open: () => WebSocketLike = openWebSocket) {}

  connect() {
    let ws: WebSocketLike;
    try {
      ws = this.open();
    } catch {
      // a tunnel whose link is down may refuse at once: try again like after a close, don't end the loop
      this.retry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.connected = true;
      this.backoff = 500;
      this.onStatus?.(true);
      for (const q of this.queue) ws.send(q.raw);
      this.queue = [];
    };
    ws.onclose = () => {
      // once per socket: a second close report must not start a second connection next to the new one
      if (this.ws !== ws) return;
      this.ws = null;
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
      this.retry();
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

  private retry() {
    setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 8000);
  }

  request<T = unknown>(req: ClientRequest): Promise<T> {
    const id = String(++this.seq);
    const up: WireUp = { type: 'request', request: { id, req } };
    const raw = JSON.stringify(up);
    return new Promise<T>((res, rej) => {
      this.pending.set(id, { res: res as (v: unknown) => void, rej });
      if (this.ws && this.ws.readyState === OPEN) this.ws.send(raw);
      else this.queue.push({ id, raw });
    });
  }

  on(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

/**
 * Access token: `?token=` on the page URL (desktop shell / dev) or the device token saved by the /pair page (phones).
 * Not used for the socket inside the phone shell: there the shell holds the device token and sends it when it opens
 * the stream (`CwTunnel.connect()` takes none).
 */
export function authToken(): string | null {
  const q = new URLSearchParams(location.search).get('token');
  if (q) { try { localStorage.setItem('cw.token', q); } catch { /* private mode */ } return q; }
  try { return localStorage.getItem('cw.token'); } catch { return null; }
}

// inside the phone shell's iframe every (re)connect is a stream over the shell's tunnel; otherwise a WebSocket
const tunnel = tunnelHost();
export const ws = new WsClient(tunnel ? () => tunnel.connect() : undefined);
