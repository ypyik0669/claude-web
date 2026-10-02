import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHUNK_BYTES, F, decodeFrame, text } from './frames.js';
import type { Link, LinkKind } from './link.js';
import { MUX_FRAME_CHARGE, MUX_PAUSE_BYTES, MUX_POLL_MS, Mux, Outbox, type MuxResponse } from './mux.js';

afterEach(() => {
  vi.useRealTimers();
});

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A link that keeps what is sent and reports whatever `held` says as buffered(). */
class FakeLink implements Link {
  kind: LinkKind = 'relay';
  onframe: (f: Uint8Array) => void = () => {};
  onclose: (why: string) => void = () => {};
  sent: { type: F; stream: number; payload: Uint8Array }[] = [];
  held = 0;
  /** buffered() grows by each frame sent, as a real link's does (until the test says it was confirmed). */
  grows = false;
  closed = false;
  send(f: Uint8Array): void {
    const fr = decodeFrame(f.slice());
    this.sent.push({ type: fr.type, stream: fr.stream, payload: fr.payload });
    if (this.grows) this.held += f.length;
  }
  buffered(): number {
    return this.held;
  }
  close(): void {
    this.closed = true;
  }
  /** As the PC would send it. */
  deliver(type: F, stream: number, payload: Uint8Array | string = new Uint8Array(0)): void {
    const body = typeof payload === 'string' ? enc.encode(payload) : payload;
    const f = new Uint8Array(5 + body.length);
    f[0] = type;
    new DataView(f.buffer).setUint32(1, stream);
    f.set(body, 5);
    this.onframe(f);
  }
}

