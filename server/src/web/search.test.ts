import { describe, expect, it } from 'vitest';
import { ENGINES, NEEDS_BROWSER, REFUSED_COOLDOWN_MS, UNREACHABLE_COOLDOWN_MS, acceptLanguage, autoOrder, bingMarket, clampCount, engineSetting, search, type BrowserSearch, type Cooldown } from './search.js';
import type { RawSearchPage } from './engines/pages.js';

const bingPage = (items: [string, string][]) => `<html><body><ol id="b_results">${items.map(([t, u]) => `<li class="b_algo"><h2><a href="${u}">${t}</a></h2><div class="b_caption"><p class="b_lineclamp2">about ${t}</p></div></li>`).join('')}</ol></body></html>`;
const ddgPage = (items: [string, string][]) => `<div id="links">${items.map(([t, u]) => `<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(u)}&amp;rut=0">${t}</a><a class="result__snippet" href="#">about ${t}</a></div>`).join('')}</div>`;
const BING_EMPTY = '<html><body><ol id="b_results"><li class="b_no">nothing</li></ol></body></html>';
const DDG_EMPTY = '<div class="no-results">No results.</div>';
const WALL = '<html><body><div class="captcha-container">One last step</div></body></html>';

interface Call { url: string; method: string; headers: Record<string, string>; body?: string }
/** A fetch that answers by host; every call is kept. */
function fakeFetch(routes: Record<string, (c: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fn = (async (input: any, init: any = {}) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = String(v);
    const call: Call = { url, method: init.method ?? 'GET', headers, body: init.body };
    calls.push(call);
    if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const route = routes[new URL(url).host];
    if (!route) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    return route(call);
  }) as unknown as typeof fetch;
  return { fn, calls, hosts: () => calls.map((c) => new URL(c.url).host) };
}
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const failing = (code: string) => () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code } }); };

