// The shell's screens, in plain DOM (no framework: the shell must stay small): the PC list, a busy screen while
// pairing or connecting, a failure screen, and the app in a full-screen frame with a thin bar above it for the
// connection's state. Text only, no innerHTML: nothing from a PC name or an error can become markup.
import type { DeviceRec } from './devices';
import type { Explained } from './explain';

export interface BarAction {
  label: string;
  run: () => void;
}

export interface BarState {
  text: string;
  raw?: string;
  tone: 'info' | 'warn' | 'err';
  busy?: boolean;
  actions?: BarAction[];
  /** Shows a × that hides the bar. */
  closable?: boolean;
}

export interface ListOptions {
  connect: (d: DeviceRec) => void;
  remove: (d: DeviceRec) => void;
  /** A line on top: a link that did not read, a pairing kept only for this visit. */
  notice?: Explained | null;
  /** iOS Safari outside the home screen. */
  iosHint?: (() => void) | null;
}

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  for (const k of kids) if (k) el.append(k);
  return el;
}

function button(label: string, cls: string, run: () => void): HTMLButtonElement {
  const b = h('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', run);
  return b;
}

/** 「刚刚 / N 分钟前 / N 小时前 / N 天前」. */
export function ago(ts: number, now: number): string {
  const s = Math.max(0, now - ts) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86_400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86_400)} 天前`;
}

function why(x: Explained): HTMLElement {
  return h('div', 'why', h('p', 'why-text', x.text), x.raw ? h('p', 'why-raw', `原文：${x.raw}`) : null);
}

export const IOS_HINT = '在 Safari 里点「分享」→「添加到主屏幕」，以后从主屏幕打开：不然 7 天没打开这个页面，Safari 会清掉这里的配对，要重新扫码。';
export const EMPTY_LIST = '还没有配对的电脑。在电脑上打开 Claude Web → 设置 → 手机与其它电脑，用手机扫那里的二维码。';

export class Ui {
  private readonly page: HTMLElement;
  private readonly appBox: HTMLElement;
  private readonly bar: HTMLElement;
  private frame: HTMLIFrameElement | null = null;

  constructor(root: HTMLElement) {
    const head = h('header', 'top', h('span', 'logo', '✱'), h('span', 'name', 'Claude Web'));
    this.page = h('main', 'page');
    this.bar = h('div', 'bar');
    this.bar.hidden = true;
    this.appBox = h('div', 'app', this.bar);
    this.appBox.hidden = true;
    root.append(h('div', 'shell', head, this.page), this.appBox);
  }

  devices(list: DeviceRec[], o: ListOptions): void {
    const rows = list.map((d) => this.row(d, o));
    this.show(
      o.notice ? h('div', 'notice', why(o.notice)) : null,
      o.iosHint ? h('div', 'hint', h('p', '', IOS_HINT), button('知道了', 'link', o.iosHint)) : null,
      h('h1', '', '你的电脑'),
      rows.length ? h('ul', 'devices', ...rows) : h('p', 'empty', EMPTY_LIST),
    );
  }

  busy(title: string, line: string, o: { progress?: number | null; note?: Explained | null; cancel?: (() => void) | null } = {}): void {
    const bar = o.progress == null ? null : h('div', 'progress', h('div', 'fill'));
    if (bar) (bar.firstChild as HTMLElement).style.width = `${Math.round(Math.min(1, Math.max(0, o.progress!)) * 100)}%`;
    this.show(
      h('div', 'busy', h('div', 'spin'), h('h1', '', title), h('p', 'line', line), bar, o.note ? why(o.note) : null, o.cancel ? button('取消', 'ghost', o.cancel) : null),
    );
  }

  failed(title: string, x: Explained, o: { retry?: (() => void) | null; back: () => void }): void {
    this.show(
      h('div', 'failed', h('h1', '', title), why(x), h('div', 'actions', o.retry ? button('重试', 'primary', o.retry) : null, button('返回', 'ghost', o.back))),
    );
  }

  /**
   * The app at `url`, in a new frame: an old one is removed first (its page unloads, so it opens no more streams),
   * then `unloaded` runs (the shell ends that page's streams), then the new frame loads.
   */
  app(url: string, unloaded: () => void): void {
    this.frame?.remove();
    this.frame = null;
    unloaded();
    const f = h('iframe', 'frame');
    f.title = 'Claude Web';
    f.src = url;
    this.appBox.append(f);
    this.frame = f;
    this.appBox.hidden = false;
    this.page.parentElement!.hidden = true;
  }

  closeApp(): void {
    this.frame?.remove();
    this.frame = null;
    this.setBar(null);
    this.appBox.hidden = true;
    this.page.parentElement!.hidden = false;
  }

  setBar(b: BarState | null): void {
    this.bar.replaceChildren();
    this.bar.hidden = !b;
    if (!b) return;
    this.bar.className = `bar ${b.tone}`;
    const acts = (b.actions ?? []).map((a) => button(a.label, 'bar-act', a.run));
    if (b.busy) this.bar.append(h('span', 'spin small'));
    this.bar.append(h('span', 'bar-text', b.text, b.raw ? h('span', 'bar-raw', `（原文：${b.raw}）`) : null), ...acts);
    if (b.closable) {
      const close = button('×', 'bar-x', () => this.setBar(null));
      close.setAttribute('aria-label', '关闭');
      this.bar.append(close);
    }
  }

  private row(d: DeviceRec, o: ListOptions): HTMLElement {
    const when = d.lastAt ? `上次连接 ${ago(d.lastAt, Date.now())}` : `配对于 ${ago(d.pairedAt, Date.now())}`;
    const open = button('', 'device', () => o.connect(d));
    open.append(h('span', 'pc', d.pcName), h('span', 'when', when));
    let armed = false;
    const del = button('删除', 'del', () => {
      if (!armed) {
        armed = true;
        del.textContent = '确定删除？';
        del.classList.add('armed');
        return;
      }
      o.remove(d);
    });
    return h('li', '', open, del);
  }

  private show(...kids: Child[]): void {
    this.page.replaceChildren(...kids.filter((k): k is Node | string => !!k));
    this.closeApp();
  }
}
