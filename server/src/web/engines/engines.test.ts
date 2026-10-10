import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBing, resolveBingUrl } from './bing.js';
import { parseDuckDuckGo, resolveDuckDuckGoUrl } from './duckduckgo.js';
import { decodeEntities, inlineText } from '../entities.js';

// Trimmed from real result pages fetched once (2026-10-10): only the result blocks, tracking tokens zeroed.
const fixture = (name: string) => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '__fixtures__', name), 'utf8');

describe('parseBing', () => {
  it('reads the organic results of a real page: title, the address behind the redirect link, the snippet', () => {
    const p = parseBing(fixture('bing.html'));
    expect(p.state).toBe('ok');
    expect(p.results).toHaveLength(6);
    expect(p.results[0]).toEqual({
      title: 'Node.js — Run JavaScript Everywhere',
      url: 'https://nodejs.org/',
      snippet: 'Node.js® is a free, open-source, cross-platform JavaScript runtime environment that lets developers create servers, web apps, …',
    });
    expect(p.results[1].url).toBe('https://nodejs.org/en/download');
    expect(p.results[1].title).toBe('Download Node.js®'); // &#174; and the <strong> around the words
    expect(p.results[2].url).toBe('https://www.w3schools.com/nodejs/');
    // nothing of Bing's own, nothing that is not an http(s) address, no address twice
    for (const r of p.results) {
      expect(r.url).toMatch(/^https?:\/\//);
      expect(new URL(r.url).hostname).not.toMatch(/(^|\.)bing\.com$/);
      expect(r.title).not.toMatch(/[<>]/);
    }
    expect(new Set(p.results.map((r) => r.url)).size).toBe(p.results.length);
  });

  it('unwraps /ck/a redirect links (u=a1<base64url>), keeps direct links, drops Bing\'s own and relative ones', () => {
    const wrap = (target: string, marker = 'a1') => `https://www.bing.com/ck/a?!&&p=0000&ptn=3&ver=2&hsh=4&fclid=0&psq=q&u=${marker}${Buffer.from(target).toString('base64url')}&ntb=1`;
    expect(resolveBingUrl(wrap('https://example.com/a?b=1&c=中文'))).toBe('https://example.com/a?b=1&c=%E4%B8%AD%E6%96%87');
    expect(resolveBingUrl(wrap('http://plain.example/', 'a0'))).toBe('http://plain.example/');
    expect(resolveBingUrl('https://docs.example.org/x')).toBe('https://docs.example.org/x');
    expect(resolveBingUrl('https://www.bing.com/images/search?q=x')).toBeNull();
    expect(resolveBingUrl('/search?q=next')).toBeNull();
    expect(resolveBingUrl('#')).toBeNull();
    expect(resolveBingUrl(wrap('javascript:alert(1)'))).toBeNull(); // the wrapper is Bing's, so nothing is left to return
    expect(resolveBingUrl('javascript:void(0)')).toBeNull();
  });

  it('falls back to the caption\'s paragraph, then its text, for the snippet', () => {
    const li = (caption: string) => `<ol id="b_results"><li class="b_algo"><h2><a href="https://e.example/">T</a></h2>${caption}</li></ol>`;
    expect(parseBing(li('<div class="b_caption"><p>from the <b>paragraph</b></p></div>')).results[0].snippet).toBe('from the paragraph');
    expect(parseBing(li('<div class="b_caption">bare &amp; text</div>')).results[0].snippet).toBe('bare & text');
    expect(parseBing(li('')).results[0].snippet).toBe('');
  });

  it('a result list with nothing in it is "empty"; a challenge or a script shell is "blocked"', () => {
    // hand-written from the markup Bing uses (these two states cannot be fetched on demand)
    expect(parseBing('<html><body><ol id="b_results"><li class="b_no"><h1>There are no results for <strong>zqxj</strong></h1></li></ol></body></html>').state).toBe('empty');
    expect(parseBing('<html><body><div class="captcha-container"><ol id="b_results"></ol>One last step</div></body></html>').state).toBe('blocked');
    expect(parseBing('<html><head><script>window.location="/"</script></head><body></body></html>').state).toBe('blocked');
    expect(parseBing('').state).toBe('blocked');
  });
});

describe('parseDuckDuckGo', () => {
  it('reads a real html.duckduckgo.com page: title, the address inside uddg=, the snippet', () => {
    const p = parseDuckDuckGo(fixture('duckduckgo.html'));
    expect(p.state).toBe('ok');
    expect(p.results).toHaveLength(5);
    expect(p.results[0].title).toBe('Backpressuring in Streams | Node.js Learn');
    expect(p.results[0].url).toBe('https://nodejs.org/learn/modules/backpressuring-in-streams');
    expect(p.results[0].snippet).toContain('A good example of why the backpressure mechanism');
    expect(p.results[0].snippet).toContain("Node.js' Stream implementation"); // &#x27; decoded, <b> removed
    for (const r of p.results) {
      expect(r.url).toMatch(/^https?:\/\//);
      expect(new URL(r.url).hostname).not.toMatch(/(^|\.)duckduckgo\.com$/);
      expect(r.snippet).not.toMatch(/[<>]/);
      expect(r.snippet.length).toBeGreaterThan(20);
    }
  });

  it('leaves ads out, and reads a result that has no snippet', () => {
    const ad = '<div class="result results_links result--ad"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fduckduckgo.com%2Fy.js%3Fad_domain%3Dshop.example&amp;rut=0">Buy now</a><a class="result__snippet" href="#">ad text</a></div>';
    const real = '<div class="result results_links web-result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freal.example%2Fp%3Fa%3D1%26b%3D2&amp;rut=0">Real <b>one</b></a></div>';
    const p = parseDuckDuckGo(`<div id="links">${ad}${real}</div>`);
    expect(p.results).toEqual([{ title: 'Real one', url: 'https://real.example/p?a=1&b=2', snippet: '' }]);
  });

  it('resolves the redirect link, and a direct one', () => {
    expect(resolveDuckDuckGoUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.example%2F%E4%B8%AD&rut=0')).toBe('https://a.example/%E4%B8%AD');
    expect(resolveDuckDuckGoUrl('https://direct.example/x')).toBe('https://direct.example/x');
    expect(resolveDuckDuckGoUrl('//duckduckgo.com/l/?uddg=javascript%3Aalert(1)')).toBeNull();
    expect(resolveDuckDuckGoUrl('//duckduckgo.com/html/?q=next')).toBeNull();
    expect(resolveDuckDuckGoUrl('')).toBeNull();
  });

  it('"no results" is empty; the bots page (or anything else) is blocked', () => {
    expect(parseDuckDuckGo('<div class="serp__results"><div class="no-results"><div class="no-results__message">No results found for <b>zqxj</b></div></div></div>').state).toBe('empty');
    expect(parseDuckDuckGo('<div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div>').state).toBe('blocked');
    expect(parseDuckDuckGo('').state).toBe('blocked');
  });
});

describe('entities', () => {
  it('decodes named and numeric references, leaves unknown names as written', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#x27; &copy;&#174; &hellip; &#x4E2D;&#25991;')).toBe('a & b <c> "d" \'e\' ©® … 中文');
    expect(decodeEntities('&nbsp;x&nosuchname; &amp')).toBe(' x&nosuchname; &');
    expect(decodeEntities('&#0; &#xD800; &#x110000;')).toBe('� � �');
    expect(decodeEntities('no references')).toBe('no references');
  });
  it('inline markup becomes one line of text', () => {
    expect(inlineText('  <strong>Node</strong>.js\n  &mdash; <em>run</em>&nbsp;it ')).toBe('Node.js — run it');
  });
});
