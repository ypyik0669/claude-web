import { describe, expect, it } from 'vitest';
import { PAGE_ENGINES, readResultPage, resultPageUrl, unwrapResultUrl, type RawSearchPage } from './pages.js';

const page = (over: Partial<RawSearchPage>): RawSearchPage => ({ url: 'https://engine.example/search?q=q', title: 'q', text: '', candidates: [], ...over });

describe('the result page to load', () => {
  it('each engine has its own address, the query percent-encoded', () => {
    expect(resultPageUrl('duckduckgo', 'a b&c')).toBe('https://html.duckduckgo.com/html/?q=a%20b%26c');
    expect(resultPageUrl('bing', 'a b')).toBe('https://www.bing.com/search?q=a%20b&setmkt=en-US');
    expect(resultPageUrl('google', 'a b')).toBe('https://www.google.com/search?q=a%20b&hl=en');
    expect(resultPageUrl('yahoo', 'a b')).toBe('https://search.yahoo.com/search?p=a%20b');
    expect(resultPageUrl('baidu', 'a b')).toBe('https://www.baidu.com/s?wd=a%20b');
    for (const e of PAGE_ENGINES) expect(() => new URL(resultPageUrl(e, '提示缓存 "怎么用" #1?'))).not.toThrow();
  });

  it('an engine can be pointed elsewhere (tests, a mirror): the same variables the fetched pages use', () => {
    const env = { CW_DDG_URL: 'http://127.0.0.1:7002/ddg/', CW_BING_URL: 'http://127.0.0.1:7001', CW_GOOGLE_URL: ' ', CW_BAIDU_URL: 'https://mirror.example/baidu' };
    expect(resultPageUrl('duckduckgo', 'a b', env)).toBe('http://127.0.0.1:7002/ddg/html/?q=a%20b');
    expect(resultPageUrl('bing', 'a b', env)).toBe('http://127.0.0.1:7001/search?q=a%20b&setmkt=en-US');
    expect(resultPageUrl('google', 'a b', env)).toBe('https://www.google.com/search?q=a%20b&hl=en'); // blank = not set
    expect(resultPageUrl('yahoo', 'a b', env)).toBe('https://search.yahoo.com/search?p=a%20b');
    expect(resultPageUrl('baidu', 'a b', env)).toBe('https://mirror.example/baidu/s?wd=a%20b');
  });

  it('Bing is told a market and Google a language, from the script the question is written in', () => {
    expect(resultPageUrl('bing', '提示缓存 怎么用')).toMatch(/&setmkt=zh-CN$/);
    // only en-US and zh-CN answer with a plain list
    expect(resultPageUrl('bing', 'Rust 所有権 わかりやすく')).toMatch(/&setmkt=en-US$/);
    expect(resultPageUrl('google', '提示缓存 怎么用')).toMatch(/&hl=zh-CN$/);
    expect(resultPageUrl('google', 'Rust 所有権 わかりやすく')).toMatch(/&hl=ja$/);
  });
});

