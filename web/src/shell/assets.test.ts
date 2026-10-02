import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MuxResponse } from '@anywhere';
import { cacheName, ensureAppCache, entryAssets, healthVersion, staleCaches, type CacheLike, type CachesLike } from './assets';

const enc = new TextEncoder();
const DIST_INDEX = path.resolve(__dirname, '../../dist/index.html');

describe('cacheName', () => {
  it('is per device and per version (review focus 5: a new PC version never reads the old files)', () => {
    expect(cacheName('d1', '0.1.5')).toBe('cw-app-d1-0.1.5');
    expect(cacheName('d1', '0.1.5')).not.toBe(cacheName('d1', '0.1.6'));
    expect(cacheName('d1', '0.1.5')).not.toBe(cacheName('d2', '0.1.5'));
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

describe('staleCaches', () => {
  it("only this device's other versions", () => {
    const keys = ['cw-app-d1-0.1.4', 'cw-app-d1-0.1.5', 'cw-app-d10-0.1.4', 'cw-app-d2-0.1.4', 'cw-shell-abc', 'other'];
    expect(staleCaches(keys, 'd1', 'cw-app-d1-0.1.5')).toEqual(['cw-app-d1-0.1.4']);
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

const SCOPE = 'https://ypyik0669.github.io/claude-web/';
const INDEX = `<script type="module" src="./assets/index-A1.js"></script><link rel="stylesheet" href="./assets/index-C3.css">`;

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
    ['/index.html']: { type: 'text/html', body: INDEX },
    ['/assets/index-A1.js']: { type: 'text/javascript', body: 'console.log(1)' },
    ['/assets/index-C3.css']: { type: 'text/css', body: 'body{}' },
  };

  it('takes index.html and its entry files, stores index.html last, and drops this device’s older versions', async () => {
    const { caches, store, order } = memoryCaches();
    await caches.open('cw-app-d1-0.1.4');
    await caches.open('cw-app-d2-0.1.4');
    const pc = pcFiles(FILES);
    const progress: string[] = [];
    const name = await ensureAppCache({ caches, scope: SCOPE, deviceId: 'd1', version: '0.1.5', get: pc.get, onProgress: (d, t) => progress.push(`${d}/${t}`) });
    expect(name).toBe('cw-app-d1-0.1.5');
    expect(pc.asked.sort()).toEqual(['/assets/index-A1.js', '/assets/index-C3.css', '/index.html']);
    // the index is the mark that the cache is whole
    expect(order[order.length - 1]).toBe(`cw-app-d1-0.1.5 ${SCOPE}app/index.html`);
    const c = store.get('cw-app-d1-0.1.5')!;
    expect(await c.get(`${SCOPE}app/assets/index-A1.js`)!.clone().text()).toBe('console.log(1)');
    expect(c.get(`${SCOPE}app/assets/index-C3.css`)!.headers.get('content-type')).toBe('text/css');
    expect([...store.keys()].sort()).toEqual(['cw-app-d1-0.1.5', 'cw-app-d2-0.1.4']);
    expect(progress[progress.length - 1]).toBe('3/3');
  });

  it('a whole cache is used as it is: nothing is fetched again', async () => {
    const { caches } = memoryCaches();
    await ensureAppCache({ caches, scope: SCOPE, deviceId: 'd1', version: '0.1.5', get: pcFiles(FILES).get });
    const again = pcFiles(FILES);
    await ensureAppCache({ caches, scope: SCOPE, deviceId: 'd1', version: '0.1.5', get: again.get });
    expect(again.asked).toEqual([]);
  });

  it('a missing or refused file fails the whole thing, and leaves no index.html behind (the next try starts over)', async () => {
    const { caches, store } = memoryCaches();
    const refused = { ...FILES, ['/assets/index-C3.css']: { status: 413, type: 'text/plain', body: '慢速转发时单个响应不能超过 2 MB' } };
    await expect(ensureAppCache({ caches, scope: SCOPE, deviceId: 'd1', version: '0.1.5', get: pcFiles(refused).get })).rejects.toThrow(/413/);
    expect(store.get('cw-app-d1-0.1.5')?.has(`${SCOPE}app/index.html`) ?? false).toBe(false);
    await expect(ensureAppCache({ caches, scope: SCOPE, deviceId: 'd1', version: '0.1.5', get: pcFiles({ ['/index.html']: FILES['/index.html'] }).get })).rejects.toThrow(/cut off/);
  });

  it('an index.html with no entry files is not the app', async () => {
    const { caches } = memoryCaches();
    const pc = pcFiles({ ['/index.html']: { type: 'text/html', body: '<h3>web/dist not built</h3>' } });
    await expect(ensureAppCache({ caches, scope: SCOPE, deviceId: 'd1', version: '0.1.5', get: pc.get })).rejects.toThrow();
  });
});
