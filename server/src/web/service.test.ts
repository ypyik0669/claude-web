import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { BrowserCommand } from '../protocol.js';
import { MASK, MAX_IMAGE_CHARS, NEEDS_DESKTOP, WebService, decodeBody, maskWebSettings, type WebDeps } from './service.js';
import { CONTENT_END, CONTENT_START, SEARCH_FAILED_HINT } from './format.js';

/** SecretService's shape, without the platform keystore. */
const secrets = {
  protect: async (plain: string) => `enc:plain:${Buffer.from(plain, 'utf8').toString('base64')}`,
  reveal: async (v: string | undefined) => (v?.startsWith('enc:plain:') ? Buffer.from(v.slice('enc:plain:'.length), 'base64').toString('utf8') : v ?? ''),
};

function make(over: Partial<WebDeps> = {}, settings: Record<string, unknown> = {}) {
  const web = new WebService({ settings: () => settings, setSetting: async (k, v) => { if (v === undefined) delete settings[k]; else settings[k] = v; }, secrets, env: {}, lookup: async () => [], ...over });
  let changed = 0;
  web.on('changed', () => { changed++; });
  return { web, settings, changes: () => changed };
}

/** A window: what it was sent. */
function win() {
  const got: BrowserCommand[] = [];
  return { key: {}, got, send: (c: BrowserCommand) => { got.push(c); } };
}

const tick = () => new Promise((r) => setTimeout(r, 5));
const textOf = (r: { content: any[] }) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

