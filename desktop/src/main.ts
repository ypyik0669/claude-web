import { app, BrowserWindow, Menu, Tray, Notification, dialog, shell, ipcMain, nativeImage, nativeTheme, powerSaveBlocker, screen } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { ServerHost } from './server-host';
import { KeepAwake } from './keep-awake';
import { autoUpdater } from 'electron-updater';
import { CHECK_EVERY_MS, FIRST_CHECK_MS, firstLine, isRequired, manualDownloadUrl, notesText, releasePage, updateMode, type UpdateMode } from './update-policy';
import { execFileSync } from 'node:child_process';
import { captureGuest } from './browser-capture';
import { cleanUserAgent } from './user-agent';
import os from 'node:os';
import { ZOOM_STEPS, cleanZoom, fitWindow, minWindow, nextZoom, scaleCaption, trafficLightY, zoomAsk, zoomLimit, type ZoomAsk } from './zoom';

const isMac = process.platform === 'darwin';

/**
 * Apps launched from Finder / the Dock get launchd's minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin), so git, gh,
 * codex, gemini, ssh-agent helpers and a global npm are all "not found". Ask the user's login shell for its PATH
 * once, before the server is forked (the server and every session inherit it).
 */
function fixPosixPath() {
  if (process.platform === 'win32') return;
  const parts: string[] = [];
  try {
    const shellBin = process.env.SHELL || (isMac ? '/bin/zsh' : '/bin/bash');
    const out = execFileSync(shellBin, ['-ilc', 'printf "__CW_PATH__%s__CW_PATH__" "$PATH"'], { encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = /__CW_PATH__(.*?)__CW_PATH__/s.exec(out);
    if (m) parts.push(...m[1].split(':'));
  } catch { /* shell missing or slow: fall back to the usual locations */ }
  const home = os.homedir();
  parts.push(...(process.env.PATH ?? '').split(':'), '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', path.join(home, '.local', 'bin'), path.join(home, '.npm-global', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin');
  process.env.PATH = [...new Set(parts.filter(Boolean))].join(':');
}
fixPosixPath();

// ---------- launch flags (read before `ready`): software rendering fallback ----------
const flagsFile = () => path.join(app.getPath('userData'), 'flags.json');
function readFlags(): { softwareRender?: boolean; gpuCrashes?: number; autoUpdate?: boolean; zoom?: number } {
  try { return JSON.parse(fs.readFileSync(flagsFile(), 'utf8')); } catch { return {}; }
}
function writeFlags(f: Record<string, unknown>) {
  try { fs.writeFileSync(flagsFile(), JSON.stringify({ ...readFlags(), ...f })); } catch { /* ignore */ }
}
if (readFlags().softwareRender || process.argv.includes('--software-render')) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
}

const APP_NAME = 'Claude Web';
const wins = new Map<string, BrowserWindow>(); // winId -> window ("main" is the first one)
let tray: Tray | null = null;
let pendingCount = 0;
let quitting = false;
// bg: the shell ground (a new window's background before its page paints); overlay: what the caption buttons are painted
// on — transparent on Windows, so they float over the top-right card and its rounded corner (verified on Windows 11,
// Electron 44); Linux has not been verified and gets the card's own colour
/**
 * The caption buttons' area is as tall as the row under them, from the window's top edge: the 8px shell gap + a 52px
 * head row until the page says otherwise (a 40px bar with the workbench tools; no gap on Linux) — so the glyphs line up
 * with that row's own icons. The page keeps its right end clear (styles.css, 142px).
 */
const CAPTION_H = process.platform === 'linux' ? 52 : 60;
// the page reports the height in the window's pixels (its row × the zoom factor): 50% of a bar … 300% of a head row
const captionH = (h: unknown) => (typeof h === 'number' && Number.isFinite(h) ? Math.min(260, Math.max(20, Math.round(h))) : 0);
/** `height` 0: no page has reported yet — the default row at the current zoom (`captionNow`). */
let titleBar = { bg: '', fg: '', overlay: '', height: 0 };
const overlayDefault = (dark: boolean) => (process.platform === 'win32' ? '#00000000' : dark ? '#1b1a18' : '#fefdfc');
let gpuCrashes = 0;
/** What the renderer's update prompt and settings page show (web: features/update/model.ts). */
type UpdateState = { status: string; mode: UpdateMode; version?: string; percent?: number; error?: string; notes?: string; required?: boolean; url?: string; page?: string };
const UPDATE_REPO = 'ypyik0669/claude-web'; // electron-builder.yml `publish`
let updateState: UpdateState = { status: 'idle', mode: updateMode(process.platform, process.env) };
const host = new ServerHost();
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');

// ---------- single instance ----------
// every page this app loads (the built-in browser above all) says it is the Chrome it is built from: see user-agent.ts
app.userAgentFallback = cleanUserAgent(app.userAgentFallback);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

function iconPath() {
  const p = app.isPackaged ? path.join(process.resourcesPath, 'icon.png') : path.resolve(__dirname, '../build/icon.png');
  return fs.existsSync(p) ? p : undefined;
}

interface Bounds { x?: number; y?: number; width?: number; height?: number; maximized?: boolean }
interface WinState { v: 2; windows: Record<string, Bounds> }

function loadState(): WinState {
  try {
    const j = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (j && j.v === 2 && j.windows) return j;
    // v1: a single window's bounds
    return { v: 2, windows: { main: j ?? {} } };
  } catch {
    return { v: 2, windows: {} };
  }
}
function saveState() {
  const st: WinState = { v: 2, windows: {} };
  for (const [id, w] of wins) if (!w.isDestroyed()) st.windows[id] = { ...w.getBounds(), maximized: w.isMaximized() };
  try { fs.writeFileSync(stateFile(), JSON.stringify(st)); } catch { /* ignore */ }
}

/** The window to talk to: focused one, else main, else any. */
function focusedWin(): BrowserWindow | null {
  const f = BrowserWindow.getFocusedWindow();
  if (f && !f.isDestroyed()) return f;
  const m = wins.get('main');
  if (m && !m.isDestroyed()) return m;
  for (const w of wins.values()) if (!w.isDestroyed()) return w;
  return null;
}
function liveWins() { return [...wins.entries()].filter(([, w]) => !w.isDestroyed()); }

function showWindow(w: BrowserWindow | null = focusedWin()) {
  if (!w) return;
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
}

function windowUrl(base: string, winId: string) {
  const u = new URL(base);
  u.searchParams.set('win', winId);
  return u.toString();
}

/**
 * What the main window shows while the server starts: a cold start is seconds (the packaged server, the first
 * scan of ~/.claude), and a window that only appears once the page has rendered reads as「打不开」— a second launch
 * from the Start menu in that time found no window to show either.
 */
function splashUrl(dark: boolean): string {
  const [bg, fg, mut] = dark ? ['#12110f', '#c4c2be', '#868480'] : ['#f7f6f2', '#47433f', '#7f7b77'];
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${APP_NAME}</title><style>`
    + `html,body{height:100%;margin:0;background:${bg};color:${fg};font:14px "Segoe UI Variable Text","Segoe UI","Microsoft YaHei UI",system-ui,sans-serif;-webkit-app-region:drag;user-select:none;cursor:default}`
    + `body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px}`
    + `.n{font-size:17px;font-weight:600}.s{color:${mut}}`
    + `.d{width:18px;height:18px;border:2px solid ${mut};border-top-color:transparent;border-radius:50%;animation:r .9s linear infinite}`
    + `@keyframes r{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.d{animation:none}}`
    + `</style></head><body><div class="d"></div><div class="n">${APP_NAME}</div><div class="s">正在启动…</div></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/**
 * `url` null: the window opens at once on the splash; the caller loads the app into it once the server is up.
 * `hidden`: not shown when ready (the startup windows of a --hidden launch — the login item; tray / a second launch shows them).
 */
function createWindow(url: string | null, winId = 'main', bounds?: Bounds, hidden = false): BrowserWindow {
  const st = bounds ?? loadState().windows[winId] ?? {};
  const dark = nativeTheme.shouldUseDarkColors;
  // 界面缩放: the page is drawn this many times as big; the smallest window grows with it (zoom.ts)
  const z = currentZoom();
  const min = minWindow(z);
  const win = new BrowserWindow({
    width: Math.max(st.width ?? 1400, min.width),
    height: Math.max(st.height ?? 900, min.height),
    x: st.x,
    y: st.y,
    minWidth: min.width,
    minHeight: min.height,
    title: APP_NAME,
    icon: iconPath(),
    backgroundColor: titleBar.bg || (dark ? '#12110f' : '#f7f6f2'),
    titleBarStyle: 'hidden',
    // macOS keeps its own traffic lights (left, see `html.mac` in styles.css; y centres them in the 52px top rows); elsewhere we draw the overlay buttons
    ...(isMac
      ? { trafficLightPosition: { x: 14, y: trafficLightY(z) } } // centred in the sidebar's 52px top row, which starts under the 8px shell gap
      : { titleBarOverlay: { color: titleBar.overlay || overlayDefault(dark), symbolColor: titleBar.fg || (dark ? '#c4c2be' : '#47433f'), height: captionNow() } }),
    show: false,
    // webviewTag powers the in-app browser tile; each <webview> declares its own partition and denies popups (and keeps
    // its own zoom: only our pages are zoomed)
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, spellcheck: false, webviewTag: true, zoomFactor: z, additionalArguments: [`--cw-win=${winId}`] },
  });
  wins.set(winId, win);
  // the factor is kept per host by Chromium, and the splash has none: say it again once a page is in
  win.webContents.on('dom-ready', () => applyZoom(win));
  if (st.maximized) win.maximize();
  win.once('ready-to-show', () => { if (!hidden) win.show(); });
  win.on('resize', saveState);
  win.on('move', saveState);
  win.on('close', (e) => {
    if (quitting) return;
    const visible = liveWins().filter(([, w]) => w.isVisible());
    if (winId !== 'main' || visible.length > 1) {
      // secondary window (or main while others stay): really close; its groups are lost unless migrated first
      wins.delete(winId);
      saveState();
      return;
    }
    e.preventDefault();
    // last visible window: hide to the tray (default) or quit, per the user's setting
    void getSetting(win, 'ui.closeToTray', true).then((tray) => { if (tray) win.hide(); else void requestQuit(); });
  });
  win.on('closed', () => { if (wins.get(winId) === win) wins.delete(winId); });
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    const origin = host.info?.url.split('/?')[0] ?? '\0';
    if (target.startsWith(origin)) {
      // same-origin window.open (browser-style "new window"): give it a real id and our preload
      const id = `w${Date.now().toString(36)}`;
      createWindow(windowUrl(target, id), id);
      return { action: 'deny' };
    }
    if (/^https?:/.test(target)) void shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, target) => {
    if (!target.startsWith(`http://${host.info?.host}:${host.info?.port}`)) { e.preventDefault(); void shell.openExternal(target); }
  });
  // the built-in browser's pages: strip our preload off the guest page. A <webview> blocks window.open in the page
  // itself unless popups are allowed (its `allowpopups` attribute) — a link that opens a new window then does
  // nothing at all, and the handler below is never asked (found in the packaged app, 2026-10-10). So they are
  // allowed here for every guest, and the handler turns each one into a tab: no window is ever created.
  win.webContents.on('will-attach-webview', (_e, prefs) => {
    delete (prefs as { preload?: string }).preload;
    prefs.nodeIntegration = false;
    prefs.contextIsolation = true;
    (prefs as { disablePopups?: boolean }).disablePopups = false;
  });
  win.webContents.on('did-attach-webview', (_e, guest) => {
    // a page's new window is a new tab of this window's built-in browser (features/browser/BrowserPanel.tsx)
    guest.setWindowOpenHandler(({ url: target }) => {
      if (/^https?:/.test(target) && !win.isDestroyed()) win.webContents.send('desktop:browserPopup', { url: target });
      return { action: 'deny' };
    });
  });
  win.on('focus', () => { pendingCount = 0; updateBadge(); });
  void win.loadURL(url ? windowUrl(url, winId) : splashUrl(dark));
  return win;
}

