import { app, BrowserWindow, Menu, Tray, Notification, dialog, shell, ipcMain, nativeImage, nativeTheme } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { ServerHost } from './server-host';

const APP_NAME = 'Claude Web';
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let pendingCount = 0;
let quitting = false;
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

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    return {};
  }
}
function saveState() {
  if (!win) return;
  const b = win.getBounds();
  fs.writeFileSync(stateFile(), JSON.stringify({ ...b, maximized: win.isMaximized() }));
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow(url: string) {
  const st = loadState();
  const dark = nativeTheme.shouldUseDarkColors;
  win = new BrowserWindow({
    width: st.width ?? 1400,
    height: st.height ?? 900,
    x: st.x,
    y: st.y,
    minWidth: 900,
    minHeight: 600,
    title: APP_NAME,
    icon: iconPath(),
    backgroundColor: dark ? '#1f1e1b' : '#faf9f5',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: dark ? '#1f1e1b' : '#faf9f5', symbolColor: dark ? '#bab6ae' : '#4d4a44', height: 40 },
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  if (st.maximized) win.maximize();
  win.once('ready-to-show', () => win?.show());
  win.on('resize', saveState);
  win.on('move', saveState);
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win?.hide(); // keep running in the tray
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url) && !url.startsWith(host.info?.url.split('/?')[0] ?? '\0')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, target) => {
    if (!target.startsWith(`http://${host.info?.host}:${host.info?.port}`)) { e.preventDefault(); void shell.openExternal(target); }
  });
  win.on('focus', () => { pendingCount = 0; updateBadge(); });
  void win.loadURL(url);
}

function updateBadge() {
  if (process.platform === 'win32' && win) {
    if (pendingCount > 0) {
      const img = badgeImage(pendingCount);
      win.setOverlayIcon(img, `${pendingCount} 个待处理`);
    } else win.setOverlayIcon(null, '');
  }
  tray?.setToolTip(pendingCount > 0 ? `${APP_NAME} · ${pendingCount} 个待处理` : APP_NAME);
}

function badgeImage(n: number) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="15" fill="#d97757"/><text x="16" y="22" font-size="18" font-family="Segoe UI,Arial" font-weight="700" fill="#fff" text-anchor="middle">${n > 9 ? '9+' : n}</text></svg>`;
  return nativeImage.createFromDataURL('data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'));
}

function sendCommand(id: string) {
  showWindow();
  win?.webContents.send('desktop:command', id);
}

function buildMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '会话',
      submenu: [
        { label: '新会话', accelerator: 'CmdOrCtrl+N', click: () => sendCommand('new') },
        { label: '命令面板', accelerator: 'CmdOrCtrl+K', click: () => sendCommand('palette') },
        { label: '搜索会话', accelerator: 'CmdOrCtrl+P', click: () => sendCommand('palette') },
        { type: 'separator' },
        { label: '中断当前轮', accelerator: 'CmdOrCtrl+Shift+C', click: () => sendCommand('interrupt') },
        { label: '结束当前会话进程', accelerator: 'CmdOrCtrl+W', click: () => sendCommand('close') },
        { type: 'separator' },
        { label: '退出', accelerator: 'CmdOrCtrl+Q', click: () => void requestQuit() },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '侧栏', accelerator: 'CmdOrCtrl+B', click: () => sendCommand('sidebar') },
        { label: '对话 / 轨迹', accelerator: 'CmdOrCtrl+Shift+J', click: () => sendCommand('tab') },
        { type: 'separator' },
        { label: '任务面板', accelerator: 'CmdOrCtrl+1', click: () => sendCommand('panel.tasks') },
        { label: '文件改动', accelerator: 'CmdOrCtrl+2', click: () => sendCommand('panel.files') },
        { label: '用量', accelerator: 'CmdOrCtrl+3', click: () => sendCommand('panel.usage') },
        { label: '配置中心', accelerator: 'CmdOrCtrl+,', click: () => sendCommand('panel.config') },
        { label: '终端', accelerator: 'CmdOrCtrl+`', click: () => sendCommand('panel.terminal') },
        { type: 'separator' },
        { label: '键盘快捷键', accelerator: 'F1', click: () => sendCommand('shortcuts') },
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
    { label: '打开', click: () => showWindow() },
    { label: '新会话', click: () => sendCommand('new') },
    { type: 'separator' },
    { label: '退出', click: () => void requestQuit() },
  ]));
  tray.on('click', () => showWindow());
}

async function requestQuit() {
  if (win && !win.isDestroyed()) {
    const running = await win.webContents.executeJavaScript('Object.values(window.__store?.getState().open ?? {}).filter(o => o.state === "running" || o.state === "waiting").length', true).catch(() => 0);
    if (running > 0) {
      const r = await dialog.showMessageBox(win, { type: 'question', buttons: ['退出', '取消'], defaultId: 1, cancelId: 1, message: `还有 ${running} 个会话在运行`, detail: '退出只会结束进程，会话记录保留在磁盘上，下次可以恢复。' });
      if (r.response !== 0) return;
    }
  }
  quitting = true;
  app.quit();
}

// ---------- IPC ----------
ipcMain.handle('desktop:pickDir', async () => {
  const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'], title: '选择工作目录' });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('desktop:openPath', (_e, p: string) => shell.openPath(p));
ipcMain.handle('desktop:openExternal', (_e, url: string) => shell.openExternal(url));
ipcMain.on('desktop:notify', (_e, { title, body, sessionId }: { title: string; body: string; sessionId?: string }) => {
  if (win?.isFocused()) return;
  pendingCount++;
  updateBadge();
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: iconPath(), silent: false });
  n.on('click', () => { showWindow(); if (sessionId) win?.webContents.send('desktop:focusSession', sessionId); });
  n.show();
  win?.flashFrame(true);
});
ipcMain.on('desktop:badge', (_e, n: number) => { pendingCount = n; updateBadge(); });
ipcMain.on('desktop:titlebar', (_e, { bg, fg }: { bg: string; fg: string }) => { try { win?.setTitleBarOverlay({ color: bg, symbolColor: fg, height: 40 }); } catch { /* not supported */ } });
ipcMain.handle('desktop:loginItem:get', () => app.getLoginItemSettings().openAtLogin);
ipcMain.handle('desktop:loginItem:set', (_e, on: boolean) => app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] }));

// ---------- lifecycle ----------
app.setAppUserModelId('com.claude-web.desktop');
process.env.CLAUDE_WEB_VERSION = app.getVersion();

app.whenReady().then(async () => {
  try {
    const info = await host.start();
    buildMenu();
    buildTray();
    createWindow(info.url);
    if (process.argv.includes('--hidden')) win?.hide();
    host.on('crash', (code) => new Notification({ title: APP_NAME, body: `后台服务退出（${code}），正在重启…` }).show());
    host.on('ready', (i) => { if (win && !win.isDestroyed() && i.url !== info.url) void win.loadURL(i.url); });
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
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', (e) => {
  if (host.info) {
    e.preventDefault();
    host.info = null;
    void host.stop().finally(() => app.quit());
  }
});
