import { describe, expect, it } from 'vitest';
import { DialError, F, decodeFrame, type DialResult, type DialState, type Link, type LinkKind } from '@anywhere';
import { appVersion, cacheName, type CacheLike, type CachesLike } from './assets';
import type { DeviceRec } from './devices';
import { readShellRequest } from './forward';
import { frameParams } from './route';
import { Session, pairWith, type Dialer, type SessionView } from './session';
import type { PairLink } from './pair-link';

const enc = new TextEncoder();
const dec = new TextDecoder();
const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));
const SCOPE = 'https://ypyik0669.github.io/claude-web/';
const ID = 'a1b2c3d4e5f6';
const DEVICE: DeviceRec = { id: ID, pcName: 'my-pc', token: 'tok', pairedAt: 1 };
const INDEX = '<script type="module" src="./assets/index-A1.js"></script><link rel="stylesheet" href="./assets/index-C3.css">';
const PC_SILENT = '电脑没有回应：电脑可能关机、睡眠，或 Claude Web 没在运行。';
/** The cache the shell uses for this version and index.html. */
const cacheOf = async (version: string, index = INDEX) => cacheName(ID, await appVersion(version, enc.encode(index)));

interface Asked {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}
type Answer = { status: number; type?: string; body: string } | 'err' | 'drop';

/** The PC at the other end of a link: answers HTTP requests from `answer`, acks WebSockets. */
class FakePc implements Link {
  onframe: (f: Uint8Array) => void = () => {};
  onclose: (why: string) => void = () => {};
  asked: Asked[] = [];
  wsOpens: string[] = [];
  closed = false;
  private reqs = new Map<number, Asked>();
  constructor(
    public kind: LinkKind,
    private readonly answer: (a: Asked) => Answer,
  ) {}
  send(f: Uint8Array): void {
    const { type, stream, payload } = decodeFrame(f.slice());
    if (type === F.WS_OPEN) {
      this.wsOpens.push(dec.decode(payload));
      queueMicrotask(() => this.deliver(F.WS_OPEN, stream));
    } else if (type === F.HTTP_REQ) {
      const h = JSON.parse(dec.decode(payload));
      this.reqs.set(stream, { method: h.method, path: h.path, headers: h.headers, body: '' });
    } else if (type === F.BODY && this.reqs.has(stream)) {
      this.reqs.get(stream)!.body += dec.decode(payload);
    } else if (type === F.END && this.reqs.has(stream)) {
      const a = this.reqs.get(stream)!;
      this.reqs.delete(stream);
      this.asked.push(a);
      const r = this.answer(a);
      setTimeout(() => {
        if (this.closed) return;
        if (r === 'drop') return this.drop();
        if (r === 'err') return this.deliver(F.ERR, stream, 'the response was cut off');
        this.deliver(F.HTTP_RES, stream, JSON.stringify({ status: r.status, headers: { 'content-type': r.type ?? 'text/plain' } }));
        this.deliver(F.BODY, stream, r.body);
        this.deliver(F.END, stream);
      }, 0);
    }
  }
  buffered(): number {
    return 0;
  }
  close(): void {
    this.closed = true;
  }
  /** The link ends from the far side. */
  drop(why = 'the direct link closed'): void {
    this.closed = true;
    this.onclose(why);
  }
  deliver(type: F, stream: number, payload = ''): void {
    const body = enc.encode(payload);
    const f = new Uint8Array(5 + body.length);
    f[0] = type;
    new DataView(f.buffer).setUint32(1, stream);
    f.set(body, 5);
    this.onframe(f);
  }
}

function pcFiles(version: string, extra: Record<string, Answer> = {}, index = INDEX) {
  return (a: Asked): Answer => {
    const p = a.path.split('?')[0];
    if (extra[p]) return extra[p];
    if (p === '/api/health') return { status: 200, type: 'application/json', body: JSON.stringify({ ok: true, version }) };
    if (p === '/index.html') return { status: 200, type: 'text/html', body: index };
    if (p.startsWith('/assets/index-')) return { status: 200, type: p.endsWith('.css') ? 'text/css' : 'text/javascript', body: `/* ${version} ${p} */` };
    // what the PC's static server does for a file it does not have
    return { status: 200, type: 'text/html', body: index };
  };
}

