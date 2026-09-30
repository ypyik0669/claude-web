/** Bridge exposed by the Electron preload (desktop/src/preload.ts). Undefined in plain browser mode. */
export interface DesktopBridge {
  version: string;
  platform: string;
  pickDir(): Promise<string | null>;
  openPath(p: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  notify(title: string, body: string, sessionId?: string): void;
  setBadge(n: number): void;
  setTitleBarColors(bg: string, fg: string): void;
  getLoginItem(): Promise<boolean>;
  setLoginItem(on: boolean): Promise<void>;
  onCommand(cb: (id: string) => void): () => void;
  onFocusSession(cb: (sessionId: string) => void): () => void;
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
}

export const desktop: DesktopBridge | undefined = (window as any).desktop;
export const isDesktop = !!desktop;