describe('search without a browser (the web app, a phone): the result pages are fetched by this process', () => {
  it('auto asks Bing first and stops there when its results are about the query', async () => {
    const f = fakeFetch({ 'www.bing.com': () => html(bingPage([['Hello world in ten languages', 'https://one.example/'], ['World of hello', 'https://two.example/']])) });
    const r = await search('  hello world ', {}, { fetch: f.fn, env: {} });
    expect(r).toEqual({ engine: 'bing', results: [{ title: 'Hello world in ten languages', url: 'https://one.example/', snippet: 'about Hello world in ten languages' }, { title: 'World of hello', url: 'https://two.example/', snippet: 'about World of hello' }] });
    expect(f.calls).toHaveLength(1);
    // a market is always named (without one Bing answered some other query), in the language of the question
    expect(f.calls[0].url).toBe('https://www.bing.com/search?q=hello%20world&setmkt=en-US');
    expect(f.calls[0].headers['user-agent']).toContain('Mozilla/5.0');
    expect(f.calls[0].headers['accept-language']).toBe('en-US,en;q=0.9');
    await search('提示缓存 怎么用', {}, { fetch: fakeFetch({ 'www.bing.com': (c) => { expect(c.url).toContain('&setmkt=zh-CN'); expect(c.headers['accept-language']).toBe('zh-CN,zh;q=0.9,en;q=0.8'); return html(bingPage([['提示缓存的用法', 'https://zh.example/']])); } }).fn, env: {} });
  });

  it('auto moves on when an engine refuses: a challenge page, an HTTP error, a network failure', async () => {
    for (const bing of [() => html(WALL), () => html('busy', 503), failing('ECONNRESET')]) {
      const f = fakeFetch({ 'www.bing.com': bing, 'html.duckduckgo.com': () => html(ddgPage([['Duck', 'https://duck.example/x']])) });
      const r = await search('q', {}, { fetch: f.fn, env: {} });
      expect(r).toEqual({ engine: 'duckduckgo', results: [{ title: 'Duck', url: 'https://duck.example/x', snippet: 'about Duck' }] });
      expect(f.hosts()).toEqual(['www.bing.com', 'html.duckduckgo.com']);
      expect(f.calls[1].url).toBe('https://html.duckduckgo.com/html/?q=q');
    }
  });

  it('Bing answering with results for something else is not handed on: the next engine is asked', async () => {
    // what Bing did to this app's own requests (2026-10-10): HTTP 200, a normal list, nothing to do with the query
    const junk = bingPage([['Manage your storage in Drive, Gmail & Photos', 'https://support.example/storage'], ['WhatsApp Web', 'https://web.example/']]);
    const f = fakeFetch({ 'www.bing.com': () => html(junk), 'html.duckduckgo.com': () => html(ddgPage([['vitest-fetch-mock - npm', 'https://npm.example/vitest-fetch-mock']])) });
    const r = await search('vitest mock fetch timers',{}, { fetch: f.fn, env: {} });
    expect(r).toEqual({ engine: 'duckduckgo', results: [{ title: 'vitest-fetch-mock - npm', url: 'https://npm.example/vitest-fetch-mock', snippet: 'about vitest-fetch-mock - npm' }] });
    // nowhere else to go: an error that says so, rather than the junk
    const alone = fakeFetch({ 'www.bing.com': () => html(junk), 'html.duckduckgo.com': () => html(WALL) });
    await expect(search('vitest mock fetch timers',{}, { fetch: alone.fn, env: {} })).rejects.toThrow(/Bing：返回的结果和搜索词对不上.*；DuckDuckGo：没有返回结果页/);
    await expect(search('vitest mock fetch timers',{ engine: 'bing' }, { fetch: alone.fn, env: {} })).rejects.toThrow(/Bing：返回的结果和搜索词对不上/);
  });

  it('Bing knowing only one word of a longer query: the next engine is preferred, the weak results are the last resort', async () => {
    const shallow = bingPage([['SQLite Home Page', 'https://sqlite.example/index.html'], ['SQLite Download Page', 'https://sqlite.example/download.html']]);
    const better = fakeFetch({ 'www.bing.com': () => html(shallow), 'html.duckduckgo.com': () => html(ddgPage([['FTS5 trigram tokenizer', 'https://sqlite.example/fts5.html#trigram']])) });
    expect((await search('sqlite fts5 trigram tokenizer chinese', {}, { fetch: better.fn, env: {} })).engine).toBe('duckduckgo');
    // DuckDuckGo not answering (rate limited): Bing's are returned, marked
    const only = fakeFetch({ 'www.bing.com': () => html(shallow), 'html.duckduckgo.com': () => html('<div class="anomaly-modal">bots</div>', 202) });
    const r = await search('sqlite fts5 trigram tokenizer chinese', {}, { fetch: only.fn, env: {} });
    expect(r.engine).toBe('bing');
    expect(r.weak).toBe(true);
    expect(r.results).toHaveLength(2);
    // …also when DuckDuckGo found nothing
    const none = fakeFetch({ 'www.bing.com': () => html(shallow), 'html.duckduckgo.com': () => html(DDG_EMPTY) });
    expect(await search('sqlite fts5 trigram tokenizer chinese', {}, { fetch: none.fn, env: {} })).toMatchObject({ engine: 'bing', weak: true });
    // asked for by name there is no next engine: the same results, the same mark
    expect(await search('sqlite fts5 trigram tokenizer chinese', { engine: 'bing' }, { fetch: only.fn, env: {} })).toMatchObject({ engine: 'bing', weak: true });
    // results that know the query's words are not marked, whoever they are from
    expect((await search('sqlite fts5 trigram tokenizer chinese', { engine: 'duckduckgo' }, { fetch: better.fn, env: {} })).weak).toBeUndefined();
  });

  it('nothing matched on one engine: the next is still asked; nothing anywhere is an empty answer, not an error', async () => {
    const some = fakeFetch({ 'www.bing.com': () => html(BING_EMPTY), 'html.duckduckgo.com': () => html(ddgPage([['Only here', 'https://only.example/']])) });
    expect((await search('q', {}, { fetch: some.fn, env: {} })).engine).toBe('duckduckgo');
    const none = fakeFetch({ 'www.bing.com': () => html(BING_EMPTY), 'html.duckduckgo.com': () => html(DDG_EMPTY) });
    expect(await search('q', {}, { fetch: none.fn, env: {} })).toEqual({ engine: 'bing', results: [] });
    // one empty, one refusing: still "nothing found", from the engine that answered
    const mixed = fakeFetch({ 'www.bing.com': () => html(WALL), 'html.duckduckgo.com': () => html(DDG_EMPTY) });
    expect(await search('q', {}, { fetch: mixed.fn, env: {} })).toEqual({ engine: 'duckduckgo', results: [] });
  });

  it('every engine refusing is an error that says what each one said', async () => {
    const f = fakeFetch({ 'www.bing.com': () => html(WALL), 'html.duckduckgo.com': () => html('<div class="anomaly-modal">bots</div>', 202) });
    await expect(search('q', {}, { fetch: f.fn, env: {} })).rejects.toThrow(/搜索没有成功。Bing：.*验证.*；DuckDuckGo：HTTP 202（请求太频繁，被限流了）/);
    const down = fakeFetch({});
    await expect(search('q', {}, { fetch: down.fn, env: {} })).rejects.toThrow(/Bing：ENOTFOUND；DuckDuckGo：ENOTFOUND/);
  });

  it('auto leaves an engine out for a while after it failed to answer — not after a query-specific or key problem', async () => {
    let t = 1_000_000;
    const cooldown: Cooldown = new Map();
    const deps = (f: ReturnType<typeof fakeFetch>) => ({ fetch: f.fn, env: {}, cooldown, now: () => t });
    // Bing cannot be reached (a blocked network): the next search does not wait for it again
    const blocked = fakeFetch({ 'www.bing.com': failing('ETIMEDOUT'), 'html.duckduckgo.com': () => html(ddgPage([['Duck', 'https://duck.example/']])) });
    expect((await search('q', {}, deps(blocked))).engine).toBe('duckduckgo');
    expect((await search('q', {}, deps(blocked))).engine).toBe('duckduckgo');
    expect(blocked.hosts()).toEqual(['www.bing.com', 'html.duckduckgo.com', 'html.duckduckgo.com']);
    expect(cooldown.get('bing')).toEqual({ until: 1_000_000 + UNREACHABLE_COOLDOWN_MS, why: 'ETIMEDOUT' });
    // asked for by name it is tried whatever happened before
    await expect(search('q', { engine: 'bing' }, deps(blocked))).rejects.toThrow(/Bing：ETIMEDOUT/);
    // when both rest, the error says they were not asked
    cooldown.set('duckduckgo', { until: t + 1000, why: 'HTTP 202（请求太频繁，被限流了）' });
    await expect(search('q', {}, deps(blocked))).rejects.toThrow(/Bing：ETIMEDOUT（刚失败过，过一会儿再试它）；DuckDuckGo：HTTP 202（请求太频繁，被限流了）（刚失败过，过一会儿再试它）/);
    // after the time it is asked again, and an answer ends the rest
    t += UNREACHABLE_COOLDOWN_MS + 1;
    const back = fakeFetch({ 'www.bing.com': () => html(bingPage([['q and a', 'https://b.example/']])) });
    expect((await search('q', {}, deps(back))).engine).toBe('bing');
    expect(cooldown.has('bing')).toBe(false);

    // a challenge / rate limit: a shorter rest
    cooldown.clear();
    const limited = fakeFetch({ 'www.bing.com': () => html(BING_EMPTY), 'html.duckduckgo.com': () => html('bots', 202) });
    await search('q', {}, deps(limited));
    expect(cooldown.get('duckduckgo')?.until).toBe(t + REFUSED_COOLDOWN_MS);
    expect(cooldown.has('bing')).toBe(false);
    // results that do not fit THIS query, a missing key, a wrong key: nothing to wait for
    cooldown.clear();
    const junk = fakeFetch({ 'www.bing.com': () => html(bingPage([['Unrelated page', 'https://x.example/']])), 'html.duckduckgo.com': () => html(ddgPage([['vitest docs', 'https://v.example/']])), 'api.search.brave.com': () => json({ error: { detail: 'Unauthorized' } }, 401) });
    await search('vitest mocking', {}, { ...deps(junk), keys: { brave: 'brave-wrong' } });
    expect([...cooldown.keys()]).toEqual([]);
  });

  it('a named engine is the only one asked', async () => {
    const f = fakeFetch({ 'www.bing.com': () => html(bingPage([['q', 'https://b.example/']])), 'html.duckduckgo.com': () => html(WALL) });
    await expect(search('q', { engine: 'duckduckgo' }, { fetch: f.fn, env: {} })).rejects.toThrow(/DuckDuckGo/);
    expect(f.calls).toHaveLength(1);
    expect((await search('q', { engine: 'bing' }, { fetch: f.fn, env: {} })).engine).toBe('bing');
  });

  it('an engine that can only be read in the browser says so, and nothing is fetched for it', async () => {
    const f = fakeFetch({});
    for (const [engine, label] of [['google', 'Google'], ['yahoo', 'Yahoo'], ['baidu', '百度']] as const) {
      const err = await search('q', { engine }, { fetch: f.fn, env: {} }).catch((e) => e as Error);
      expect(err.message).toBe(`搜索没有成功。${label}：${NEEDS_BROWSER}`);
    }
    expect(f.calls).toHaveLength(0);
  });

  it('Brave comes first in auto when its key is set; the key goes in a header, never into an error', async () => {
    const f = fakeFetch({
      'api.search.brave.com': (c) => (c.headers['x-subscription-token'] === 'brave-test-key' ? json({ web: { results: [{ title: 'T <b>one</b>', url: 'https://t.example/', description: 'brave   says' }, { title: 'bad', url: 'javascript:1' }] } }) : json({ error: { detail: 'Unauthorized' } }, 401)),
      'www.bing.com': () => html(bingPage([['q', 'https://b.example/']])),
    });
    const r = await search('q', { count: 3 }, { fetch: f.fn, env: {}, keys: { brave: 'brave-test-key' } });
    expect(r).toEqual({ engine: 'brave', results: [{ title: 'T one', url: 'https://t.example/', snippet: 'brave says' }] });
    expect(f.calls[0]).toMatchObject({ url: 'https://api.search.brave.com/res/v1/web/search?q=q&count=3', method: 'GET' });
    expect(f.calls[0].url).not.toContain('brave-test-key');
    // a wrong key: auto goes on to Bing; asked for by name, the error says the key is wrong — without the key
    const wrong = await search('q', {}, { fetch: f.fn, env: {}, keys: { brave: 'brave-wrong-key' } });
    expect(wrong.engine).toBe('bing');
    const err = await search('q', { engine: 'brave' }, { fetch: f.fn, env: {}, keys: { brave: 'brave-wrong-key' } }).catch((e) => e as Error);
    expect(err.message).toMatch(/Brave Search：API Key 不对/);
    expect(err.message).not.toContain('brave-wrong-key');
    await expect(search('q', { engine: 'brave' }, { fetch: f.fn, env: {} })).rejects.toThrow(/Brave Search：还没有填 API Key/);
  });

  it('Brave: the key as X-Subscription-Token, web.results mapped', async () => {
    const f = fakeFetch({ 'api.search.brave.com': (c) => (c.headers['x-subscription-token'] === 'brave-test-key' ? json({ web: { results: [{ title: 'Br', url: 'https://br.example/', description: 'from <strong>brave</strong>' }] } }) : json({ error: { detail: 'bad token' } }, 422)) });
    const r = await search('a b', { engine: 'brave', count: 5 }, { fetch: f.fn, env: {}, keys: { brave: 'brave-test-key' } });
    expect(r).toEqual({ engine: 'brave', results: [{ title: 'Br', url: 'https://br.example/', snippet: 'from brave' }] });
    expect(f.calls[0].url).toBe('https://api.search.brave.com/res/v1/web/search?q=a%20b&count=5');
    await expect(search('q', { engine: 'brave' }, { fetch: f.fn, env: {}, keys: { brave: 'other' } })).rejects.toThrow(/Brave Search：HTTP 422 bad token/);
  });

  it('the base URLs can be pointed elsewhere (tests, a mirror)', async () => {
    const f = fakeFetch({
      '127.0.0.1:7001': () => html(WALL),
      '127.0.0.1:7002': () => html(ddgPage([['Local', 'https://local.example/']])),
      '127.0.0.1:7004': () => json({ web: { results: [] } }),
    });
    const env = { CW_BING_URL: 'http://127.0.0.1:7001/', CW_DDG_URL: 'http://127.0.0.1:7002', CW_BRAVE_URL: 'http://127.0.0.1:7004' };
    const r = await search('q', {}, { fetch: f.fn, env, keys: { brave: 'k2' } });
    expect(r.engine).toBe('duckduckgo');
    expect(f.calls.map((c) => c.url)).toEqual(['http://127.0.0.1:7004/res/v1/web/search?q=q&count=8', 'http://127.0.0.1:7001/search?q=q&setmkt=en-US', 'http://127.0.0.1:7002/html/?q=q']);
  });

  it('count: default 8, at most 20, and results are cut to it', async () => {
    const many = Array.from({ length: 30 }, (_, i) => [`q result ${i}`, `https://r${i}.example/`] as [string, string]);
    const f = fakeFetch({ 'www.bing.com': () => html(bingPage(many)) });
    expect((await search('q', {}, { fetch: f.fn, env: {} })).results).toHaveLength(8);
    expect((await search('q', { count: 3 }, { fetch: f.fn, env: {} })).results).toHaveLength(3);
    expect((await search('q', { count: 500 }, { fetch: f.fn, env: {} })).results).toHaveLength(20);
    expect(clampCount(0)).toBe(1);
    expect(clampCount('7')).toBe(8);
    expect(clampCount(4.9)).toBe(4);
  });

  it('an empty query and a cancelled search are refused; a slow engine times out and the next is asked', async () => {
    const f = fakeFetch({ 'www.bing.com': () => html(bingPage([['q', 'https://b.example/']])) });
    await expect(search('   ', {}, { fetch: f.fn, env: {} })).rejects.toThrow('搜索词是空的');
    const gone = new AbortController();
    gone.abort();
    await expect(search('q', { signal: gone.signal }, { fetch: f.fn, env: {} })).rejects.toThrow('取消');
    expect(f.calls).toHaveLength(0);
    // Bing never answers: its request is aborted by the timeout, DuckDuckGo answers
    const slow = (async (input: any, init: any) => {
      if (String(input).includes('bing')) return new Promise<Response>((_res, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))));
      return html(ddgPage([['D', 'https://d.example/']]));
    }) as unknown as typeof fetch;
    expect((await search('q', {}, { fetch: slow, env: {}, timeoutMs: 30 })).engine).toBe('duckduckgo');
    const never = (async (_i: any, init: any) => new Promise<Response>((_res, rej) => init.signal.addEventListener('abort', () => rej(new Error('x'))))) as unknown as typeof fetch;
    await expect(search('q', {}, { fetch: never, env: {}, timeoutMs: 20 })).rejects.toThrow(/Bing：超时；DuckDuckGo：超时/);
  });

  it('helpers: the auto order, the setting, the language, the market', () => {
    expect(autoOrder()).toEqual(['bing', 'duckduckgo']);
    expect(autoOrder({ brave: 'k' })).toEqual(['brave', 'bing', 'duckduckgo']);
    // in the built-in browser DuckDuckGo is first, and Yahoo and Baidu can be read too
    expect(autoOrder({}, { browser: true })).toEqual(['duckduckgo', 'bing', 'yahoo', 'baidu']);
    expect(autoOrder({ brave: 'k' }, { browser: true })).toEqual(['brave', 'duckduckgo', 'bing', 'yahoo', 'baidu']);
    expect(ENGINES.map((e) => e.id)).toEqual(['auto', 'duckduckgo', 'bing', 'google', 'yahoo', 'baidu', 'brave']);
    expect(ENGINES.filter((e) => e.browser).map((e) => e.id)).toEqual(['google', 'yahoo', 'baidu']);
    expect(ENGINES.filter((e) => e.needsKey).map((e) => e.id)).toEqual(['brave']);
    expect(engineSetting('duckduckgo')).toBe('duckduckgo');
    expect(engineSetting('google')).toBe('google');
    // a setting left by an older version (Tavily is gone) reads as auto
    expect(engineSetting('tavily')).toBe('auto');
    expect(engineSetting(undefined)).toBe('auto');
    expect(acceptLanguage('提示缓存 怎么用')).toBe('zh-CN,zh;q=0.9,en;q=0.8');
    expect(acceptLanguage('prompt caching')).toBe('en-US,en;q=0.9');
    expect(acceptLanguage('Rust 所有権 わかりやすく')).toBe('ja,en;q=0.8');
    // only the two markets that answered a program with a plain result list
    expect(bingMarket('prompt caching')).toBe('en-US');
    expect(bingMarket('TypeScript 5.9 发布说明')).toBe('zh-CN');
    expect(bingMarket('Rust 所有権 わかりやすく')).toBe('en-US');
  });
});