describe('the address behind a listed link', () => {
  it('DuckDuckGo: /l/?uddg= is opened up; ads (y.js) and its own pages are not results', () => {
    expect(unwrapResultUrl('duckduckgo', 'https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1&rut=abc')).toBe('https://example.com/a?b=1');
    expect(unwrapResultUrl('duckduckgo', 'https://example.org/direct')).toBe('https://example.org/direct');
    expect(unwrapResultUrl('duckduckgo', 'https://duckduckgo.com/y.js?ad_domain=x.example')).toBeNull();
    expect(unwrapResultUrl('duckduckgo', 'https://duckduckgo.com/l/?uddg=https%3A%2F%2Fduckduckgo.com%2Fy.js%3Fad%3D1')).toBeNull();
    expect(unwrapResultUrl('duckduckgo', 'https://html.duckduckgo.com/html/?q=next')).toBeNull();
    expect(unwrapResultUrl('duckduckgo', 'javascript:void(0)')).toBeNull();
  });

  it('Bing: /ck/a?…u=a1<base64url> is opened up; its own pages are not results', () => {
    const wrapped = `https://www.bing.com/ck/a?!&&p=0&u=a1${Buffer.from('https://example.com/x?y=1').toString('base64url')}&ntb=1`;
    expect(unwrapResultUrl('bing', wrapped)).toBe('https://example.com/x?y=1');
    expect(unwrapResultUrl('bing', 'https://docs.example.org/x')).toBe('https://docs.example.org/x');
    expect(unwrapResultUrl('bing', 'https://www.bing.com/images/search?q=x')).toBeNull();
  });

  it('Google: direct links and /url?q=; the search itself, sign-in, help and settings are not results — its products are', () => {
    expect(unwrapResultUrl('google', 'https://docs.example/page')).toBe('https://docs.example/page');
    expect(unwrapResultUrl('google', 'https://www.google.com/url?q=https%3A%2F%2Fguide.example%2Fa&sa=U&ved=x')).toBe('https://guide.example/a');
    expect(unwrapResultUrl('google', 'https://www.google.com/url?url=https%3A%2F%2Fguide.example%2Fb')).toBe('https://guide.example/b');
    expect(unwrapResultUrl('google', 'https://www.google.com/url?q=https%3A%2F%2Faccounts.google.com%2Fsignin')).toBeNull();
    expect(unwrapResultUrl('google', 'https://www.google.com/url?q=javascript%3A1')).toBeNull();
    for (const own of ['https://www.google.com/search?q=x&start=10', 'https://www.google.com/', 'https://google.co.jp/preferences', 'https://accounts.google.com/ServiceLogin', 'https://support.google.com/websearch/answer/1', 'https://policies.google.com/privacy', 'https://www.google.com/sorry/index', 'https://www.google.com/maps/place/x']) {
      expect(unwrapResultUrl('google', own), own).toBeNull();
    }
    // a result that happens to be Google's: a product page, the developers' site, a book
    expect(unwrapResultUrl('google', 'https://developers.google.com/search/docs')).toBe('https://developers.google.com/search/docs');
    expect(unwrapResultUrl('google', 'https://cloud.google.com/run/docs')).toBe('https://cloud.google.com/run/docs');
    expect(unwrapResultUrl('google', 'https://www.google.com/chrome/')).toBe('https://www.google.com/chrome/');
  });

  it('Yahoo: r.search.yahoo.com/…/RU=<encoded>/ is opened up; its own search pages are not results', () => {
    expect(unwrapResultUrl('yahoo', 'https://r.search.yahoo.com/_ylt=Awr;_ylu=Y29sbw/RV=2/RE=1700000000/RO=10/RU=https%3a%2f%2fexample.com%2fa%3fb%3d1/RK=2/RS=xyz-')).toBe('https://example.com/a?b=1');
    expect(unwrapResultUrl('yahoo', 'https://example.org/direct')).toBe('https://example.org/direct');
    expect(unwrapResultUrl('yahoo', 'https://r.search.yahoo.com/_ylt=A/RU=https%3a%2f%2fsearch.yahoo.com%2fsearch%3fp%3dnext/RK=2/RS=x')).toBeNull();
    expect(unwrapResultUrl('yahoo', 'https://r.search.yahoo.com/_ylt=A/RU=%E0%A4%A/RK=2/RS=x')).toBeNull(); // a broken escape
    expect(unwrapResultUrl('yahoo', 'https://r.search.yahoo.com/nothing-wrapped')).toBeNull();
    expect(unwrapResultUrl('yahoo', 'https://search.yahoo.com/search?p=x&b=11')).toBeNull();
    expect(unwrapResultUrl('yahoo', 'https://images.search.yahoo.com/search/images?p=x')).toBeNull();
    expect(unwrapResultUrl('yahoo', 'https://help.yahoo.com/kb/search')).toBeNull();
    expect(unwrapResultUrl('yahoo', 'https://finance.yahoo.com/quote/X')).toBe('https://finance.yahoo.com/quote/X');
  });

  it('Baidu: the real address kept beside the redirect link is used; without one the redirect is kept; its own pages are not results', () => {
    expect(unwrapResultUrl('baidu', 'https://www.baidu.com/link?url=AbC', 'https://docs.example.cn/a')).toBe('https://docs.example.cn/a');
    // no real address on the block: the redirect still leads there when opened
    expect(unwrapResultUrl('baidu', 'https://www.baidu.com/link?url=AbC')).toBe('https://www.baidu.com/link?url=AbC');
    expect(unwrapResultUrl('baidu', 'https://www.baidu.com/link?url=AbC', 'https://www.baidu.com/s?wd=other')).toBe('https://www.baidu.com/link?url=AbC');
    expect(unwrapResultUrl('baidu', 'https://www.baidu.com/s?wd=next&pn=10')).toBeNull();
    expect(unwrapResultUrl('baidu', 'https://www.baidu.com/')).toBeNull();
    // Baike, Zhidao, Tieba are results like any other
    expect(unwrapResultUrl('baidu', 'https://baike.baidu.com/item/x')).toBe('https://baike.baidu.com/item/x');
    expect(unwrapResultUrl('baidu', 'https://example.cn/direct', 'not a url')).toBe('https://example.cn/direct');
  });
});