function memoryCaches(opts: { failOpen?: boolean } = {}) {
  const store = new Map<string, Map<string, Response>>();
  const caches: CachesLike = {
    async open(name) {
      if (opts.failOpen) throw new Error('QuotaExceededError');
      if (!store.has(name)) store.set(name, new Map());
      const m = store.get(name)!;
      const c: CacheLike = {
        async match(key) {
          return m.get(key)?.clone();
        },
        async put(key, r) {
          m.set(key, r);
        },
      };
      return c;
    },
    async keys() {
      return [...store.keys()];
    },
    async delete(name) {
      return store.delete(name);
    },
  };
  return { caches, store, opts };
}

/** Dials hand out the next link of `plan`, or throw the next error. */
function fakeDialer(plan: (FakePc | DialError)[]) {
  const calls: { topic: string; fresh: boolean }[] = [];
  let idled = 0;
  const dialer: Dialer = {
    async dial(room, onstate: (s: DialState) => void, fresh) {
      calls.push({ topic: room.topic, fresh });
      onstate('finding');
      await tick();
      const next = plan.shift();
      if (!next) throw new DialError('pc-silent', 'no answer from the PC within 15000 ms');
      if (next instanceof DialError) throw next;
      onstate(next.kind === 'relay' ? 'relay' : 'connecting');
      return { link: next, pcName: 'my-pc' } satisfies DialResult;
    },
    idle() {
      idled++;
    },
  };
  return { dialer, calls, idled: () => idled };
}

function session(plan: (FakePc | DialError)[], o: { caches?: ReturnType<typeof memoryCaches>; rtcMissing?: boolean } = {}) {
  const views: SessionView[] = [];
  const caches = o.caches ?? memoryCaches();
  const d = fakeDialer(plan);
  const s = new Session({
    device: DEVICE,
    dialer: d.dialer,
    caches: caches.caches,
    scope: SCOPE,
    owner: 'w1',
    onview: (v) => views.push(v),
    redialDelays: [0, 0, 0],
    wait: () => tick(),
    rtcMissing: o.rtcMissing,
  });
  return { s, views, caches, ...d };
}

const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 300 && !cond(); i++) await tick(1);
  expect(cond(), what).toBe(true);
};
const last = <T>(a: T[]) => a[a.length - 1];

describe('Session: dial, the app files, the app', () => {
  it('dials, takes the version, index.html and the first-screen files, then opens the app with the device token on its streams', async () => {
    const pc = new FakePc('p2p-v6', pcFiles('0.1.5'));
    const t = session([pc]);
    await t.s.start();
    expect(t.views.map((v) => v.k)).toEqual(['dialing', 'dialing', 'files', 'files', 'files', 'files', 'open']);
    const open = last(t.views) as Extract<SessionView, { k: 'open' }>;
    expect(open.url.startsWith(`${SCOPE}app/index.html?cwshell=w1&cwcache=`)).toBe(true);
    expect(frameParams(open.url).cache).toBe(await cacheOf('0.1.5'));
    expect(open.kind).toBe('p2p-v6');
    expect(open.reload).toBe(false);
    // index.html once: it is what the cache's name is made from, and what lists the entry files
    expect(pc.asked.map((a) => a.path).sort()).toEqual(['/api/health', '/assets/index-A1.js', '/assets/index-C3.css', '/index.html']);
    // a direct link: the brokers can rest
    expect(t.idled()).toBe(1);
    const ws = t.s.tunnel.connect();
    let opened = false;
    ws.onopen = () => (opened = true);
    await until(() => opened, 'the stream opened');
    expect(pc.wsOpens).toEqual(['tok']);
  });

  it('a failed dial says why (spec §10), and the app never opens', async () => {
    const t = session([new DialError('no-broker', 'no signaling broker could be reached')]);
    await t.s.start();
    expect(last(t.views)).toEqual({ k: 'failed', why: { text: '连不上牵线服务器：这个网络可能拦了，换个网络试试。', raw: 'no signaling broker could be reached' } });
  });

  it('without RTCPeerConnection the failure says so in 原文 (C4: only when the slow-relay dial failed)', async () => {
    const t = session([new DialError('unreachable', 'the slow relay could not be opened: x')], { rtcMissing: true });
    await t.s.start();
    expect(t.views.filter((v) => v.k === 'dialing').length).toBeGreaterThan(0);
    expect(last(t.views)).toEqual({ k: 'failed', why: { text: '连不上。可以先用 IM 机器人（设置 → IM 机器人）。', raw: 'RTCPeerConnection missing; the slow relay could not be opened: x' } });
  });

  it('a first-screen file over the slow relay past its size limit is said as that limit', async () => {
    const t = session([new FakePc('relay', pcFiles('0.1.5', { ['/assets/index-C3.css']: { status: 413, body: '慢速转发时单个响应不能超过 2 MB' } }))]);
    await t.s.start();
    const f = last(t.views) as Extract<SessionView, { k: 'failed' }>;
    expect(f.k).toBe('failed');
    expect(f.why.text).toMatch(/慢速转发/);
    expect(f.why.text).not.toMatch(/重启/);
    expect(f.why.raw).toMatch(/413/);
    // the relay keeps the brokers
    expect(t.idled()).toBe(0);
  });

  it('a link that drops while the first files come is a dropped link: dialed again, then the app opens', async () => {
    const first = new FakePc('p2p-v4', pcFiles('0.1.5', { ['/assets/index-C3.css']: 'drop' }));
    const second = new FakePc('p2p-v4', pcFiles('0.1.5'));
    const t = session([first, second]);
    await t.s.start();
    expect(t.views.map((v) => v.k)).toContain('relinking');
    expect(t.views.map((v) => v.k)).not.toContain('failed');
    expect(last(t.views).k).toBe('open');
    expect(t.calls.map((c) => c.fresh)).toEqual([false, true]);
  });
});

