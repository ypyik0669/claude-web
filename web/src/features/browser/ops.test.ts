import { describe, expect, it } from 'vitest';
import type { BrowserPage } from '@shared';
import { GLANCE_CHARS, OPEN_CHARS, WHEEL_NOTCH, parseKey, parseModifiers, runOp, toView, type MouseAct, type PageHandle } from './ops';

/** A page that records what it was asked, in order. */
function fakePage(o: { text?: string; url?: string; idle?: boolean; canBack?: boolean; onClick?: (p: Fake) => void; typed?: { submitted?: boolean; enter?: boolean }; scroll?: { moved: number; top: number; max: number; length: number }; picture?: { width: number; height: number } | null; view?: { width: number; height: number } } = {}) {
  const log: string[] = [];
  /** the size of the last picture taken (null: none yet) — `picture` in the options = one was taken before */
  let pictured = o.picture ?? null;
  const size = o.picture ?? { width: 1280, height: 800 };
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
    capture: async () => { log.push('capture'); pictured = size; return { mime: 'image/jpeg' as const, data: 'AAAA', ...(o.picture === undefined ? {} : size) }; },
    frame: async () => ({ picture: pictured, view: o.view ?? { width: 640, height: 400 } }),
    mouse: async (e: MouseAct) => {
      const mods = e.modifiers?.length ? ` +${e.modifiers.join('+')}` : '';
      if (e.type === 'move') log.push(`move ${e.x},${e.y}${e.held ? ` held ${e.held}` : ''}${mods}`);
      else if (e.type === 'wheel') log.push(`wheel ${e.x},${e.y} dx ${e.dx} dy ${e.dy}${mods}`);
      else log.push(`${e.type} ${e.button} ${e.count} ${e.x},${e.y}${mods}`);
    },
    insertText: async (text: string) => { log.push(`insert ${text}`); },
    url: () => p.href,
    title: () => 'T',
  };
  return p;
}
type Fake = ReturnType<typeof fakePage>;
const quick = { pause: 0, settle: 5, computerSettle: 7 };
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
    // the way key names are written for a desktop
    expect(parseKey('Page_Down').keyCode).toBe('PageDown');
    expect(parseKey('BackSpace').keyCode).toBe('Backspace');
    expect(parseKey('Return')).toEqual({ keyCode: 'Enter', modifiers: [], char: '\r' });
    expect(parseKey('Insert').keyCode).toBe('Insert');
    expect(parseKey('super+Left')).toEqual({ keyCode: 'Left', modifiers: ['meta'] });
  });
  it('a name nobody knows is no key at all — not its first letter', () => {
    expect(parseKey('NoSuchKey').keyCode).toBe('');
    expect(parseKey('Control+Whatever')).toEqual({ keyCode: '', modifiers: ['control'] });
    expect(parseKey('F99x').keyCode).toBe('');
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

describe('browser_computer: the mouse and keyboard by position, answered with a picture', () => {
  // a picture of 1280×800 of a page that is 640×400 of its own pixels: positions are halved
  const pictured = (o: Parameters<typeof fakePage>[0] = {}) => fakePage({ picture: { width: 1280, height: 800 }, view: { width: 640, height: 400 }, ...o });
  const act = (p: Fake, args: Record<string, unknown>) => run(p, 'computer', args);

  it('screenshot: the picture with its size — nothing is touched, nothing waited for', async () => {
    const p = pictured();
    const a = await act(p, { action: 'screenshot' });
    expect(p.log).toEqual(['capture']);
    expect(a).toEqual({ image: { mime: 'image/jpeg', data: 'AAAA', width: 1280, height: 800 }, page: { url: 'https://a.test/', title: 'T', text: '' } });
  });

  it('a position needs a picture to go by: before the first one, it says to take one', async () => {
    const p = fakePage({ picture: null });
    await expect(act(p, { action: 'left_click', coordinate: [10, 10] })).rejects.toThrow('先截一张图');
    expect(p.log).toEqual([]);
    // typing and keys need none
    expect((await act(p, { action: 'type', text: 'hi' })).note).toBe('已输入。');
  });

  it('a click: move there, press, release — at the page\'s own position — then a fresh picture', async () => {
    const p = pictured();
    const a = await act(p, { action: 'left_click', coordinate: [640, 300] });
    expect(p.log).toEqual(['move 320,150', 'down left 1 320,150', 'up left 1 320,150', 'settle 7', 'capture']);
    // the note is this side's own words: no text of the page, no position
    expect(a.note).toBe('已点击。');
    expect(a.image).toMatchObject({ width: 1280, height: 800 });
    expect(a.page).toEqual({ url: 'https://a.test/', title: 'T', text: '' });
  });

  it('right, middle, double and triple clicks; a held modifier goes on every event', async () => {
    const right = pictured();
    expect((await act(right, { action: 'right_click', coordinate: [2, 2] })).note).toBe('已右键点击。');
    expect(right.log.slice(0, 3)).toEqual(['move 1,1', 'down right 1 1,1', 'up right 1 1,1']);
    const middle = pictured();
    await act(middle, { action: 'middle_click', coordinate: [2, 2] });
    expect(middle.log[1]).toBe('down middle 1 1,1');
    // a double click is two clicks, the second counted 2 — what a page gets from a real mouse
    const twice = pictured();
    expect((await act(twice, { action: 'double_click', coordinate: [100, 100] })).note).toBe('已双击。');
    expect(twice.log.slice(0, 5)).toEqual(['move 50,50', 'down left 1 50,50', 'up left 1 50,50', 'down left 2 50,50', 'up left 2 50,50']);
    const thrice = pictured();
    await act(thrice, { action: 'triple_click', coordinate: [100, 100] });
    expect(thrice.log.filter((l) => l.startsWith('down'))).toEqual(['down left 1 50,50', 'down left 2 50,50', 'down left 3 50,50']);
    const held = pictured();
    await act(held, { action: 'left_click', coordinate: [100, 100], modifiers: 'ctrl+shift' });
    expect(held.log.slice(0, 3)).toEqual(['move 50,50 +control+shift', 'down left 1 50,50 +control+shift', 'up left 1 50,50 +control+shift']);
  });

  it('a drag travels: pressed at the start, moved in steps with the button held, released at the end', async () => {
    const p = pictured();
    const a = await act(p, { action: 'left_click_drag', start: [0, 0], coordinate: [320, 160] });
    expect(a.note).toBe('已拖动。');
    expect(p.log.slice(0, 2)).toEqual(['move 0,0', 'down left 1 0,0']);
    const moves = p.log.filter((l) => l.includes('held left'));
    expect(moves).toHaveLength(8);
    expect(moves[0]).toBe('move 20,10 held left');
    expect(moves[7]).toBe('move 160,80 held left');
    expect(p.log.slice(-3)).toEqual(['up left 1 160,80', 'settle 7', 'capture']);
    await expect(act(pictured(), { action: 'left_click_drag', coordinate: [10, 10] })).rejects.toThrow('位置要写成 [x, y]');
  });

  it('scroll: the wheel at that position, by notches — down and right are negative, as a wheel reports them', async () => {
    const down = pictured();
    expect((await act(down, { action: 'scroll', coordinate: [640, 400], direction: 'down', amount: 3 })).note).toBe('已滚动。');
    expect(down.log.slice(0, 2)).toEqual(['move 320,200', `wheel 320,200 dx 0 dy ${-3 * WHEEL_NOTCH}`]);
    const wheel = async (direction: string, amount?: number) => { const p = pictured(); await act(p, { action: 'scroll', coordinate: [0, 0], direction, amount }); return p.log[1]; };
    expect(await wheel('up', 2)).toBe(`wheel 0,0 dx 0 dy ${2 * WHEEL_NOTCH}`);
    expect(await wheel('left', 1)).toBe(`wheel 0,0 dx ${WHEEL_NOTCH} dy 0`);
    expect(await wheel('right', 1)).toBe(`wheel 0,0 dx ${-WHEEL_NOTCH} dy 0`);
    expect(await wheel('down')).toBe(`wheel 0,0 dx 0 dy ${-3 * WHEEL_NOTCH}`); // three notches when not said
    expect(await wheel('down', 999)).toBe(`wheel 0,0 dx 0 dy ${-20 * WHEEL_NOTCH}`);
  });

  it('type goes to whatever has the focus; key is a key or a shortcut; wait waits; each ends with a picture', async () => {
    const typed = pictured();
    expect((await act(typed, { action: 'type', text: 'hello 世界' })).note).toBe('已输入。');
    expect(typed.log).toEqual(['insert hello 世界', 'settle 7', 'capture']);
    const key = pictured();
    expect((await act(key, { action: 'key', text: ' ctrl+a ' })).note).toBe('已按键。');
    expect(key.log).toEqual(['key ctrl+a', 'settle 7', 'capture']);
    await expect(act(pictured(), { action: 'key', text: '' })).rejects.toThrow('不认识的按键');
    await expect(act(pictured(), { action: 'key', text: 'NoSuchKey' })).rejects.toThrow('不认识的按键：NoSuchKey');
    const waited = pictured();
    const t0 = Date.now();
    expect((await act(waited, { action: 'wait', seconds: 0.1 })).note).toBe('已等待。');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(90);
    expect(waited.log).toEqual(['capture']);
  });

  it('a position outside the picture, or an action nobody knows, touches nothing', async () => {
    const p = pictured();
    await expect(act(p, { action: 'left_click', coordinate: [1281, 10] })).rejects.toThrow('位置 [1281, 10] 在截图（1280×800）外面。');
    await expect(act(p, { action: 'left_click', coordinate: [10, -1] })).rejects.toThrow('外面');
    await expect(act(p, { action: 'left_click', coordinate: 'middle' })).rejects.toThrow('位置要写成 [x, y]');
    await expect(act(p, { action: 'fly', coordinate: [1, 1] })).rejects.toThrow('不认识的操作：fly');
    expect(p.log).toEqual([]);
  });
});

describe('positions and modifiers', () => {
  it('toView: a position in the picture is the same place in the page, whatever the two sizes', () => {
    const view = { width: 640, height: 400 };
    expect(toView([0, 0], { width: 1280, height: 800 }, view)).toEqual({ x: 0, y: 0 });
    expect(toView([640, 400], { width: 1280, height: 800 }, view)).toEqual({ x: 320, y: 200 });
    // the far edge of the picture is the last pixel of the page, not one past it
    expect(toView([1280, 800], { width: 1280, height: 800 }, view)).toEqual({ x: 639, y: 399 });
    // a picture the same size as the page: positions as they are
    expect(toView([123, 45], view, view)).toEqual({ x: 123, y: 45 });
    // a picture that was shrunk (a wide page drawn at 1280)
    expect(toView([640, 300], { width: 1280, height: 600 }, { width: 1920, height: 900 })).toEqual({ x: 960, y: 450 });
    expect(toView([10.4, 10.6], view, view)).toEqual({ x: 10, y: 11 });
  });
  it('parseModifiers: the names people write become the names an input event takes; anything else is left out', () => {
    expect(parseModifiers('shift')).toEqual(['shift']);
    expect(parseModifiers('ctrl+shift')).toEqual(['control', 'shift']);
    expect(parseModifiers('Control + Alt')).toEqual(['control', 'alt']);
    expect(parseModifiers('cmd, option')).toEqual(['meta', 'alt']);
    expect(parseModifiers('win')).toEqual(['meta']);
    expect(parseModifiers('shift+shift+hyper')).toEqual(['shift']);
    expect(parseModifiers(undefined)).toEqual([]);
    expect(parseModifiers(7)).toEqual([]);
  });
});
