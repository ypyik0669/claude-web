// The built-in browser's tabs (structure round 2, spec §4): one browser per window, in the right panel. A small store
// of its own — the panel draws it, the host (host.ts) drives it for an Agent, and `openInBrowser` is how the rest of
// the app opens a page in it.
import { create } from 'zustand';
import { viewable } from './url';
import { tr } from '@/i18n';
import type { ViewportId } from './viewport';

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
  /** the loading bar under the address bar, 0–1 (panel-logic.ts `progressOn`); undefined: no bar */
  progress?: number;
  /** this tab's page zoom (Ctrl/Cmd + = / - / 0 with the focus in the page); undefined = 100% */
  zoom?: number;
  /** drawn as a device (viewport.ts); undefined = auto, the panel's size */
  viewport?: ViewportId;
}

/**
 * The browser profiles (Electron partitions): the user's own (what the browser tile always used), Claude's separate
 * one, and one that is not kept on disk (gone when the app quits). The desktop shell knows the same three names
 * (desktop/src/guest-tools.ts `BROWSER_PARTITIONS`: the file: guard, cookie import and clearing take only these).
 */
export const USER_PARTITION = 'persist:cw-browser';
export const AGENT_PARTITION = 'persist:cw-agent';
export const SESSION_PARTITION = 'cw-session';
/** Local pages (file:): in memory, apart from every login — what they load cannot reach a profile's cookies or storage (desktop/src/guest-tools.ts LOCAL_PARTITION). */
export const LOCAL_PARTITION = 'cw-local';
/** The profile a page of this address is made in: a local file its own; anything else `otherwise`. */
const profileFor = (url: string, otherwise: string): string => (/^file:/i.test(url) ? LOCAL_PARTITION : otherwise);

/**
 * 保留 Cookie: shared — the user and Claude browse with the same logins; separate — Claude in a profile of its own;
 * session — both in one that is cleared when the app quits.
 */
export type CookieMode = 'shared' | 'separate' | 'session';
export const COOKIE_MODES: readonly CookieMode[] = ['shared', 'separate', 'session'];
export const COOKIES_KEY = 'web.browser.cookies';

/** `web.browser.cookies` when it is one of the three, else the old `web.browser.isolated` (true → separate). */
export function cookiesMode(settings: Record<string, unknown> | undefined): CookieMode {
  const v = settings?.[COOKIES_KEY];
  if (typeof v === 'string' && (COOKIE_MODES as readonly string[]).includes(v)) return v as CookieMode;
  return settings?.['web.browser.isolated'] === true ? 'separate' : 'shared';
}

/** How 保留 Cookie words each choice (the ⋯ menu and 设置 → 联网与浏览器 say the same). */
export function cookieModeText(mode: CookieMode): { label: string; desc: string } {
  if (mode === 'separate') return { label: tr('分开'), desc: tr('Claude 用单独的一份，你登录过的网站对它来说都没登录') };
  if (mode === 'session') return { label: tr('关掉就清'), desc: tr('你和 Claude 共用一份，关掉应用就全部清掉') };
  return { label: tr('共用'), desc: tr('Claude 打开的网页带着你在内置浏览器里登录过的账号') };
}

export function partitionsFor(mode: CookieMode): { user: string; agent: string } {
  if (mode === 'session') return { user: SESSION_PARTITION, agent: SESSION_PARTITION };
  return { user: USER_PARTITION, agent: mode === 'separate' ? AGENT_PARTITION : USER_PARTITION };
}

/**
 * Where a new page of the user's is made. The settings live in the app's store, which this module may not import (the
 * store imports auto-open.ts, which imports this): host.ts hands in the source.
 */
let partitionSource: () => string = () => USER_PARTITION;
export function setPartitionSource(fn: () => string): void { partitionSource = fn; }
export const userPartition = (): string => partitionSource();

/** 清除浏览数据: the profiles the mode uses, and any an open tab still uses (a tab keeps its profile for life). */
export function browsingPartitions(mode: CookieMode): string[] {
  const p = partitionsFor(mode);
  return [...new Set([p.user, p.agent, ...useBrowser.getState().tabs.filter((t) => t.src).map((t) => t.partition)])];
}

/** `takenOver`: the conversations whose Agent the user has taken the browser over from (接管) — the conversation's, so a tab it opens later is covered too. */
interface BrowserState { tabs: BrowserTab[]; active: string | null; takenOver: string[] }
export const useBrowser = create<BrowserState>(() => ({ tabs: [], active: null, takenOver: [] }));