/** A built-in browser that answers by engine; every call is kept. A missing engine = its page cannot be loaded. */
function fakeBrowser(pages: Record<string, RawSearchPage | Error | ((url: string, signal: AbortSignal) => RawSearchPage | Promise<RawSearchPage>)>) {
  const calls: { engine: string; url: string }[] = [];
  const fn: BrowserSearch = async (engine, url, signal) => {
    calls.push({ engine, url });
    const p = pages[engine];
    if (!p) return { url, title: '', text: '', candidates: [], failed: 'ERR_CONNECTION_RESET' };
    if (p instanceof Error) throw p;
    return typeof p === 'function' ? p(url, signal) : p;
  };
  return { fn, calls, engines: () => calls.map((c) => c.engine) };
}
/** What the window hands back for a page that lists these links. */
const listed = (url: string, items: [string, string][], more: Partial<RawSearchPage> = {}): RawSearchPage => ({
  url,
  title: 'results',
  text: items.map(([t]) => `${t}\nabout ${t}`).join('\n'),
  candidates: items.map(([title, href]) => ({ title, href, snippet: `${title} about ${title}` })),
  ...more,
});
const ddgWrapped = (target: string) => `https://duckduckgo.com/l/?uddg=${encodeURIComponent(target)}&rut=0`;
const BOTS: RawSearchPage = { url: 'https://html.duckduckgo.com/html/?q=q', title: 'DuckDuckGo', text: 'Unfortunately, bots use DuckDuckGo too. Please complete the following challenge.', candidates: [] };
const SORRY: RawSearchPage = { url: 'https://www.google.com/sorry/index?continue=x', title: 'https://www.google.com/search?q=q', text: 'Our systems have detected unusual traffic from your computer network.', candidates: [] };