function updateBadge() {
  const m = wins.get('main');
  if (process.platform === 'win32' && m && !m.isDestroyed()) {
    if (pendingCount > 0) {
      const img = badgeImage(pendingCount);
      m.setOverlayIcon(img, `${pendingCount} 个待处理`);
    } else m.setOverlayIcon(null, '');
  }
  if (isMac) app.dock?.setBadge(pendingCount > 0 ? String(pendingCount) : '');
  tray?.setToolTip(pendingCount > 0 ? `${APP_NAME} · ${pendingCount} 个待处理` : APP_NAME);
}

function badgeImage(n: number) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="15" fill="#eb7f3b"/><text x="16" y="22" font-size="18" font-family="Segoe UI,Arial" font-weight="700" fill="#fff" text-anchor="middle">${n > 9 ? '9+' : n}</text></svg>`;
  return nativeImage.createFromDataURL('data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'));
}

function sendCommand(id: string) {
  const w = focusedWin();
  showWindow(w);
  w?.webContents.send('desktop:command', id);
}
function broadcast(channel: string, arg: unknown) {
  for (const [, w] of liveWins()) w.webContents.send(channel, arg);
}

// ---------- 界面缩放 (zoom.ts): one factor for every window, remembered in flags.json ----------
// Electron's own zoomIn / zoomOut roles would do the zooming, but they forget it at the next start, want Ctrl+Shift+=
// for "in", and leave the caption buttons, the traffic lights and the smallest window where they were.
let zoom = 1;
let zoomRead = false;
/** The work area of the screen a window is on (the primary screen without one). Only after `ready`. */
function workAreaOf(w?: BrowserWindow | null) {
  return (w && !w.isDestroyed() ? screen.getDisplayMatching(w.getBounds()) : screen.getPrimaryDisplay()).workArea;
}
/** The factor in use. Read once, when the first window is made: what the screen can take is only known after `ready`. */
function currentZoom(): number {
  if (!zoomRead) {
    zoomRead = true;
    zoom = cleanZoom(readFlags().zoom, zoomLimit(workAreaOf(null)));
  }
  return zoom;
}
/** The caption buttons' height: what the page reported, or the default row at this zoom until one has. */
const captionNow = () => titleBar.height || Math.round(CAPTION_H * currentZoom());
const zoomInfo = (w?: BrowserWindow | null) => ({ zoom: currentZoom(), max: zoomLimit(workAreaOf(w)), min: ZOOM_STEPS[0] as number, steps: [...ZOOM_STEPS] as number[] });
/** Everything of one window that follows the factor: the page, the smallest size (and the size, if now under it), the traffic lights. */
function applyZoom(w: BrowserWindow) {
  const z = currentZoom();
  try {
    if (Math.abs(w.webContents.getZoomFactor() - z) > 0.001) w.webContents.setZoomFactor(z);
    const min = minWindow(z);
    w.setMinimumSize(min.width, min.height);
    if (!w.isMaximized() && !w.isFullScreen()) {
      const to = fitWindow(w.getBounds(), min, workAreaOf(w));
      if (to) w.setBounds(to);
    }
    if (isMac) w.setWindowButtonPosition({ x: 14, y: trafficLightY(z) });
  } catch { /* a window on its way out */ }
}
/**
 * A request from the menu (its accelerators) or from a page (设置 → 外观, the command palette). Every window is told
 * the outcome, changed or not — the focused one says it (「界面缩放 125%」, or that this is as far as it goes).
 */
function setZoom(ask: ZoomAsk, from: BrowserWindow | null = focusedWin()) {
  const prev = currentZoom();
  const max = zoomLimit(workAreaOf(from));
  const next = nextZoom(prev, ask, max);
  const changed = next !== prev;
  if (changed) {
    zoom = next;
    writeFlags({ zoom });
    // until the pages report their rows again (they do, on the change): the same row, as big as it is now drawn
    if (titleBar.height) titleBar.height = captionH(scaleCaption(titleBar.height, prev, next));
    for (const [, w] of liveWins()) {
      applyZoom(w);
      if (!isMac && titleBar.fg) { try { w.setTitleBarOverlay({ color: titleBar.overlay, symbolColor: titleBar.fg, height: captionNow() }); } catch { /* not supported */ } }
    }
    mainLog(`[zoom] ${Math.round(next * 100)}%`);
  }
  const info = { zoom, max, min: ZOOM_STEPS[0] as number, steps: [...ZOOM_STEPS] as number[] };
  broadcast('desktop:zoom', { ...info, changed, ask: typeof ask === 'number' ? 'set' : ask });
  return info;
}

// Accelerators mirror web/src/features/workbench/shortcuts.ts (desktop column); labels use the same user words as
// its `label`s and web/src/ui/terms.ts (对话 / 分屏 / 标签页 / 右侧面板 / 步骤视图 — never 会话 / 窗格 / 停靠 / 轨迹).
function buildMenu() {
  const cmd = (label: string, accelerator: string | undefined, id: string): Electron.MenuItemConstructorOptions => ({ label, accelerator, click: () => sendCommand(id) });
  const template: Electron.MenuItemConstructorOptions[] = [
    // macOS: the first menu is always the app menu (About / Hide / Quit); Quit goes through the exit guard
    ...(isMac ? [{
      label: APP_NAME,
      submenu: [
        { role: 'about' }, { type: 'separator' },
        { label: '设置…', accelerator: 'Cmd+,', click: () => sendCommand('settings') },
        { type: 'separator' }, { role: 'services' }, { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' },
        { label: `退出 ${APP_NAME}`, accelerator: 'Cmd+Q', click: () => void requestQuit() },
      ],
    } as Electron.MenuItemConstructorOptions] : []),
    {
      label: '对话',
      submenu: [
        cmd('新对话', 'CmdOrCtrl+N', 'new'),
        cmd('命令面板', 'CmdOrCtrl+K', 'palette'),
        cmd('搜索对话', 'CmdOrCtrl+P', 'palette'),
        { type: 'separator' },
        cmd('中断当前轮', 'CmdOrCtrl+Shift+C', 'interrupt'),
        cmd('结束当前对话的进程', 'CmdOrCtrl+Shift+Q', 'close'),
        ...(isMac ? [] : [{ type: 'separator' }, { label: '退出', accelerator: 'CmdOrCtrl+Q', click: () => void requestQuit() }] as Electron.MenuItemConstructorOptions[]),
      ],
    },
    {
      label: '工作台',
      submenu: [
        cmd('新分组', 'CmdOrCtrl+T', 'group.new'),
        cmd('关闭分组', 'CmdOrCtrl+Shift+W', 'group.close'),
        cmd('重命名分组', 'F2', 'group.rename'),
        cmd('下一个分组', 'Ctrl+Tab', 'group.next'),
        cmd('上一个分组', 'Ctrl+Shift+Tab', 'group.prev'),
        ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ ...cmd(`跳到分组 ${n}`, `CmdOrCtrl+${n}`, `group.jump.${n - 1}`), visible: n <= 3 })),
        { type: 'separator' },
        cmd('向右分屏', 'CmdOrCtrl+D', 'pane.splitRight'),
        cmd('向下分屏', 'CmdOrCtrl+Shift+D', 'pane.splitDown'),
        cmd('关闭标签页（最后一个则关掉这个分屏）', 'CmdOrCtrl+W', 'tile.close'),
        cmd('放大 / 还原分屏', 'CmdOrCtrl+Shift+Enter', 'pane.zoom'),
        cmd('下一个分屏', 'CmdOrCtrl+Alt+Right', 'pane.next'),
        cmd('上一个分屏', 'CmdOrCtrl+Alt+Left', 'pane.prev'),
        ...[1, 2, 3, 4, 5, 6].map((n) => ({ ...cmd(`跳到分屏 ${n}`, `Alt+${n}`, `pane.jump.${n - 1}`), visible: n <= 2 })),
        { type: 'separator' },
        cmd('新标签页', 'CmdOrCtrl+Shift+T', 'tile.new'),
        cmd('下一个标签页', 'CmdOrCtrl+PageDown', 'tile.next'),
        cmd('上一个标签页', 'CmdOrCtrl+PageUp', 'tile.prev'),
        { type: 'separator' },
        cmd('在新窗口打开当前分组', 'CmdOrCtrl+Shift+N', 'window.new'),
      ],
    },
    {
      label: '视图',
      submenu: [
        cmd('侧栏', 'CmdOrCtrl+B', 'sidebar'),
        cmd('对话 / 步骤视图', 'Alt+J', 'tab'),
        { type: 'separator' },
        cmd('右侧面板', 'CmdOrCtrl+J', 'dock.toggle'),
        cmd('右侧面板收成图标栏', 'CmdOrCtrl+Shift+J', 'dock.minimize'),
        cmd('总览（Mission Control）', 'CmdOrCtrl+Shift+M', 'panel.mission'),
        cmd('任务面板', 'CmdOrCtrl+Shift+1', 'panel.tasks'),
        cmd('审阅（改动）', 'CmdOrCtrl+Shift+2', 'panel.files'),
        cmd('用量', 'CmdOrCtrl+Shift+3', 'panel.usage'),
        ...(isMac ? [] : [cmd('设置', 'CmdOrCtrl+,', 'settings')]),
        cmd('配置中心（右侧面板）', undefined, 'panel.config'),
        cmd('终端', 'CmdOrCtrl+`', 'panel.terminal'),
        { type: 'separator' },
        cmd('键盘快捷键', 'F1', 'shortcuts'),
        { role: 'togglefullscreen' },
        { type: 'separator' },
        // 界面缩放 — ours, not the zoomIn / zoomOut roles (see setZoom). `=` is the key itself; `Plus` is it with Shift,
        // and the keypad has its own names
        { label: '放大界面', accelerator: 'CmdOrCtrl+=', click: () => void setZoom('in') },
        { label: '缩小界面', accelerator: 'CmdOrCtrl+-', click: () => void setZoom('out') },
        { label: '还原界面大小', accelerator: 'CmdOrCtrl+0', click: () => void setZoom('reset') },
        ...([['CmdOrCtrl+Plus', 'in'], ['CmdOrCtrl+numadd', 'in'], ['CmdOrCtrl+numsub', 'out'], ['CmdOrCtrl+num0', 'reset']] as const)
          .map(([accelerator, ask]): Electron.MenuItemConstructorOptions => ({ label: `界面缩放（${accelerator}）`, accelerator, visible: false, click: () => void setZoom(ask) })),
        { type: 'separator' },
        { role: 'reload' }, { role: 'toggleDevTools' },
      ],
    },
    {
      label: '编辑',
      submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }],
    },
    ...(isMac ? [{ label: '窗口', role: 'windowMenu' } as Electron.MenuItemConstructorOptions] : []),
    {
      label: '帮助',
      submenu: [
        { label: '打开数据目录', click: () => void shell.openPath(app.getPath('userData')) },
        { label: '在浏览器中打开', click: () => host.info && void shell.openExternal(host.info.url) },
        { label: `版本 ${app.getVersion()}`, enabled: false },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function buildTray() {
  const ip = iconPath();
  const img = ip ? nativeImage.createFromPath(ip).resize({ width: isMac ? 18 : 16, height: isMac ? 18 : 16 }) : badgeImage(0);
  tray = new Tray(img);
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开', click: () => showWindow(wins.get('main') ?? focusedWin()) },
    { label: '新对话', click: () => sendCommand('new') },
    { type: 'separator' },
    { label: '退出', click: () => void requestQuit() },
  ]));
  // macOS opens the context menu on click by itself; a click handler there would fight it
  if (!isMac) tray.on('click', () => showWindow(wins.get('main') ?? focusedWin()));
}

