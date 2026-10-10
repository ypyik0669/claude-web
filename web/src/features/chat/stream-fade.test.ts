import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { arrive, fadeNewText, FRESH_MS, rehypeStreamFade, type FadeState, type HNode } from './stream-fade';

const text = (value: string, s?: number): HNode => ({ type: 'text', value, ...(s === undefined ? {} : { position: { start: { offset: s }, end: { offset: s + value.length } } }) });
const el = (tagName: string, children: HNode[], s = 0, e = 0): HNode => ({ type: 'element', tagName, properties: {}, children, position: { start: { offset: s }, end: { offset: e } } });
const root = (...children: HNode[]): HNode => ({ type: 'root', children });
/** a node's children as `text` / `<w>young</w>` / `<s>old</s>` */
const show = (n: HNode): string => (n.children ?? []).map((c) => {
  if (c.type === 'text') return c.value;
  if (c.tagName === 'span') return `<${(c.properties?.className as string[] | undefined)?.includes('w') ? 'w' : 's'}>${show(c)}</${(c.properties?.className as string[] | undefined)?.includes('w') ? 'w' : 's'}>`;
  return `<${c.tagName}>${show(c)}</${c.tagName}>`;
}).join('');

describe('arrive', () => {
  it('what is there when the stream is first seen is not new', () => {
    expect(arrive(null, 'Hello wor', 100)).toEqual({ text: 'Hello wor', marks: [] });
  });
  it('each delta adds a mark where it starts; the same text again changes nothing', () => {
    const a = arrive(null, 'He', 0);
    const b = arrive(a, 'Hello', 30);
    expect(b.marks).toEqual([{ off: 2, at: 30 }]);
    expect(arrive(b, 'Hello', 60)).toBe(b);
    const c = arrive(b, 'Hello wor', 90);
    expect(c.marks).toEqual([{ off: 2, at: 30 }, { off: 5, at: 90 }]);
    expect(c.text).toBe('Hello wor');
  });
  it('text that changed anywhere but at its end starts over, with nothing new', () => {
    const a = arrive(arrive(null, 'He', 0), 'Hello', 30);
    expect(arrive(a, 'Jello', 60)).toEqual({ text: 'Jello', marks: [] });
    expect(arrive(a, 'Hel', 60)).toEqual({ text: 'Hel', marks: [] });
  });
  it('marks before the last block are dropped, but for the one whose delta may reach into it', () => {
    let st: FadeState = arrive(null, '', 0);
    st = arrive(st, 'One.', 10);          // mark 0
    st = arrive(st, 'One. Two.', 20);     // mark 4
    st = arrive(st, 'One. Two.\n\nTh', 30); // mark 9 — this delta starts the next block (at 11)
    st.from = 11;
    st = arrive(st, 'One. Two.\n\nThree', 40); // mark 13
    expect(st.marks.map((m) => m.off)).toEqual([9, 13]);
    // no mark before the block (it was there from the start): all are kept
    let other: FadeState = arrive(null, 'Old text', 0);
    other.from = 0;
    other = arrive(other, 'Old text more', 10);
    other = arrive(other, 'Old text more and more', 20);
    expect(other.marks.map((m) => m.off)).toEqual([8, 13]);
  });
});

