import { app, BrowserWindow, Menu, Tray, Notification, dialog, shell, ipcMain, nativeImage, nativeTheme } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { ServerHost } from './server-host';

const APP_NAME = 'Claude Web';
const wins = new Map<string, BrowserWindow>(); // winId -> window ("main" is the first one)
let tray: Tray | null = null;
let pendingCount = 0;
let quitting = false;
let titleBar = { bg: '', fg: '' };
const host = new ServerHost();
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');

// ---------- single instance ----------
if (!app.requestSingleInstanceLock()) {
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
    titleBarOverlay: { color: titleBar.bg || (dark ? '#1f1e1b' : '#faf9f5'), symbolColor: titleBar.fg || (dark ? '#bab6ae' : '#4d4a44'), height: 40 },
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, spellcheck: false, additionalArguments: [`--cw-win=${winId}`] },
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
    win.hide(); // last visible window: keep running in the tray
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
    {
      label: '会话',
      submenu: [
        cmd('新会话', 'CmdOrCtrl+N', 'new'),
        cmd('命令面板', 'CmdOrCtrl+K', 'palette'),
        cmd('搜索会话', 'CmdOrCtrl+P', 'palette'),
        { type: 'separator' },
        cmd('中断当前轮', 'CmdOrCtrl+Shift+C', 'interrupt'),
        cmd('结束当前会话进程', 'CmdOrCtrl+Shift+Q', 'close'),
        { type: 'separator' },
        { label: '退出', accelerator: 'CmdOrCtrl+Q', click: () => void requestQuit() },
      ],
    },
    {
      label: '工作台',
      submenu: [
        cmd('新分组', 'CmdOrCtrl+T', 'group.new'),
        cmd('关闭分组', 'CmdOrCtrl+Shift+W', 'group.close'),
        cmd('重命名分组', 'F2', 'group.rename'),
        cmd('下一个分组', 'CmdOrCtrl+Tab', 'group.next'),
        cmd('上一个分组', 'CmdOrCtrl+Shift+Tab', 'group.prev'),
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
        cmd('任务面板', 'CmdOrCtrl+Shift+1', 'panel.tasks'),
        cmd('文件改动', 'CmdOrCtrl+Shift+2', 'panel.files'),
        cmd('用量', 'CmdOrCtrl+Shift+3', 'panel.usage'),
        cmd('配置中心', 'CmdOrCtrl+,', 'panel.config'),
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
  const img = ip ? nativeImage.createFromPath(ip).resize({ width: 16, height: 16 }) : badgeImage(0);
  tray = new Tray(img);
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开', click: () => showWindow(wins.get('main') ?? focusedWin()) },
    { label: '新会话', click: () => sendCommand('new') },
    { type: 'separator' },
    { label: '退出', click: () => void requestQuit() },
  ]));
  tray.on('click', () => showWindow(wins.get('main') ?? focusedWin()));
}

async function requestQuit() {
  const ids = new Set<string>();
  for (const [, w] of liveWins()) {
    const arr: string[] = await w.webContents.executeJavaScript('Object.values(window.__store?.getState().open ?? {}).filter(o => o.state === "running" || o.state === "waiting").map(o => o.sessionId)', true).catch(() => []);
    for (const id of arr) ids.add(id);
  }
  if (ids.size > 0) {
    const w = focusedWin();
    const r = await dialog.showMessageBox(w ?? undefined as any, { type: 'question', buttons: ['退出', '取消'], defaultId: 1, cancelId: 1, message: `还有 ${ids.size} 个会话在运行`, detail: '退出只会结束进程，会话记录保留在磁盘上，下次可以恢复。' });
    if (r.response !== 0) return;
  }
  quitting = true;
  app.quit();
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
  for (const [, w] of liveWins()) { try { w.setTitleBarOverlay({ color: bg, symbolColor: fg, height: 40 }); } catch { /* not supported */ } }
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

// ---------- lifecycle ----------
app.setAppUserModelId('com.claude-web.desktop');
process.env.CLAUDE_WEB_VERSION = app.getVersion();

app.whenReady().then(async () => {
  try {
    const info = await host.start();
    buildMenu();
    buildTray();
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
app.on('before-quit', () => { quitting = true; saveState(); });
app.on('will-quit', (e) => {
  if (host.info) {
    e.preventDefault();
    host.info = null;
    void host.stop().finally(() => app.quit());
  }
});
