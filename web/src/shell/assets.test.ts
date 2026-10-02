import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MuxResponse } from '@anywhere';
import {
  MAX_ENTRY_BYTES, appVersion, cacheName, deviceCaches, ensureAppCache, entryAssets, healthVersion, oversizedEntries, staleCaches, PcStatusError,
  type CacheLike, type CachesLike,
} from './assets';

const enc = new TextEncoder();
const DIST = path.resolve(__dirname, '../../dist');
const DIST_INDEX = path.join(DIST, 'index.html');
const D1 = 'a1b2c3d4e5f6';
const D2 = '0123456789ab';

describe('cacheName', () => {
  it('is per device and per version (review focus 5: a new PC version never reads the old files)', () => {
    expect(cacheName('d1', '0.1.5')).toBe('cw-app-d1-0.1.5');
    expect(cacheName('d1', '0.1.5')).not.toBe(cacheName('d1', '0.1.6'));
    expect(cacheName('d1', '0.1.5')).not.toBe(cacheName('d2', '0.1.5'));
  });
});

describe('appVersion: the version and a hash of index.html (a rebuild at the same version is a new one)', () => {
  it('is <version>+<8 hex of sha256(index.html)>', async () => {
    // sha256('abc') = ba7816bf…
    expect(await appVersion('0.1.5', enc.encode('abc'))).toBe('0.1.5+ba7816bf');
  });
  it('the same version with another index.html gives another cache', async () => {
    const a = cacheName(D1, await appVersion('0.1.5', enc.encode('<script src="./assets/index-A.js">')));
    const b = cacheName(D1, await appVersion('0.1.5', enc.encode('<script src="./assets/index-B.js">')));
    expect(a).not.toBe(b);
  });
});

