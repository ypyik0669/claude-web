// Where a request inside the shell's scope goes: the shell's own files, one of the app's files (served from the
// cache, or fetched from the PC over the link), or one of the PC's endpoints (always over the link). Pure; the
// service worker (sw.ts) and the shell window (main.ts) both use it.

export type Route = { kind: 'shell' } | { kind: 'asset'; path: string } | { kind: 'api'; path: string } | { kind: 'pass' };

/** The app runs below the shell, in this folder (app/index.html), with relative paths only (Vite base './'). */
export const APP_DIR = 'app/';
/** On the app frame's address: the shell window that owns the frame, and the app cache it reads. */
export const OWNER_PARAM = 'cwshell';
export const CACHE_PARAM = 'cwcache';
const APP_CACHE_RE = /^cw-app-[\w.+-]{1,200}$/;

/** A path on the PC's remote-access listener: one leading slash (call sites write it without, see app-url.test.ts). */
export function pcPath(rel: string): string {
  return `/${rel.replace(/^\/+/, '')}`;
}

/** `scope` is the service worker's scope: a URL, or a path on the request's origin. */
export function route(url: URL, scope: string): Route {
  let base: URL;
  try {
    base = new URL(scope, url);
  } catch {
    return { kind: 'pass' };
  }
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return { kind: 'pass' };
  const rest = url.pathname.slice(base.pathname.length);
  if (!rest.startsWith(APP_DIR)) return { kind: 'shell' };
  let search = url.search;
  const q = new URLSearchParams(search);
  if (q.has(OWNER_PARAM) || q.has(CACHE_PARAM)) {
    // only then re-encoded: any other query goes to the PC byte for byte
    q.delete(OWNER_PARAM);
    q.delete(CACHE_PARAM);
    const s = q.toString();
    search = s ? `?${s}` : '';
  }
  const inApp = rest.slice(APP_DIR.length);
  const path = `${pcPath(inApp)}${search}`;
  return inApp.startsWith('api/') ? { kind: 'api', path } : { kind: 'asset', path };
}

/** The address the shell opens the app at: its window's id and the cache of the PC's version, as query marks. */
export function appEntry(scope: string, owner: string, cache: string): string {
  const u = new URL(`${APP_DIR}index.html`, scope);
  u.searchParams.set(OWNER_PARAM, owner);
  u.searchParams.set(CACHE_PARAM, cache);
  return u.href;
}

/** The marks on a frame's (or a navigation's) address; null for what has none (a worker, a page opened by itself). */
export function frameParams(url: string): { owner: string | null; cache: string | null } {
  try {
    const q = new URL(url).searchParams;
    const cache = q.get(CACHE_PARAM);
    return { owner: q.get(OWNER_PARAM) || null, cache: cache && APP_CACHE_RE.test(cache) ? cache : null };
  } catch {
    return { owner: null, cache: null };
  }
}

/** The cache key of a PC path: the URL the app frame asks for it at. */
export function appKey(scope: string, path: string): string {
  return new URL(`${APP_DIR}${path.replace(/^\/+/, '')}`, scope).href;
}
