import { contextBridge, ipcRenderer } from 'electron';

const on = (channel: string) => (cb: (arg: any) => void) => {
  const h = (_e: unknown, arg: any) => cb(arg);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('desktop', {
  version: process.env.CLAUDE_WEB_VERSION ?? '',
  platform: process.platform,
  pickDir: () => ipcRenderer.invoke('desktop:pickDir'),
  openPath: (p: string) => ipcRenderer.invoke('desktop:openPath', p),
  openExternal: (url: string) => ipcRenderer.invoke('desktop:openExternal', url),
  notify: (title: string, body: string, sessionId?: string) => ipcRenderer.send('desktop:notify', { title, body, sessionId }),
  setBadge: (n: number) => ipcRenderer.send('desktop:badge', n),
  setTitleBarColors: (bg: string, fg: string) => ipcRenderer.send('desktop:titlebar', { bg, fg }),
  getLoginItem: () => ipcRenderer.invoke('desktop:loginItem:get'),
  setLoginItem: (on: boolean) => ipcRenderer.invoke('desktop:loginItem:set', on),
  onCommand: on('desktop:command'),
  onFocusSession: on('desktop:focusSession'),
  windowId: process.argv.find((a) => a.startsWith('--cw-win='))?.slice(9) ?? 'main',
  newWindow: () => ipcRenderer.invoke('desktop:window:new'),
  focusWindow: (id: string) => ipcRenderer.invoke('desktop:window:focus', id),
  listWindows: () => ipcRenderer.invoke('desktop:window:list'),
  updateState: () => ipcRenderer.invoke('desktop:update:state'),
  checkUpdate: () => ipcRenderer.invoke('desktop:update:check'),
  downloadUpdate: () => ipcRenderer.invoke('desktop:update:download'),
  installUpdate: () => ipcRenderer.invoke('desktop:update:install'),
  onUpdate: on('desktop:update'),
  setFlags: (f: Record<string, unknown>) => ipcRenderer.invoke('desktop:flags:set', f),
  getFlags: () => ipcRenderer.invoke('desktop:flags:get'),
  relaunch: () => ipcRenderer.invoke('desktop:relaunch'),
  quit: () => ipcRenderer.invoke('desktop:quit'),
});
