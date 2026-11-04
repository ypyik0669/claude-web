import { contextBridge, ipcRenderer, webFrame } from 'electron';

const on = (channel: string) => (cb: (arg: any) => void) => {
  const h = (_e: unknown, arg: any) => cb(arg);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

// platform class for chrome that differs per OS (macOS traffic lights sit on the left)
window.addEventListener('DOMContentLoaded', () => document.documentElement.classList.add(process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'));

contextBridge.exposeInMainWorld('desktop', {
  version: process.env.CLAUDE_WEB_VERSION ?? '',
  platform: process.platform,
  pickDir: () => ipcRenderer.invoke('desktop:pickDir'),
  // 录屏 (stage E3): our own source picker, then the chosen source for the next getDisplayMedia
  captureSources: () => ipcRenderer.invoke('desktop:capture:sources'),
  chooseCapture: (pick: unknown) => ipcRenderer.invoke('desktop:capture:choose', pick),
  pickFile: () => ipcRenderer.invoke('desktop:pickFile'),
  showAppMenu: (x: number, y: number) => ipcRenderer.send('desktop:appMenu', { x, y }),
  openPath: (p: string) => ipcRenderer.invoke('desktop:openPath', p),
  openExternal: (url: string) => ipcRenderer.invoke('desktop:openExternal', url),
  notify: (title: string, body: string, sessionId?: string) => ipcRenderer.send('desktop:notify', { title, body, sessionId }),
  setBadge: (n: number) => ipcRenderer.send('desktop:badge', n),
  setTitleBarColors: (bg: string, fg: string, overlay?: string, height?: number) => ipcRenderer.send('desktop:titlebar', { bg, fg, overlay, height }),
  // Windows / Linux: the page's own caption buttons (ui/WindowControls.tsx)
  windowControl: (act: 'min' | 'max' | 'close') => ipcRenderer.send('desktop:win', act),
  isMaximized: () => ipcRenderer.sendSync('desktop:win:maximized') as boolean,
  onMaximized: on('desktop:maximized'),
  getLoginItem: () => ipcRenderer.invoke('desktop:loginItem:get'),
  setLoginItem: (on: boolean) => ipcRenderer.invoke('desktop:loginItem:set', on),
  onCommand: on('desktop:command'),
  onFocusSession: on('desktop:focusSession'),
  // 深链接: a nudge that a claude-web:// link is waiting; take it (once) when ready
  onDeepLink: on('desktop:deepLink'),
  takeDeepLink: () => ipcRenderer.invoke('desktop:deepLink:take'),
  windowId: process.argv.find((a) => a.startsWith('--cw-win='))?.slice(9) ?? 'main',
  newWindow: () => ipcRenderer.invoke('desktop:window:new'),
  focusWindow: (id: string) => ipcRenderer.invoke('desktop:window:focus', id),
  listWindows: () => ipcRenderer.invoke('desktop:window:list'),
  updateState: () => ipcRenderer.invoke('desktop:update:state'),
  checkUpdate: () => ipcRenderer.invoke('desktop:update:check'),
  downloadUpdate: () => ipcRenderer.invoke('desktop:update:download'),
  installUpdate: () => ipcRenderer.invoke('desktop:update:install'),
  onUpdate: on('desktop:update'),
  // 界面缩放: the factor this page is drawn at right now (no round trip: the first paint needs it), and asking the
  // shell — which owns it, for every window — to change it
  getZoom: () => webFrame.getZoomFactor(),
  zoomInfo: () => ipcRenderer.invoke('desktop:zoom:get'),
  setZoom: (ask: 'in' | 'out' | 'reset' | number) => ipcRenderer.invoke('desktop:zoom:set', ask),
  onZoom: on('desktop:zoom'),
  // the built-in browser: a page's new window arrives as a new tab; a picture of one of its pages
  onBrowserPopup: on('desktop:browserPopup'),
  captureGuest: (id: number) => ipcRenderer.invoke('desktop:browser:capture', id),
  // a file:/// page the app opens in it next (file-guard.ts: any other file: load there is refused)
  allowFileOnce: (url: string) => ipcRenderer.invoke('desktop:browser:allowFile', url),
  // the browser panel's tools (guest-tools.ts): a key pressed in a page that is the panel's (find, page zoom); a
  // page drawn as a device; its downloads; a picture of it saved; a local HTML file picked
  onGuestKey: on('desktop:guestKey'),
  guestEmulate: (id: number, vp: unknown) => ipcRenderer.invoke('desktop:browser:emulate', id, vp),
  guestDebug: (id: number, q: unknown) => ipcRenderer.invoke('desktop:browser:debug', id, q),
  guestRecover: (id: number) => ipcRenderer.invoke('desktop:browser:recover', id),
  onGuestDownload: on('desktop:guestDownload'),
  openDownload: (p: string) => ipcRenderer.invoke('desktop:download:open', p),
  showDownload: (p: string) => ipcRenderer.invoke('desktop:download:show', p),
  saveScreenshot: (id: number, name: string) => ipcRenderer.invoke('desktop:browser:saveShot', id, name),
  pickHtmlFile: () => ipcRenderer.invoke('desktop:browser:pickHtml'),
  // 导入 Cookie… (parsed in the page from the user's file) / 清除浏览数据, for one of the browser's profiles
  importCookies: (partition: string, cookies: unknown[]) => ipcRenderer.invoke('desktop:browser:importCookies', partition, cookies),
  clearBrowsingData: (partition: string) => ipcRenderer.invoke('desktop:browser:clearData', partition),
  geminiLogin: (partition?: string, proxyServer?: string) => ipcRenderer.invoke('desktop:gemini:login', partition, proxyServer),
  geminiForget: (partition: string) => ipcRenderer.invoke('desktop:gemini:forget', partition),
  geminiRefresh: (partition: string) => ipcRenderer.invoke('desktop:gemini:refresh', partition),
  // the right-click menu's 引用到输入框 (context-menu.ts): the selected text, for the input box in front
  onQuoteSelection: on('desktop:quoteSelection'),
  setFlags: (f: Record<string, unknown>) => ipcRenderer.invoke('desktop:flags:set', f),
  getFlags: () => ipcRenderer.invoke('desktop:flags:get'),
  relaunch: () => ipcRenderer.invoke('desktop:relaunch'),
  quit: () => ipcRenderer.invoke('desktop:quit'),
});
