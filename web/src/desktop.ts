/** Bridge exposed by the Electron preload (desktop/src/preload.ts). Undefined in plain browser mode. */
export interface DesktopBridge {
  version: string;
  platform: string;
  pickDir(): Promise<string | null>;
  /** 录屏 (stage E3): screens / windows for our own picker (not this app's windows), the pick for the next getDisplayMedia, a file */
  captureSources?(): Promise<{ id: string; name: string; kind: 'screen' | 'window'; thumb: string }[]>;
  chooseCapture?(p: { kind: 'source'; id: string } | { kind: 'guest'; webContentsId: number }): Promise<boolean>;
  pickFile?(): Promise<string | null>;
  /** ☰: the application menu (对话 / 工作台 / 视图 / 前往 / 编辑 / 帮助) as a popup at x, y (page coordinates); older shells lack it */
  showAppMenu?(x: number, y: number): void;
  openPath(p: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  notify(title: string, body: string, sessionId?: string): void;
  setBadge(n: number): void;
  /** bg: the shell ground (new windows start on it); overlay: what the caption buttons are painted on (default bg);
   *  height: how tall the caption buttons' area is — the row they sit over, from the window's top edge */
  setTitleBarColors(bg: string, fg: string, overlay?: string, height?: number): void;
  /** Windows / Linux: the page draws the caption buttons; older shells lack these (and draw their own) */
  windowControl?(act: 'min' | 'max' | 'close'): void;
  isMaximized?(): boolean;
  onMaximized?(cb: (max: boolean) => void): () => void;
  getLoginItem(): Promise<boolean>;
  setLoginItem(on: boolean): Promise<void>;
  onCommand(cb: (id: string) => void): () => void;
  onFocusSession(cb: (sessionId: string) => void): () => void;
  /** 深链接 (claude-web://): a nudge that one is waiting, and taking it (null when there is none / not the main window) */
  onDeepLink?(cb: () => void): () => void;
  takeDeepLink?(): Promise<{ kind: 'new'; folder?: string; q?: string; peer?: string } | { kind: 'session'; id: string } | null>;
  // multi-window (phase 2); optional so an older preload still type-checks
  windowId?: string;
  newWindow?(): Promise<string>;
  focusWindow?(id: string): Promise<void>;
  listWindows?(): Promise<string[]>;
  // phase 4: updater / launch flags / lifecycle
  updateState?(): Promise<any>;
  checkUpdate?(): Promise<void>;
  downloadUpdate?(): Promise<void>;
  /** false: nothing downloaded to install (the prompt says so) */
  installUpdate?(): Promise<boolean | void>;
  onUpdate?(cb: (s: any) => void): () => void;
  setFlags?(f: Record<string, unknown>): Promise<void>;
  getFlags?(): Promise<Record<string, unknown>>;
  relaunch?(): Promise<void>;
  quit?(): Promise<void>;
  // 界面缩放 (desktop/src/zoom.ts): the shell owns the factor, for every window, and remembers it
  /** the factor this page is drawn at right now */
  getZoom?(): number;
  zoomInfo?(): Promise<ZoomInfo>;
  /** one step in / out, back to 100%, or a factor; answers with what it is now */
  setZoom?(ask: 'in' | 'out' | 'reset' | number): Promise<ZoomInfo>;
  onZoom?(cb: (e: ZoomInfo & { changed: boolean; ask: 'in' | 'out' | 'reset' | 'set' }) => void): () => void;
  // the built-in browser (features/browser): a page of it wants a new window → a new tab here; a picture of a page
  onBrowserPopup?(cb: (p: { url: string }) => void): () => void;
  /** `id`: the <webview>'s `getWebContentsId()`. Null: nothing could be drawn. */
  captureGuest?(id: number): Promise<{ mime: 'image/jpeg' | 'image/png'; data: string; width?: number; height?: number } | null>;
  /** the app opens this `file:///…` page in the built-in browser next: the shell lets that one tab load it, and refuses
   *  every other file: load there (desktop/src/file-guard.ts). False: not a file address it takes. */
  allowFileOnce?(url: string): Promise<boolean>;
  // the browser panel's tools (desktop/src/guest-tools.ts); `id` is always a <webview>'s `getWebContentsId()`
  /** Ctrl/Cmd+F or Ctrl/Cmd + = / - / 0 pressed in a page: the panel finds / zooms that tab (not the app) */
  onGuestKey?(cb: (e: { id: number; key: 'find' | 'zoomIn' | 'zoomOut' | 'zoomReset' }) => void): () => void;
  /** draw the page as this device (touch, a mobile user agent when `mobile`), or as the panel again (null). False: refused. */
  guestEmulate?(id: number, vp: { w: number; h: number; touch: boolean; mobile: boolean } | null): Promise<boolean>;
  /** Claude's browser_console / browser_network / browser_snapshot: what the page's DevTools protocol has (desktop/src/guest-debug.ts); `{error}` when it cannot be read. */
  guestDebug?(id: number, q: { op: 'console' | 'network' | 'snapshot' }): Promise<unknown>;
  /** a page stuck in a script: its renderer is ended and the page loaded again. False: not this window's page. */
  guestRecover?(id: number): Promise<boolean>;
  /** a download of one of this window's pages, as it goes (features/browser/panel-logic.ts `DownloadRow`) */
  onGuestDownload?(cb: (e: import('@/features/browser/panel-logic').DownloadRow) => void): () => void;
  /** open / show a file one of those downloads saved (the shell refuses any other path). False: it did not. */
  openDownload?(path: string): Promise<boolean>;
  showDownload?(path: string): Promise<boolean>;
  /** the page as a PNG where the user picks: the path saved, null when they cancelled, false when it failed */
  saveScreenshot?(id: number, name: string): Promise<string | null | false>;
  /** the system's open dialog for one .html / .htm file: its path, or null */
  pickHtmlFile?(): Promise<string | null>;
  /** 导入 Cookie…: cookies parsed from the user's file (features/browser/cookies.ts) set into one of the browser's
   *  profiles (state.ts); false: refused (not one of ours). The values never go anywhere else. */
  importCookies?(partition: string, cookies: import('@/features/browser/cookies').ImportedCookie[]): Promise<{ set: number; failed: number } | false>;
  /** 清除浏览数据: that profile's cookies, site storage and cache; false: refused or failed */
  clearBrowsingData?(partition: string): Promise<boolean>;
  /** 右键菜单 → 引用到输入框 (desktop/src/context-menu.ts): the text that was selected where the menu was opened */
  onQuoteSelection?(cb: (text: string) => void): () => void;
  /** 网关 → Gemini 账号: sign in to Google in a window of its own (`partition`: one from an earlier login, to sign in
   *  again); its cookies once signed in, null when the window was closed first. `proxyServer` is the loopback
   *  host:port the server tunnels to the chosen exit. */
  geminiLogin?(partition?: string, proxyServer?: string): Promise<{ cookie: string; partition: string; userAgent: string } | null>;
  /** the account was deleted: wipe the login that window kept */
  geminiForget?(partition: string): Promise<void>;
  /** keep a signed-in profile alive: load gemini.google.com in a windowless Chrome so Chromium renews its
   *  cookies, and hand the renewed ones back (null when nothing changed or the sign-in is gone) */
  geminiRefresh?(partition: string): Promise<{ cookie: string; userAgent: string } | null>;
}

/** `max`: the largest factor this window's screen can take (the smallest window must still fit it). */
export interface ZoomInfo { zoom: number; max: number; min: number; /** every factor there is, smallest first */ steps?: number[] }

export const desktop: DesktopBridge | undefined = (window as any).desktop;
export const isDesktop = !!desktop;
