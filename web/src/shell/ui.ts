// The shell's screens, in plain DOM (no framework: the shell must stay small): the PC list, a busy screen while
// pairing or connecting, a failure screen, and the app in a full-screen frame with a thin bar above it for the
// connection's state. Text only, no innerHTML: nothing from a PC name or an error can become markup.
import { imeComposing } from '../ui/ime';
import type { DeviceRec } from './devices';
import type { Explained } from './explain';
import { tr } from './i18n';

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
  /** Runs when the × hides it. */
  onClose?: () => void;
}

export interface ListOptions {
  connect: (d: DeviceRec) => void;
  remove: (d: DeviceRec) => void;
  /** A line on top: a link that did not read, a pairing kept only for this visit. */
  notice?: Explained | null;
  /** iOS Safari outside the home screen. */
  iosHint?: (() => void) | null;
  /** 扫码配对 (the shell's own scanner); null where this browser has no camera to give. */
  scan?: (() => void) | null;
  /** A pasted pairing link (the fallback field, 「扫不了？粘贴配对链接」); returns an error to show under it, or null when taken. */
  paste: (text: string) => string | null;
  /** The fallback field open (the scanner could not run). */
  pasteOpen?: boolean;
}

export interface AskOptions {
  /** 就在 Safari 里用: pair here, now. */
  here: () => void;
  back: () => void;
}

export interface ScanScreen {
  /** Where the camera's picture goes. */
  video: HTMLVideoElement;
  /** A line under the frame (a QR that is not a pairing one), or null. */
  say(text: string | null): void;
  /** The camera did not open: why, with the fallback (粘贴配对链接) and 返回. */
  failed(x: Explained): void;
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
  if (s < 60) return tr('刚刚');
  if (s < 3600) return tr('{s} 分钟前', { s: Math.floor(s / 60) });
  if (s < 86_400) return tr('{s} 小时前', { s: Math.floor(s / 3600) });
  return tr('{s} 天前', { s: Math.floor(s / 86_400) });
}

function why(x: Explained): HTMLElement {
  return h('div', 'why', h('p', 'why-text', x.text), x.raw ? h('p', 'why-raw', tr('原文：{raw}', { raw: x.raw })) : null);
}

export const IOS_HINT = tr('在 Safari 里配对的电脑只留在 Safari 里，主屏幕图标打开的是另一份。想从主屏幕用：在电脑上重新生成二维码，扫码后照提示先添加到主屏幕。只在 Safari 里用的话，7 天没打开这个页面 Safari 会清掉配对，要重新扫码。');
export const EMPTY_LIST = tr('还没有配对的电脑。在电脑上打开 Claude Web → 设置 → 手机与远程，生成配对码，再点下面的「扫码配对」。');
export const ASK_WHY = tr('先加到主屏幕再配对：以后点图标就能用，不用再扫码。在 Safari 里配对的电脑只留在 Safari 里。');
export const HOME_STEPS = [tr('点 Safari 的分享按钮（新版 Safari 在「⋯」里）'), tr('选「添加到主屏幕」'), tr('从主屏幕的图标打开，会自动配对（10 分钟内）')];
export const ALREADY_HOME = tr('主屏幕上已经有 Claude Web 了：打开它，点「扫码配对」再扫一次电脑上的二维码。');
export const INSTALL_HINT = tr('装到主屏幕：以后点图标就能打开，配好的电脑不用再配。');
export const SCAN_HINT = tr('对准电脑上 设置 → 手机与远程 的二维码');

const SVG = 'http://www.w3.org/2000/svg';

