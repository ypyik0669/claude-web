import { webContents, type WebContents } from 'electron';

/** Wider than this a picture of a page is scaled down (a 4K page as it is would be tens of megabytes for a model to read). */
export const MAX_WIDTH = 1280;
/** A page that is not being drawn (hidden, the screen asleep) never answers: the wait ends here. */
export const DRAW_MS = 5000;

/**
 * A picture of a page of the built-in browser, for an Agent's browser_screenshot (web/src/features/browser/guest.ts →
 * `desktop.captureGuest`). `id` is the <webview>'s `getWebContentsId()`. Only a page that the asking window itself
 * hosts is drawn; null when there is no such page or nothing could be drawn (in time).
 */
export async function captureGuest(asker: WebContents, id: unknown): Promise<{ mime: 'image/jpeg'; data: string } | null> {
  const guest = typeof id === 'number' ? webContents.fromId(id) : undefined;
  if (!guest || guest.isDestroyed() || guest.hostWebContents !== asker) return null;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((r) => { timer = setTimeout(() => r(null), DRAW_MS); });
  const img = await Promise.race([guest.capturePage().catch(() => null), late]).finally(() => clearTimeout(timer));
  if (!img || img.isEmpty()) return null;
  const out = img.getSize().width > MAX_WIDTH ? img.resize({ width: MAX_WIDTH, quality: 'good' }) : img;
  return { mime: 'image/jpeg', data: out.toJPEG(72).toString('base64') };
}
