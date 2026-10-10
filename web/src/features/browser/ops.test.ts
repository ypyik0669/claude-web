import { describe, expect, it } from 'vitest';
import type { BrowserPage } from '@shared';
import { GLANCE_CHARS, OPEN_CHARS, parseKey, runOp, type PageHandle } from './ops';

/** A page that records what it was asked, in order. */
function fakePage(o: { text?: string; url?: string; idle?: boolean; canBack?: boolean; onClick?: (p: Fake) => void; typed?: { submitted?: boolean; enter?: boolean }; scroll?: { moved: number; top: number; max: number; length: number } } = {}) {
  const log: string[] = [];
  const p = {
    log,
    href: o.url ?? 'https://a.test/',
    text: o.text ?? 'hello',
    navigate: async (url: string) => { log.push(`navigate ${url}`); p.href = url; return o.idle ?? true; },
    call: async (fn: string, arg: Record<string, unknown>) => {
      log.push(`${fn} ${JSON.stringify(arg)}`);
      if (fn === 'read') {
        const from = Number(arg.offset) || 0;
        const page: BrowserPage = { url: p.href, title: 'T', text: p.text.slice(from, from + Number(arg.maxChars)) };
        return { page, length: p.text.length };
      }
      if (fn === 'find') return { page: { url: p.href, title: 'T', text: '' }, elements: [{ ref: 'e1', role: 'link', name: 'x' }] };
      if (fn === 'click') { o.onClick?.(p); return { name: '登录', role: 'button' }; }
      if (fn === 'type') return { name: '搜索', role: 'input', ...o.typed };
      if (fn === 'scroll') return o.scroll ?? { moved: 600, top: 600, max: 4000, length: p.text.length };
      throw new Error(`unexpected ${fn}`);
    },
    settle: async (ms: number) => { log.push(`settle ${ms}`); return o.idle ?? true; },
    back: async () => { log.push('back'); return o.canBack ?? true; },
    key: async (k: string) => { log.push(`key ${k}`); },
    capture: async () => { log.push('capture'); return { mime: 'image/jpeg' as const, data: 'AAAA' }; },
    url: () => p.href,
    title: () => 'T',
  };
  return p;
}
type Fake = ReturnType<typeof fakePage>;
const quick = { pause: 0, settle: 5 };
const run = (p: Fake, op: Parameters<typeof runOp>[1], args: Record<string, unknown> = {}) => runOp(p as unknown as PageHandle, op, args, quick);

