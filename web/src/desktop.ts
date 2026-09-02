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
}

export const desktop: DesktopBridge | undefined = (window as any).desktop;
export const isDesktop = !!desktop;