describe('what a loaded page turned out to be', () => {
  const three = [
    { title: 'One  title\n here', href: 'https://one.example/', snippet: 'One title here  the first\nsnippet' },
    { title: 'Two', href: 'https://two.example/', snippet: 'Two' },
    { title: 'Three', href: 'https://three.example/' },
  ];

  it('a result list: titles and snippets on one line, the title taken out of its own block text, no address twice, cut to the count', () => {
    const p = readResultPage('duckduckgo', page({ candidates: [...three, { title: 'One again', href: 'https://one.example/' }, { title: '', href: 'https://untitled.example/' }, { title: 'Four', href: 'https://four.example/' }] }), 10);
    expect(p).toEqual({ state: 'ok', results: [
      { title: 'One title here', url: 'https://one.example/', snippet: 'the first snippet' },
      { title: 'Two', url: 'https://two.example/', snippet: '' },
      { title: 'Three', url: 'https://three.example/', snippet: '' },
      { title: 'Four', url: 'https://four.example/', snippet: '' },
    ] });
    expect(readResultPage('duckduckgo', page({ candidates: three }), 2).results.map((r) => r.url)).toEqual(['https://one.example/', 'https://two.example/']);
    // very long text is bounded
    const long = readResultPage('bing', page({ candidates: [{ title: 'T'.repeat(900), href: 'https://long.example/', snippet: 's '.repeat(2000) }] }), 5).results[0];
    expect(long.title).toHaveLength(300);
    expect(long.snippet.length).toBeLessThanOrEqual(360);
  });

  // what the engines print between a title and its text (seen on the real pages, 2026-10-10): DuckDuckGo the address
  // and a machine date, Bing the address as breadcrumbs. The reader has the url already
  it('a snippet starts at its text: the address as displayed and the machine-readable date are taken off the front', () => {
    const snip = (title: string, href: string, snippet: string) => readResultPage('duckduckgo', page({ candidates: [{ title, href, snippet }] }), 5).results[0].snippet;
    expect(snip('Backpressuring in Streams', 'https://nodejs.org/en/learn/modules/backpressuring-in-streams', 'Backpressuring in Streams nodejs.org/en/learn/modules/backpressuring-in-streams 2025-03-04T00:00:00.0000000 There is a general problem that occurs during data handling'))
      .toBe('There is a general problem that occurs during data handling');
    expect(snip('Tokio select', 'https://www.docs.rs/tokio/latest/tokio/macro.select.html', 'Tokio select https://www.docs.rs › tokio › latest Waits on multiple concurrent branches')).toBe('Waits on multiple concurrent branches');
    expect(snip('T', 'https://example.com/a', 'T www.example.com/a The text')).toBe('The text');
    expect(snip('T', 'https://example.com/a', 'T 2026-01-02T03:04:05Z The text')).toBe('The text');
    // only at the front, and only this result's own host: an address the text talks about stays
    expect(snip('T', 'https://example.com/a', 'T See other.example/docs and example.com/b for more')).toBe('See other.example/docs and example.com/b for more');
    expect(snip('T', 'https://example.com/a', 'T Released 2026-01-02T03:04:05Z in the morning')).toBe('Released 2026-01-02T03:04:05Z in the morning');
    // a host with characters a pattern would read as its own
    expect(snip('T', 'https://a+b.example/x', 'T a+b.example/x text')).toBe('text');
    expect(snip('T', 'https://example.com/a', 'T example.com')).toBe('');
  });

  it('a challenge is told apart from results: by where the page ended up, or by what it says when it lists next to nothing', () => {
    // the engine sent the page somewhere else
    expect(readResultPage('google', page({ url: 'https://www.google.com/sorry/index?continue=x', candidates: three }), 8).state).toBe('blocked');
    expect(readResultPage('google', page({ url: 'https://consent.google.com/m?continue=x' }), 8).state).toBe('blocked');
    expect(readResultPage('bing', page({ url: 'https://www.bing.com/turing/captcha/challenge' }), 8).state).toBe('blocked');
    expect(readResultPage('yahoo', page({ url: 'https://guce.yahoo.com/consent?x=1' }), 8).state).toBe('blocked');
    expect(readResultPage('baidu', page({ url: 'https://wappass.baidu.com/static/captcha/tuxing.html' }), 8).state).toBe('blocked');
    expect(readResultPage('duckduckgo', page({ url: 'https://duckduckgo.com/anomaly.js?x=1' }), 8).state).toBe('blocked');
    // the same address, a challenge in place of the list
    for (const text of ['Unfortunately, bots use DuckDuckGo too.', 'Our systems have detected unusual traffic from your computer network', "Please verify you're a human", 'One last step', '百度安全验证 请完成以下验证', '检测到异常流量']) {
      expect(readResultPage('duckduckgo', page({ text }), 8).state, text).toBe('blocked');
    }
    expect(readResultPage('bing', page({ title: 'Captcha', text: '' }), 8).state).toBe('blocked');
    // a challenge page with a link or two on it is still a challenge…
    expect(readResultPage('duckduckgo', page({ text: 'Please complete the following challenge', candidates: three.slice(0, 2) }), 8).state).toBe('blocked');
    // …but a real list whose results talk about CAPTCHAs is a real list
    expect(readResultPage('duckduckgo', page({ text: 'How to solve a captcha - guide\nreCAPTCHA docs', candidates: three }), 8).state).toBe('ok');
    // the words far down a page are not what the page is
    expect(readResultPage('duckduckgo', page({ text: `${'results '.repeat(200)} captcha`, candidates: three.slice(0, 1) }), 8).state).toBe('ok');
  });

  it('nothing listed: "nothing matched" when the page says so, otherwise it is not a result page (a shell, a block)', () => {
    for (const text of ['No results found for zzqx.', 'Your search - zzqx - did not match any documents.', 'We did not find results for: zzqx', '抱歉，没有找到与“zzqx”相关的网页。', '未找到相关结果']) {
      expect(readResultPage('duckduckgo', page({ text }), 8), text).toEqual({ state: 'empty', results: [] });
    }
    expect(readResultPage('bing', page({ text: 'Bing\nImages Videos Maps' }), 8)).toEqual({ state: 'blocked', results: [] });
    expect(readResultPage('yahoo', page({ text: '' }), 8).state).toBe('blocked');
    // only the engine's own links listed: nothing to hand on
    expect(readResultPage('bing', page({ text: 'navigation', candidates: [{ title: 'Images', href: 'https://www.bing.com/images/search?q=q' }] }), 8).state).toBe('blocked');
  });
});