describe('one operation on a page of the built-in browser', () => {
  it('open: loads, then reads from the start', async () => {
    const p = fakePage();
    const a = await run(p, 'open', { url: 'https://b.test/x' });
    expect(p.log).toEqual(['navigate https://b.test/x', `read {"offset":0,"maxChars":${OPEN_CHARS}}`]);
    expect(a.page?.url).toBe('https://b.test/x');
    expect(a.note).toBeUndefined();
  });
  it('open on a page still loading says the text may be incomplete', async () => {
    const a = await run(fakePage({ idle: false }), 'open', { url: 'https://b.test/' });
    expect(a.note).toMatch(/还在加载/);
  });
  it('read passes the window through; find is the page\'s own answer', async () => {
    const p = fakePage({ text: 'x'.repeat(50) });
    const a = await run(p, 'read', { offset: 10, maxChars: 20 });
    expect(a.page?.text).toHaveLength(20);
    expect((await run(p, 'find', { query: 'x' })).elements).toHaveLength(1);
    expect(p.log.at(-1)).toBe('find {"query":"x"}');
  });
  it('click: acts, lets the page settle, reads it back as a glance — and says where it ended up', async () => {
    const p = fakePage({ onClick: (x) => { x.href = 'https://a.test/next'; } });
    const a = await run(p, 'click', { ref: 'e3' });
    expect(p.log).toEqual(['click {"ref":"e3"}', 'settle 5', `read {"offset":0,"maxChars":${GLANCE_CHARS}}`]);
    // the note is this side's own words: the ref, not the button's text; that the address changed, not the address
    expect(a.note).toBe('已点击 [e3]。页面换了地址（见下面的「来源」）。');
    expect(a.page?.url).toBe('https://a.test/next');
  });
  it('a click that stays on the page does not claim a move', async () => {
    expect((await run(fakePage(), 'click', { ref: '[e1]' })).note).toBe('已点击 [e1]。');
  });
  it('type: only typing answers at once; submitting reads the page back; a field with no form gets Enter', async () => {
    const plain = fakePage();
    expect(await run(plain, 'type', { ref: 'e1', text: 'hi' })).toEqual({ note: '已在 [e1] 里输入。' });
    expect(plain.log).toEqual(['type {"ref":"e1","text":"hi","submit":false}']);

    const form = fakePage({ typed: { submitted: true } });
    const a = await run(form, 'type', { ref: 'e1', text: 'hi', submit: true });
    expect(form.log).toEqual(['type {"ref":"e1","text":"hi","submit":true}', 'settle 5', `read {"offset":0,"maxChars":${GLANCE_CHARS}}`]);
    expect(a.note).toMatch(/输入并提交/);

    const bare = fakePage({ typed: { enter: true } });
    await run(bare, 'type', { ref: 'e1', text: 'hi', submit: true });
    expect(bare.log.slice(0, 2)).toEqual(['type {"ref":"e1","text":"hi","submit":true}', 'key Enter']);
  });
  it('key: pressed, then the glance; no key is an error', async () => {
    const p = fakePage();
    expect((await run(p, 'key', { key: 'Escape' })).note).toBe('已按 Escape。');
    expect(p.log[0]).toBe('key Escape');
    await expect(run(p, 'key', { key: ' ' })).rejects.toThrow(/key/);
  });
  it('scroll: says where it is, and where new text starts when the page grew', async () => {
    const grown = fakePage({ text: 'y'.repeat(900), scroll: { moved: 600, top: 600, max: 4000, length: 500 } });
    expect((await run(grown, 'scroll', { direction: 'down' })).note).toBe('已向下滚动（位置 600 / 4000）。页面多出了内容：用 browser_read {"offset": 500} 读新出现的部分。');
    const same = fakePage({ text: 'y'.repeat(500), scroll: { moved: -300, top: 0, max: 4000, length: 500 } });
    expect((await run(same, 'scroll', { direction: 'up' })).note).toMatch(/^已向上滚动（位置 0 \/ 4000）。用 browser_read/);
    const end = fakePage({ scroll: { moved: 0, top: 4000, max: 4000, length: 5 } });
    expect((await run(end, 'scroll', { direction: 'down' })).note).toBe('已经到页面最下面了。');
    expect(end.log).toHaveLength(1);
  });
  it('back: nothing to go back to is said, not an error', async () => {
    expect(await run(fakePage({ canBack: false }), 'back')).toEqual({ note: '没有上一页了。' });
    const p = fakePage();
    expect((await run(p, 'back')).note).toBe('已返回上一页。');
    expect(p.log).toEqual(['back', 'settle 5', `read {"offset":0,"maxChars":${GLANCE_CHARS}}`]);
  });
  it('screenshot: the picture, and which page it is of', async () => {
    const a = await run(fakePage(), 'screenshot');
    expect(a.image).toEqual({ mime: 'image/jpeg', data: 'AAAA' });
    expect(a.page).toEqual({ url: 'https://a.test/', title: 'T', text: '' });
  });
  it('after an action on a page that keeps loading, the note says so', async () => {
    expect((await run(fakePage({ idle: false }), 'click', { ref: 'e1' })).note).toMatch(/已点击 \[e1\]。页面还在加载/);
  });
});

describe('key names', () => {
  it('named keys become the names the page is sent', () => {
    expect(parseKey('Enter')).toEqual({ keyCode: 'Enter', modifiers: [], char: '\r' });
    expect(parseKey('ArrowDown')).toEqual({ keyCode: 'Down', modifiers: [] });
    expect(parseKey('esc')).toEqual({ keyCode: 'Escape', modifiers: [] });
    expect(parseKey('PageDown').keyCode).toBe('PageDown');
    expect(parseKey('F5')).toEqual({ keyCode: 'F5', modifiers: [] });
    expect(parseKey('Space')).toEqual({ keyCode: 'Space', modifiers: [], char: ' ' });
  });
  it('a character types itself; with a modifier it is a shortcut', () => {
    expect(parseKey('a')).toEqual({ keyCode: 'A', modifiers: [], char: 'a' });
    expect(parseKey('Control+A')).toEqual({ keyCode: 'A', modifiers: ['control'] });
    expect(parseKey('Ctrl+Shift+k')).toEqual({ keyCode: 'K', modifiers: ['control', 'shift'] });
    expect(parseKey('Shift+a')).toEqual({ keyCode: 'A', modifiers: ['shift'], char: 'a' });
    expect(parseKey('/')).toEqual({ keyCode: '/', modifiers: [], char: '/' });
    expect(parseKey('+')).toEqual({ keyCode: '+', modifiers: [], char: '+' });
    expect(parseKey('Control++')).toEqual({ keyCode: '+', modifiers: ['control'] });
    expect(parseKey('').keyCode).toBe('');
  });
});