/** A QR mark for 扫码配对 (three finder squares and a few modules), in the button's colour. */
function qrMark(): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'qr-mark');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ['M4 4h6v6H4z', 'M14 4h6v6h-6z', 'M4 14h6v6H4z', 'M14 14h2v2h-2z', 'M18 18h2v2h-2z', 'M14 18h2', 'M18 14h2']) {
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

/** iOS's share mark (a box with an arrow out of it), drawn in the text's colour. */
function shareMark(): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'share-mark');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ['M12 3v12', 'M8 7l4-4 4 4', 'M7 10H6a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1h-1']) {
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

export class Ui {
  private readonly page: HTMLElement;
  private readonly appBox: HTMLElement;
  private readonly bar: HTMLElement;
  private frame: HTMLIFrameElement | null = null;
  /** The list's 安装到主屏幕 card (Android, a browser that offers it): its place, and what the button runs. */
  private installSlot: HTMLElement | null = null;
  private install: (() => void) | null = null;

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
    this.installSlot = h('div', 'install-slot');
    this.fillInstall();
    const scan = o.scan ? button(tr('扫码配对'), 'primary wide scan-btn', o.scan) : null;
    if (scan) scan.prepend(qrMark());
    this.show(
      o.notice ? h('div', 'notice', why(o.notice)) : null,
      o.iosHint ? h('div', 'hint', h('p', '', IOS_HINT), button(tr('知道了'), 'link', o.iosHint)) : null,
      this.installSlot,
      h('h1', '', tr('你的电脑')),
      rows.length ? h('ul', 'devices', ...rows) : h('p', 'empty', EMPTY_LIST),
      scan,
      // the fallback, for a phone whose camera cannot be used: open by itself when there is no scanner
      this.pasteBox(o.paste, !!o.pasteOpen || !o.scan),
    );
  }

  /**
   * 扫码配对: the camera full screen with a frame to aim at; × goes back. A QR that is not a pairing one says so under
   * the frame and the camera goes on; a camera that will not open says why, with the fallback.
   */
  scanner(o: { close: () => void; paste: () => void }): ScanScreen {
    const video = h('video', 'scan-video');
    video.setAttribute('playsinline', '');
    video.setAttribute('muted', '');
    video.muted = true;
    video.autoplay = true;
    const close = button('×', 'scan-x', o.close);
    close.setAttribute('aria-label', tr('关闭'));
    const line = h('p', 'scan-line');
    line.hidden = true;
    const frame = h('div', 'scan-frame', h('i', 'scan-sweep'));
    const fail = h('div', 'scan-fail');
    fail.hidden = true;
    const box = h(
      'div',
      'scan',
      video,
      h('div', 'scan-top', close, h('h1', '', tr('扫码配对'))),
      frame,
      h('div', 'scan-bottom', h('p', 'scan-hint', SCAN_HINT), line, fail),
    );
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', tr('扫码配对'));
    this.show(box);
    return {
      video,
      say(text) {
        line.textContent = text ?? '';
        line.hidden = !text;
      },
      failed(x) {
        frame.hidden = true;
        line.hidden = true;
        fail.hidden = false;
        fail.replaceChildren(why(x), h('div', 'actions', button(tr('粘贴配对链接'), 'primary', o.paste), button(tr('返回'), 'ghost', o.close)));
      },
    };
  }

  /** The list's 安装到主屏幕 card: shown while `run` is offered (the browser's install prompt, kept), gone with null. */
  setInstall(run: (() => void) | null): void {
    this.install = run;
    this.fillInstall();
  }

  private fillInstall(): void {
    this.installSlot?.replaceChildren(...(this.install ? [h('div', 'hint install', h('p', '', INSTALL_HINT), button(tr('安装到主屏幕'), 'primary', this.install))] : []));
  }

  /**
   * iOS Safari opened with a pairing link (ruling R12b): add to the home screen first (the steps, at once — the
   * home-screen app pairs by itself, the link rides in a cookie), or pair here. A phone that has the icon already
   * scans again from inside it (the cookie only reaches a home-screen app made from now on).
   */
  askPair(pc: string, o: AskOptions): void {
    const steps = h('ol', 'steps', ...HOME_STEPS.map((s, i) => h('li', '', s, i === 0 ? shareMark() : null)));
    this.show(
      h(
        'div',
        'ask',
        h('h1', '', tr('和 {pc} 配对', { pc: pc || tr('电脑') })),
        h('p', 'line', ASK_WHY),
        steps,
        h('p', 'steps-note', ALREADY_HOME),
        button(tr('就在 Safari 里用'), 'ghost wide', o.here),
        button(tr('返回'), 'link', o.back),
      ),
    );
  }

  busy(title: string, line: string, o: { progress?: number | null; cancel?: (() => void) | null } = {}): void {
    const bar = o.progress == null ? null : h('div', 'progress', h('div', 'fill'));
    if (bar) (bar.firstChild as HTMLElement).style.width = `${Math.round(Math.min(1, Math.max(0, o.progress!)) * 100)}%`;
    this.show(h('div', 'busy', h('div', 'spin'), h('h1', '', title), h('p', 'line', line), bar, o.cancel ? button(tr('取消'), 'ghost', o.cancel) : null));
  }

  failed(title: string, x: Explained, o: { retry?: (() => void) | null; back: () => void }): void {
    this.show(
      h('div', 'failed', h('h1', '', title), why(x), h('div', 'actions', o.retry ? button(tr('重试'), 'primary', o.retry) : null, button(tr('返回'), 'ghost', o.back))),
    );
  }

  /**
   * The app at `url`, in a new frame: an old one is removed first (its page unloads, so it opens no more streams),
   * then `unloaded` runs (the shell ends that page's streams), then the new frame loads.
   */
  app(url: string, unloaded: () => void, loaded?: () => void): void {
    this.frame?.remove();
    this.frame = null;
    unloaded();
    const f = h('iframe', 'frame');
    f.title = 'Claude Web';
    // a moment after its load, so its first screen has painted before anything that hid it goes
    if (loaded) f.addEventListener('load', () => setTimeout(loaded, 250), { once: true });
    f.src = url;
    this.appBox.append(f);
    this.frame = f;
    this.appBox.hidden = false;
    this.page.parentElement!.hidden = true;
  }

  /** The app frame's window (what a message from the app must come from), or null. */
  frameWindow(): Window | null {
    return this.frame?.contentWindow ?? null;
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
    this.bar.append(h('span', 'bar-text', b.text, b.raw ? h('span', 'bar-raw', tr('（原文：{raw}）', { raw: b.raw })) : null), ...acts);
    if (b.closable) {
      const close = button('×', 'bar-x', () => {
        b.onClose?.();
        this.setBar(null);
      });
      close.setAttribute('aria-label', tr('关闭'));
      this.bar.append(close);
    }
  }

  /** The app is open and its bar says nothing: room for an offer (安装到主屏幕) without covering the connection's state. */
  barFree(): boolean {
    return !this.appBox.hidden && this.bar.hidden === true;
  }

  private pasteBox(paste: (text: string) => string | null, open: boolean): HTMLElement {
    const input = h('input', 'paste-in');
    input.type = 'url';
    input.placeholder = tr('粘贴电脑上的配对链接');
    input.autocomplete = 'off';
    input.setAttribute('autocapitalize', 'off');
    input.spellcheck = false;
    const err = h('p', 'paste-err');
    err.hidden = true;
    const submit = () => {
      const said = paste(input.value);
      err.textContent = said ?? '';
      err.hidden = !said;
    };
    input.addEventListener('keydown', (e) => {
      // the Enter that commits pinyin (macOS / Safari) belongs to the input method
      if (e.key === 'Enter' && !imeComposing(e)) {
        e.preventDefault();
        submit();
      }
    });
    const form = h('div', 'paste', h('div', 'paste-row', input, button(tr('配对'), 'primary', submit)), err);
    form.hidden = !open;
    const toggle = button(tr('扫不了？粘贴配对链接'), 'link paste-toggle', () => {
      form.hidden = !form.hidden;
      if (!form.hidden) input.focus();
    });
    return h('div', 'paste-box', open ? h('h2', '', tr('粘贴配对链接')) : toggle, form);
  }

  private row(d: DeviceRec, o: ListOptions): HTMLElement {
    const when = d.lastAt ? tr('上次连接 {ago}', { ago: ago(d.lastAt, Date.now()) }) : tr('配对于 {ago}', { ago: ago(d.pairedAt, Date.now()) });
    const open = button('', 'device', () => o.connect(d));
    open.append(h('span', 'pc', d.pcName), h('span', 'when', when));
    let armed = false;
    const del = button(tr('删除'), 'del', () => {
      if (!armed) {
        armed = true;
        del.textContent = tr('确定删除？');
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
