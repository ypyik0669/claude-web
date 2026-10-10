import { describe, expect, it } from 'vitest';
import { REFUSED_COOLDOWN_MS, UNREACHABLE_COOLDOWN_MS, acceptLanguage, autoOrder, bingMarket, clampCount, engineSetting, search, type Cooldown } from './search.js';

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

describe('search', () => {
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
    // DuckDuckGo's results are not second-guessed
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
    const junk = fakeFetch({ 'www.bing.com': () => html(bingPage([['Unrelated page', 'https://x.example/']])), 'html.duckduckgo.com': () => html(ddgPage([['vitest docs', 'https://v.example/']])), 'api.tavily.com': () => json({ detail: { error: 'Unauthorized' } }, 401) });
    await search('vitest mocking', {}, { ...deps(junk), keys: { tavily: 'tvly-wrong' } });
    expect([...cooldown.keys()]).toEqual([]);
  });

  it('a named engine is the only one asked', async () => {
    const f = fakeFetch({ 'www.bing.com': () => html(bingPage([['q', 'https://b.example/']])), 'html.duckduckgo.com': () => html(WALL) });
    await expect(search('q', { engine: 'duckduckgo' }, { fetch: f.fn, env: {} })).rejects.toThrow(/DuckDuckGo/);
    expect(f.calls).toHaveLength(1);
    expect((await search('q', { engine: 'bing' }, { fetch: f.fn, env: {} })).engine).toBe('bing');
  });

  it('a keyed engine comes first in auto when its key is set; the key goes in a header, never into an error', async () => {
    const f = fakeFetch({
      'api.tavily.com': (c) => (c.headers.authorization === 'Bearer tvly-test-key' ? json({ results: [{ title: 'T <b>one</b>', url: 'https://t.example/', content: 'tavily   says' }, { title: 'bad', url: 'javascript:1' }] }) : json({ detail: { error: 'Unauthorized' } }, 401)),
      'www.bing.com': () => html(bingPage([['q', 'https://b.example/']])),
    });
    const r = await search('q', { count: 3 }, { fetch: f.fn, env: {}, keys: { tavily: 'tvly-test-key' } });
    expect(r).toEqual({ engine: 'tavily', results: [{ title: 'T one', url: 'https://t.example/', snippet: 'tavily says' }] });
    expect(f.calls[0]).toMatchObject({ url: 'https://api.tavily.com/search', method: 'POST' });
    expect(JSON.parse(f.calls[0].body!)).toEqual({ query: 'q', max_results: 3, search_depth: 'basic' });
    expect(f.calls[0].url).not.toContain('tvly');
    // a wrong key: auto goes on to Bing; asked for by name, the error says the key is wrong — without the key
    const wrong = await search('q', {}, { fetch: f.fn, env: {}, keys: { tavily: 'tvly-wrong-key' } });
    expect(wrong.engine).toBe('bing');
    const err = await search('q', { engine: 'tavily' }, { fetch: f.fn, env: {}, keys: { tavily: 'tvly-wrong-key' } }).catch((e) => e as Error);
    expect(err.message).toMatch(/Tavily：API Key 不对/);
    expect(err.message).not.toContain('tvly-wrong-key');
    await expect(search('q', { engine: 'tavily' }, { fetch: f.fn, env: {} })).rejects.toThrow(/Tavily：还没有填 API Key/);
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
      '127.0.0.1:7003': () => json({ results: [] }),
      '127.0.0.1:7004': () => json({ web: { results: [] } }),
    });
    const env = { CW_BING_URL: 'http://127.0.0.1:7001/', CW_DDG_URL: 'http://127.0.0.1:7002', CW_TAVILY_URL: 'http://127.0.0.1:7003', CW_BRAVE_URL: 'http://127.0.0.1:7004' };
    const r = await search('q', {}, { fetch: f.fn, env, keys: { tavily: 'k1', brave: 'k2' } });
    expect(r.engine).toBe('duckduckgo');
    expect(f.calls.map((c) => c.url)).toEqual(['http://127.0.0.1:7003/search', 'http://127.0.0.1:7004/res/v1/web/search?q=q&count=8', 'http://127.0.0.1:7001/search?q=q&setmkt=en-US', 'http://127.0.0.1:7002/html/?q=q']);
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
    expect(autoOrder({ tavily: 'k', brave: 'k' })).toEqual(['tavily', 'brave', 'bing', 'duckduckgo']);
    expect(engineSetting('duckduckgo')).toBe('duckduckgo');
    expect(engineSetting('google')).toBe('auto');
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