describe('Session: the link drops while the app is open', () => {
  it('redials with fresh broker connections; a stream asked for meanwhile opens on the new link; the app is not reloaded', async () => {
    const first = new FakePc('p2p-v6', pcFiles('0.1.5'));
    const second = new FakePc('relay', pcFiles('0.1.5'));
    const t = session([first, second]);
    await t.s.start();
    const n = t.views.length;
    first.drop();
    expect(t.views[n]).toEqual({ k: 'relinking' });
    const ws = t.s.tunnel.connect();
    let opened = false;
    ws.onopen = () => (opened = true);
    await until(() => opened, 'the waiting stream opened on the new link');
    expect(second.wsOpens).toEqual(['tok']);
    expect(t.calls.map((c) => c.fresh)).toEqual([false, true]);
    expect(t.views.slice(n).map((v) => v.k)).toEqual(['relinking', 'dialing', 'dialing', 'linked']);
    expect(last(t.views)).toEqual({ k: 'linked', kind: 'relay' });
    // same build: the version and index.html are checked, no file is taken again
    expect(second.asked.map((a) => a.path)).toEqual(['/api/health', '/index.html']);
  });

  it('a PC that was upgraded meanwhile: the new version’s files, the old cache gone, the app reloaded on them', async () => {
    const first = new FakePc('p2p-v4', pcFiles('0.1.5'));
    const second = new FakePc('p2p-v4', pcFiles('0.1.6'));
    const t = session([first, second]);
    await t.s.start();
    const ws = t.s.tunnel.connect();
    let closes = 0;
    ws.onclose = () => closes++;
    first.drop();
    await until(() => last(t.views).k === 'open', 'reopened');
    const open = last(t.views) as Extract<SessionView, { k: 'open' }>;
    expect(open.reload).toBe(true);
    expect(frameParams(open.url).cache).toBe(await cacheOf('0.1.6'));
    expect([...t.caches.store.keys()]).toEqual([await cacheOf('0.1.6')]);
    expect(closes).toBe(1);
  });

  it('a rebuild at the same version (index.html changed) is a new build too: taken whole, the app reloaded', async () => {
    const rebuilt = '<script type="module" src="./assets/index-Z9.js"></script>';
    const first = new FakePc('p2p-v4', pcFiles('0.1.5'));
    const second = new FakePc('p2p-v4', pcFiles('0.1.5', {}, rebuilt));
    const t = session([first, second]);
    await t.s.start();
    first.drop();
    await until(() => last(t.views).k === 'open', 'reopened');
    const open = last(t.views) as Extract<SessionView, { k: 'open' }>;
    expect(open.reload).toBe(true);
    expect(frameParams(open.url).cache).toBe(await cacheOf('0.1.5', rebuilt));
    expect(second.asked.map((a) => a.path)).toContain('/assets/index-Z9.js');
    expect([...t.caches.store.keys()]).toEqual([await cacheOf('0.1.5', rebuilt)]);
  });

  it('every redial failing: the down view says why, waiting streams close', async () => {
    const first = new FakePc('p2p-v6', pcFiles('0.1.5'));
    const t = session([first]);
    await t.s.start();
    first.drop();
    const ws = t.s.tunnel.connect();
    let closed = false;
    ws.onclose = () => (closed = true);
    await until(() => last(t.views).k === 'down', 'gave up');
    expect(last(t.views)).toEqual({ k: 'down', why: { text: PC_SILENT, raw: 'no answer from the PC within 15000 ms' } });
    expect(t.calls.length).toBe(4);
    await until(() => closed, 'the waiting stream closed');
    // tapped 重新连接 (or the network came back): dials again
    void t.s.redial();
    await until(() => t.calls.length === 5, 'redialed on request');
  });

  it('a link that ended on a protocol error says the versions differ and does not redial on its own', async () => {
    const first = new FakePc('relay', pcFiles('0.1.5'));
    const t = session([first]);
    await t.s.start();
    first.drop('protocol: unknown kind 9');
    await tick();
    const d = last(t.views) as Extract<SessionView, { k: 'down' }>;
    expect(d.k).toBe('down');
    expect(d.why.text).toMatch(/版本不一致/);
    expect(t.calls.length).toBe(1);
  });
});