describe('WebService: the window hosting the browser', () => {
  it('sends a command to the ONE most recently announced window and resolves with its answer', async () => {
    const { web, changes } = make();
    const a = win();
    const b = win();
    expect(web.status().host).toBe(false);
    web.setHost(a.key, true, a.send);
    expect(web.status().host).toBe(true);
    expect(changes()).toBe(1);
    const p = web.browser('sess-1', 'read', { offset: 0, maxChars: 500 });
    expect(a.got).toHaveLength(1);
    expect(a.got[0]).toMatchObject({ sessionId: 'sess-1', op: 'read', args: { offset: 0, maxChars: 500 } });
    expect(a.got[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(web.result(a.key, a.got[0].id, true, { page: { url: 'https://x.example/', title: 'X', text: 'hello', elements: [{ ref: 5 as any, role: 'button', name: 'Go' }, null as any] } })).toBe(true);
    // shapes are made sure of: a numeric ref becomes the string the model sends back, junk entries go
    expect(await p).toEqual({ page: { url: 'https://x.example/', title: 'X', text: 'hello', elements: [{ ref: '5', role: 'button', name: 'Go' }] } });

    // a second window announces: it gets the commands, the first gets nothing more, and nobody is told "host changed"
    web.setHost(b.key, true, b.send);
    expect(changes()).toBe(1);
    const p2 = web.browser('sess-1', 'back');
    expect(b.got).toHaveLength(1);
    expect(a.got).toHaveLength(1);
    web.result(b.key, b.got[0].id, true, {});
    expect(await p2).toEqual({});

    // it goes away: the first is still connected and takes over; announcing again makes a window the most recent
    web.dropConnection(b.key);
    expect(web.status().host).toBe(true);
    void web.browser('s', 'scroll', { direction: 'down' }).catch(() => {});
    expect(a.got).toHaveLength(2);
    web.setHost(b.key, true, b.send);
    web.setHost(a.key, true, a.send);
    void web.browser('s', 'key', { key: 'Enter' }).catch(() => {});
    expect(a.got).toHaveLength(3);
    expect(b.got).toHaveLength(1);
    web.dropConnection(a.key);
    web.dropConnection(b.key);
    expect(web.status().host).toBe(false);
    expect(changes()).toBe(2);
  });

  it('only the window that was asked can answer; its error is the error; a late answer is not taken', async () => {
    const { web } = make({ commandTimeoutMs: 40 });
    const a = win();
    const other = win();
    web.setHost(a.key, true, a.send);
    const p = web.browser('s', 'click', { ref: '3' });
    expect(web.result(other.key, a.got[0].id, true, { note: 'not mine' })).toBe(false);
    expect(web.result(a.key, 'no-such-id', true, {})).toBe(false);
    expect(web.result(a.key, a.got[0].id, false, undefined, '没有 ref 3 这个元素')).toBe(true);
    await expect(p).rejects.toThrow('没有 ref 3 这个元素');
    // no answer in time
    const slow = web.browser('s', 'click', { ref: '4' });
    await expect(slow).rejects.toThrow(/没有回应/);
    expect(web.result(a.key, a.got[1].id, true, {})).toBe(false);
  });

  it('a window that goes away (or stops hosting) fails what it was asked at once', async () => {
    const { web } = make({ commandTimeoutMs: 60_000 });
    const a = win();
    web.setHost(a.key, true, a.send);
    const p1 = web.browser('s', 'screenshot');
    const p2 = web.browser('s', 'read');
    web.dropConnection(a.key);
    await expect(p1).rejects.toThrow(/断开/);
    await expect(p2).rejects.toThrow(/断开/);
    const b = win();
    web.setHost(b.key, true, b.send);
    const p3 = web.browser('s', 'read');
    web.setHost(b.key, false);
    await expect(p3).rejects.toThrow(/不再提供/);
    expect(web.status().host).toBe(false);
    // a send that throws (the socket closed under it) is a failure, not a hang
    const c = win();
    web.setHost(c.key, true, () => { throw new Error('socket closed'); });
    await expect(web.browser('s', 'read')).rejects.toThrow(/socket closed/);
  });

  it('a screenshot is the one large answer: taken up to the limit, refused beyond it, and only for a screenshot', async () => {
    const { web } = make();
    const a = win();
    web.setHost(a.key, true, a.send);
    const ok = web.browser('s', 'screenshot');
    web.result(a.key, a.got[0].id, true, { image: { mime: 'image/jpeg', data: 'A'.repeat(1_000_000) }, page: { url: 'https://x.example/', title: '', text: '' } });
    expect((await ok).image?.data).toHaveLength(1_000_000);
    const big = web.browser('s', 'screenshot');
    web.result(a.key, a.got[1].id, true, { image: { mime: 'image/png', data: 'A'.repeat(MAX_IMAGE_CHARS + 1) } });
    await expect(big).rejects.toThrow(/截图太大/);
    const wrong = web.browser('s', 'screenshot');
    web.result(a.key, a.got[2].id, true, { image: { mime: 'image/svg+xml' as any, data: '<svg/>' } });
    await expect(wrong).rejects.toThrow(/格式不对/);
    const read = web.browser('s', 'read');
    web.result(a.key, a.got[3].id, true, { image: { mime: 'image/png', data: 'AAAA' }, note: 'n' });
    expect(await read).toEqual({ note: 'n' });
  });

  it('refuses addresses no browser tool may open, before any window is asked', async () => {
    const { web } = make();
    const a = win();
    web.setHost(a.key, true, a.send);
    await expect(web.browser('s', 'open', { url: 'file:///etc/passwd' })).rejects.toThrow(/file:/);
    await expect(web.browser('s', 'open', { url: 'http://169.254.169.254/latest/meta-data/' })).rejects.toThrow(/元数据/);
    await expect(web.browser('s', 'open', {})).rejects.toThrow(/不是一个完整的网址/);
    expect(a.got).toHaveLength(0);
    // the user's own browser may open the LAN and the dev server
    void web.browser('s', 'open', { url: 'http://192.168.1.10:8080/' }).catch(() => {});
    void web.browser('s', 'open', { url: 'http://localhost:5173/' }).catch(() => {});
    expect(a.got.map((c) => c.args.url)).toEqual(['http://192.168.1.10:8080/', 'http://localhost:5173/']);
    web.dropConnection(a.key);
  });
});

describe('WebService: no window — this server reads the page', () => {
  let site: http.Server;
  let other: http.Server;
  let base = '';
  let otherPort = 0;
  const hits: string[] = [];
  beforeAll(async () => {
    site = http.createServer((req, res) => {
      hits.push(req.url ?? '');
      const send = (status: number, type: string, body: string | Buffer, extra: Record<string, string> = {}) => { res.writeHead(status, { 'content-type': type, ...extra }); res.end(body); };
      switch ((req.url ?? '').split('?')[0]) {
        case '/page': return send(200, 'text/html; charset=utf-8', '<html><head><title>Test page</title></head><body><h1>Hello</h1><p>The quick brown fox. <a href="/next">Next page</a> <a href="https://out.example/x">Outside</a></p><script>ignored()</script></body></html>');
        case '/long': return send(200, 'text/html', `<title>Long</title><p>${'word '.repeat(6000)}NEEDLE here${' tail'.repeat(100)}</p>`);
        case '/redirect': return send(302, 'text/plain', '', { location: '/page' });
        case '/loop': return send(302, 'text/plain', '', { location: '/loop' });
        case '/to-lan': return send(302, 'text/plain', '', { location: 'http://192.168.77.1/admin' });
        case '/to-self': return send(302, 'text/plain', '', { location: `http://127.0.0.1:${otherPort}/api/file?path=/etc/passwd` });
        case '/gbk': return send(200, 'text/html; charset=gbk', Buffer.concat([Buffer.from('<title>'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), Buffer.from('</title><p>'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), Buffer.from('</p>')]));
        case '/json': return send(200, 'application/json', '{"a": 1,\r\n "b": "<not html>"}');
        case '/plain': return send(200, 'text/plain; charset=utf-8', 'just\ntext & <b>no</b> markup');
        case '/pdf': return send(200, 'application/pdf', '%PDF-1.7');
        case '/forbidden': return send(403, 'text/html', '<h1>blocked</h1>');
        default: return send(404, 'text/html', '<h1>nope</h1>');
      }
    });
    other = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('this is claude-web itself'); });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', () => r()));
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    otherPort = (other.address() as AddressInfo).port;
  });
  afterAll(async () => {
    site.closeAllConnections();
    other.closeAllConnections();
    await new Promise((r) => site.close(r));
    await new Promise((r) => other.close(r));
  });

  it('open fetches the page and turns it into text + links; read and find work on what was kept, per conversation', async () => {
    const { web } = make();
    const r = await web.browser('s1', 'open', { url: `${base}/page` });
    expect(r.page).toEqual({
      url: `${base}/page`, title: 'Test page', text: '# Hello\n\nThe quick brown fox. Next page Outside',
      elements: [{ ref: '1', role: 'link', name: 'Next page', href: `${base}/next` }, { ref: '2', role: 'link', name: 'Outside', href: 'https://out.example/x' }],
    });
    const read = await web.browser('s1', 'read', { offset: 9, maxChars: 500 });
    expect(read.page).toEqual({ url: `${base}/page`, title: 'Test page', text: 'The quick brown fox. Next page Outside' });
    const found = await web.browser('s1', 'find', { query: 'NEXT' });
    expect(found.elements).toEqual([{ ref: '1', role: 'link', name: 'Next page', href: `${base}/next` }]);
    expect(found.note).toContain('第 30 个字符附近');
    expect((await web.browser('s1', 'find', { query: 'out.example' })).elements?.[0].name).toBe('Outside'); // by address too
    expect(await web.browser('s1', 'find', { query: 'zebra' })).toEqual({ page: { url: `${base}/page`, title: 'Test page', text: '' }, elements: [] });
    // another conversation has no page yet
    await expect(web.browser('s2', 'read')).rejects.toThrow(/还没有打开网页/);
    await expect(web.browser('s2', 'find', { query: 'x' })).rejects.toThrow(/还没有打开网页/);
  });

  it('a long page comes in pieces that join up', async () => {
    const { web } = make();
    const first = (await web.browser('s', 'open', { url: `${base}/long` })).page!;
    expect(first.text).toHaveLength(12_000);
    expect(first.truncated).toBe(true);
    expect(first.nextOffset).toBe(12_000);
    const second = (await web.browser('s', 'read', { offset: first.nextOffset, maxChars: 60_000 })).page!;
    expect(second.truncated).toBeUndefined();
    expect(second.elements).toBeUndefined(); // the elements go with the top of the page only
    const whole = first.text + second.text;
    expect(whole.startsWith('word word word')).toBe(true);
    expect(whole.endsWith('tail tail')).toBe(true);
    expect(whole).toHaveLength('word '.repeat(6000).length + 'NEEDLE here'.length + ' tail'.repeat(100).length);
    const spot = (await web.browser('s', 'find', { query: 'needle' })).note!;
    expect(spot).toContain(`第 ${whole.indexOf('NEEDLE')} 个字符附近`);
    expect((await web.browser('s', 'read', { offset: 10 ** 9 })).page!.text).toBe(''); // past the end: nothing, no error
  });

  it('follows redirects itself, judging every hop: not into the LAN, not into this server, not for ever', async () => {
    const { web } = make({ ownPorts: () => [otherPort] });
    expect((await web.browser('s', 'open', { url: `${base}/redirect` })).page!.url).toBe(`${base}/page`);
    await expect(web.browser('s', 'open', { url: `${base}/to-lan` })).rejects.toThrow(/跳转到了 http:\/\/192\.168\.77\.1\/admin。.*内网/);
    await expect(web.browser('s', 'open', { url: `${base}/to-self` })).rejects.toThrow(/Claude Web 自己/);
    await expect(web.browser('s', 'open', { url: `${base}/loop` })).rejects.toThrow(/跳转了太多次/);
    // asked for directly: the same answers, and nothing is fetched
    const before = hits.length;
    await expect(web.browser('s', 'open', { url: `http://127.0.0.1:${otherPort}/` })).rejects.toThrow(/Claude Web 自己/);
    await expect(web.browser('s', 'open', { url: 'http://10.0.0.8/' })).rejects.toThrow(/内网/);
    await expect(web.browser('s', 'open', { url: 'ftp://example.com/' })).rejects.toThrow(/ftp:/);
    expect(hits.length).toBe(before);
    // the page kept is still the last one that opened
    expect((await web.browser('s', 'read')).page!.title).toBe('Test page');
  });

  it('a name that resolves into the LAN is refused before the request; an unknown one is left to the fetch', async () => {
    const calls: string[] = [];
    const fake = (async (u: any) => { calls.push(String(u)); return new Response('<title>ok</title><p>public</p>', { headers: { 'content-type': 'text/html' } }); }) as unknown as typeof fetch;
    const lan = make({ fetch: fake, lookup: async (h) => (h === 'intranet.example' ? ['192.168.5.5'] : h === 'meta.example' ? ['169.254.169.254'] : ['93.184.216.34']) });
    await expect(lan.web.browser('s', 'open', { url: 'http://intranet.example/wiki' })).rejects.toThrow(/内网/);
    await expect(lan.web.browser('s', 'open', { url: 'http://meta.example/' })).rejects.toThrow(/元数据/);
    expect(calls).toEqual([]);
    expect((await lan.web.browser('s', 'open', { url: 'https://public.example/a' })).page!.text).toBe('public');
    const unknown = make({ fetch: fake, lookup: async () => { throw new Error('ENOTFOUND'); } });
    expect((await unknown.web.browser('s', 'open', { url: 'https://only-the-proxy-knows.example/' })).page!.title).toBe('ok');
  });

  it('reads the page in its own encoding; text and JSON as they are; says what it cannot read', async () => {
    const { web } = make();
    const gbk = (await web.browser('s', 'open', { url: `${base}/gbk` })).page!;
    expect(gbk.title).toBe('中文');
    expect(gbk.text).toBe('中文');
    expect((await web.browser('s', 'open', { url: `${base}/json` })).page!.text).toBe('{"a": 1,\n "b": "<not html>"}');
    expect((await web.browser('s', 'open', { url: `${base}/plain` })).page!.text).toBe('just\ntext & <b>no</b> markup');
    await expect(web.browser('s', 'open', { url: `${base}/pdf` })).rejects.toThrow(/不是网页或文字（application\/pdf）/);
    await expect(web.browser('s', 'open', { url: `${base}/missing` })).rejects.toThrow(/HTTP 404/);
    await expect(web.browser('s', 'open', { url: `${base}/forbidden` })).rejects.toThrow(/HTTP 403（这个网站可能拒绝了不是浏览器的访问）/);
    await expect(web.browser('s', 'open', { url: 'http://127.0.0.1:9/' })).rejects.toThrow(/打不开 http:\/\/127\.0\.0\.1:9\//);
    expect(decodeBody(Buffer.from('<meta charset="gb2312"><p>'), '')).toContain('<p>');
    expect(decodeBody(Buffer.concat([Buffer.from('<meta http-equiv="content-type" content="text/html; charset=gbk">'), Buffer.from([0xd6, 0xd0])]), 'text/html')).toContain('中');
    expect(decodeBody(Buffer.from('é'), 'text/html; charset=no-such-encoding')).toBe('é');
  });

  it('what needs a real browser says so; the proxy is looked at before going out', async () => {
    let looked = 0;
    const { web } = make({ goingOut: async () => { looked++; } });
    for (const op of ['click', 'type', 'key', 'scroll', 'back', 'screenshot'] as const) {
      await expect(web.browser('s', op, { ref: '1' })).rejects.toThrow(NEEDS_DESKTOP);
    }
    expect(NEEDS_DESKTOP).toBe('这个操作需要桌面版 Claude Web 的内置浏览器（现在没有桌面窗口连着）。');
    expect(looked).toBe(0);
    await web.browser('s', 'open', { url: `${base}/page` });
    expect(looked).toBe(1);
    await web.browser('s', 'read'); // from what was kept: nothing goes out
    expect(looked).toBe(1);
  });
});

describe('WebService: search, keys, status', () => {
  const tavily = (async (u: any, init: any = {}) => {
    const auth = new Headers(init.headers).get('authorization');
    if (String(u).startsWith('https://api.tavily.com/')) return new Response(JSON.stringify(auth === 'Bearer tvly-unit-test' ? { results: [{ title: 'From Tavily', url: 'https://t.example/', content: 'c' }] } : { detail: { error: 'Unauthorized' } }), { status: auth === 'Bearer tvly-unit-test' ? 200 : 401 });
    if (String(u).startsWith('https://www.bing.com/')) return new Response('<ol id="b_results"><li class="b_algo"><h2><a href="https://b.example/">From Bing</a></h2></li></ol>', { status: 200 });
    return new Response('', { status: 500 });
  }) as unknown as typeof fetch;

  it('a key is stored protected, read back only as a mask, used by the search, and removable', async () => {
    const { web, settings, changes } = make({ fetch: tavily });
    expect(web.status().engines).toEqual([
      { id: 'auto', label: '自动（Bing → DuckDuckGo）', needsKey: false },
      { id: 'bing', label: 'Bing', needsKey: false },
      { id: 'duckduckgo', label: 'DuckDuckGo', needsKey: false },
      { id: 'tavily', label: 'Tavily', needsKey: true, hasKey: false },
      { id: 'brave', label: 'Brave Search', needsKey: true, hasKey: false },
    ]);
    expect((await web.search('q')).engine).toBe('bing');
    await web.setKey('web.search.tavilyKey', '  tvly-unit-test  ');
    expect(settings['web.search.tavilyKey']).toMatch(/^enc:/);
    expect(String(settings['web.search.tavilyKey'])).not.toContain('tvly-unit-test');
    expect(maskWebSettings(settings)['web.search.tavilyKey']).toBe(MASK);
    expect(JSON.stringify(web.status())).not.toContain('tvly');
    expect(web.status().engines.find((e) => e.id === 'tavily')?.hasKey).toBe(true);
    expect(changes()).toBe(1);
    expect(await web.search('q')).toEqual({ engine: 'tavily', results: [{ title: 'From Tavily', url: 'https://t.example/', snippet: 'c' }] });
    // the mask sent back by a settings page changes nothing
    const stored = settings['web.search.tavilyKey'];
    await web.setKey('web.search.tavilyKey', MASK);
    expect(settings['web.search.tavilyKey']).toBe(stored);
    expect((await web.search('q')).engine).toBe('tavily');
    // '' removes it
    await web.setKey('web.search.tavilyKey', '');
    expect('web.search.tavilyKey' in settings).toBe(false);
    expect(web.status().engines.find((e) => e.id === 'tavily')?.hasKey).toBe(false);
    expect((await web.search('q')).engine).toBe('bing');
  });

  it('the stored keys are read once at start; one that cannot be read counts as not set', async () => {
    const stored = { 'web.search.tavilyKey': await secrets.protect('tvly-unit-test'), 'web.search.braveKey': 'enc:dpapi:broken' };
    const failing = { ...secrets, reveal: async (v: string | undefined) => { if (v?.includes('broken')) throw new Error('无法解密'); return secrets.reveal(v); } };
    const { web } = make({ fetch: tavily, secrets: failing }, stored);
    const warn = console.warn;
    const said: string[] = [];
    console.warn = (...a: unknown[]) => { said.push(a.join(' ')); };
    try { await web.warm(); } finally { console.warn = warn; }
    expect(said.join('\n')).toContain('brave');
    expect(said.join('\n')).not.toContain('tvly-unit-test');
    expect(web.status().engines.filter((e) => e.needsKey).map((e) => e.hasKey)).toEqual([true, false]);
    expect((await web.search('q')).engine).toBe('tavily');
  });

  it('the engine setting is followed (anything unknown reads as auto); a call can name its own', async () => {
    const { web, settings } = make({ fetch: tavily });
    settings['web.search.engine'] = 'tavily';
    await expect(web.search('q')).rejects.toThrow(/Tavily：还没有填 API Key/);
    expect(web.status().engine).toBe('tavily');
    settings['web.search.engine'] = 'yahoo';
    expect(web.status().engine).toBe('auto');
    expect((await web.search('q')).engine).toBe('bing');
    expect((await web.search('q', { engine: 'bing' })).engine).toBe('bing');
  });

  it('an engine that did not answer is left out of the next searches — until a 联网 setting or the proxy changes', async () => {
    const asked: string[] = [];
    const net = (async (u: any) => {
      const host = new URL(String(u)).host;
      asked.push(host);
      if (host === 'www.bing.com') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ETIMEDOUT' } });
      return new Response('<div class="result"><a class="result__a" href="https://d.example/">From DuckDuckGo</a></div>', { status: 200 });
    }) as unknown as typeof fetch;
    const { web } = make({ fetch: net });
    const bingAsked = () => asked.filter((h) => h === 'www.bing.com').length;
    expect((await web.search('q')).engine).toBe('duckduckgo');
    expect((await web.search('q')).engine).toBe('duckduckgo');
    expect((await web.search('other')).engine).toBe('duckduckgo');
    expect(bingAsked()).toBe(1); // not waited for three times
    // the user picked another engine / turned something in 联网: start over
    web.settingsChanged();
    await web.search('q');
    expect(bingAsked()).toBe(2);
    // a proxy was set (the reason Bing could not be reached may be gone)
    web.networkChanged();
    await web.search('q');
    expect(bingAsked()).toBe(3);
    await web.search('q');
    expect(bingAsked()).toBe(3);
    // named in a call, it is asked whatever happened
    await expect(web.search('q', { engine: 'bing' })).rejects.toThrow(/Bing：ETIMEDOUT/);
    expect(bingAsked()).toBe(4);
  });

  it('results that only half fit the query are handed on with a warning', async () => {
    const shallow = (async (u: any) => (String(u).startsWith('https://www.bing.com/')
      ? new Response('<ol id="b_results"><li class="b_algo"><h2><a href="https://sqlite.example/">SQLite Home Page</a></h2></li></ol>', { status: 200 })
      : new Response('bots', { status: 202 }))) as unknown as typeof fetch;
    const { web } = make({ fetch: shallow });
    const r = await web.tool('s', 'web_search', { query: 'sqlite fts5 trigram tokenizer' });
    expect(r.isError).toBeUndefined();
    expect(textOf(r)).toContain('1. SQLite Home Page');
    expect(textOf(r)).toContain('注意：这些结果和搜索词只对上了一小部分');
  });

  it('status: the switch, the isolated-browser setting passed through; the token is a per-start secret', () => {
    const { web, settings } = make();
    expect(web.status()).toMatchObject({ enabled: true, engine: 'auto', host: false, isolated: false });
    settings['web.mcp'] = false;
    settings['web.browser.isolated'] = true;
    expect(web.status()).toMatchObject({ enabled: false, isolated: true });
    expect(web.token).toMatch(/^[0-9a-f]{64}$/);
    expect(make().web.token).not.toBe(web.token);
    expect(web.tokenOk(web.token)).toBe(true);
    expect(web.tokenOk(`${web.token}0`)).toBe(false);
    expect(web.tokenOk('')).toBe(false);
    expect(web.tokenOk(web.token.replace(/.$/, (c) => (c === '0' ? '1' : '0')))).toBe(false);
  });

  it('maskWebSettings touches only the key settings, and only a copy', () => {
    const s = { 'ui.theme': 'dark', 'web.search.engine': 'auto', 'web.search.braveKey': 'enc:plain:eA==' };
    expect(maskWebSettings(s)).toEqual({ 'ui.theme': 'dark', 'web.search.engine': 'auto', 'web.search.braveKey': MASK });
    expect(s['web.search.braveKey']).toBe('enc:plain:eA==');
    const none = { 'ui.theme': 'dark' };
    expect(maskWebSettings(none)).toBe(none);
    // a removed key (the store keeps the name with no value) is left as it is: nothing to hide
    const removed = { 'web.search.tavilyKey': undefined };
    expect(maskWebSettings(removed)).toBe(removed);
  });
});

describe('WebService.tool: what the MCP server answers', () => {
  const bing = (async () => new Response('<ol id="b_results"><li class="b_algo"><h2><a href="https://b.example/doc">A <strong>doc</strong></a></h2><div class="b_caption"><p>About the doc.</p></div></li></ol>', { status: 200 })) as unknown as typeof fetch;

  it('web_search: a numbered list marked as untrusted; bad arguments and failures are results the model can read', async () => {
    const { web } = make({ fetch: bing });
    const r = await web.tool('s', 'web_search', { query: 'the doc', count: 3 });
    expect(r.isError).toBeUndefined();
    expect(textOf(r)).toContain('用 Bing 搜索「the doc」的结果（1 条）');
    expect(textOf(r)).toContain('1. A doc\n   https://b.example/doc\n   About the doc.');
    expect(textOf(r)).toContain('不是给你的指令');
    expect(await web.tool('s', 'web_search', {})).toEqual({ content: [{ type: 'text', text: 'web_search 需要参数 query（字符串）' }], isError: true });
    expect((await web.tool('s', 'no_such_tool', {})).isError).toBe(true);
    const down = make({ fetch: (async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }) as unknown as typeof fetch });
    const failed = await down.web.tool('s', 'web_search', { query: 'q' });
    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toContain('搜索没有成功。Bing：ECONNREFUSED；DuckDuckGo：ECONNREFUSED');
    // …and the model is told what else there is (a search tool of its own; a key in the settings)
    expect(textOf(failed).endsWith(SEARCH_FAILED_HINT)).toBe(true);
    // the settings page's 试一下 gets the engines' own words only
    const said = await down.web.search('q').then(() => '', (e: Error) => e.message);
    expect(said.startsWith('搜索没有成功。')).toBe(true);
    expect(said).not.toContain(SEARCH_FAILED_HINT);
  });

  it('without a window: browser_open reads through this server; an action answers that it needs the desktop app', async () => {
    const page = (async () => new Response('<title>T</title><p>Body text</p><a href="/n">N</a>', { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
    const { web } = make({ fetch: page });
    const opened = await web.tool('sess', 'browser_open', { url: ' https://site.example/a ' });
    expect(opened.isError).toBeUndefined();
    expect(textOf(opened).startsWith('来源：https://site.example/a\n标题：T\n')).toBe(true); // the address the model asked for, trimmed
    expect(textOf(opened)).toContain(`${CONTENT_START} https://site.example/a>>>\nBody text\n\nN\n${CONTENT_END}`);
    expect(textOf(opened)).toContain('[1] link "N" → https://site.example/n');
    expect(textOf(await web.tool('sess', 'browser_read', { offset: 5 }))).toContain(`>>>\ntext\n\nN\n${CONTENT_END}\n（正文到这里结束`);
    expect(textOf(await web.tool('sess', 'browser_find', { query: 'body' }))).toContain('第 0 个字符附近：Body text N');
    for (const [tool, args] of [['browser_click', { ref: 1 }], ['browser_type', { ref: '1', text: 'x' }], ['browser_press_key', { key: 'Enter' }], ['browser_scroll', { direction: 'down' }], ['browser_back', {}], ['browser_screenshot', {}]] as const) {
      const r = await web.tool('sess', tool, args as Record<string, unknown>);
      expect(r.isError, tool).toBe(true);
      expect(textOf(r), tool).toContain(NEEDS_DESKTOP);
      expect(textOf(r), tool).toContain(tool);
    }
    expect(textOf(await web.tool('sess', 'browser_open', { url: 'file:///C:/x' }))).toContain('只能打开 http / https');
  });

  it('with a window: arguments go over as the contract says, the answers come back formatted, a screenshot as an image', async () => {
    const { web } = make();
    const w = win();
    web.setHost(w.key, true, w.send);
    const page = { url: 'https://app.example/', title: 'App', text: 'Welcome back', elements: [{ ref: 'e7', role: 'textbox', name: 'Search', value: '' }] };
    const call = async (tool: string, args: Record<string, unknown>, answer: any) => {
      const p = web.tool('conv-9', tool, args);
      await tick();
      const cmd = w.got[w.got.length - 1];
      web.result(w.key, cmd.id, true, answer);
      return { cmd, r: await p };
    };
    const open = await call('browser_open', { url: 'https://app.example/' }, { page });
    expect(open.cmd).toMatchObject({ sessionId: 'conv-9', op: 'open', args: { url: 'https://app.example/' } });
    expect(textOf(open.r)).toContain('[e7] textbox "Search"');
    expect((await call('browser_read', { offset: 100, max_chars: 2000 }, { page: { ...page, text: 'later text' } })).cmd).toMatchObject({ op: 'read', args: { offset: 100, maxChars: 2000 } });
    expect((await call('browser_read', {}, { page })).cmd.args).toEqual({ offset: 0, maxChars: 12_000 });
    expect((await call('browser_find', { query: 'search' }, { elements: page.elements })).cmd).toMatchObject({ op: 'find', args: { query: 'search' } });
    // a model often sends the ref as a number, or with the brackets it was shown in
    expect((await call('browser_click', { ref: 7 }, { page })).cmd).toMatchObject({ op: 'click', args: { ref: '7' } });
    expect((await call('browser_click', { ref: '[e7]' }, {})).cmd.args).toEqual({ ref: 'e7' });
    const typed = await call('browser_type', { ref: 'e7', text: 'hello', submit: true }, { page, note: '已输入并提交。' });
    expect(typed.cmd).toMatchObject({ op: 'type', args: { ref: 'e7', text: 'hello', submit: true } });
    expect(textOf(typed.r)).toContain('已输入并提交。');
    expect((await call('browser_type', { ref: 'e7', text: '' }, {})).cmd.args).toEqual({ ref: 'e7', text: '' }); // clearing a field is typing nothing
    expect((await call('browser_press_key', { key: 'Escape' }, {})).cmd).toMatchObject({ op: 'key', args: { key: 'Escape' } });
    expect((await call('browser_scroll', { direction: 'up', amount: 2 }, {})).cmd).toMatchObject({ op: 'scroll', args: { direction: 'up', amount: 2 } });
    expect((await call('browser_scroll', {}, {})).cmd.args).toEqual({ direction: 'down' });
    const back = await call('browser_back', {}, {});
    expect(back.cmd).toMatchObject({ op: 'back', args: {} });
    expect(textOf(back.r)).toBe('已返回上一页。');
    const shot = await call('browser_screenshot', {}, { image: { mime: 'image/jpeg', data: 'QUJD' }, page: { url: 'https://app.example/', title: 'App', text: '' } });
    expect(shot.r.content).toEqual([{ type: 'text', text: expect.stringContaining('当前页面的截图（https://app.example/）') }, { type: 'image', data: 'QUJD', mimeType: 'image/jpeg' }]);
    // nothing reaches the window for arguments that make no sense
    const n = w.got.length;
    expect((await web.tool('conv-9', 'browser_click', {})).isError).toBe(true);
    expect((await web.tool('conv-9', 'browser_type', { ref: 'e7' })).isError).toBe(true);
    expect((await web.tool('conv-9', 'browser_scroll', { direction: 'sideways' })).isError).toBe(true);
    expect(w.got).toHaveLength(n);
    // the window's own failure is what the model reads
    const p = web.tool('conv-9', 'browser_click', { ref: 'e99' });
    await tick();
    web.result(w.key, w.got[w.got.length - 1].id, false, undefined, '页面上没有 e99');
    expect(await p).toEqual({ content: [{ type: 'text', text: '页面上没有 e99' }], isError: true });
    web.dropConnection(w.key);
  });
});
