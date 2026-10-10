// Web search in the built-in browser: a search engine's result page is loaded in a page of its own — not the
// conversation's tab, whose page a search must not replace, and not on screen — and what it lists is read there
// (page-agent.js `results`). A real page: the engine's scripts ran, and the browser profile's cookies are behind it,
// so a verification the user did once in the browser still counts. Desktop app only (host.ts).
//
// Timing is this file's promise to the server (search.ts BROWSER_TIMEOUT_MS): one page is answered within about
// SEARCH_LOAD_MS + SEARCH_SETTLE_MS + SEARCH_LIST_MS whatever the page does (a few seconds for a page that shows its
// document at once), a page that cannot be loaded comes back as `failed`, and up to MAX_PAGES are read at once (a
// model often asks for several searches in one turn).
import type { BrowserSearchPage } from '@shared';
import agentSrc from './page-agent.js?raw';
import { hasWebview, type WebviewEl } from './state';
import { loadable } from './url';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** How long a result page has to show its document (a host that swallows the connection is given up on after this). */
export const SEARCH_LOAD_MS = 15_000;
/** Once the document is there, how long the rest of the page may keep loading before it is stopped and read. */
export const SEARCH_SETTLE_MS = 2_000;
/** A page with next to nothing listed gets this long to draw a list with its scripts. */
export const SEARCH_LIST_MS = 2_500;
/** A page is closed after this long without a search (a page of a browser is a process). */
export const SEARCH_IDLE_MS = 3 * 60_000;
/** Result pages read at the same time. */
export const MAX_PAGES = 3;
/** Fewer links than this and the list may still be coming. */
const ENOUGH = 3;
const POLL_MS = 250;
const READ_MS = 3_000;

interface Worker {
  el: WebviewEl;
  partition: string;
  busy: boolean;
  /** documents shown so far (dom-ready of the main frame): a load is waited for by this number going up */
  docs: number;
  loading: boolean;
  failed: string;
  idle?: ReturnType<typeof setTimeout>;
}
const workers: Worker[] = [];
/** searches waiting for a page to be free */
const waiters: (() => void)[] = [];

function shut(w: Worker): void {
  clearTimeout(w.idle);
  const at = workers.indexOf(w);
  if (at >= 0) workers.splice(at, 1);
  try { w.el.remove(); } catch { /* already gone */ }
  waiters.shift()?.();
}

/** A hidden page in `partition` (a <webview>'s profile is fixed when it is made: another profile is another page). */
function open(url: string, partition: string): Worker {
  const el = document.createElement('webview') as unknown as WebviewEl;
  el.setAttribute('partition', partition);
  el.setAttribute('src', url);
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('data-cw-search', '');
  // laid out at a real size (a page with no size loads lazily and lists nothing), but off screen and never drawn
  el.style.cssText = 'position:fixed;left:-20000px;top:0;width:1280px;height:900px;visibility:hidden;pointer-events:none;';
  const w: Worker = { el, partition, busy: true, docs: 0, loading: true, failed: '' };
  el.addEventListener('dom-ready', () => { w.docs++; });
  el.addEventListener('did-start-loading', () => { w.loading = true; });
  el.addEventListener('did-stop-loading', () => { w.loading = false; });
  el.addEventListener('did-fail-load', ((e: Event) => {
    const d = e as unknown as { errorCode: number; errorDescription: string; isMainFrame: boolean };
    // -3 is ERR_ABORTED: the page redirected itself, which is not a failure
    if (d.isMainFrame && d.errorCode !== -3) w.failed = d.errorDescription || `error ${d.errorCode}`;
  }) as EventListener);
  workers.push(w);
  document.body.appendChild(el);
  return w;
}

/** A free page of this profile, taken; null when a new one may be made; waits while all are in use. */
async function take(partition: string): Promise<Worker | null> {
  for (;;) {
    for (const w of [...workers]) if (!w.el.isConnected) shut(w);
    const free = workers.find((w) => !w.busy && w.partition === partition);
    if (free) {
      free.busy = true;
      clearTimeout(free.idle);
      return free;
    }
    if (workers.length >= MAX_PAGES) {
      // a page of the other profile that nobody is using makes room
      const other = workers.find((w) => !w.busy);
      if (other) shut(other);
    }
    if (workers.length < MAX_PAGES) return null;
    await new Promise<void>((r) => waiters.push(r));
  }
}

function give(w: Worker): void {
  if (!workers.includes(w)) return; // shut on the way: that already let the next one in
  w.busy = false;
  w.idle = setTimeout(() => shut(w), SEARCH_IDLE_MS);
  waiters.shift()?.();
}

/** What the page lists right now; null while it cannot be asked (between two documents). */
async function read(w: Worker): Promise<BrowserSearchPage | null> {
  const asked = w.el.executeJavaScript<{ ok: boolean; value?: BrowserSearchPage }>(
    `${agentSrc}\n;(() => { try { return { ok: true, value: window.__cwAgent.results() }; } catch (e) { return { ok: false }; } })()`,
  ).then((r) => (r?.ok && r.value ? r.value : null), () => null);
  return Promise.race([asked, sleep(READ_MS).then(() => null)]);
}

async function load(url: string, partition: string): Promise<BrowserSearchPage> {
  if (!loadable(url)) throw new Error(`不是能打开的地址：${url.slice(0, 200)}`);
  const unreachable = (why: string): BrowserSearchPage => ({ url, title: '', text: '', candidates: [], failed: why });
  let w = await take(partition);
  let before = 0;
  if (!w) {
    w = open(url, partition);
  } else {
    before = w.docs;
    w.failed = '';
    w.loading = true;
    // rejects when the load fails (the failure is in `failed`) and with ERR_ABORTED when the page redirects itself
    void w.el.loadURL(url).catch(() => {});
  }
  try {
    const deadline = Date.now() + SEARCH_LOAD_MS;
    // the new document, not what the page showed for the search before
    while (w.docs === before && !w.failed && Date.now() < deadline) await sleep(60);
    if (w.failed) return unreachable(w.failed);
    if (w.docs === before) {
      // nothing came in all that time (a host that swallows the connection): stop waiting for it
      shut(w);
      return unreachable('ERR_TIMED_OUT');
    }
    // The document is there. A script can be run in it only once it has stopped loading (Electron holds it until
    // then), and a result list does not need the page's pictures and trackers: the page's own scripts get a moment,
    // then whatever is still coming is stopped.
    for (const end = Math.min(deadline, Date.now() + SEARCH_SETTLE_MS); w.loading && !w.failed && Date.now() < end;) await sleep(60);
    if (w.failed) return unreachable(w.failed);
    if (w.loading) {
      try { w.el.stop(); } catch { /* being torn down */ }
      await sleep(80);
    }
    let page: BrowserSearchPage | null = null;
    let last = -1;
    for (const end = Date.now() + SEARCH_LIST_MS; ;) {
      if (w.failed) return unreachable(w.failed);
      const now = await read(w);
      if (now) {
        // a list that is there and no longer growing
        if (now.candidates.length >= ENOUGH && now.candidates.length === last) return now;
        last = now.candidates.length;
        page = now;
      }
      if (Date.now() >= end) break;
      await sleep(POLL_MS);
    }
    if (!page) throw new Error('结果页没有回应。');
    return page;
  } finally {
    give(w);
  }
}

/** Load a search engine's result page and list what it shows. `failed` in the answer: the page could not be loaded. */
export function searchPage(url: string, partition: string): Promise<BrowserSearchPage> {
  if (!hasWebview()) return Promise.reject(new Error('这个窗口没有内置浏览器'));
  return load(url, partition);
}