/** Read one renderer-side setting (meta.json `settings`) from a window; `def` when unavailable. */
async function getSetting<T>(w: BrowserWindow | null, key: string, def: T): Promise<T> {
  if (!w || w.isDestroyed()) return def;
  const v = await w.webContents.executeJavaScript(`window.__store?.getState().settings?.[${JSON.stringify(key)}]`, true).catch(() => undefined);
  return v === undefined || v === null ? def : (v as T);
}

/** Exit guard: counts running sessions, pending permissions and unsaved editors across every window. */
async function requestQuit() {
  const running = new Set<string>();
  let pending = 0, dirty = 0;
  for (const [, w] of liveWins()) {
    const r: { running: string[]; pending: number; dirty: number } = await w.webContents.executeJavaScript(`(() => { const s = window.__store?.getState(); if (!s) return { running: [], pending: 0, dirty: 0 }; const open = Object.values(s.open ?? {}); return { running: open.filter(o => o.state === "running" || o.state === "waiting").map(o => o.sessionId), pending: open.reduce((a, o) => a + (o.pending?.length ?? 0), 0), dirty: Object.keys(s.dirtyDocs ?? {}).length }; })()`, true).catch(() => ({ running: [], pending: 0, dirty: 0 }));
    for (const id of r.running) running.add(id);
    pending += r.pending;
    dirty += r.dirty;
  }
  const confirmExit = await getSetting(focusedWin(), 'ui.confirmExit', true);
  if (confirmExit && (running.size > 0 || pending > 0 || dirty > 0)) {
    const w = focusedWin();
    const parts = [running.size ? `${running.size} 个对话在运行` : '', pending ? `${pending} 个权限请求待处理` : '', dirty ? `${dirty} 个文件未保存` : ''].filter(Boolean);
    const r = await dialog.showMessageBox(w ?? undefined as any, { type: 'question', buttons: ['退出', dirty ? '取消（回去保存）' : '取消', '最小化到托盘'], defaultId: 1, cancelId: 1, message: parts.join('，'), detail: '退出会结束对话的进程（记录保留在磁盘，发消息即可继续）；未保存的编辑会丢失。' });
    if (r.response === 1) return;
    if (r.response === 2) { for (const [, x] of liveWins()) x.hide(); return; }
  }
  quitting = true;
  app.quit();
}

