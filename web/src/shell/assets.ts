// The app's files on the phone: Cache Storage, one cache per PC (device) and PC version, so the phone always runs
// the files of the version it talks to and never mixes two (review focus 5). The first screen's files are taken
// whole when a version is new to the phone; everything else is fetched when the app asks (and kept, see main.ts).
import type { MuxResponse } from '@anywhere';
import { appKey, pcPath } from './route';

/** The parts of Cache Storage used here (window and service worker both have it; tests pass a map). */
export interface CacheLike {
  match(key: string): Promise<Response | undefined>;
  put(key: string, res: Response): Promise<void>;
}
export interface CachesLike {
  open(name: string): Promise<CacheLike>;
  keys(): Promise<string[]>;
  delete(name: string): Promise<boolean>;
}

/** GET of a path on the PC (over the link). */
export type PcGet = (path: string) => Promise<MuxResponse>;

const APP_PREFIX = 'cw-app-';
const VERSION_RE = /^[\w.+-]{1,64}$/;
/** `./assets/<file>`: no `..`, no `//`, nothing that could leave the folder. */
const ENTRY_RE = /^\.\/assets\/(?!.*\.\.)(?!.*\/\/)[\w.@~-][\w./@~-]*$/;
const INDEX = 'index.html';

export function cacheName(deviceId: string, version: string): string {
  return `${APP_PREFIX}${deviceId}-${version}`;
}

/** Caches of this device's other versions (device ids have no `-`, so `d1-` never matches `d10-`). */
export function staleCaches(keys: string[], deviceId: string, keep: string): string[] {
  const mine = `${APP_PREFIX}${deviceId}-`;
  return keys.filter((k) => k.startsWith(mine) && k !== keep);
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null;
}

/** What the built index.html loads first: its `./assets/` module scripts, module preloads and stylesheets, in order. */
export function entryAssets(indexHtml: string): string[] {
  const out: string[] = [];
  for (const m of indexHtml.matchAll(/<(script|link)\b[^>]*>/gi)) {
    const tag = m[0];
    let url: string | null = null;
    if (m[1].toLowerCase() === 'script') url = attr(tag, 'src');
    else {
      const rel = (attr(tag, 'rel') ?? '').toLowerCase().split(/\s+/);
      if (rel.includes('modulepreload') || rel.includes('stylesheet')) url = attr(tag, 'href');
    }
    if (url && ENTRY_RE.test(url) && !out.includes(url)) out.push(url);
  }
  return out;
}

/** The app version from the PC's api/health answer; throws for anything that is not one. */
export function healthVersion(res: MuxResponse): string {
  if (res.status !== 200) throw new Error(`api/health answered ${res.status}`);
  let v: unknown;
  try {
    v = (JSON.parse(new TextDecoder().decode(res.body)) as { version?: unknown }).version;
  } catch {
    throw new Error('api/health did not answer JSON');
  }
  if (typeof v !== 'string' || !VERSION_RE.test(v)) throw new Error(`api/health gave no usable version: ${JSON.stringify(v)}`);
  return v;
}

/** A copy of a PC answer as a cacheable response: its type only (the cache key is the URL). */
export function toCached(res: MuxResponse): Response {
  const headers: Record<string, string> = {};
  if (res.headers['content-type']) headers['content-type'] = res.headers['content-type'];
  return new Response(res.body.slice(), { status: 200, headers });
}

async function fetchOk(get: PcGet, path: string): Promise<MuxResponse> {
  const res = await get(path);
  if (res.status !== 200) {
    const said = new TextDecoder().decode(res.body.subarray(0, 300)).trim();
    throw new Error(`${path}: ${res.status}${said ? ` ${said}` : ''}`);
  }
  return res;
}

/** Is this cache whole? index.html goes in last, so its presence says so. */
export async function cacheComplete(caches: CachesLike, scope: string, name: string): Promise<boolean> {
  return (await caches.keys()).includes(name) && !!(await (await caches.open(name)).match(appKey(scope, INDEX)));
}

/**
 * The cache of `version` for `deviceId`, whole: if it is not yet, index.html and its entry files are taken from the
 * PC (all of them or none: any failure rejects and index.html is not stored), then the device's older versions go.
 */
export async function ensureAppCache(o: {
  caches: CachesLike;
  scope: string;
  deviceId: string;
  version: string;
  get: PcGet;
  onProgress?: (done: number, total: number) => void;
}): Promise<string> {
  const name = cacheName(o.deviceId, o.version);
  if (!(await cacheComplete(o.caches, o.scope, name))) {
    const index = await fetchOk(o.get, pcPath(INDEX));
    const entries = entryAssets(new TextDecoder().decode(index.body));
    if (entries.length === 0) throw new Error('index.html loads no ./assets/ files: not the built app');
    const total = entries.length + 1;
    let done = 0;
    const tell = () => o.onProgress?.(done, total);
    tell();
    // the link takes them in turn; a big entry file does not hold the small ones back
    const files = await Promise.all(
      entries.map(async (e) => {
        const res = await fetchOk(o.get, pcPath(e.slice(2)));
        done++;
        tell();
        return [e, res] as const;
      }),
    );
    const cache = await o.caches.open(name);
    for (const [e, res] of files) await cache.put(appKey(o.scope, e.slice(2)), toCached(res));
    await cache.put(appKey(o.scope, INDEX), toCached(index));
    done++;
    tell();
  }
  for (const k of staleCaches(await o.caches.keys(), o.deviceId, name)) await o.caches.delete(k);
  return name;
}
