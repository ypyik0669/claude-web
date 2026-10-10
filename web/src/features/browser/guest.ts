// A tab of the built-in browser as something an operation can be carried out on (ops.ts `PageHandle`): the tab's
// <webview>, driven through the tag's own methods. Desktop app only — elsewhere there is no page to drive and the
// server reads pages itself.
import { desktop } from '@/desktop';
import agentSrc from './page-agent.js?raw';
import { parseKey, type MouseAct, type PageHandle, type Picture } from './ops';
import { guestOf, patchTab, tabOf, waitGuest, type WebviewEl } from './state';
import { loadable } from './url';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** How long a page is given to load before it is read as it is. */
export const LOAD_MS = 20_000;

/** Wait until the page has stopped loading and stayed so for a moment. False: still loading after `ms`. */
async function idle(el: WebviewEl, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  let calm = 0;
  for (;;) {
    let loading = true;
    try { loading = el.isLoading(); } catch { /* being re-attached: counts as loading */ }
    calm = loading ? 0 : calm + 1;
    if (calm >= 2) return true;
    if (Date.now() >= end) return false;
    await sleep(120);
  }
}

/** How much longer a page that is still loading is waited for when something has to be asked of it. */
export const ASK_WAIT_MS = 3_000;

/**
 * A script runs in a page only once its main frame has stopped loading (Electron holds it until then). A page that
 * never does — a picture that does not arrive, a connection kept open — would leave every read waiting until the
 * server gives up on it: it is given a little longer, then its loading is stopped and it is read as it is.
 */
async function askable(el: WebviewEl): Promise<void> {
  const loading = () => { try { return el.isLoadingMainFrame ? el.isLoadingMainFrame() : el.isLoading(); } catch { return false; } };
  for (const end = Date.now() + ASK_WAIT_MS; loading() && Date.now() < end;) await sleep(100);
  if (!loading()) return;
  try { el.stop(); } catch { /* being re-attached */ }
  await sleep(80);
}

/** The size of the last picture taken of each tab's page: the frame an Agent's positions are given in. */
const pictures = new Map<string, { width: number; height: number }>();

async function capture(el: WebviewEl): Promise<Picture> {
  // the shell does it (it can scale and re-encode); a window without the shell's bridge falls back to the tag's own
  if (desktop?.captureGuest) {
    const img = await desktop.captureGuest(el.getWebContentsId());
    if (img?.data) return img;
    throw new Error('这个页面现在截不了图（它没有被画出来：窗口最小化了，或者屏幕关着）。');
  }
  const late = new Promise<undefined>((r) => setTimeout(() => r(undefined), 5000));
  const shot = await Promise.race([el.capturePage?.().catch(() => undefined), late]);
  const url = shot && !shot.isEmpty?.() ? shot.toDataURL() : '';
  const m = /^data:(image\/(?:png|jpeg));base64,(.+)$/.exec(url);
  if (!m) throw new Error('这个页面现在截不了图。');
  const size = shot?.getSize?.();
  return { mime: m[1] as 'image/png' | 'image/jpeg', data: m[2], ...(size?.width && size.height ? { width: size.width, height: size.height } : {}) };
}

/**
 * The page of a tab. The tab's <webview> exists once the tab has an address (a new tab has none): `navigate` on such
 * a tab gives it one, which mounts the page.
 */
