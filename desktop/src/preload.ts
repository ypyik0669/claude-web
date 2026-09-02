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
});