describe('Session: the frame’s requests, through the shell window', () => {
  const req = async (o: object) => readShellRequest({ cw: 'fetch', v: 1, owner: 'w1', cache: await cacheOf('0.1.5'), method: 'GET', headers: {}, body: null, ...o })!;
  const text = (b: ArrayBuffer | null) => (b ? dec.decode(new Uint8Array(b)) : '');

  it('api: the device token added over the link, the PC’s 413 passed through as it is', async () => {
    const pc = new FakePc('relay', pcFiles('0.1.5', { ['/api/file']: { status: 413, body: '慢速转发时不能预览 / 上传文件' } }));
    const t = session([pc]);
    await t.s.start();
    const r = await t.s.serve(await req({ kind: 'api', path: '/api/file?path=C%3A%5Ca.png', headers: { range: 'bytes=0-' } }));
    expect(r.status).toBe(413);
    expect(text(r.body)).toBe('慢速转发时不能预览 / 上传文件');
    const asked = last(pc.asked);
    expect(asked.path).toBe('/api/file?path=C%3A%5Ca.png&token=tok');
    expect(asked.headers.range).toBe('bytes=0-');
    // an <img> shows nothing for a 413: the shell says it too (review focus 4: a clear message, not a spinner)
    expect(last(t.views)).toEqual({ k: 'refused', text: '慢速转发时不能预览 / 上传文件' });
  });

  it('api: an ERR from the PC is a 502 in Chinese with the original', async () => {
    const pc = new FakePc('p2p-v6', pcFiles('0.1.5', { ['/api/attachments']: 'err' }));
    const t = session([pc]);
    await t.s.start();
    const r = await t.s.serve(await req({ kind: 'api', method: 'POST', path: '/api/attachments?sessionId=s&rel=a', body: enc.encode('xyz').buffer }));
    expect(r.status).toBe(502);
    expect(text(r.body)).toBe('电脑那边的响应中断了。（原文：the response was cut off）');
    expect(last(pc.asked).body).toBe('xyz');
  });

  it('asset: fetched when the frame asks, kept in its cache; one the PC does not have is a 404', async () => {
    const pc = new FakePc('p2p-v6', pcFiles('0.1.5', { ['/assets/lazy.js']: { status: 200, type: 'text/javascript', body: 'lazy' } }));
    const t = session([pc]);
    await t.s.start();
    const name = await cacheOf('0.1.5');
    const r = await t.s.serve(await req({ kind: 'asset', path: '/assets/lazy.js' }));
    expect(r.status).toBe(200);
    expect(text(r.body)).toBe('lazy');
    await until(() => !!t.caches.store.get(name)!.get(`${SCOPE}app/assets/lazy.js`), 'kept');
    expect(await t.caches.store.get(name)!.get(`${SCOPE}app/assets/lazy.js`)!.clone().text()).toBe('lazy');
    const gone = await t.s.serve(await req({ kind: 'asset', path: '/assets/old-chunk.js' }));
    expect(gone.status).toBe(404);
    expect(t.caches.store.get(name)!.has(`${SCOPE}app/assets/old-chunk.js`)).toBe(false);
  });

  it('the answer first, the cache after: a cache that fails never turns a good answer into a 502', async () => {
    const pc = new FakePc('p2p-v6', pcFiles('0.1.5', { ['/assets/lazy.js']: { status: 200, type: 'text/javascript', body: 'lazy' } }));
    const caches = memoryCaches();
    const t = session([pc], { caches });
    await t.s.start();
    caches.opts.failOpen = true;
    const r = await t.s.serve(await req({ kind: 'asset', path: '/assets/lazy.js' }));
    expect(r.status).toBe(200);
    expect(text(r.body)).toBe('lazy');
    await tick(5);
  });

  it('while redialing a request waits for the new link', async () => {
    const first = new FakePc('p2p-v6', pcFiles('0.1.5'));
    const second = new FakePc('p2p-v6', pcFiles('0.1.5', { ['/api/x']: { status: 200, body: 'ok' } }));
    const t = session([first, second]);
    await t.s.start();
    first.drop();
    const r = await t.s.serve(await req({ kind: 'api', path: '/api/x' }));
    expect(r.status).toBe(200);
    expect(text(r.body)).toBe('ok');
  });

  it('after close() nothing goes out and requests are answered at once', async () => {
    const pc = new FakePc('p2p-v6', pcFiles('0.1.5'));
    const t = session([pc]);
    await t.s.start();
    t.s.close();
    expect(pc.closed).toBe(true);
    const r = await t.s.serve(await req({ kind: 'api', path: '/api/x' }));
    expect(r.status).toBe(502);
  });
});

