// WsClient on an injected socket (the phone shell's tunnel socket has the same shape), and tunnelHost().
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientRequest, ServerEvent } from '@shared';
import { WsClient } from './client';
import { tunnelHost, type CwTunnel, type TunnelSocket } from './tunnel';

/** A socket the test opens and drops by hand. readyState uses the WebSocket values: 0 connecting, 1 open, 3 closed. */
class FakeSocket implements TunnelSocket {
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  send(text: string) {
    if (this.readyState !== 1) throw new Error('send on a socket that is not open');
    this.sent.push(text);
  }
  close() { this.drop(); }
  open() { this.readyState = 1; this.onopen?.(); }
  drop() { this.readyState = 3; this.onclose?.(); }
  down(d: unknown) { this.onmessage?.({ data: JSON.stringify(d) }); }
  /** the request ids this socket carried, in order */
  ids() { return this.sent.map((s) => JSON.parse(s).request.id as string); }
}

const LIST: ClientRequest = { kind: 'sessions.list' };
const INFO: ClientRequest = { kind: 'engine.info' };

let sockets: FakeSocket[];
const client = () => new WsClient(() => { const s = new FakeSocket(); sockets.push(s); return s; });
/** settle state of a promise, without awaiting it to the end */
const track = (p: Promise<unknown>) => {
  const t = { state: 'pending' as 'pending' | 'resolved' | 'rejected', value: undefined as unknown };
  p.then((v) => { t.state = 'resolved'; t.value = v; }, (e: Error) => { t.state = 'rejected'; t.value = e.message; });
  return t;
};
/** lets the promise callbacks above run (plain microtasks: not faked by vi.useFakeTimers) */
const flush = async () => { for (let i = 0; i < 3; i++) await Promise.resolve(); };