// ---------- auto-update (electron-updater → GitHub Releases; see update-policy.ts) ----------
function mainLog(line: string) {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'main.log'), `[${new Date().toISOString()}] ${line}\n`); } catch { /* ignore */ }
}
/** Merge into the state (a new version replaces what was known about the old one) and tell every window. */
function setUpdate(patch: Partial<UpdateState>) {
  const prev = updateState;
  const fresh = patch.version !== undefined && patch.version !== prev.version;
  updateState = fresh ? { status: prev.status, mode: prev.mode, ...patch } : { ...prev, ...patch };
  if (patch.status !== 'downloading') delete updateState.percent;
  if (patch.status !== 'error') delete updateState.error;
  if (updateState.status !== prev.status || fresh) mainLog(`[update] ${updateState.status}${updateState.version ? ` ${updateState.version}` : ''}${updateState.error ? ` ${updateState.error}` : ''}`);
  broadcast('desktop:update', updateState);
}
/** A generic feed instead of GitHub (end-to-end checks: scripts/smoke-packaged.mjs serves one). */
const updateFeed = () => process.env.CW_UPDATE_FEED || undefined;
function setupUpdater() {
  const mode = updateState.mode;
  autoUpdater.autoDownload = mode === 'auto';
  // 稍后 on a downloaded update: the installer runs when the app quits
  autoUpdater.autoInstallOnAppQuit = mode === 'auto';
  autoUpdater.allowPrerelease = false;
  (autoUpdater as any).logger = null;
  const feed = updateFeed();
  if (feed) {
    autoUpdater.setFeedURL({ provider: 'generic', url: feed });
    autoUpdater.forceDevUpdateConfig = true;
  } else if (process.env.PORTABLE_EXECUTABLE_FILE) {
    // the portable exe ships no app-update.yml; it only ever checks (manual mode never downloads)
    const [owner, repo] = UPDATE_REPO.split('/');
    autoUpdater.setFeedURL({ provider: 'github', owner, repo });
  }
  autoUpdater.on('checking-for-update', () => setUpdate({ status: 'checking' }));
  autoUpdater.on('update-available', (i) => {
    const notes = notesText(i.releaseNotes);
    setUpdate({
      status: 'available',
      version: i.version,
      notes,
      required: isRequired(notes),
      page: releasePage(UPDATE_REPO, i.version),
      url: manualDownloadUrl({ repo: UPDATE_REPO, version: i.version, platform: process.platform, arch: process.arch, arm64Translated: app.runningUnderARM64Translation, portable: !!process.env.PORTABLE_EXECUTABLE_FILE, feed }),
    });
  });
  autoUpdater.on('update-not-available', () => setUpdate({ status: 'none' }));
  autoUpdater.on('download-progress', (p) => setUpdate({ status: 'downloading', percent: p.percent }));
  autoUpdater.on('update-downloaded', (i) => setUpdate({ status: 'downloaded', version: i.version }));
  // a failed download keeps what was found (the prompt's 手动下载 link still works)
  autoUpdater.on('error', (e) => setUpdate({ status: 'error', error: firstLine(e) }));
}
/** Look for a new version. `manual`: the button in settings (reports why it could not look). */
function checkForUpdate(manual = false) {
  if (!app.isPackaged && !updateFeed()) { if (manual) setUpdate({ status: 'error', error: '开发模式不检查更新' }); return; }
  if (updateState.status === 'checking' || updateState.status === 'downloading' || updateState.status === 'downloaded') return;
  autoUpdater.checkForUpdates().catch((e) => setUpdate({ status: 'error', error: firstLine(e) }));
}
/** Automatic checks: shortly after start, then every few hours — unless turned off in settings (flags.json). */
function scheduleUpdateChecks() {
  const tick = () => { if (readFlags().autoUpdate !== false) checkForUpdate(); };
  setTimeout(tick, Number(process.env.CW_UPDATE_FIRST_MS) || FIRST_CHECK_MS).unref?.();
  setInterval(tick, CHECK_EVERY_MS).unref?.();
}

