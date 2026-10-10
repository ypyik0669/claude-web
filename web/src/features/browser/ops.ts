// One operation an Agent asked of the built-in browser (spec 2026-10-10-ui-structure §5.2), carried out on a page.
// Pure over `PageHandle` — what a page of the browser can be asked — so the order of things (act, let the page
// settle, read it back) is tested without a browser; guest.ts makes a PageHandle out of a <webview>.
import type { BrowserAnswer, BrowserOp, BrowserPage } from '@shared';

export interface PageHandle {
  /** Load an address and wait for it. Throws with the reason when it cannot be loaded; false = still loading after the wait. */
  navigate(url: string): Promise<boolean>;
  /** Call the page agent (page-agent.js): `__cwAgent[fn](arg)`. */
  call<T>(fn: 'read' | 'find' | 'click' | 'type' | 'scroll', arg: Record<string, unknown>): Promise<T>;
  /** Wait while the page is loading (a click may have started a navigation). False: still loading after `ms`. */
  settle(ms: number): Promise<boolean>;
  /** Go back one page. False: there is none. */
  back(): Promise<boolean>;
  /** Press a key in the page (`Enter`, `Tab`, `Escape`, `ArrowDown`, `Control+A`, a character…). */
  key(key: string): Promise<void>;
  capture(): Promise<{ mime: 'image/jpeg' | 'image/png'; data: string }>;
  url(): string;
  title(): string;
}

/** What `open` reads at once (the server shows 12 000 of it and says how to go on). */
export const OPEN_CHARS = 60_000;
/** After an action the page is a glance (the server's ACTION_CHARS). */
export const GLANCE_CHARS = 6_000;
/** How long an action's effect is given to finish loading. */
export const ACTION_SETTLE_MS = 8_000;
const STILL_LOADING = '页面还在加载，下面的内容可能不全（过一会儿用 browser_read 再读）。';

interface Read { page: BrowserPage; length: number }
interface Did { submitted?: boolean; enter?: boolean }
interface Scrolled { moved: number; top: number; max: number; length: number }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));
/** `[kqz12]` — a note names what was acted on by its ref, never by its text: the server shows a note OUTSIDE the
 *  untrusted-content markers, so it carries this side's own words only (no element names, no addresses). */
const at = (ref: unknown) => `[${str(ref).trim().replace(/^\[|\]$/g, '').slice(0, 24)}]`;

export interface OpTimes { pause?: number; settle?: number }

/**
 * Carry out one operation. After anything that may change the page (click, type + submit, a key, back) the page is
 * given a moment, then read back as a glance — the model sees what its action did without asking again.
 */
export async function runOp(page: PageHandle, op: BrowserOp, args: Record<string, unknown>, t: OpTimes = {}): Promise<BrowserAnswer> {
  const pause = t.pause ?? 250;
  const settleMs = t.settle ?? ACTION_SETTLE_MS;
  const glance = async (note: string): Promise<BrowserAnswer> => {
    await sleep(pause);
    const idle = await page.settle(settleMs);
    const r = await page.call<Read>('read', { offset: 0, maxChars: GLANCE_CHARS });
    return { page: r.page, note: idle ? note : `${note}${STILL_LOADING}` };
  };
  switch (op) {
    case 'open': {
      const idle = await page.navigate(str(args.url));
      const r = await page.call<Read>('read', { offset: 0, maxChars: OPEN_CHARS });
      return idle ? { page: r.page } : { page: r.page, note: STILL_LOADING };
    }
    case 'read': {
      const r = await page.call<Read>('read', { offset: Number(args.offset) || 0, maxChars: Number(args.maxChars) || 12_000 });
      return { page: r.page };
    }
    case 'find':
      return page.call<BrowserAnswer>('find', { query: str(args.query) });
    case 'click': {
      const before = page.url();
      await page.call<Did>('click', { ref: args.ref });
      const a = await glance(`已点击 ${at(args.ref)}。`);
      return page.url() !== before ? { ...a, note: `${a.note ?? ''}页面换了地址（见下面的「来源」）。` } : a;
    }
    case 'type': {
      const d = await page.call<Did>('type', { ref: args.ref, text: str(args.text), submit: args.submit === true });
      if (d.enter) await page.key('Enter');
      if (d.submitted || d.enter) return glance(`已在 ${at(args.ref)} 里输入并提交。`);
      return { note: `已在 ${at(args.ref)} 里输入。` };
    }
    case 'key': {
      const key = str(args.key).trim();
      if (!key) throw new Error('browser_press_key 需要参数 key');
      await page.key(key);
      return glance(`已按 ${parseKey(key).keyCode || '键'}。`);
    }
    case 'scroll': {
      const up = args.direction === 'up';
      const s = await page.call<Scrolled>('scroll', { direction: up ? 'up' : 'down', amount: Number(args.amount) || 1 });
      await sleep(pause);
      if (!s.moved) return { note: up ? '已经在页面最上面了。' : '已经到页面最下面了。' };
      // a page that loads more as it scrolls grew: the new part starts where the old text ended
      const now = await page.call<Read>('read', { offset: 0, maxChars: 200 });
      const grew = now.length > s.length ? `页面多出了内容：用 browser_read {"offset": ${s.length}} 读新出现的部分。` : '用 browser_read 读内容（offset 是文字的位置，和滚到哪里无关）。';
      return { note: `已向${up ? '上' : '下'}滚动（位置 ${s.top} / ${s.max}）。${grew}` };
    }
    case 'back': {
      if (!(await page.back())) return { note: '没有上一页了。' };
      return glance('已返回上一页。');
    }
    case 'screenshot': {
      const image = await page.capture();
      return { image, page: { url: page.url(), title: page.title(), text: '' } };
    }
  }
}

/** Key names as the tools take them → what the page is sent (Electron's accelerator names), with the modifiers apart. */
export function parseKey(key: string): { keyCode: string; modifiers: string[]; char?: string } {
  const parts = key.split('+').map((p) => p.trim()).filter(Boolean);
  // a lone "+" (or "Control++") is the plus key itself
  const last = key.trim().endsWith('+') ? '+' : parts.pop() ?? '';
  const modifiers: string[] = [];
  for (const m of parts) {
    const k = m.toLowerCase();
    if (k === 'ctrl' || k === 'control') modifiers.push('control');
    else if (k === 'shift') modifiers.push('shift');
    else if (k === 'alt' || k === 'option') modifiers.push('alt');
    else if (k === 'meta' || k === 'cmd' || k === 'command' || k === 'win') modifiers.push('meta');
  }
  const NAMES: Record<string, string> = {
    enter: 'Enter', return: 'Enter', tab: 'Tab', escape: 'Escape', esc: 'Escape', backspace: 'Backspace', delete: 'Delete', del: 'Delete',
    arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right', up: 'Up', down: 'Down', left: 'Left', right: 'Right',
    pageup: 'PageUp', pagedown: 'PageDown', home: 'Home', end: 'End', space: 'Space', ' ': 'Space',
  };
  const named = NAMES[last.toLowerCase()];
  if (named) return { keyCode: named, modifiers, ...(named === 'Enter' ? { char: '\r' } : named === 'Space' ? { char: ' ' } : {}) };
  if (/^f\d{1,2}$/i.test(last)) return { keyCode: last.toUpperCase(), modifiers };
  // one character: typed as itself unless a modifier makes it a shortcut
  const ch = Array.from(last)[0] ?? '';
  return { keyCode: ch.length === 1 && /[a-z]/i.test(ch) ? ch.toUpperCase() : ch, modifiers, ...(modifiers.some((m) => m !== 'shift') ? {} : { char: ch }) };
}
