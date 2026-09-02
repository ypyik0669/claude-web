import type { ClientRequest, ServerEvent, WireDown, WireUp } from '@shared';

type Listener = (e: ServerEvent) => void;

class WsClient {
  private ws: WebSocket | null = null;
  private seq = 0;
  private pending = new Map<string, { res: (v: unknown) => void; rej: (e: Error) => void }>();
  private listeners = new Set<Listener>();
  private backoff = 500;
  private queue: string[] = [];
  connected = false;
  onStatus: ((c: boolean) => void) | null = null;

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.backoff = 500;
      this.onStatus?.(true);
      for (const q of this.queue) ws.send(q);
      this.queue = [];
    };
    ws.onclose = () => {
      this.connected = false;
      this.onStatus?.(false);
      for (const p of this.pending.values()) p.rej(new Error('connection closed'));
      this.pending.clear();
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
      else this.queue.push(raw);
    });
  }

  on(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

export const ws = new WsClient();