// ---------- IPC ----------
ipcMain.handle('desktop:pickDir', async (e) => {
  const w = BrowserWindow.fromWebContents(e.sender) ?? focusedWin();
  const r = await dialog.showOpenDialog(w!, { properties: ['openDirectory', 'createDirectory'], title: '选择工作目录' });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('desktop:openPath', (_e, p: string) => shell.openPath(p));
ipcMain.handle('desktop:openExternal', (_e, url: string) => shell.openExternal(url));
ipcMain.on('desktop:notify', (e, { title, body, sessionId }: { title: string; body: string; sessionId?: string }) => {
  const src = BrowserWindow.fromWebContents(e.sender);
  if (src?.isFocused()) return;
  pendingCount++;
  updateBadge();
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: iconPath(), silent: false });
  n.on('click', () => {
    showWindow(src && !src.isDestroyed() ? src : focusedWin());
    if (sessionId) broadcast('desktop:focusSession', sessionId); // each window checks whether it holds the session
  });
  n.show();
  src?.flashFrame(true);
});
ipcMain.on('desktop:badge', (_e, n: number) => { pendingCount = n; updateBadge(); });
ipcMain.on('desktop:titlebar', (_e, { bg, fg, overlay, height }: { bg: string; fg: string; overlay?: string; height?: number }) => {
  titleBar = { bg, fg, overlay: overlay || bg, height: captionH(height) };
  if (!isMac) for (const [, w] of liveWins()) { try { w.setTitleBarOverlay({ color: titleBar.overlay, symbolColor: fg, height: captionNow() }); } catch { /* not supported */ } }
});
ipcMain.handle('desktop:zoom:get', (e) => zoomInfo(BrowserWindow.fromWebContents(e.sender)));
ipcMain.handle('desktop:zoom:set', (e, v: unknown) => {
  const from = BrowserWindow.fromWebContents(e.sender);
  const ask = zoomAsk(v);
  return ask === null ? zoomInfo(from) : setZoom(ask, from);
});
// a picture of a page of the built-in browser, for an Agent's browser_screenshot (browser-capture.ts)
ipcMain.handle('desktop:browser:capture', (e, id: unknown) => captureGuest(e.sender, id));
ipcMain.handle('desktop:loginItem:get', () => app.getLoginItemSettings().openAtLogin);
ipcMain.handle('desktop:loginItem:set', (_e, on: boolean) => app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] }));
ipcMain.handle('desktop:window:new', () => {
  if (!host.info) throw new Error('server not ready');
  const id = `w${Date.now().toString(36)}`;
  const src = focusedWin();
  const b = src ? src.getBounds() : undefined;
  createWindow(host.info.url, id, b ? { x: b.x + 40, y: b.y + 40, width: b.width, height: b.height } : undefined);
  return id;
});
ipcMain.handle('desktop:window:focus', (_e, id: string) => { const w = wins.get(id); if (w && !w.isDestroyed()) showWindow(w); });
ipcMain.handle('desktop:window:list', () => liveWins().map(([id]) => id));
ipcMain.handle('desktop:update:state', () => updateState);
ipcMain.handle('desktop:update:check', () => checkForUpdate(true));
ipcMain.handle('desktop:update:download', () => {
  if (updateState.mode !== 'auto') { if (updateState.url) void shell.openExternal(updateState.url); return; }
  autoUpdater.downloadUpdate().catch((e) => setUpdate({ status: 'error', error: firstLine(e) }));
});
/** 立即重启更新: the installer runs silently and starts the new version (only once it is downloaded). */
ipcMain.handle('desktop:update:install', () => {
  if (updateState.mode !== 'auto' || updateState.status !== 'downloaded') return false;
  quitting = true;
  saveState();
  mainLog(`[update] installing ${updateState.version}`);
  autoUpdater.quitAndInstall(true, true);
  return true;
});
ipcMain.handle('desktop:flags:set', (_e, f: Record<string, unknown>) => { writeFlags(f); });
ipcMain.handle('desktop:flags:get', () => readFlags());
ipcMain.handle('desktop:relaunch', () => { quitting = true; app.relaunch(); app.exit(0); });
ipcMain.handle('desktop:quit', () => void requestQuit());