beforeEach(() => { sockets = []; });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('WsClient on an injected socket', () => {
  it('requests made before the socket opens are queued and go out on open, in order', async () => {
    const c = client();
    const early = track(c.request(LIST)); // before connect(): no socket at all
    c.connect();
    expect(sockets).toHaveLength(1);
    const second = track(c.request(INFO)); // socket exists but is still connecting
    expect(sockets[0].sent).toEqual([]);

    sockets[0].open();
    expect(c.connected).toBe(true);
    expect(sockets[0].sent.map((s) => JSON.parse(s))).toEqual([
      { type: 'request', request: { id: '1', req: LIST } },
      { type: 'request', request: { id: '2', req: INFO } },
    ]);

    // once open, a request goes straight out
    track(c.request(LIST));
    expect(sockets[0].ids()).toEqual(['1', '2', '3']);
    await flush();
    expect(early.state).toBe('pending');
    expect(second.state).toBe('pending');
  });

  it('after a close it reconnects with backoff (calls open again); requests that never went out are not rejected', async () => {
    vi.useFakeTimers();
    const c = client();
    const status: boolean[] = [];
    c.onStatus = (v) => status.push(v);
    c.connect();
    sockets[0].open();
    const sentOnFirst = track(c.request(LIST));
    expect(sockets[0].ids()).toEqual(['1']);

    sockets[0].drop();
    expect(c.connected).toBe(false);
    const whileDown = track(c.request(INFO)); // queued: the old socket is closed
    await flush();
    expect(sentOnFirst).toEqual({ state: 'rejected', value: 'connection closed' }); // it went out, its answer is lost
    expect(whileDown.state).toBe('pending');

    vi.advanceTimersByTime(499);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2); // open() called again after 500 ms

    sockets[1].drop(); // never opened (the tunnel or the computer is not reachable)
    await flush();
    expect(whileDown.state).toBe('pending'); // still queued, not rejected
    vi.advanceTimersByTime(999);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3); // backoff doubled to 1 s

    sockets[2].open();
    expect(sockets[2].ids()).toEqual(['2']); // the queued request goes out on the new socket
    sockets[2].down({ type: 'reply', reply: { id: '2', ok: true, data: 'ok' } });
    await flush();
    expect(whileDown).toEqual({ state: 'resolved', value: 'ok' });

    // a successful open resets the backoff
    sockets[2].drop();
    vi.advanceTimersByTime(500);
    expect(sockets).toHaveLength(4);
    expect(status).toEqual([true, false, false, true, false]);
  });

  it('the backoff stops growing at 8 s', () => {
    vi.useFakeTimers();
    const c = client();
    c.connect();
    for (const wait of [500, 1000, 2000, 4000, 8000, 8000]) {
      const n = sockets.length;
      sockets[n - 1].drop();
      vi.advanceTimersByTime(wait - 1);
      expect(sockets).toHaveLength(n);
      vi.advanceTimersByTime(1);
      expect(sockets).toHaveLength(n + 1);
    }
  });

  it('replies are routed to the promise with their id; an error reply rejects it; events go to the listeners', async () => {
    const c = client();
    c.connect();
    sockets[0].open();
    const a = track(c.request(LIST));
    const b = track(c.request(INFO));
    const e = track(c.request(LIST));
    const events: ServerEvent[] = [];
    c.on((ev) => events.push(ev));

    sockets[0].down({ type: 'reply', reply: { id: '2', ok: true, data: { engine: 'ccb' } } });
    sockets[0].down({ type: 'reply', reply: { id: '99', ok: true, data: 'nobody asked' } }); // unknown id: ignored
    sockets[0].down({ type: 'event', event: { kind: 'sessions.changed' } });
    sockets[0].down({ type: 'reply', reply: { id: '1', ok: true, data: [1, 2] } });
    sockets[0].down({ type: 'reply', reply: { id: '3', ok: false, error: 'boom' } });
    await flush();

    expect(a).toEqual({ state: 'resolved', value: [1, 2] });
    expect(b).toEqual({ state: 'resolved', value: { engine: 'ccb' } });
    expect(e).toEqual({ state: 'rejected', value: 'boom' });
    expect(events).toEqual([{ kind: 'sessions.changed' }]);
  });

  it('a socket that reports its close twice still leads to one reconnect', () => {
    vi.useFakeTimers();
    const c = client();
    c.connect();
    sockets[0].open();
    sockets[0].drop();
    sockets[0].drop();
    vi.advanceTimersByTime(8000);
    expect(sockets).toHaveLength(2);
  });

  it('an open() that throws is retried after the backoff instead of ending the reconnect loop', () => {
    vi.useFakeTimers();
    let fail = 2;
    const c = new WsClient(() => {
      if (fail-- > 0) throw new Error('tunnel is down');
      const s = new FakeSocket(); sockets.push(s); return s;
    });
    expect(() => c.connect()).not.toThrow();
    vi.advanceTimersByTime(500);
    expect(sockets).toHaveLength(0);
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(1);
  });
});

describe('tunnelHost', () => {
  const tunnel: CwTunnel = { connect: () => new FakeSocket(), kind: () => 'relay' };
  const page = (parent: unknown, origin = 'https://ypy.github.io') => {
    const w: Record<string, unknown> = { location: { origin } };
    w.parent = parent === 'self' ? w : parent;
    vi.stubGlobal('window', w);
  };

  it('no window (node, workers) → null', () => {
    expect(tunnelHost()).toBeNull();
  });

  it('a top-level page (parent is the window itself) → null', () => {
    page('self');
    expect(tunnelHost()).toBeNull();
  });

  it('a cross-origin parent, whose location and properties throw on access → null', () => {
    const blocked = {
      get location(): never { throw new Error('SecurityError: Blocked a frame with origin'); },
      get __cwTunnel(): never { throw new Error('SecurityError: Blocked a frame with origin'); },
    };
    page(blocked);
    expect(tunnelHost()).toBeNull();
  });

  it('a parent on another origin → null even when it has a __cwTunnel', () => {
    page({ location: { origin: 'https://evil.example' }, __cwTunnel: tunnel });
    expect(tunnelHost()).toBeNull();
  });

  it('a same-origin parent without __cwTunnel → null', () => {
    page({ location: { origin: 'https://ypy.github.io' } });
    expect(tunnelHost()).toBeNull();
  });

  it("a same-origin parent with __cwTunnel → the parent's tunnel", () => {
    page({ location: { origin: 'https://ypy.github.io' }, __cwTunnel: tunnel });
    expect(tunnelHost()).toBe(tunnel);
  });
});
