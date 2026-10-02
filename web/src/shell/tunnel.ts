// window.__cwTunnel: the app frame's WebSockets, each one a stream over the shell's link to the PC (ws/tunnel.ts
// has the contract). One tunnel per paired PC while the app is open; the link under it is replaced on a redial.
import type { LinkKind, MuxWs } from '@anywhere';
import type { CwTunnel, TunnelSocket } from '../ws/tunnel';

/** What the tunnel needs of a Mux. */
export interface WsOpener {
  openWs(token: string): MuxWs;
  readonly kind: LinkKind;
}

/** up: streams open on `mux`; redialing: new streams wait for the next link (C1); down: they close at once. */
export type TunnelState = 'up' | 'redialing' | 'down';

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

/**
 * One stream. Every event reaches the app a microtask later and in order, like a WebSocket's: never from inside
 * connect(), and after whatever runs synchronously with it (a link that ends tells the shell first, so the app's
 * reconnect finds the tunnel already redialing). readyState changes when its event is dispatched.
 */
class Stream implements TunnelSocket {
  readyState = CONNECTING;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  ws: MuxWs | null = null;
  /** No more events: the close is dispatched or queued. */
  ended = false;

  constructor(private readonly drop: (s: Stream) => void) {}

  attach(ws: MuxWs): void {
    this.ws = ws;
    ws.onopen = () => this.later(() => {
      this.readyState = OPEN;
      this.onopen?.();
    });
    ws.onmessage = (data) => this.later(() => this.onmessage?.({ data }));
    ws.onclose = () => this.end();
  }

  send(text: string): void {
    // MuxWs.send never throws; after the end (or before the open) there is nothing to send on
    if (this.readyState === OPEN && !this.ended) this.ws?.send(text);
  }

  close(): void {
    if (this.ended) return;
    if (this.readyState < CLOSING) this.readyState = CLOSING;
    const ws = this.ws;
    // a MuxWs tells the PC and fires its own onclose a microtask later; one not attached yet just ends
    if (ws) ws.close();
    else this.end();
  }

  /** Ends it (the stream closed, or never got a link): onclose once, asynchronously. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.drop(this);
    this.later(() => {
      this.readyState = CLOSED;
      this.onclose?.();
    }, true);
  }

  private later(fn: () => void, last = false): void {
    queueMicrotask(() => {
      // nothing after the close event (an open or a message queued just before it still goes first)
      if (this.readyState === CLOSED && !last) return;
      try {
        fn();
      } catch (e) {
        console.error('[shell tunnel] app handler:', e);
      }
    });
  }
}

export class ShellTunnel implements CwTunnel {
  private mux: WsOpener | null = null;
  private state: TunnelState = 'down';
  private readonly live = new Set<Stream>();
  private waiting: Stream[] = [];

  constructor(private readonly token: string) {}

  /** The link under the tunnel: a new one after a redial (waiting streams open on it), or none. */
  setLink(mux: WsOpener | null, state: TunnelState): void {
    this.mux = state === 'up' ? mux : null;
    this.state = this.mux ? 'up' : state === 'up' ? 'down' : state;
    const waiting = this.waiting;
    this.waiting = [];
    if (this.mux) for (const s of waiting) this.open(s);
    else if (this.state === 'down') for (const s of waiting) s.end();
    else this.waiting = waiting;
  }

  connect(): TunnelSocket {
    const s = new Stream((x) => {
      this.live.delete(x);
      this.waiting = this.waiting.filter((w) => w !== x);
    });
    this.live.add(s);
    if (this.mux) this.open(s);
    else if (this.state === 'redialing') this.waiting.push(s);
    else s.end();
    return s;
  }

  kind(): LinkKind | null {
    return this.mux?.kind ?? null;
  }

  /** Every stream ends (the app frame is being reloaded or closed): the PC is told for those on a link. */
  closeAll(): void {
    for (const s of [...this.live]) s.close();
    this.waiting = [];
  }

  private open(s: Stream): void {
    if (s.ended || !this.mux) return;
    s.attach(this.mux.openWs(this.token));
  }
}