describe('search in the built-in browser: the result page is loaded in a real page and read there', () => {
  it('auto reads DuckDuckGo first; its wrapped links are opened up, its ads and own pages left out, and this process fetches nothing', async () => {
    const b = fakeBrowser({
      duckduckgo: (url) => listed(url, [
        ['Hello world in ten languages', ddgWrapped('https://one.example/a?b=1')],
        ['An ad about hello world', 'https://duckduckgo.com/y.js?ad_domain=ads.example&ad_provider=x'],
        ['World of hello', 'https://two.example/'],
        ['DuckDuckGo settings', 'https://duckduckgo.com/settings'],
        ['Hello world in ten languages', ddgWrapped('https://one.example/a?b=1')],
      ]),
    });
    const f = fakeFetch({});
    const r = await search('  hello world ', {}, { fetch: f.fn, env: {}, browser: b.fn });
    expect(r).toEqual({ engine: 'duckduckgo', results: [
      { title: 'Hello world in ten languages', url: 'https://one.example/a?b=1', snippet: 'about Hello world in ten languages' },
      { title: 'World of hello', url: 'https://two.example/', snippet: 'about World of hello' },
    ] });
    expect(b.calls).toEqual([{ engine: 'duckduckgo', url: 'https://html.duckduckgo.com/html/?q=hello%20world' }]);
    expect(f.calls).toHaveLength(0);
  });

  it('a challenge instead of results: the next engine is asked, the engine rests a minute, and the error says how the user gets past it', async () => {
    let t = 5_000_000;
    const cooldown: Cooldown = new Map();
    const b = fakeBrowser({ duckduckgo: BOTS, bing: (url) => listed(url, [['q and a', 'https://b.example/']]) });
    const r = await search('q', {}, { env: {}, browser: b.fn, cooldown, now: () => t });
    expect(r).toEqual({ engine: 'bing', results: [{ title: 'q and a', url: 'https://b.example/', snippet: 'about q and a' }] });
    expect(b.engines()).toEqual(['duckduckgo', 'bing']);
    expect(b.calls[1].url).toBe('https://www.bing.com/search?q=q&setmkt=en-US');
    expect(cooldown.get('duckduckgo')?.until).toBe(t + REFUSED_COOLDOWN_MS);
    // the next search does not wait for it again
    await search('q', {}, { env: {}, browser: b.fn, cooldown, now: () => t });
    expect(b.engines()).toEqual(['duckduckgo', 'bing', 'bing']);
    // every engine challenging: the model is told to open the page so the user can do the check there
    t += REFUSED_COOLDOWN_MS + 1;
    const all = fakeBrowser({ duckduckgo: BOTS, bing: { ...BOTS, url: 'https://www.bing.com/turing/captcha/challenge' }, yahoo: { ...BOTS, text: 'Please verify you are a human' }, baidu: { url: 'https://wappass.baidu.com/static/captcha/tuxing.html', title: '百度安全验证', text: '', candidates: [] } });
    const err = await search('q', {}, { env: {}, browser: all.fn }).catch((e) => e as Error);
    expect(all.engines()).toEqual(['duckduckgo', 'bing', 'yahoo', 'baidu']);
    expect(err.message).toContain('DuckDuckGo：要求验证，或者没有给出结果页。可以用 browser_open 打开 https://html.duckduckgo.com/html/?q=q ，请用户在内置浏览器里完成验证后再搜');
    expect(err.message).toContain('百度：要求验证');
    // Google asked for by name: its /sorry/ page is a challenge whatever it lists
    const g = fakeBrowser({ google: SORRY });
    await expect(search('q', { engine: 'google' }, { env: {}, browser: g.fn })).rejects.toThrow(/Google：要求验证.*browser_open 打开 https:\/\/www\.google\.com\/search\?q=q&hl=en/);
    expect(g.engines()).toEqual(['google']);
  });

  it('a result page that cannot be loaded: the engine is out of reach from here — skipped, and left out for five minutes', async () => {
    const t = 7_000_000;
    const cooldown: Cooldown = new Map();
    const b = fakeBrowser({ bing: (url) => listed(url, [['q and a', 'https://b.example/']]) });
    expect((await search('q', {}, { env: {}, browser: b.fn, cooldown, now: () => t })).engine).toBe('bing');
    expect(cooldown.get('duckduckgo')).toEqual({ until: t + UNREACHABLE_COOLDOWN_MS, why: 'ERR_CONNECTION_RESET' });
    // nothing reachable: each engine's own reason
    await expect(search('q', {}, { env: {}, browser: fakeBrowser({}).fn })).rejects.toThrow('搜索没有成功。DuckDuckGo：ERR_CONNECTION_RESET；Bing：ERR_CONNECTION_RESET；Yahoo：ERR_CONNECTION_RESET；百度：ERR_CONNECTION_RESET');
  });

  it('results are judged the same way: unrelated ones are not handed on, weak ones are the last resort, an empty page is "nothing found"', async () => {
    // what Bing answered a real page with on 2026-10-10: a normal list about something else
    const junk = (url: string) => listed(url, [['Manage your Apple Account', 'https://account.example/'], ['WhatsApp Web', 'https://web.example/']]);
    const b = fakeBrowser({ duckduckgo: BOTS, bing: junk, yahoo: (url) => listed(url, [['Tokio select! macro - Rust', 'https://r.search.yahoo.com/_ylt=A0;_ylu=Y29sbw/RV=2/RE=1/RO=10/RU=https%3a%2f%2fdocs.example%2ftokio%2fmacro.select.html/RK=2/RS=abc-']]) });
    const r = await search('rust tokio select macro', {}, { env: {}, browser: b.fn });
    expect(r).toEqual({ engine: 'yahoo', results: [{ title: 'Tokio select! macro - Rust', url: 'https://docs.example/tokio/macro.select.html', snippet: 'about Tokio select! macro - Rust' }] });
    expect(b.engines()).toEqual(['duckduckgo', 'bing', 'yahoo']);
    // only one word known, and nobody else answers: handed on, marked
    const shallow = fakeBrowser({ duckduckgo: (url) => listed(url, [['SQLite Home Page', 'https://sqlite.example/'], ['SQLite Download Page', 'https://sqlite.example/download.html']]) });
    expect(await search('sqlite fts5 trigram tokenizer chinese', {}, { env: {}, browser: shallow.fn })).toMatchObject({ engine: 'duckduckgo', weak: true });
    // a real page that says nothing matched
    const none = fakeBrowser({ duckduckgo: { url: 'https://html.duckduckgo.com/html/?q=zzqx', title: 'zzqx at DuckDuckGo', text: 'No results found for zzqx.', candidates: [] }, baidu: { url: 'https://www.baidu.com/s?wd=zzqx', title: 'zzqx_百度搜索', text: '抱歉，没有找到与“zzqx”相关的网页。', candidates: [] } });
    expect(await search('zzqx', {}, { env: {}, browser: none.fn })).toEqual({ engine: 'duckduckgo', results: [] });
    expect(none.engines()).toEqual(['duckduckgo', 'bing', 'yahoo', 'baidu']);
  });

  it('the window not answering is not the engine\'s fault: this process fetches what it can for the rest of the search', async () => {
    const cooldown: Cooldown = new Map();
    const b = fakeBrowser({ duckduckgo: new Error('浏览器所在的窗口没有回应') });
    const f = fakeFetch({ 'html.duckduckgo.com': () => html(ddgPage([['Duck', 'https://duck.example/x']])) });
    const r = await search('q', {}, { fetch: f.fn, env: {}, browser: b.fn, cooldown });
    expect(r).toEqual({ engine: 'duckduckgo', results: [{ title: 'Duck', url: 'https://duck.example/x', snippet: 'about Duck' }] });
    expect(b.engines()).toEqual(['duckduckgo']);
    expect(f.hosts()).toEqual(['html.duckduckgo.com']);
    expect([...cooldown.keys()]).toEqual([]);
    // the fetched pages refusing too: the browser is not asked again in this search, and the engines that need it say so
    const walls = fakeFetch({ 'html.duckduckgo.com': () => html(WALL), 'www.bing.com': () => html(WALL) });
    const b2 = fakeBrowser({ duckduckgo: new Error('gone') });
    const err = await search('q', {}, { fetch: walls.fn, env: {}, browser: b2.fn }).catch((e) => e as Error);
    expect(b2.engines()).toEqual(['duckduckgo']);
    expect(walls.hosts()).toEqual(['html.duckduckgo.com', 'www.bing.com']);
    expect(err.message).toMatch(/DuckDuckGo：没有返回结果页.*；Bing：没有返回结果页.*；Yahoo：要用内置浏览器来搜，而它这次没有应答；百度：要用内置浏览器来搜，而它这次没有应答/);
    // an engine with no other way, asked for by name: the error says what the browser said
    await expect(search('q', { engine: 'google' }, { env: {}, browser: fakeBrowser({ google: new Error('窗口关了') }).fn })).rejects.toThrow('搜索没有成功。Google：内置浏览器没有完成这次搜索（窗口关了）');
  });

  it('a window that does not answer in time: whoever supplied it is told, the rest of the search is fetched by this process, the engine is not blamed', async () => {
    let aborted = false;
    let silent = 0;
    const never = (_url: string, signal: AbortSignal) => new Promise<RawSearchPage>((_res, rej) => signal.addEventListener('abort', () => { aborted = true; rej(new Error('内置浏览器没有在限定的时间里完成')); }));
    const b = fakeBrowser({ duckduckgo: never, bing: (url) => listed(url, [['q and a', 'https://b.example/']]) });
    const cooldown: Cooldown = new Map();
    const f = fakeFetch({ 'html.duckduckgo.com': () => html(ddgPage([['Duck', 'https://duck.example/x']])) });
    const r = await search('q', {}, { fetch: f.fn, env: {}, browser: b.fn, browserTimeoutMs: 30, cooldown, onBrowserSilent: () => { silent++; } });
    expect(r.engine).toBe('duckduckgo');
    expect(aborted).toBe(true); // the signal reached the window
    expect(silent).toBe(1);
    expect(b.engines()).toEqual(['duckduckgo']);
    expect(f.hosts()).toEqual(['html.duckduckgo.com']);
    expect([...cooldown.keys()]).toEqual([]);
    // the fetch has its own time: the browser's being used up does not count against it
    const slow = (async (_i: any, init: any) => new Promise<Response>((res, rej) => {
      const t = setTimeout(() => res(html(ddgPage([['Late duck', 'https://late.example/']]))), 60);
      init.signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')); });
    })) as unknown as typeof fetch;
    expect((await search('q', { engine: 'duckduckgo' }, { fetch: slow, env: {}, browser: fakeBrowser({ duckduckgo: never }).fn, browserTimeoutMs: 20, timeoutMs: 2000 })).results[0].title).toBe('Late duck');
    // an engine with no other way says what happened
    await expect(search('q', { engine: 'yahoo' }, { env: {}, browser: fakeBrowser({ yahoo: never }).fn, browserTimeoutMs: 20 })).rejects.toThrow('搜索没有成功。Yahoo：内置浏览器没有完成这次搜索（没有在限定时间内应答）');
    // the window answering with an error is not silence
    silent = 0;
    await search('q', {}, { fetch: f.fn, env: {}, browser: fakeBrowser({ duckduckgo: new Error('这个窗口没有内置浏览器') }).fn, onBrowserSilent: () => { silent++; } });
    expect(silent).toBe(0);
    // the caller cancelling ends the search
    const gone = new AbortController();
    const waiting = fakeBrowser({ duckduckgo: never });
    const p = search('q', { signal: gone.signal }, { fetch: f.fn, env: {}, browser: waiting.fn, onBrowserSilent: () => { silent++; } });
    gone.abort();
    await expect(p).rejects.toThrow('搜索被取消了');
    expect(waiting.engines()).toEqual(['duckduckgo']);
    expect(silent).toBe(0);
  });

  it('a named engine is read in the browser and is the only one asked: Google, Yahoo, Baidu', async () => {
    const g = fakeBrowser({ google: (url) => listed(url, [
      ['Prompt caching - docs', 'https://docs.example/prompt-caching'],
      ['Sign in', 'https://accounts.google.com/ServiceLogin?continue=x'],
      ['Wrapped prompt caching guide', 'https://www.google.com/url?q=https%3A%2F%2Fguide.example%2Fcaching&sa=U'],
      ['More results', 'https://www.google.com/search?q=prompt+caching&start=10'],
    ]) });
    const r = await search('prompt caching', { engine: 'google' }, { env: {}, browser: g.fn });
    expect(r.engine).toBe('google');
    expect(r.results.map((x) => x.url)).toEqual(['https://docs.example/prompt-caching', 'https://guide.example/caching']);
    expect(g.calls).toEqual([{ engine: 'google', url: 'https://www.google.com/search?q=prompt%20caching&hl=en' }]);
    // Baidu: the address the result block keeps beside its redirect link
    const bd = fakeBrowser({ baidu: (url) => ({ ...listed(url, []), candidates: [
      { title: '提示缓存 怎么用 - 文档', href: 'https://www.baidu.com/link?url=AbC123', alt: 'https://docs.example.cn/cache', snippet: '提示缓存 怎么用 - 文档 这是摘要' },
      { title: '百度首页', href: 'https://www.baidu.com/' },
    ] }) });
    const zh = await search('提示缓存 怎么用', { engine: 'baidu' }, { env: {}, browser: bd.fn });
    expect(zh).toEqual({ engine: 'baidu', results: [{ title: '提示缓存 怎么用 - 文档', url: 'https://docs.example.cn/cache', snippet: '这是摘要' }] });
    expect(bd.calls[0].url).toBe(`https://www.baidu.com/s?wd=${encodeURIComponent('提示缓存 怎么用')}`);
  });

  it('count cuts the list; Brave with a key is still asked first, by this process', async () => {
    const many = Array.from({ length: 30 }, (_, i) => [`q result ${i}`, `https://r${i}.example/`] as [string, string]);
    const b = fakeBrowser({ duckduckgo: (url) => listed(url, many) });
    expect((await search('q', {}, { env: {}, browser: b.fn })).results).toHaveLength(8);
    expect((await search('q', { count: 3 }, { env: {}, browser: b.fn })).results.map((x) => x.url)).toEqual(['https://r0.example/', 'https://r1.example/', 'https://r2.example/']);
    expect((await search('q', { count: 500 }, { env: {}, browser: b.fn })).results).toHaveLength(20);
    const f = fakeFetch({ 'api.search.brave.com': () => json({ web: { results: [{ title: 'Br', url: 'https://br.example/', description: 'd' }] } }) });
    const before = b.calls.length;
    expect((await search('q', {}, { fetch: f.fn, env: {}, browser: b.fn, keys: { brave: 'k' } })).engine).toBe('brave');
    expect(b.calls.length).toBe(before);
    // its key being wrong: on to the browser
    const bad = fakeFetch({ 'api.search.brave.com': () => json({}, 401) });
    expect((await search('q', {}, { fetch: bad.fn, env: {}, browser: b.fn, keys: { brave: 'k' } })).engine).toBe('duckduckgo');
  });
});
