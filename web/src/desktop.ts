/** Bridge exposed by the Electron preload (desktop/src/preload.ts). Undefined in plain browser mode. */
export interface DesktopBridge {
  version: string;
  platform: string;
  pickDir(): Promise<string | null>;
  openPath(p: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  notify(title: string, body: string, sessionId?: string): void;
  setBadge(n: number): void;
  /** bg: the shell ground (new windows start on it); overlay: what the caption buttons are painted on (default bg);
   *  height: how tall the caption buttons' area is — the row they sit over, from the window's top edge */
  setTitleBarColors(bg: string, fg: string, overlay?: string, height?: number): void;
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
  // 界面缩放 (desktop/src/zoom.ts): the shell owns the factor, for every window, and remembers it
  /** the factor this page is drawn at right now */
  getZoom?(): number;
  zoomInfo?(): Promise<ZoomInfo>;
  /** one step in / out, back to 100%, or a factor; answers with what it is now */
  setZoom?(ask: 'in' | 'out' | 'reset' | number): Promise<ZoomInfo>;
  onZoom?(cb: (e: ZoomInfo & { changed: boolean; ask: 'in' | 'out' | 'reset' | 'set' }) => void): () => void;
}

/** `max`: the largest factor this window's screen can take (the smallest window must still fit it). */
export interface ZoomInfo { zoom: number; max: number; min: number; /** every factor there is, smallest first */ steps?: number[] }

export const desktop: DesktopBridge | undefined = (window as any).desktop;
export const isDesktop = !!desktop;
