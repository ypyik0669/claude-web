// The built-in browser's tabs (structure round 2, spec §4): one browser per window, in the right panel. A small store
// of its own — the panel draws it, the host (host.ts) drives it for an Agent, and `openInBrowser` is how the rest of
// the app opens a page in it.
import { create } from 'zustand';
import { loadable } from './url';

export interface BrowserTab {
  id: string;
  /** the address its page was created with; '' = a new tab: its own page (search box, recent sites), no web page yet.
   *  Set once — the page moves on by being told to load, never by this changing (a <webview> reloads when its `src` is set again). */
  src: string;
  /** where the page is now (the address field) */
  url: string;
  /** the web app only (no <webview>): what its <iframe> shows — an iframe does not say where it went */
  frameUrl?: string;
  title: string;
  loading: boolean;
  back: boolean;
  fwd: boolean;
  /** why the last load failed (cleared when the next one starts) */
  error?: string;
  /** the conversation whose Agent opened this tab (and works in it) */
  agent?: string;
  /** an Agent's operation is running in it right now */
  busy?: boolean;
  /** the browser profile it was created in: fixed for the tab's life (a <webview>'s partition cannot change) */
  partition: string;
}

/** The user's own profile (what the browser tile always used), and the Agent's separate one (`web.browser.isolated`). */
export const USER_PARTITION = 'persist:cw-browser';
export const AGENT_PARTITION = 'persist:cw-agent';

interface BrowserState { tabs: BrowserTab[]; active: string | null }
export const useBrowser = create<BrowserState>(() => ({ tabs: [], active: null }));

let seq = 0;
const blank = (o: Partial<BrowserTab> = {}): BrowserTab => ({ id: `b${Date.now().toString(36)}${(seq++).toString(36)}`, src: '', url: '', title: '', loading: false, back: false, fwd: false, partition: USER_PARTITION, ...o });

/** A new tab, in front unless `front: false`. Returns its id. */
export function newTab(o: { url?: string; agent?: string; partition?: string; front?: boolean } = {}): string {
  const url = o.url && loadable(o.url) ? o.url : '';
  const tab = blank({ src: url, url, agent: o.agent, partition: o.partition ?? USER_PARTITION, loading: !!url });
  useBrowser.setState((s) => ({ tabs: [...s.tabs, tab], active: o.front === false && s.active ? s.active : tab.id }));
  return tab.id;
}

/** Close a tab; the one after it (else before it) comes to the front. The browser always has a tab: closing the last opens a new one. */
export function closeTab(id: string): void {
  useBrowser.setState((s) => {
    const i = s.tabs.findIndex((t) => t.id === id);
    if (i < 0) return s;
    const tabs = s.tabs.filter((t) => t.id !== id);
    if (!tabs.length) { const t = blank(); return { tabs: [t], active: t.id }; }
    return { tabs, active: s.active === id ? (tabs[i] ?? tabs[i - 1]).id : s.active };
  });
}

export function frontTab(id: string): void {
  useBrowser.setState((s) => (s.active === id || !s.tabs.some((t) => t.id === id) ? s : { ...s, active: id }));
}

export function patchTab(id: string, patch: Partial<BrowserTab>): void {
  useBrowser.setState((s) => {
    const cur = s.tabs.find((t) => t.id === id);
    if (!cur || (Object.keys(patch) as (keyof BrowserTab)[]).every((k) => cur[k] === patch[k])) return s;
    return { ...s, tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) };
  });
}

export const tabOf = (id: string): BrowserTab | undefined => useBrowser.getState().tabs.find((t) => t.id === id);
/** The tab an Agent of this conversation works in (one per conversation). */
export const agentTab = (sessionId: string): BrowserTab | undefined => useBrowser.getState().tabs.find((t) => t.agent === sessionId);

/** The browser has at least one tab once it is on screen. */
export function ensureTab(): void {
  if (!useBrowser.getState().tabs.length) newTab();
}

/**
 * Open a page for the user: in the tab in front when that one is still a new tab, else in a new one. (Showing the
 * right panel's 浏览器 is the caller's: right-panel.ts `openInBrowser`.)
 */
export function openUrl(url: string): string {
  const s = useBrowser.getState();
  const cur = s.tabs.find((t) => t.id === s.active);
  if (cur && !cur.src && !cur.agent && loadable(url)) { patchTab(cur.id, { src: url, url, loading: true, error: undefined }); return cur.id; }
  return newTab({ url });
}

// ---- the live pages: a tab's <webview> (desktop) once it is in the document ----

/** What guest.ts needs of a `<webview>` element (Electron's tag; typed here because the DOM lib does not know it). */
export interface WebviewEl extends HTMLElement {
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
  isLoading(): boolean;
  isLoadingMainFrame?(): boolean;
  stop(): void;
  reload(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  executeJavaScript<T = unknown>(code: string, userGesture?: boolean): Promise<T>;
  sendInputEvent(e: Record<string, unknown>): Promise<void> | void;
  getWebContentsId(): number;
  capturePage?(): Promise<{ toDataURL(): string; isEmpty?(): boolean; getSize?(): { width: number; height: number } }>;
  insertText?(text: string): Promise<void>;
  openDevTools?(): void;
}

interface Live { el: WebviewEl; ready: boolean }
const live = new Map<string, Live>();
const waiters = new Map<string, (() => void)[]>();

export function setGuest(tabId: string, el: WebviewEl | null): void {
  if (!el) { live.delete(tabId); return; }
  const cur = live.get(tabId);
  if (cur?.el !== el) live.set(tabId, { el, ready: false });
}
/** The page answered `dom-ready`: its methods may be called now. */
export function guestReady(tabId: string): void {
  const g = live.get(tabId);
  if (!g) return;
  g.ready = true;
  for (const w of waiters.get(tabId) ?? []) w();
  waiters.delete(tabId);
}
export const guestOf = (tabId: string): WebviewEl | undefined => { const g = live.get(tabId); return g?.ready ? g.el : undefined; };
/** The element whether or not it is ready yet (its size can be read at once). */
export const guestElOf = (tabId: string): WebviewEl | undefined => live.get(tabId)?.el;

/** The tab's page once it can be driven; undefined when it did not get there in `ms` (no browser here, tab closed). */
export function waitGuest(tabId: string, ms: number): Promise<WebviewEl | undefined> {
  const now = guestOf(tabId);
  if (now) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); resolve(guestOf(tabId)); };
    const timer = setTimeout(() => { waiters.set(tabId, (waiters.get(tabId) ?? []).filter((w) => w !== done)); resolve(guestOf(tabId)); }, ms);
    waiters.set(tabId, [...(waiters.get(tabId) ?? []), done]);
  });
}

/** Whether this window can show real pages: Electron with the `<webview>` tag (the desktop app). */
let can: boolean | undefined;
export function hasWebview(): boolean {
  if (can === undefined) {
    try { can = typeof (document.createElement('webview') as Partial<WebviewEl>).loadURL === 'function'; } catch { can = false; }
  }
  return can;
}