describe('entryAssets', () => {
  it.skipIf(!fs.existsSync(DIST_INDEX))('reads the built app (npm run build -w web): at least the entry script and its stylesheet', () => {
    const list = entryAssets(fs.readFileSync(DIST_INDEX, 'utf8'));
    expect(list.length).toBeGreaterThanOrEqual(2);
    for (const p of list) expect(p.startsWith('./assets/')).toBe(true);
    expect(list.some((p) => p.endsWith('.js'))).toBe(true);
    expect(list.some((p) => p.endsWith('.css'))).toBe(true);
  });

  // over the slow relay the PC refuses any response over 2 MiB: an entry file past it could never open the app there.
  // A local check only (CI tests before it builds): the shell build itself fails past the limit (vite.shell.config.ts)
  it.skipIf(!fs.existsSync(DIST_INDEX))('every first-screen file of the built app stays under 1 900 000 bytes (the relay caps a response at 2 MiB)', () => {
    expect(MAX_ENTRY_BYTES).toBe(1_900_000);
    for (const p of entryAssets(fs.readFileSync(DIST_INDEX, 'utf8'))) {
      expect(fs.statSync(path.join(DIST, p)).size, p).toBeLessThan(MAX_ENTRY_BYTES);
    }
  });

  it('the shell build fails when a first-screen file passes the limit', () => {
    const big = oversizedEntries('<script type="module" src="./assets/a.js"></script><link rel="stylesheet" href="./assets/b.css">', (p) => (p === './assets/a.js' ? MAX_ENTRY_BYTES : 10));
    expect(big).toEqual([{ path: './assets/a.js', bytes: MAX_ENTRY_BYTES }]);
    expect(oversizedEntries('<script type="module" src="./assets/a.js"></script>', () => MAX_ENTRY_BYTES - 1)).toEqual([]);
    const src = fs.readFileSync(path.resolve(__dirname, '../../vite.shell.config.ts'), 'utf8');
    expect(src).toMatch(/oversizedEntries\(/);
  });

  it('the module script, module preloads and stylesheets under ./assets/, once each, in page order', () => {
    const html = `<!doctype html><html><head>
      <link rel="manifest" href="manifest.webmanifest" />
      <link rel="apple-touch-icon" href="icon-192.png" />
      <script type="module" crossorigin src="./assets/index-A1.js"></script>
      <link rel="modulepreload" crossorigin href="./assets/runtime-B2.js">
      <link href='./assets/index-C3.css' crossorigin rel='stylesheet'>
      <link rel="modulepreload" href="./assets/runtime-B2.js">
      <link rel="preload" as="font" href="./assets/font.woff2">
      <script src="https://cdn.example/x.js"></script>
      <script type="module" src="./assets/../../escape.js"></script>
      <link rel="stylesheet" href="assets/no-dot.css">
    </head><body><div id="root"></div></body></html>`;
    expect(entryAssets(html)).toEqual(['./assets/index-A1.js', './assets/runtime-B2.js', './assets/index-C3.css']);
  });

  it('a page with none gives none', () => {
    expect(entryAssets('<h3>web/dist not built</h3>')).toEqual([]);
  });
});

describe('healthVersion', () => {
  const res = (o: unknown, status = 200): MuxResponse => ({ status, headers: {}, body: enc.encode(JSON.stringify(o)) });

  it("the app version from the PC's /api/health", () => {
    expect(healthVersion(res({ ok: true, version: '0.1.5', serverIdHash: 'x' }))).toBe('0.1.5');
  });

  it('anything else is an error, not a guessed version', () => {
    expect(() => healthVersion(res({ ok: true }))).toThrow();
    expect(() => healthVersion(res({ ok: true, version: '0.1.5' }, 500))).toThrow();
    expect(() => healthVersion(res({ ok: true, version: '../x' }))).toThrow();
    expect(() => healthVersion({ status: 200, headers: {}, body: enc.encode('<html>') })).toThrow();
  });
});

describe('staleCaches / deviceCaches', () => {
  const keys = [`cw-app-${D1}-0.1.4+aaaaaaaa`, `cw-app-${D1}-0.1.5+bbbbbbbb`, `cw-app-${D2}-0.1.4+cccccccc`, 'cw-shell-abc', 'other'];
  it("only this device's other versions", () => {
    expect(staleCaches(keys, D1, `cw-app-${D1}-0.1.5+bbbbbbbb`)).toEqual([`cw-app-${D1}-0.1.4+aaaaaaaa`]);
  });
  it('a removed device: all of its caches, nobody else’s', () => {
    expect(deviceCaches(keys, D1)).toEqual([`cw-app-${D1}-0.1.4+aaaaaaaa`, `cw-app-${D1}-0.1.5+bbbbbbbb`]);
  });
  it('an id that is not the PC’s shape (12 lowercase hex) matches nothing', () => {
    expect(deviceCaches(['cw-app-d1-0.1.5', 'cw-app-d10-0.1.5'], 'd1')).toEqual([]);
    expect(staleCaches([`cw-app-${D1}-x`], 'cw-app', '')).toEqual([]);
  });
});

/** Cache Storage in memory: what the shell window uses (open / keys / delete, match / put). */
function memoryCaches() {
  const store = new Map<string, Map<string, Response>>();
  const order: string[] = [];
  const caches: CachesLike = {
    async open(name) {
      if (!store.has(name)) store.set(name, new Map());
      const m = store.get(name)!;
      const c: CacheLike = {
        async match(key) {
          return m.get(key)?.clone();
        },
        async put(key, r) {
          order.push(`${name} ${key}`);
          m.set(key, r);
        },
      };
      return c;
    },
    async keys() {
      return [...store.keys()];
    },
    async delete(name) {
      return store.delete(name);
    },
  };
  return { caches, store, order };
}

const SCOPE = 'https://claude-web-shell.github.io/';
const INDEX = `<script type="module" src="./assets/index-A1.js"></script><link rel="stylesheet" href="./assets/index-C3.css">`;
const INDEX_RES: MuxResponse = { status: 200, headers: { 'content-type': 'text/html' }, body: enc.encode(INDEX) };

function pcFiles(files: Record<string, { status?: number; type: string; body: string }>) {
  const asked: string[] = [];
  const get = async (p: string): Promise<MuxResponse> => {
    asked.push(p);
    const f = files[p];
    if (!f) throw new Error('the response was cut off');
    return { status: f.status ?? 200, headers: { 'content-type': f.type }, body: enc.encode(f.body) };
  };
  return { get, asked };
}

describe('ensureAppCache', () => {
  const FILES = {
    ['/assets/index-A1.js']: { type: 'text/javascript', body: 'console.log(1)' },
    ['/assets/index-C3.css']: { type: 'text/css', body: 'body{}' },
  };
  const opts = (caches: CachesLike, get: (p: string) => Promise<MuxResponse>, version = '0.1.5+bbbbbbbb', index = INDEX_RES) => ({ caches, scope: SCOPE, deviceId: D1, version, index, get });

  it('takes the entry files of index.html, stores index.html last, and drops this device’s older versions', async () => {
    const { caches, store, order } = memoryCaches();
    await caches.open(`cw-app-${D1}-0.1.4+aaaaaaaa`);
    await caches.open(`cw-app-${D2}-0.1.4+aaaaaaaa`);
    const pc = pcFiles(FILES);
    const progress: string[] = [];
    const name = await ensureAppCache({ ...opts(caches, pc.get), onProgress: (d, t) => progress.push(`${d}/${t}`) });
    expect(name).toBe(`cw-app-${D1}-0.1.5+bbbbbbbb`);
    expect(pc.asked.sort()).toEqual(['/assets/index-A1.js', '/assets/index-C3.css']);
    // the index is the mark that the cache is whole
    expect(order[order.length - 1]).toBe(`${name} ${SCOPE}app/index.html`);
    const c = store.get(name)!;
    expect(await c.get(`${SCOPE}app/assets/index-A1.js`)!.clone().text()).toBe('console.log(1)');
    expect(c.get(`${SCOPE}app/assets/index-C3.css`)!.headers.get('content-type')).toBe('text/css');
    expect([...store.keys()].sort()).toEqual([name, `cw-app-${D2}-0.1.4+aaaaaaaa`].sort());
    expect(progress[progress.length - 1]).toBe('3/3');
  });

  it('a whole cache is used as it is: nothing is fetched again', async () => {
    const { caches } = memoryCaches();
    await ensureAppCache(opts(caches, pcFiles(FILES).get));
    const again = pcFiles(FILES);
    await ensureAppCache(opts(caches, again.get));
    expect(again.asked).toEqual([]);
  });

  it('a rebuild at the same version (another index.html, another hash) is taken whole, the old build’s cache dropped', async () => {
    const { caches, store } = memoryCaches();
    const first = await ensureAppCache(opts(caches, pcFiles(FILES).get));
    const rebuilt = `<script type="module" src="./assets/index-Z9.js"></script>`;
    const pc = pcFiles({ ['/assets/index-Z9.js']: { type: 'text/javascript', body: 'z' } });
    const second = await ensureAppCache(opts(caches, pc.get, await appVersion('0.1.5', enc.encode(rebuilt)), { ...INDEX_RES, body: enc.encode(rebuilt) }));
    expect(second).not.toBe(first);
    expect(pc.asked).toEqual(['/assets/index-Z9.js']);
    expect([...store.keys()]).toEqual([second]);
  });

  it('a missing or refused file fails the whole thing, and leaves no index.html behind (the next try starts over)', async () => {
    const { caches, store } = memoryCaches();
    const refused = { ...FILES, ['/assets/index-C3.css']: { status: 413, type: 'text/plain', body: '慢速转发时单个响应不能超过 2 MB' } };
    const err = await ensureAppCache(opts(caches, pcFiles(refused).get)).catch((e) => e);
    expect(err).toBeInstanceOf(PcStatusError);
    expect(err.status).toBe(413);
    expect(String(err.message)).toMatch(/413/);
    expect(store.get(`cw-app-${D1}-0.1.5+bbbbbbbb`)?.has(`${SCOPE}app/index.html`) ?? false).toBe(false);
    await expect(ensureAppCache(opts(caches, pcFiles({}).get))).rejects.toThrow(/cut off/);
  });

  it('an index.html with no entry files is not the app', async () => {
    const { caches } = memoryCaches();
    const bare = { ...INDEX_RES, body: enc.encode('<h3>web/dist not built</h3>') };
    await expect(ensureAppCache(opts(caches, pcFiles({}).get, '0.1.5+cccccccc', bare))).rejects.toThrow();
  });
});
