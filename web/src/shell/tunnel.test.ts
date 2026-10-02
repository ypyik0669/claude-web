import { describe, expect, it } from 'vitest';
import { F, Mux, decodeFrame, type Link, type LinkKind } from '@anywhere';
import { ShellTunnel } from './tunnel';

const enc = new TextEncoder();
const dec = new TextDecoder();
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** The phone's end of a link: frames sent are kept, the test plays the PC. */
class FakeLink implements Link {
  kind: LinkKind;
  onframe: (f: Uint8Array) => void = () => {};
  onclose: (why: string) => void = () => {};
  sent: { type: F; stream: number; text: string }[] = [];
  constructor(kind: LinkKind = 'p2p-v6') {
    this.kind = kind;
  }
  send(f: Uint8Array): void {
    const fr = decodeFrame(f.slice());
    this.sent.push({ type: fr.type, stream: fr.stream, text: dec.decode(fr.payload) });
  }
  buffered(): number {
    return 0;
  }
  close(): void {}
  deliver(type: F, stream: number, payload = ''): void {
    const body = enc.encode(payload);
    const f = new Uint8Array(5 + body.length);
    f[0] = type;
    new DataView(f.buffer).setUint32(1, stream);
    f.set(body, 5);
    this.onframe(f);
  }
  opens() {
    return this.sent.filter((s) => s.type === F.WS_OPEN);
  }
}

function events(s: { onopen: (() => void) | null; onclose: (() => void) | null; onmessage: ((ev: { data: string }) => void) | null; readyState: number }) {
  const log: string[] = [];
  s.onopen = () => log.push(`open ${s.readyState}`);
  s.onclose = () => log.push(`close ${s.readyState}`);
  s.onmessage = (ev) => log.push(`msg ${ev.data}`);
  return log;
}

describe('ShellTunnel (the app’s window.__cwTunnel)', () => {
  it('opens a stream with the device token; open on the PC’s ack, messages both ways, close told later', async () => {
    const link = new FakeLink();
    const t = new ShellTunnel('tok');
    t.setLink(new Mux(link), 'up');
    expect(t.kind()).toBe('p2p-v6');
    const s = t.connect();
    expect(s.readyState).toBe(0);
    const log = events(s);
    expect(link.opens()).toEqual([{ type: F.WS_OPEN, stream: 1, text: 'tok' }]);
    await tick();
    expect(log).toEqual([]);
    link.deliver(F.WS_OPEN, 1);
    await tick();
    expect(log).toEqual(['open 1']);
    link.deliver(F.WS_MSG, 1, '{"kind":"hello"}');
    await tick();
    expect(log).toEqual(['open 1', 'msg {"kind":"hello"}']);
    s.send('{"id":1}');
    expect(link.sent.some((f) => f.type === F.WS_MSG && f.text === '{"id":1}')).toBe(true);
    s.close();
    expect(s.readyState).not.toBe(1);
    expect(link.sent.some((f) => f.type === F.WS_CLOSE && f.stream === 1)).toBe(true);
    await tick();
    expect(log).toEqual(['open 1', 'msg {"kind":"hello"}', 'close 3']);
  });

  it('a token the PC refuses closes the stream (asynchronously, never inside connect())', async () => {
    const link = new FakeLink();
    const t = new ShellTunnel('bad');
    t.setLink(new Mux(link), 'up');
    const s = t.connect();
    const log = events(s);
    link.deliver(F.WS_CLOSE, 1);
    await tick();
    expect(log).toEqual(['close 3']);
    expect(s.readyState).toBe(3);
  });

  it('C1: connect() during a redial stays connecting, then opens on the new link (no backoff of its own)', async () => {
    const old = new FakeLink();
    const t = new ShellTunnel('tok');
    t.setLink(new Mux(old), 'up');
    const before = t.connect();
    const beforeLog = events(before);
    old.deliver(F.WS_OPEN, 1);
    await tick();
    // the link drops: the open stream ends, as a WebSocket would
    old.onclose('ice failed');
    t.setLink(null, 'redialing');
    await tick();
    expect(beforeLog).toEqual(['open 1', 'close 3']);
    expect(t.kind()).toBeNull();
    const s = t.connect();
    const log = events(s);
    await tick();
    expect(s.readyState).toBe(0);
    expect(log).toEqual([]);
    const fresh = new FakeLink('relay');
    t.setLink(new Mux(fresh), 'up');
    expect(fresh.opens()).toEqual([{ type: F.WS_OPEN, stream: 1, text: 'tok' }]);
    expect(t.kind()).toBe('relay');
    fresh.deliver(F.WS_OPEN, 1);
    await tick();
    expect(log).toEqual(['open 1']);
    s.send('hi');
    expect(fresh.sent.some((f) => f.type === F.WS_MSG && f.text === 'hi')).toBe(true);
  });

  it('C1: a redial that gives up closes the waiting streams, asynchronously', async () => {
    const t = new ShellTunnel('tok');
    t.setLink(null, 'redialing');
    const s = t.connect();
    const log = events(s);
    t.setLink(null, 'down');
    expect(log).toEqual([]);
    await tick();
    expect(log).toEqual(['close 3']);
  });

  it('a stream closed by the app while it waits for a redial is not opened later', async () => {
    const t = new ShellTunnel('tok');
    t.setLink(null, 'redialing');
    const s = t.connect();
    const log = events(s);
    s.close();
    await tick();
    expect(log).toEqual(['close 3']);
    const link = new FakeLink();
    t.setLink(new Mux(link), 'up');
    expect(link.opens()).toEqual([]);
  });

  it('with no link at all a stream closes at once, but not from inside connect()', async () => {
    const t = new ShellTunnel('tok');
    const s = t.connect();
    expect(s.readyState).toBe(0);
    const log = events(s);
    await tick();
    expect(log).toEqual(['close 3']);
  });

  it('closeAll ends every stream (the app frame is reloaded): the PC is told for the open ones', async () => {
    const link = new FakeLink();
    const t = new ShellTunnel('tok');
    t.setLink(new Mux(link), 'up');
    const a = t.connect();
    const b = t.connect();
    const la = events(a);
    const lb = events(b);
    link.deliver(F.WS_OPEN, 1);
    await tick();
    t.closeAll();
    await tick();
    expect(la).toEqual(['open 1', 'close 3']);
    expect(lb).toEqual(['close 3']);
    expect(link.sent.filter((f) => f.type === F.WS_CLOSE).map((f) => f.stream).sort()).toEqual([1, 2]);
  });

  it('send() before open or after close is dropped, never thrown', () => {
    const t = new ShellTunnel('tok');
    const s = t.connect();
    expect(() => s.send('x')).not.toThrow();
    s.close();
    expect(() => s.send('x')).not.toThrow();
  });
});
