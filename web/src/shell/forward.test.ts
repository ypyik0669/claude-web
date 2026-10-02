import { describe, expect, it } from 'vitest';
import { readShellReply, readShellRequest, replyFromError, replyFromPc, replyNoWindow, responseParts, spaFallback, withToken } from './forward';

const enc = new TextEncoder();
const dec = new TextDecoder();
const RELAY_REFUSED = '慢速转发时不能预览 / 上传文件';
const bodyText = (b: ArrayBuffer | null) => (b ? dec.decode(new Uint8Array(b)) : '');

describe('what the shell window answers the service worker', () => {
  it("passes the PC's 413 through as it is (the preview shows that body, review focus 4)", () => {
    const r = replyFromPc({ status: 413, headers: { 'content-type': 'text/plain; charset=utf-8', 'content-length': '33' }, body: enc.encode(RELAY_REFUSED) });
    expect(r.status).toBe(413);
    expect(bodyText(r.body)).toBe(RELAY_REFUSED);
    expect(r.headers['content-type']).toBe('text/plain; charset=utf-8');
  });

  it('passes other answers through too, without the headers the new response sets itself', () => {
    const r = replyFromPc({ status: 206, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-1/10', 'content-length': '2', 'transfer-encoding': 'chunked' }, body: new Uint8Array([1, 2]) });
    expect(r.status).toBe(206);
    expect(r.headers).toEqual({ 'content-type': 'video/mp4', 'content-range': 'bytes 0-1/10' });
    expect([...new Uint8Array(r.body!)]).toEqual([1, 2]);
  });

  it('the body is a buffer of its own (it is transferred), even when the PC answer is a view on a bigger one', () => {
    const big = new Uint8Array([9, 9, 9, 1, 2, 3, 9]);
    const r = replyFromPc({ status: 200, headers: {}, body: big.subarray(3, 6) });
    expect(r.body!.byteLength).toBe(3);
    expect([...new Uint8Array(r.body!)]).toEqual([1, 2, 3]);
  });

  it("an ERR from the PC (English) is a 502 with a Chinese sentence and the original (R8c)", () => {
    const r = replyFromError(new Error('the response was cut off'));
    expect(r.status).toBe(502);
    expect(r.headers['content-type']).toMatch(/^text\/plain/);
    expect(bodyText(r.body)).toBe('电脑那边的响应中断了。（原文：the response was cut off）');
  });

  it('no shell window to ask is a 503 in Chinese', () => {
    const r = replyNoWindow();
    expect(r.status).toBe(503);
    expect(bodyText(r.body)).toMatch(/[一-鿿]/);
  });
});

describe('withToken', () => {
  it('adds the device token to the path sent over the link (never to an address the page navigates to)', () => {
    expect(withToken('/api/file?path=C%3A%5Cx.png', 'T/k+n')).toBe('/api/file?path=C%3A%5Cx.png&token=T%2Fk%2Bn');
    expect(withToken('/api/health', 'tok')).toBe('/api/health?token=tok');
  });

  it("replaces a token the app put there (the shell's is the one for this PC)", () => {
    expect(withToken('/api/file?token=old&path=a', 'new')).toBe('/api/file?token=new&path=a');
  });
});

describe('spaFallback', () => {
  const html = { status: 200, headers: { 'content-type': 'text/html' }, body: new Uint8Array(0) };
  it('a file the PC does not have comes back as its index.html', () => {
    expect(spaFallback('/assets/old-chunk.js', html)).toBe(true);
    expect(spaFallback('/assets/old-chunk.js?x=1', html)).toBe(true);
  });
  it('index.html itself, a directory, or a real file is not', () => {
    expect(spaFallback('/index.html', html)).toBe(false);
    expect(spaFallback('/', html)).toBe(false);
    expect(spaFallback('/assets/a.js', { ...html, headers: { 'content-type': 'text/javascript' } })).toBe(false);
    expect(spaFallback('/assets/a.js', { ...html, status: 404 })).toBe(false);
  });
});

describe('responseParts', () => {
  it('a status that cannot carry a body gets none', () => {
    const p = responseParts({ status: 304, headers: {}, body: new ArrayBuffer(3) });
    expect(p.body).toBeNull();
    expect(p.init.status).toBe(304);
    expect(() => new Response(p.body, p.init)).not.toThrow();
  });
  it('a status a Response cannot have becomes a 502', () => {
    expect(responseParts({ status: 101, headers: {}, body: null }).init.status).toBe(502);
    expect(responseParts({ status: 1000, headers: {}, body: null }).init.status).toBe(502);
  });
  it('builds a working Response', async () => {
    const p = responseParts({ status: 413, headers: { 'content-type': 'text/plain' }, body: enc.encode(RELAY_REFUSED).buffer as ArrayBuffer });
    const res = new Response(p.body, p.init);
    expect(res.status).toBe(413);
    expect(await res.text()).toBe(RELAY_REFUSED);
  });
});

describe('the messages between the service worker and the shell window', () => {
  it('a request: only well-formed ones are read', () => {
    const ok = { cw: 'fetch', v: 1, owner: 'w1', cache: 'cw-app-d1-0.1.5', kind: 'api', method: 'GET', path: '/api/file?path=a', headers: { range: 'bytes=0-' }, body: null };
    expect(readShellRequest(ok)).toEqual({ owner: 'w1', cache: 'cw-app-d1-0.1.5', kind: 'api', method: 'GET', path: '/api/file?path=a', headers: { range: 'bytes=0-' }, body: null });
    expect(readShellRequest({ ...ok, owner: null, cache: null })?.owner).toBeNull();
    expect(readShellRequest({ ...ok, v: 2 })).toBeNull();
    expect(readShellRequest({ ...ok, kind: 'shell' })).toBeNull();
    expect(readShellRequest({ ...ok, path: 'api/x' })).toBeNull();
    expect(readShellRequest({ ...ok, headers: { a: 1 } })?.headers).toEqual({});
    expect(readShellRequest(null)).toBeNull();
  });

  it('a reply: a skip, or a status with headers and a body', () => {
    expect(readShellReply({ skip: true })).toBe('skip');
    expect(readShellReply({ status: 200, headers: { a: 'b' }, body: new ArrayBuffer(1) })).toEqual({ status: 200, headers: { a: 'b' }, body: new ArrayBuffer(1) });
    expect(readShellReply({ status: 'x' })).toBeNull();
    expect(readShellReply(undefined)).toBeNull();
  });
});
