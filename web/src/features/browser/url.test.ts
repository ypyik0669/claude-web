import { describe, expect, it } from 'vitest';
import { MAX_RECENT, SEARCH_URL, addressToUrl, frameSandbox, loadable, pushRecent, readRecent, siteHue, siteLetter, siteOf } from './url';

describe('the address field', () => {
  it('keeps an address, completes a local one, a bare domain gets https', () => {
    expect(addressToUrl(' https://example.com/a?b=1 ')).toBe('https://example.com/a?b=1');
    expect(addressToUrl('localhost:3000')).toBe('http://localhost:3000');
    expect(addressToUrl(':5173/app')).toBe('http://localhost:5173/app');
    expect(addressToUrl('192.168.1.8:8080/x')).toBe('http://192.168.1.8:8080/x');
    expect(addressToUrl('[::1]:3090')).toBe('http://[::1]:3090');
    expect(addressToUrl('github.com/anthropics')).toBe('https://github.com/anthropics');
    expect(addressToUrl('docs.python.org')).toBe('https://docs.python.org');
    expect(addressToUrl('')).toBe('');
  });
  it('searches for anything else', () => {
    expect(addressToUrl('vite 配置代理')).toBe(`${SEARCH_URL}${encodeURIComponent('vite 配置代理')}`);
    expect(addressToUrl('react')).toBe(`${SEARCH_URL}react`);
    // a sentence with a dot in it is words, not a domain
    expect(addressToUrl('what is node.js used for')).toBe(`${SEARCH_URL}${encodeURIComponent('what is node.js used for')}`);
    expect(addressToUrl('javascript:alert(1)')).toBe(`${SEARCH_URL}${encodeURIComponent('javascript:alert(1)')}`);
  });
  it('only web pages are loaded', () => {
    expect(loadable('https://a.b')).toBe(true);
    expect(loadable('about:blank')).toBe(true);
    expect(loadable('javascript:alert(1)')).toBe(false);
    expect(loadable('file:///c:/x')).toBe(false);
  });
});

describe('a site\'s name, letter and colour', () => {
  it('names a site by its host', () => {
    expect(siteOf('https://www.github.com/a/b')).toBe('github.com');
    expect(siteOf('http://localhost:3000/x')).toBe('localhost:3000');
    expect(siteOf('not a url')).toBe('not a url');
  });
  it('one letter, the same colour every time', () => {
    expect(siteLetter('https://github.com')).toBe('G');
    expect(siteLetter('http://localhost:3000')).toBe('L');
    expect(siteLetter('https://www.zhihu.com/question/1')).toBe('Z');
    expect(siteHue('https://github.com/a')).toBe(siteHue('https://www.github.com/b'));
    expect(siteHue('https://github.com')).toBeGreaterThanOrEqual(0);
    expect(siteHue('https://github.com')).toBeLessThan(360);
  });
});

describe('recent sites', () => {
  const at = 1;
  it('the last page of each site, newest first; searches are not sites', () => {
    let list = pushRecent([], { url: 'https://a.com/1', title: 'A1', at })!;
    list = pushRecent(list, { url: 'https://b.com/', title: 'B', at })!;
    list = pushRecent(list, { url: 'https://www.a.com/2', title: 'A2', at })!;
    expect(list.map((r) => r.url)).toEqual(['https://www.a.com/2', 'https://b.com/']);
    expect(pushRecent(list, { url: `${SEARCH_URL}x`, title: 'x', at })).toBeNull();
    expect(pushRecent(list, { url: 'about:blank', title: '', at })).toBeNull();
    // the same page again changes nothing (no write)
    expect(pushRecent(list, { url: 'https://www.a.com/2', title: 'A2', at: 9 })).toBeNull();
  });
  it('is bounded, and reads back only what it wrote', () => {
    let list: ReturnType<typeof readRecent> = [];
    for (let i = 0; i < 30; i++) list = pushRecent(list, { url: `https://s${i}.com/`, title: `S${i}`, at: i })!;
    expect(list).toHaveLength(MAX_RECENT);
    expect(list[0].url).toBe('https://s29.com/');
    expect(readRecent([{ url: 'https://ok.com', title: 'ok', at: 1 }, { url: 'javascript:x' }, null, 'x', { url: 5 }])).toEqual([{ url: 'https://ok.com', title: 'ok', at: 1 }]);
    expect(readRecent('nope')).toEqual([]);
  });
});

describe('the iframe of the web version', () => {
  const own = 'http://127.0.0.1:3090';
  it('another site keeps its own origin', () => {
    expect(frameSandbox('https://example.com/a', own)).toContain('allow-same-origin');
    expect(frameSandbox('http://127.0.0.1:5173/', own)).toContain('allow-same-origin');
  });
  it('a document that would share the origin of the app does not get it', () => {
    for (const u of ['about:blank', `${own}/`, `${own}/api/file?path=x`, ' http://127.0.0.1:3090 ', 'not a url']) {
      expect(frameSandbox(u, own), u).not.toContain('allow-same-origin');
      expect(frameSandbox(u, own), u).toContain('allow-scripts');
    }
  });
});