let seq = 0;
const blank = (o: Partial<BrowserTab> = {}): BrowserTab => ({ id: `b${Date.now().toString(36)}${(seq++).toString(36)}`, src: '', url: '', title: '', loading: false, back: false, fwd: false, partition: userPartition(), ...o });

/**
 * A new tab, in front unless `front: false`. Returns its id. Its profile is the one of this moment (or `partition`,
 * an Agent's); a tab still without a page takes the profile of the moment it gets one (`firstPage`).
 */
export function newTab(o: { url?: string; agent?: string; partition?: string; front?: boolean } = {}): string {
  const url = o.url && viewable(o.url) ? o.url : '';
  const tab = blank({ src: url, url, agent: o.agent, partition: o.partition ?? profileFor(url, userPartition()), loading: !!url });
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

/** 接管 (on) / 交还 (off): the conversation's Agent — all its tabs, now and later. */
export function setTakenOver(sessionId: string, on: boolean): void {
  useBrowser.setState((s) => (s.takenOver.includes(sessionId) === on ? s
    : { ...s, takenOver: on ? [...s.takenOver, sessionId] : s.takenOver.filter((x) => x !== sessionId) }));
}
/** Has the user taken over the browser from this conversation's Agent? */
export const isTakenOver = (sessionId: string): boolean => useBrowser.getState().takenOver.includes(sessionId);

export function patchTab(id: string, patch: Partial<BrowserTab>): void {
  useBrowser.setState((s) => {
    const cur = s.tabs.find((t) => t.id === id);
    if (!cur || (Object.keys(patch) as (keyof BrowserTab)[]).every((k) => cur[k] === patch[k])) return s;
    return { ...s, tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) };
  });
}

export const tabOf = (id: string): BrowserTab | undefined => useBrowser.getState().tabs.find((t) => t.id === id);
/** The tab each conversation's Agent switched to (browser_tabs): session id → tab id. Not kept: a tab list is not either. */
const agentCurrent = new Map<string, string>();
/** The tab an Agent of this conversation works in: the one it switched to, else its first. */
export const agentTab = (sessionId: string): BrowserTab | undefined => {
  const tabs = useBrowser.getState().tabs;
  const cur = agentCurrent.get(sessionId);
  return (cur ? tabs.find((t) => t.id === cur && t.agent === sessionId) : undefined) ?? tabs.find((t) => t.agent === sessionId);
};
export const agentCurrentOf = (sessionId: string): string | undefined => agentCurrent.get(sessionId);
export function setAgentCurrent(sessionId: string, tabId: string | undefined): void {
  if (tabId) agentCurrent.set(sessionId, tabId);
  else agentCurrent.delete(sessionId);
}

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
  if (cur && !cur.src && !cur.agent && viewable(url)) { patchTab(cur.id, { src: url, url, loading: true, error: undefined, partition: profileFor(url, firstPage(cur)) }); return cur.id; }
  return newTab({ url });
}

/** The profile a tab without a page yet makes its page in: the user's of this moment (the mode may have changed since the tab opened); an Agent's tab keeps its own. */
export const firstPage = (tab: BrowserTab): string => (tab.agent || tab.src ? tab.partition : userPartition());

// ---- the live pages: a tab's <webview> (desktop) once it is in the document ----

/** What guest.ts needs of a `<webview>` element (Electron's tag; typed here because the DOM lib does not know it). */
export interface WebviewEl extends HTMLElement {
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
  isLoading(): boolean;
  isLoadingMainFrame?(): boolean;
  isCrashed?(): boolean;
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
  setZoomFactor?(factor: number): void;
  /** the request's id; the answer arrives as `found-in-page` */
  findInPage?(text: string, o?: { forward?: boolean; findNext?: boolean; matchCase?: boolean }): number;
  stopFindInPage?(action: 'clearSelection' | 'keepSelection' | 'activateSelection'): void;
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
/** The tab whose page is the shell's webContents `id` (what the shell names a page by: `desktop.onGuestKey`). */
export function tabOfGuest(id: number): string | undefined {
  for (const [tabId, g] of live) {
    try { if (g.ready && g.el.getWebContentsId() === id) return tabId; } catch { /* not attached */ }
  }
  return undefined;
}

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