describe('fadeNewText', () => {
  const NOW = 10_000;
  const young = NOW - 50, old = NOW - FRESH_MS - 1;

  it('cuts the last block’s text where the deltas started: young pieces fade, older ones do not', () => {
    const p = el('p', [text('Hello world again', 0)], 0, 17);
    const from = fadeNewText(root(p), 'Hello world again', [{ off: 6, at: old }, { off: 12, at: young }], NOW);
    expect(from).toBe(0);
    // 「Hello 」 was there before the stream was first seen, 「world 」 came a while ago, 「again」 just now
    expect(show(p)).toBe('<s>Hello </s><s>world </s><w>again</w>');
  });

  it('text from before the stream was first seen is left alone until something is added to it', () => {
    const p = el('p', [text('Hello', 0)], 0, 5);
    fadeNewText(root(p), 'Hello', [], NOW);
    expect(show(p)).toBe('Hello');
    const p2 = el('p', [text('Hello', 0), el('em', [text('there', 6)], 5, 12)], 0, 12);
    fadeNewText(root(p2), 'Hello *there*', [{ off: 5, at: young }], NOW);
    // the first text node has no cut in it and predates every mark: plain; the emphasis arrived with the delta
    expect(show(p2)).toBe('Hello<em><w>there</w></em>');
  });

  it('only the last top-level block is touched; earlier blocks are plain text again', () => {
    const source = 'One two.\n\nThree four';
    const p1 = el('p', [text('One two.', 0)], 0, 8), p2 = el('p', [text('Three four', 10)], 10, 20);
    const tree = root(p1, text('\n'), p2, text('\n'));
    const from = fadeNewText(tree, source, [{ off: 4, at: old }, { off: 8, at: old }, { off: 16, at: young }], NOW);
    expect(from).toBe(10);
    expect(show(p1)).toBe('One two.');
    expect(show(p2)).toBe('<s>Three </s><w>four</w>');
  });

  it('a piece is new by its own age only: nothing already on screen for a while ever gets the class back', () => {
    const p = () => el('p', [text('aa bb cc dd', 0)], 0, 11);
    const marks = [{ off: 3, at: 100 }, { off: 6, at: 200 }, { off: 9, at: 300 }];
    const at = (now: number) => { const n = p(); fadeNewText(root(n), 'aa bb cc dd', marks, now); return show(n); };
    expect(at(310)).toBe('<s>aa </s><w>bb </w><w>cc </w><w>dd</w>');
    expect(at(100 + FRESH_MS)).toBe('<s>aa </s><s>bb </s><w>cc </w><w>dd</w>');
    expect(at(300 + FRESH_MS)).toBe('<s>aa </s><s>bb </s><s>cc </s><s>dd</s>');
    // the number of pieces — so which DOM node holds which piece — never changes while the block is the last one
    expect(at(99_999).match(/<s>/g)).toHaveLength(4);
  });

  it('a code block is never cut (CodeBlock reads its text as one string)', () => {
    const pre = el('pre', [el('code', [text('npm install\nnpm start\n', 8)], 0, 34)], 0, 34);
    const from = fadeNewText(root(pre), '```bash\nnpm install\nnpm start\n```', [{ off: 20, at: young }], NOW);
    expect(from).toBe(0);
    expect(show(pre)).toBe('<code>npm install\nnpm start\n</code>');
  });

  it('a cut that would tear a character apart is not made', () => {
    // 「ok 」, a thumbs-up (a surrogate pair) with a skin tone (another pair), a space, e + a combining acute accent
    const value = 'ok \u{1F44D}\u{1F3FD} e\u0301';
    expect(value).toHaveLength(10);
    const p = el('p', [text(value, 0)], 0, value.length);
    // inside the surrogate pair, before the skin tone, before the combining accent
    fadeNewText(root(p), value, [{ off: 4, at: young }, { off: 5, at: young }, { off: 9, at: young }], NOW);
    expect(show(p)).toBe(value);
    // a clean place in the same text is used
    const q = el('p', [text(value, 0)], 0, value.length);
    fadeNewText(root(q), value, [{ off: 3, at: young }], NOW);
    expect(show(q)).toBe(`<s>ok </s><w>${value.slice(3)}</w>`);
  });

  it('where the source and the text differ (an entity, a quote’s 「> 」), a cut is used only if all after it is the same', () => {
    const source = '> a &amp; b\n> second line';
    const value = 'a & b\nsecond line';
    const q = el('blockquote', [el('p', [{ type: 'text', value, position: { start: { offset: 2 }, end: { offset: source.length } } }], 2, source.length)], 0, source.length);
    // a cut on the first line (the entity and the 「> 」 come after it): not used; one in the second line: used
    fadeNewText(root(q), source, [{ off: 4, at: old }, { off: source.length - 4, at: young }], NOW);
    expect(show(q)).toBe('<p><s>a & b\nsecond </s><w>line</w></p>');
  });

  it('text nodes without a position (made by a plugin) are left alone', () => {
    const p = el('p', [text('see '), el('a', [text('https://x.dev')], 0, 0), text(' now')], 0, 21);
    fadeNewText(root(p), 'see https://x.dev now', [{ off: 2, at: young }], NOW);
    expect(show(p)).toBe('see <a>https://x.dev</a> now');
  });

  it('nothing to do: no blocks, or a tree that ends in something that is not an element', () => {
    expect(fadeNewText(root(), '', [{ off: 0, at: young }], NOW)).toBeUndefined();
    expect(fadeNewText(root(text('stray', 0)), 'stray', [{ off: 2, at: young }], NOW)).toBeUndefined();
  });
});

describe('through react-markdown (the real parser and renderer)', () => {
  const render = (source: string, marks: { off: number; at: number }[], now: number) => {
    const ref: { current: FadeState | null } = { current: { text: source, marks } };
    const html = renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], rehypePlugins: [[rehypeStreamFade, ref, () => now]] as never }, source));
    return { html, from: ref.current!.from };
  };

  it('the new end of the last paragraph is a span with class w; the paragraph before it is plain', () => {
    const source = 'First paragraph.\n\nSecond one is **bold** and goes on';
    const { html, from } = render(source, [{ off: 10, at: 0 }, { off: source.length - 8, at: 990 }], 1000);
    expect(from).toBe(18);
    expect(html).toContain('<p>First paragraph.</p>');
    expect(html).toContain('<span class="w"> goes on</span>');
    expect(html).toContain('<strong><span>bold</span></strong>');
    // everything is still there, in order
    expect(html.replace(/<[^>]+>/g, '')).toBe('First paragraph.\nSecond one is bold and goes on');
  });

  it('list items and table cells of the last block are cut the same way', () => {
    const list = '- alpha\n- beta gamma';
    const a = render(list, [{ off: list.length - 5, at: 995 }], 1000);
    expect(a.html).toContain('<li><span>beta </span><span class="w">gamma</span></li>');
    const table = '| a | b |\n| - | - |\n| one | two three |';
    const b = render(table, [{ off: table.indexOf('three'), at: 995 }], 1000);
    expect(b.html).toContain('<td><span>two </span><span class="w">three</span></td>');
  });

  it('a fenced code block stays one text', () => {
    const source = 'Run this:\n\n```bash\nnpm install\nnpm start\n```';
    const { html } = render(source, [{ off: 25, at: 995 }], 1000);
    expect(html).toContain('<pre><code class="language-bash">npm install\nnpm start\n</code></pre>');
    expect(html).not.toContain('<span');
  });

  it('once every piece is older than the fade, no span has the class', () => {
    const source = 'Second one goes on';
    const { html } = render(source, [{ off: 7, at: 0 }, { off: 11, at: 100 }], 100 + FRESH_MS);
    expect(html).toBe('<p><span>Second </span><span>one </span><span>goes on</span></p>');
  });
});