describe('pairWith', () => {
  const LINK: PairLink = { ps: new Uint8Array(16).fill(7), code: '123456', pc: 'qr-pc' };
  const paired = () => new FakePc('p2p-v6', (a) => (a.path === '/api/pair' ? { status: 200, type: 'application/json', body: JSON.stringify({ token: 'T', device: { id: ID, name: 'iPhone' } }) } : { status: 403, body: 'no' }));

  it('POSTs the code over the pairing link and returns the device to keep; the pairing link is closed after', async () => {
    const pc = paired();
    const rec = await pairWith(LINK, fakeDialer([pc]).dialer, () => {}, 'Mozilla/5.0 (iPhone)', { now: () => 42 });
    expect(rec).toEqual({ id: ID, pcName: 'my-pc', token: 'T', pairedAt: 42 });
    expect(pc.asked[0].method).toBe('POST');
    expect(JSON.parse(pc.asked[0].body)).toEqual({ code: '123456', name: '' });
    expect(pc.asked[0].headers['user-agent']).toBe('Mozilla/5.0 (iPhone)');
    expect(pc.closed).toBe(true);
  });

  it("the PC's refusal is what the user reads", async () => {
    const pc = new FakePc('relay', () => ({ status: 400, type: 'application/json', body: JSON.stringify({ error: '配对码不对' }) }));
    const err = await pairWith(LINK, fakeDialer([pc]).dialer, () => {}, 'x').catch((e) => e);
    expect(err.explained).toEqual({ text: '配对码不对', raw: '' });
    expect(err.pcAnswered).toBe(true);
    expect(pc.closed).toBe(true);
  });

  it('a QR the PC does not answer is an expired, used or replaced one (not "the PC may be off")', async () => {
    const err = await pairWith(LINK, fakeDialer([new DialError('pc-silent', 'no answer')]).dialer, () => {}, 'x').catch((e) => e);
    expect(err.explained).toEqual({ text: '电脑没有回应这个二维码：二维码可能已过期（10 分钟有效）、已经用过，或电脑上又生成了新的。在电脑上重新生成二维码再扫一次。', raw: 'no answer' });
    expect(err.pcAnswered).toBe(false);
  });

  it('cancelled (a newer pairing, or the screen left): its link is closed and its result dropped', async () => {
    const pc = paired();
    const ac = new AbortController();
    const p = pairWith(LINK, fakeDialer([pc]).dialer, () => {}, 'x', { signal: ac.signal }).catch((e) => e);
    ac.abort();
    const err = await p;
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AbortError');
    expect(pc.closed).toBe(true);
  });
});