// ---------- lifecycle ----------
if (process.platform === 'win32') app.setAppUserModelId('com.claude-web.desktop');
process.env.CLAUDE_WEB_VERSION = app.getVersion();

// 不让电脑睡眠 while remote access is on (keep-awake.ts). The server reports before it says 'ready' — at its startup,
// again after every restart, and on every change — so this listens before host.start().
const keepAwake = new KeepAwake(powerSaveBlocker);
host.on('keepAwake', (on: boolean) => { mainLog(`[keep-awake] ${on ? 'on' : 'off'}`); keepAwake.set(on); });

if (gotLock) app.whenReady().then(async () => {
  // the window first (on the splash), then the server: see splashUrl
  const hidden = process.argv.includes('--hidden');
  const main = createWindow(null, 'main', undefined, hidden);
  try {
    const info = await host.start();
    buildMenu();
    buildTray();
    setupUpdater();
    scheduleUpdateChecks();
    const st = loadState();
    if (main.isDestroyed()) createWindow(info.url, 'main', undefined, hidden);
    else void main.loadURL(windowUrl(info.url, 'main'));
    for (const id of Object.keys(st.windows)) if (id !== 'main') createWindow(info.url, id, undefined, hidden);
    host.on('crash', (code) => new Notification({ title: APP_NAME, body: `后台服务退出（${code}），正在重启…` }).show());
    host.on('ready', (i) => { if (i.url !== info.url) for (const [id, w] of liveWins()) void w.loadURL(windowUrl(i.url, id)); });
  } catch (e: any) {
    const msg = `启动失败：${e?.stack ?? e?.message ?? e}`;
    try { fs.appendFileSync(path.join(app.getPath('userData'), 'main.log'), `[${new Date().toISOString()}] ${msg}\n`); } catch { /* ignore */ }
    dialog.showErrorBox(APP_NAME, msg);
    app.quit();
  }
});
process.on('uncaughtException', (e) => {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'main.log'), `[${new Date().toISOString()}] uncaught: ${e.stack ?? e}\n`); } catch { /* ignore */ }
});
app.on('window-all-closed', () => { /* stay in tray */ });
// macOS: clicking the Dock icon brings the (hidden) main window back
app.on('activate', () => { if (host.info) showWindow(wins.get('main') ?? focusedWin()); });
// GPU process died twice → switch to software rendering and relaunch (the usual fix for driver black screens)
app.on('child-process-gone', (_e, d) => {
  if (d.type !== 'GPU' || d.reason === 'clean-exit') return;
  if (++gpuCrashes >= 2 && !readFlags().softwareRender) {
    writeFlags({ softwareRender: true, gpuCrashes });
    quitting = true;
    app.relaunch();
    app.exit(0);
  }
});
app.on('before-quit', () => { quitting = true; saveState(); });
app.on('will-quit', (e) => {
  keepAwake.set(false);
  if (host.info) {
    e.preventDefault();
    host.info = null;
    void host.stop().finally(() => app.quit());
  }
});
