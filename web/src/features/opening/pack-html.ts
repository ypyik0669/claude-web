// A web pack's page, for 试放一次 and a card's preview (the desktop's own start gets it from the shell instead). The app
// fetches it — same origin, with the token — and hands it to the opening page, which puts it in its sandboxed frame.
import type { OpeningInfo } from '@shared';
import { authToken } from '@/ws/client';
import { appUrl } from '@/util/app-url';
import { packFileUrl } from './model';

const cache = new Map<string, Promise<string | null>>();

/** The page (null: it could not be read). Kept for the page's life: a pack's page does not change under the same id but by re-import. */
export function packHtml(pack: OpeningInfo): Promise<string | null> {
  if (pack.kind !== 'web' || !pack.entry) return Promise.resolve(null);
  const key = `${pack.id}/${pack.entry}`;
  let p = cache.get(key);
  if (!p) {
    p = fetch(appUrl(packFileUrl(pack.id, pack.entry, authToken()))).then((r) => (r.ok ? r.text() : null)).catch(() => null);
    cache.set(key, p);
    // a failure is not kept: the next try asks again
    void p.then((v) => { if (v === null) cache.delete(key); });
  }
  return p;
}

/** A pack was added or removed: pages read before may be another pack's now (the same folder name re-used). */
export const forgetPackHtml = () => cache.clear();
