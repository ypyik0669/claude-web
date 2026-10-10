import { describe, expect, it } from 'vitest';
import { htmlToText } from './html-text.js';

describe('htmlToText', () => {
  it('reads an article: title, headings, paragraphs, lists, and the links as numbered elements', () => {
    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>  Streams &amp;
  backpressure </title><style>body{color:red}</style><script>var a = "<p>not text</p>";</script></head>
<body>
  <nav><a href="/home">Home</a><a href="/docs">Docs</a></nav>
  <main>
    <h1>Backpressure</h1>
    <p>Data can arrive <em>faster</em> than it is
       consumed. See <a href="/api/stream.html#pipe">the <code>pipe</code> docs</a> and
       <a href="https://other.example/guide?a=1&amp;b=2">the guide</a>.</p>
    <h2>Rules</h2>
    <ul><li>Respect <code>write()</code>'s return value</li><li>Wait for <b>drain</b>
      <ol><li>first</li><li>second</li></ol></li></ul>
    <p>Line one<br>line two</p>
  </main>
  <footer>© Example</footer>
</body></html>`;
    const p = htmlToText(html, 'https://docs.example/learn/backpressure');
    expect(p.title).toBe('Streams & backpressure');
    expect(p.text).toBe([
      '# Backpressure',
      '',
      'Data can arrive faster than it is consumed. See the pipe docs and the guide.',
      '',
      '## Rules',
      '',
      "- Respect write()'s return value",
      '- Wait for drain',
      '',
      '  1. first',
      '  2. second',
      '',
      'Line one',
      'line two',
      '',
      '© Example',
    ].join('\n'));
    expect(p.elements).toEqual([
      { ref: '1', role: 'link', name: 'the pipe docs', href: 'https://docs.example/api/stream.html#pipe' },
      { ref: '2', role: 'link', name: 'the guide', href: 'https://other.example/guide?a=1&b=2' },
    ]);
  });

  it('drops what is not for reading: scripts, styles, navigation, hidden subtrees, media, comments', () => {
    const html = `<body><!-- <p>commented</p> --><p>kept</p>
<script type="module">document.write("</nav><p>from script</p>")</script>
<noscript><p>enable js</p></noscript>
<div hidden><p>hidden attr</p><div>nested</div></div>
<div style="color:red; display : none"><span>styled away</span></div>
<svg viewBox="0 0 1 1"><title>icon</title><path d="M0 0"/><svg/></svg>
<nav class="x"><ul><li><a href="/a">A</a></li></ul><nav>inner</nav></nav>
<select><option>opt</option></select><template><p>tpl</p></template>
<div aria-hidden="true">still visible</div><p>end</p></body>`;
    const p = htmlToText(html, 'https://e.example/');
    expect(p.text).toBe('kept\n\nstill visible\n\nend');
    expect(p.elements).toEqual([]);
  });

  it('keeps <pre> as written, tables as rows with separators, images as their alt text', () => {
    const html = `<p>Run:</p><pre><code>npm  run   build
  &amp;&amp; node dist/x.js\n\ttabbed</code></pre>
<table><tr><th>Name</th><th>Value</th></tr><tr><td>a</td><td>1 &lt; 2</td></tr></table>
<p><img src="x.png" alt="A diagram"><img src="y.png" alt=""><img src="z.png"></p>`;
    const p = htmlToText(html);
    expect(p.text).toBe('Run:\n\nnpm  run   build\n  && node dist/x.js\n\ttabbed\n\nName | Value\na | 1 < 2\n\n[image: A diagram]');
  });

  it('links: resolved against <base> / the page, http(s) only, no duplicates, named by label when they hold no text', () => {
    const html = `<head><base href="https://cdn.example/root/"></head>
<a href="page.html">Relative</a> <a href="page.html">Same again</a> <a href="#top">top</a> <a href="javascript:void(0)">js</a>
<a href="mailto:a@b.example">mail</a> <a href="//other.example/x">Scheme-relative</a>
<a href="/icon" aria-label="Open menu"><svg><path/></svg></a> <a href="/img"><img alt="Logo" src="l.png"></a> <a href="/empty"></a>
<a href="/unclosed">Unclosed <a href="/next">Next</a>`;
    const p = htmlToText(html, 'https://site.example/dir/index.html');
    expect(p.elements).toEqual([
      { ref: '1', role: 'link', name: 'Relative', href: 'https://cdn.example/root/page.html' },
      { ref: '2', role: 'link', name: 'Scheme-relative', href: 'https://other.example/x' },
      { ref: '3', role: 'link', name: 'Open menu', href: 'https://cdn.example/icon' },
      { ref: '4', role: 'link', name: '[image: Logo]', href: 'https://cdn.example/img' },
      { ref: '5', role: 'link', name: 'Unclosed', href: 'https://cdn.example/unclosed' },
      { ref: '6', role: 'link', name: 'Next', href: 'https://cdn.example/next' },
    ]);
    expect(htmlToText('<a href="/rel">no base</a>').elements).toEqual([]); // nothing to resolve against
    expect(htmlToText(Array.from({ length: 30 }, (_, i) => `<a href="/p${i}">L${i}</a>`).join(''), 'https://e.example/', { maxLinks: 10 }).elements).toHaveLength(10);
  });

  it('survives broken markup: stray <, unclosed tags, an unbalanced quote, text with no tags', () => {
    expect(htmlToText('a < b and c > d').text).toBe('a < b and c > d');
    expect(htmlToText('<p>one<p>two<div>three').text).toBe('one\n\ntwo\nthree');
    expect(htmlToText('<p title="a > b">quoted</p>').text).toBe('quoted'); // a `>` inside a quoted value is not the end of the tag
    // a quote that never closes would swallow the rest of the page: the tag ends at the first `>` instead
    expect(htmlToText('<p title="oops>broken</p><p>after</p>').text).toBe('broken\n\nafter');
    expect(htmlToText('<p>cut <span').text).toBe('cut');
    expect(htmlToText('<script>never closed <p>x</p>').text).toBe('');
    expect(htmlToText('').text).toBe('');
    expect(htmlToText('plain &amp; simple').text).toBe('plain & simple');
    expect(htmlToText('<textarea>typed\ntext</textarea>').text).toBe('typed text');
  });

  it('collapses whitespace of every kind, and decodes references in text and attributes', () => {
    const p = htmlToText('<p>a&nbsp;&nbsp;b \t\n c&#160;d</p>\n\n\n<p>&ldquo;q&rdquo;</p><a href="/x?a=1&amp;b=%20">go&rarr;</a>', 'https://e.example/');
    expect(p.text).toBe('a b c d\n\n“q”\n\ngo→');
    expect(p.elements[0].href).toBe('https://e.example/x?a=1&b=%20');
  });
});
