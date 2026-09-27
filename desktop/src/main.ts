import { app, BrowserWindow, Menu, Tray, Notification, dialog, shell, ipcMain, nativeImage, nativeTheme } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { ServerHost } from './server-host';
import { autoUpdater } from 'electron-updater';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

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
    const out = execFileSync(shellBin, ['-ilc', 'printf "__CW_PATH__%s__CW_PATH__" "$PATH"'], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
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
function readFlags(): { softwareRender?: boolean; gpuCrashes?: number } {
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
let titleBar = { bg: '', fg: '' };
let gpuCrashes = 0;
type UpdateState = { status: string; version?: string; percent?: number; error?: string; notes?: string };
let updateState: UpdateState = { status: 'idle' };
const host = new ServerHost();
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');

// ---------- single instance ----------
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

function createWindow(url: string, winId = 'main', bounds?: Bounds): BrowserWindow {
  const st = bounds ?? loadState().windows[winId] ?? {};
  const dark = nativeTheme.shouldUseDarkColors;
  const win = new BrowserWindow({
    width: st.width ?? 1400,
    height: st.height ?? 900,
    x: st.x,
    y: st.y,
    minWidth: 900,
    minHeight: 600,
    title: APP_NAME,
    icon: iconPath(),
    backgroundColor: titleBar.bg || (dark ? '#1f1e1b' : '#faf9f5'),
    titleBarStyle: 'hidden',
    // macOS keeps its own traffic lights (left, see `html.mac` in styles.css); elsewhere we draw the overlay buttons
    ...(isMac
      ? { trafficLightPosition: { x: 14, y: 13 } }
      : { titleBarOverlay: { color: titleBar.bg || (dark ? '#1f1e1b' : '#faf9f5'), symbolColor: titleBar.fg || (dark ? '#bab6ae' : '#4d4a44'), height: 40 } }),
    show: false,
    // webviewTag powers the in-app browser tile; each <webview> declares its own partition and denies popups
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, spellcheck: false, webviewTag: true, additionalArguments: [`--cw-win=${winId}`] },
  });
  wins.set(winId, win);
  if (st.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
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
  // in-app browser tiles: strip our preload off the guest page and keep every popup out of process
  win.webContents.on('will-attach-webview', (_e, prefs) => {
    delete (prefs as { preload?: string }).preload;
    prefs.nodeIntegration = false;
    prefs.contextIsolation = true;
  });
  win.webContents.on('did-attach-webview', (_e, guest) => {
    guest.setWindowOpenHandler(({ url: target }) => {
      if (/^https?:/.test(target)) void shell.openExternal(target);
      return { action: 'deny' };
    });
  });
  win.on('focus', () => { pendingCount = 0; updateBadge(); });
  void win.loadURL(windowUrl(url, winId));
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
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="15" fill="#d97757"/><text x="16" y="22" font-size="18" font-family="Segoe UI,Arial" font-weight="700" fill="#fff" text-anchor="middle">${n > 9 ? '9+' : n}</text></svg>`;
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

// Accelerators mirror web/src/features/workbench/shortcuts.ts (desktop column).
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
      label: '会话',
      submenu: [
        cmd('新会话', 'CmdOrCtrl+N', 'new'),
        cmd('命令面板', 'CmdOrCtrl+K', 'palette'),
        cmd('搜索会话', 'CmdOrCtrl+P', 'palette'),
        { type: 'separator' },
        cmd('中断当前轮', 'CmdOrCtrl+Shift+C', 'interrupt'),
        cmd('结束当前会话进程', 'CmdOrCtrl+Shift+Q', 'close'),
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
        cmd('关闭标签 / 窗格', 'CmdOrCtrl+W', 'tile.close'),
        cmd('缩放窗格', 'CmdOrCtrl+Shift+Enter', 'pane.zoom'),
        cmd('下一个窗格', 'CmdOrCtrl+Alt+Right', 'pane.next'),
        cmd('上一个窗格', 'CmdOrCtrl+Alt+Left', 'pane.prev'),
        ...[1, 2, 3, 4, 5, 6].map((n) => ({ ...cmd(`跳到窗格 ${n}`, `Alt+${n}`, `pane.jump.${n - 1}`), visible: n <= 2 })),
        { type: 'separator' },
        cmd('窗格内新标签', 'CmdOrCtrl+Shift+T', 'tile.new'),
        cmd('下一个标签', 'CmdOrCtrl+PageDown', 'tile.next'),
        cmd('上一个标签', 'CmdOrCtrl+PageUp', 'tile.prev'),
        { type: 'separator' },
        cmd('在新窗口打开当前分组', 'CmdOrCtrl+Shift+N', 'window.new'),
      ],
    },
    {
      label: '视图',
      submenu: [
        cmd('侧栏', 'CmdOrCtrl+B', 'sidebar'),
        cmd('对话 / 轨迹', 'Alt+J', 'tab'),
        { type: 'separator' },
        cmd('停靠面板', 'CmdOrCtrl+J', 'dock.toggle'),
        cmd('最小化停靠面板', 'CmdOrCtrl+Shift+J', 'dock.minimize'),
        cmd('总览（Mission Control）', 'CmdOrCtrl+Shift+M', 'panel.mission'),
        cmd('任务面板', 'CmdOrCtrl+Shift+1', 'panel.tasks'),
        cmd('文件改动', 'CmdOrCtrl+Shift+2', 'panel.files'),
        cmd('用量', 'CmdOrCtrl+Shift+3', 'panel.usage'),
        ...(isMac ? [] : [cmd('设置', 'CmdOrCtrl+,', 'settings')]),
        cmd('配置中心（停靠面板）', undefined, 'panel.config'),
        cmd('终端', 'CmdOrCtrl+`', 'panel.terminal'),
        { type: 'separator' },
        cmd('键盘快捷键', 'F1', 'shortcuts'),
        { role: 'togglefullscreen' },
        { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' },
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
    { label: '新会话', click: () => sendCommand('new') },
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
    const parts = [running.size ? `${running.size} 个会话在运行` : '', pending ? `${pending} 个权限请求待处理` : '', dirty ? `${dirty} 个文件未保存` : ''].filter(Boolean);
    const r = await dialog.showMessageBox(w ?? undefined as any, { type: 'question', buttons: ['退出', dirty ? '取消（回去保存）' : '取消', '最小化到托盘'], defaultId: 1, cancelId: 1, message: parts.join('，'), detail: '退出会结束会话进程（记录保留在磁盘，可恢复）；未保存的编辑会丢失。' });
    if (r.response === 1) return;
    if (r.response === 2) { for (const [, x] of liveWins()) x.hide(); return; }
  }
  quitting = true;
  app.quit();
}

// ---------- auto-update (electron-updater → GitHub Releases; no-op in dev) ----------
function setUpdate(s: UpdateState) {
  updateState = s;
  broadcast('desktop:update', s);
}
function setupUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  (autoUpdater as any).logger = null;
  autoUpdater.on('checking-for-update', () => setUpdate({ status: 'checking' }));
  autoUpdater.on('update-available', (i) => setUpdate({ status: 'available', version: i.version, notes: typeof i.releaseNotes === 'string' ? i.releaseNotes.replace(/<[^>]+>/g, '') : undefined }));
  autoUpdater.on('update-not-available', () => setUpdate({ status: 'none' }));
  autoUpdater.on('download-progress', (p) => setUpdate({ status: 'downloading', percent: p.percent }));
  autoUpdater.on('update-downloaded', (i) => setUpdate({ status: 'downloaded', version: i.version }));
  autoUpdater.on('error', (e) => setUpdate({ status: 'error', error: String(e.message).split('\n')[0] }));
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
ipcMain.on('desktop:titlebar', (_e, { bg, fg }: { bg: string; fg: string }) => {
  titleBar = { bg, fg };
  if (!isMac) for (const [, w] of liveWins()) { try { w.setTitleBarOverlay({ color: bg, symbolColor: fg, height: 40 }); } catch { /* not supported */ } }
});
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
ipcMain.handle('desktop:update:check', () => {
  if (!app.isPackaged) { setUpdate({ status: 'error', error: '开发模式不检查更新' }); return; }
  autoUpdater.checkForUpdates().catch((e) => setUpdate({ status: 'error', error: e.message }));
});
ipcMain.handle('desktop:update:download', () => autoUpdater.downloadUpdate().catch((e) => setUpdate({ status: 'error', error: e.message })));
ipcMain.handle('desktop:update:install', () => { quitting = true; autoUpdater.quitAndInstall(); });
ipcMain.handle('desktop:flags:set', (_e, f: Record<string, unknown>) => { writeFlags(f); });
ipcMain.handle('desktop:flags:get', () => readFlags());
ipcMain.handle('desktop:relaunch', () => { quitting = true; app.relaunch(); app.exit(0); });
ipcMain.handle('desktop:quit', () => void requestQuit());

// ---------- lifecycle ----------
if (process.platform === 'win32') app.setAppUserModelId('com.claude-web.desktop');
process.env.CLAUDE_WEB_VERSION = app.getVersion();

if (gotLock) app.whenReady().then(async () => {
  try {
    const info = await host.start();
    buildMenu();
    buildTray();
    setupUpdater();
    const st = loadState();
    createWindow(info.url, 'main');
    for (const id of Object.keys(st.windows)) if (id !== 'main') createWindow(info.url, id);
    if (process.argv.includes('--hidden')) for (const [, w] of liveWins()) w.hide();
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
  if (host.info) {
    e.preventDefault();
    host.info = null;
    void host.stop().finally(() => app.quit());
  }
});