export function pageOf(tabId: string): PageHandle {
  const need = async (): Promise<WebviewEl> => {
    const el = guestOf(tabId) ?? (await waitGuest(tabId, 8000));
    if (!el) throw new Error(tabOf(tabId) ? '内置浏览器的这个标签页还没准备好。' : '这个标签页已经关掉了：用 browser_open 重新打开网址。');
    return el;
  };
  const call = async <T>(fn: string, arg: Record<string, unknown>): Promise<T> => {
    const el = await need();
    await askable(el);
    // the agent script answers {ok, value} | {ok: false, error}: a throw inside the page would otherwise arrive as
    // Electron's own wording
    const r = await el.executeJavaScript<{ ok: boolean; value?: T; error?: string }>(
      `${agentSrc}\n;(() => { try { return { ok: true, value: window.__cwAgent[${JSON.stringify(fn)}](${JSON.stringify(arg)}) }; } catch (e) { return { ok: false, error: String((e && e.message) || e) }; } })()`,
    );
    if (!r || !r.ok) throw new Error(r?.error || '页面没有回应这个操作。');
    return r.value as T;
  };
  return {
    async navigate(url) {
      if (!loadable(url)) throw new Error(`内置浏览器只打开 http / https 的地址：${url.slice(0, 200)}`);
      const tab = tabOf(tabId);
      if (!tab) throw new Error('这个标签页已经关掉了：用 browser_open 重新打开网址。');
      if (!tab.src) {
        // a new tab: giving it an address is what creates its page
        patchTab(tabId, { src: url, url, loading: true, error: undefined });
      } else {
        const had = await need();
        patchTab(tabId, { error: undefined });
        // rejects when the load fails (and with ERR_ABORTED when the page redirects itself or starts a download)
        void had.loadURL(url).catch(() => {});
      }
      const el = await need();
      await sleep(150);
      const done = await idle(el, LOAD_MS);
      const err = tabOf(tabId)?.error;
      if (err) throw new Error(`打不开 ${url}：${err}`);
      // what the page builds after `load` (most sites) gets a moment
      await sleep(300);
      return done;
    },
    call: call as PageHandle['call'],
    async settle(ms) {
      return idle(await need(), ms);
    },
    async back() {
      const el = await need();
      if (!el.canGoBack()) return false;
      el.goBack();
      return true;
    },
    async key(key) {
      const el = await need();
      const k = parseKey(key);
      if (!k.keyCode) throw new Error(`不认识的按键：${key}`);
      const mods = k.modifiers.length ? { modifiers: k.modifiers } : {};
      await el.sendInputEvent({ type: 'keyDown', keyCode: k.keyCode, ...mods });
      if (k.char !== undefined) await el.sendInputEvent({ type: 'char', keyCode: k.char, ...mods });
      await el.sendInputEvent({ type: 'keyUp', keyCode: k.keyCode, ...mods });
    },
    async capture() {
      const p = await capture(await need());
      if (p.width && p.height) pictures.set(tabId, { width: p.width, height: p.height }); else pictures.delete(tabId);
      return p;
    },
    async frame() {
      const view = await call<{ width: number; height: number }>('view', {});
      return { picture: pictures.get(tabId) ?? null, view };
    },
    async mouse(e: MouseAct) {
      const el = await need();
      const mods = e.modifiers?.length ? e.modifiers : [];
      if (e.type === 'move') await el.sendInputEvent({ type: 'mouseMove', x: e.x, y: e.y, ...(e.held ? { button: e.held, modifiers: [...mods, `${e.held}ButtonDown`] } : mods.length ? { modifiers: mods } : {}) });
      else if (e.type === 'wheel') await el.sendInputEvent({ type: 'mouseWheel', x: e.x, y: e.y, deltaX: e.dx, deltaY: e.dy, canScroll: true, ...(mods.length ? { modifiers: mods } : {}) });
      else await el.sendInputEvent({ type: e.type === 'down' ? 'mouseDown' : 'mouseUp', x: e.x, y: e.y, button: e.button, clickCount: e.count, ...(mods.length ? { modifiers: mods } : {}) });
    },
    async insertText(text: string) {
      const el = await need();
      if (!el.insertText) throw new Error('这个页面现在不能输入文字。');
      await el.insertText(text);
    },
    url() {
      try { return guestOf(tabId)?.getURL() || tabOf(tabId)?.url || ''; } catch { return tabOf(tabId)?.url ?? ''; }
    },
    title() {
      try { return guestOf(tabId)?.getTitle() || tabOf(tabId)?.title || ''; } catch { return tabOf(tabId)?.title ?? ''; }
    },
  };
}

/** Selected text of a tab's page (for 「发给对话」); '' when there is none or the page cannot be asked. */
export async function selectionOf(tabId: string): Promise<string> {
  const el = guestOf(tabId);
  if (!el) return '';
  try {
    return String((await el.executeJavaScript<string>(`${agentSrc}\n;window.__cwAgent.selection()`)) ?? '');
  } catch { return ''; }
}
