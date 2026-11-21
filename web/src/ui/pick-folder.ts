import type { FsDirs, PickDirResult } from '@shared';
import { desktop } from '@/desktop';
import { ws } from '@/ws/client';
import { dlg } from './dialog';
import type { FolderApi } from './FolderBrowser';
import { tr } from '@/i18n';

const serverFolders: FolderApi = {
  dirs: (path) => ws.request<FsDirs>({ kind: 'fs.dirs', path }),
  mkdir: async (path) => { await ws.request({ kind: 'fs.mkdir', path }); },
};

/**
 * Pick a folder on the machine the server runs on. The desktop app: the system's dialog. A browser: the server's
 * native dialog when it can show one to this browser, otherwise (issue #12 — Linux without zenity / kdialog or a
 * display, a browser on another computer) the page's own folder browser. Null when cancelled.
 *
 * `start`: the folder the desktop dialog and the page's folder browser open in (the server's native dialog takes
 * none). Without one the desktop dialog opens where Windows remembered, which can be a folder that is gone — Windows
 * then first says 「Location is not available」 (2026-11-21); the shell only steps in when it knows the last pick is
 * gone (desktop/src/dialog-start.ts) — so pass one whenever the caller knows a sensible place.
 */
export async function pickFolder(o: { title?: string; start?: string } = {}): Promise<string | null> {
  if (desktop) return desktop.pickDir({ ...(o.title ? { title: o.title } : {}), ...(o.start ? { start: o.start } : {}) });
  let r: PickDirResult;
  try {
    r = await ws.request<PickDirResult>({ kind: 'fs.pickDir', fallback: true });
  } catch {
    r = { unavailable: 'no-dialog' };
  }
  if (typeof r === 'string' || r === null) return r;
  return dlg.folder(o.title ?? tr('选择工作目录'), serverFolders, { start: o.start, message: r.unavailable === 'remote' ? tr('这里列的是运行 Claude Web 的那台电脑上的文件夹。') : undefined });
}