describe('Outbox', () => {
  it('charges every frame: small frames pause after at most 8 192 (the relay link caps 65 536), not after 1 MiB of them', () => {
    vi.useFakeTimers();
    const link = new FakeLink();
    link.grows = true;
    const out = new Outbox(link);
    let drained = 0;
    out.ondrain = () => drained++;
    for (let i = 0; i < 20_000; i++) out.frame(1, F.WS_MSG);
    const first = link.sent.length;
    // 5-byte frames: bytes alone would have let 200 000 through
    expect(first).toBe(Math.ceil(MUX_PAUSE_BYTES / (5 + MUX_FRAME_CHARGE)));
    expect(first).toBeLessThanOrEqual(MUX_PAUSE_BYTES / MUX_FRAME_CHARGE);
    expect(out.busy()).toBe(true);
    vi.advanceTimersByTime(MUX_POLL_MS * 5);
    expect(link.sent.length).toBe(first);
    // the other side confirms everything: the count starts again
    while (link.sent.length < 20_000) {
      const n = link.sent.length;
      link.held = 0;
      vi.advanceTimersByTime(MUX_POLL_MS);
      expect(link.sent.length - n).toBeLessThanOrEqual(first);
    }
    // the last few went out under the mark: drained at once, and no timer is left
    expect(drained).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('takes the streams in turn: a small frame does not wait behind a whole body', () => {
    vi.useFakeTimers();
    const link = new FakeLink();
    link.held = MUX_PAUSE_BYTES;
    const out = new Outbox(link);
    out.pieces(1, new Uint8Array(CHUNK_BYTES * 4), F.BODY);
    out.frame(2, F.WS_MSG, 'hi');
    expect(link.sent).toEqual([]);
    link.held = 0;
    vi.advanceTimersByTime(MUX_POLL_MS);
    expect(link.sent.map((s) => s.stream)).toEqual([1, 2, 1, 1, 1]);
    expect(link.sent.filter((s) => s.stream === 1).every((s) => s.payload.length === CHUNK_BYTES && s.type === F.BODY)).toBe(true);
  });

  it('pieces: CHUNK_BYTES each, the last as `last`; empty data with `last` is one empty frame', () => {
    const link = new FakeLink();
    const out = new Outbox(link);
    out.pieces(3, new Uint8Array(CHUNK_BYTES * 2 + 1), F.BODY, F.WS_MSG);
    out.pieces(4, new Uint8Array(0), F.BODY, F.WS_MSG);
    out.pieces(5, new Uint8Array(0), F.BODY);
    expect(link.sent.map((s) => [s.stream, s.type, s.payload.length])).toEqual([
      [3, F.BODY, CHUNK_BYTES],
      [3, F.BODY, CHUNK_BYTES],
      [3, F.WS_MSG, 1],
      [4, F.WS_MSG, 0],
    ]);
  });

  it('drop() forgets a stream, close() sends nothing more and leaves no timer', () => {
    vi.useFakeTimers();
    const link = new FakeLink();
    link.held = MUX_PAUSE_BYTES;
    const out = new Outbox(link);
    out.frame(1, F.WS_MSG, 'a');
    out.frame(2, F.WS_MSG, 'b');
    out.drop(1);
    out.close();
    link.held = 0;
    vi.advanceTimersByTime(MUX_POLL_MS * 3);
    expect(link.sent).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('Mux', () => {
  it('a WebSocket: the token in WS_OPEN, sends held until the PC says open, long messages in pieces both ways', () => {
    const link = new FakeLink();
    const mux = new Mux(link);
    const ws = mux.openWs('tok');
    const got: string[] = [];
    let opened = 0;
    ws.onopen = () => opened++;
    ws.onmessage = (t) => got.push(t);
    expect(link.sent.map((s) => [s.type, text(s.payload)])).toEqual([[F.WS_OPEN, 'tok']]);
    const id = link.sent[0].stream;
    expect(id).toBeGreaterThan(0);
    ws.send('early');
    expect(link.sent.length).toBe(1);
    link.deliver(F.WS_OPEN, id);
    expect(opened).toBe(1);
    expect(link.sent.slice(1).map((s) => [s.type, text(s.payload)])).toEqual([[F.WS_MSG, 'early']]);
    // a long message with multi-byte characters cut across pieces
    const long = '中文消息'.repeat(4000);
    ws.send(long);
    const pieces = link.sent.slice(2);
    expect(pieces.map((s) => s.type)).toEqual([F.BODY, F.BODY, F.WS_MSG]);
    const bytes = enc.encode(long);
    for (let i = 0; i < pieces.length; i++) link.deliver(pieces[i].type, id, bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES));
    expect(got).toEqual([long]);
  });

  it('own close(): WS_CLOSE goes out, onclose comes a microtask later, once', async () => {
    const link = new FakeLink();
    const mux = new Mux(link);
    const ws = mux.openWs('tok');
    let closed = 0;
    ws.onclose = () => closed++;
    const id = link.sent[0].stream;
    ws.close();
    ws.close();
    expect(link.sent.at(-1)).toEqual(expect.objectContaining({ type: F.WS_CLOSE, stream: id }));
    expect(closed).toBe(0);
    await Promise.resolve();
    expect(closed).toBe(1);
    link.deliver(F.WS_CLOSE, id);
    expect(closed).toBe(1);
  });

  it('a request: head with content-length, the body in pieces, END; the response put back together', async () => {
    const link = new FakeLink();
    const mux = new Mux(link);
    const body = new Uint8Array(CHUNK_BYTES + 10).fill(7);
    const p = mux.request({ method: 'POST', path: '/api/x?y=1', headers: { 'X-Test': 'a' }, body });
    const [head, ...rest] = link.sent;
    expect(head.type).toBe(F.HTTP_REQ);
    expect(JSON.parse(text(head.payload))).toEqual({ method: 'POST', path: '/api/x?y=1', headers: { 'x-test': 'a', 'content-length': String(body.length) } });
    expect(rest.map((s) => [s.type, s.payload.length])).toEqual([
      [F.BODY, CHUNK_BYTES],
      [F.BODY, 10],
      [F.END, 0],
    ]);
    link.deliver(F.HTTP_RES, head.stream, JSON.stringify({ status: 201, headers: { 'Content-Type': 'text/plain' } }));
    link.deliver(F.BODY, head.stream, 'he');
    link.deliver(F.BODY, head.stream, 'llo');
    link.deliver(F.END, head.stream);
    const res: MuxResponse = await p;
    expect(res.status).toBe(201);
    expect(res.headers).toEqual({ 'content-type': 'text/plain' });
    expect(dec.decode(res.body)).toBe('hello');
  });

  it('ERR rejects the request with its text; a bad path is refused before anything goes out', async () => {
    const link = new FakeLink();
    const mux = new Mux(link);
    const p = mux.request({ method: 'GET', path: '/a' });
    link.deliver(F.ERR, link.sent[0].stream, 'connect ECONNREFUSED');
    await expect(p).rejects.toThrow('connect ECONNREFUSED');
    const n = link.sent.length;
    await expect(mux.request({ method: 'GET', path: 'a' })).rejects.toThrow();
    expect(link.sent.length).toBe(n);
  });

  it('the link ending tells every stream and onclose; close() tells the streams but not onclose', async () => {
    const link = new FakeLink();
    const mux = new Mux(link);
    const ws = mux.openWs('tok');
    let wsClosed = 0;
    ws.onclose = () => wsClosed++;
    const p = mux.request({ method: 'GET', path: '/a' });
    const whys: string[] = [];
    mux.onclose = (w) => whys.push(w);
    link.onclose('the other side closed the link');
    expect(wsClosed).toBe(1);
    await expect(p).rejects.toThrow(/the other side closed the link/);
    expect(whys).toEqual(['the other side closed the link']);
    await expect(mux.request({ method: 'GET', path: '/a' })).rejects.toThrow();

    const link2 = new FakeLink();
    const mux2 = new Mux(link2);
    const ws2 = mux2.openWs('tok');
    let ws2Closed = 0;
    ws2.onclose = () => ws2Closed++;
    let told = 0;
    mux2.onclose = () => told++;
    mux2.close();
    expect(link2.closed).toBe(true);
    expect(ws2Closed).toBe(1);
    expect(told).toBe(0);
    const late = mux2.openWs('tok');
    let lateClosed = 0;
    late.onclose = () => lateClosed++;
    await Promise.resolve();
    expect(lateClosed).toBe(1);
  });

  it('answers PING with PONG and ignores frames of streams it does not have', () => {
    const link = new FakeLink();
    new Mux(link);
    link.deliver(F.PING, 0, 'abc');
    link.deliver(F.WS_MSG, 99, 'nobody');
    link.deliver(F.HTTP_RES, 98, '{}');
    expect(link.sent.map((s) => [s.type, s.stream, text(s.payload)])).toEqual([[F.PONG, 0, 'abc']]);
  });
});
