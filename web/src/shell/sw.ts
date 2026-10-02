// The shell's service worker (scope: the shell's folder). Three kinds of request (route.ts):
//  - the shell's own files: from its precache (taken at install), else the network — the shell only changes with a
//    new sw.js (a deploy changes its file list), so a flaky GitHub Pages matters only on the first visit;
//  - app/…: the app frame's files, from the cache of the PC version the frame runs (its address names it); a miss,
//  - and app/api/…, go to the shell window that owns the frame (also on its address), which makes the request over
//    its link to the PC and answers (forward.ts has the messages). No window answering within 60 s: 503.
// Built on its own as one classic script (vite.shell.config.ts), so it imports nothing it shares at run time.
import { MSG_FETCH, MSG_VERSION, readShellReply, replyNoWindow, responseParts, type ShellReply } from './forward';
import { appKey, frameParams, route } from './route';

declare const __SHELL_FILES__: string[];
declare const __SHELL_BUILD__: string;

/** The service-worker globals used here (the web tsconfig has the DOM lib, not WebWorker). */
interface SwClient {
  readonly id: string;
  readonly url: string;
  readonly frameType?: string;
  postMessage(m: unknown, transfer: Transferable[]): void;
}
interface ExtendableEventLike extends Event {
  waitUntil(p: Promise<unknown>): void;
}
interface FetchEventLike extends ExtendableEventLike {
  readonly request: Request;
  readonly clientId: string;
  respondWith(r: Promise<Response>): void;
}
interface SwScope {
  readonly registration: { readonly scope: string };
  readonly clients: {
    get(id: string): Promise<SwClient | undefined>;
    matchAll(o: { type: 'window'; includeUncontrolled: boolean }): Promise<SwClient[]>;
  };
  skipWaiting(): Promise<void>;
  addEventListener(type: 'install' | 'activate', fn: (e: ExtendableEventLike) => void): void;
  addEventListener(type: 'fetch', fn: (e: FetchEventLike) => void): void;
}

const sw = self as unknown as SwScope;
const SHELL_CACHE = `cw-shell-${__SHELL_BUILD__}`;
const ASK_MS = 60_000;
const NONE = { owner: null, cache: null };

sw.addEventListener('install', (e) => {
  e.waitUntil(precache().then(() => sw.skipWaiting()));
});

sw.addEventListener('activate', (e) => {
  e.waitUntil(dropOldShells());
});

sw.addEventListener('fetch', (e) => {
  const r = route(new URL(e.request.url), sw.registration.scope);
  if (r.kind === 'pass') return;
  if (r.kind === 'shell') {
    if (e.request.method === 'GET') e.respondWith(shellFile(e.request));
    return;
  }
  e.respondWith(appRequest(e, r.kind, r.path));
});

async function precache(): Promise<void> {
  const c = await caches.open(SHELL_CACHE);
  // one by one, best effort: a first visit on a flaky network still installs (what is missing comes from the network)
  await Promise.allSettled(['./', ...__SHELL_FILES__].map((f) => c.add(new Request(new URL(f, sw.registration.scope).href, { cache: 'reload' }))));
}

async function dropOldShells(): Promise<void> {
  for (const k of await caches.keys()) if (k.startsWith('cw-shell-') && k !== SHELL_CACHE) await caches.delete(k);
}

async function shellFile(req: Request): Promise<Response> {
  const scope = sw.registration.scope;
  const path = new URL(req.url).pathname;
  // the shell is one page: its folder and index.html are the same file
  const page = req.mode === 'navigate' && (path === new URL(scope).pathname || path === new URL('index.html', scope).pathname);
  const hit = await caches.match(page ? scope : req, { cacheName: SHELL_CACHE, ignoreSearch: page });
  return hit ?? fetch(req);
}

async function marksOf(e: FetchEventLike): Promise<{ owner: string | null; cache: string | null }> {
  if (e.request.mode === 'navigate') return frameParams(e.request.url);
  if (!e.clientId) return NONE;
  const c = await sw.clients.get(e.clientId).catch(() => undefined);
  return c ? frameParams(c.url) : NONE;
}

async function appRequest(e: FetchEventLike, kind: 'asset' | 'api', path: string): Promise<Response> {
  const req = e.request;
  const { owner, cache } = await marksOf(e);
  const read = req.method === 'GET' || req.method === 'HEAD';
  if (kind === 'asset' && cache && read) {
    const hit = await caches.match(appKey(sw.registration.scope, path), { cacheName: cache });
    if (hit) return hit;
  }
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => (headers[k] = v));
  const body = read ? null : await req.arrayBuffer();
  const reply = await ask({ cw: MSG_FETCH, v: MSG_VERSION, owner, cache, kind, method: req.method, path, headers, body });
  const p = responseParts(reply);
  try {
    return new Response(p.body, p.init);
  } catch {
    // a header value the browser will not take (node's http is more lenient): the answer without its headers
    return new Response(p.body, { status: p.init.status });
  }
}

/** Every shell window is asked (each says skip unless the frame is its own); the first real answer wins. */
async function ask(msg: object): Promise<ShellReply> {
  const scope = sw.registration.scope;
  const all = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true }).catch(() => [] as SwClient[]);
  const wins = all.filter((c) => c.frameType !== 'nested' && c.frameType !== 'none' && route(new URL(c.url), scope).kind === 'shell');
  if (wins.length === 0) return replyNoWindow();
  return new Promise((resolve) => {
    let left = wins.length;
    let done = false;
    const ports: MessagePort[] = [];
    const finish = (r: ShellReply) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const p of ports) p.close();
      resolve(r);
    };
    const passed = () => {
      if (--left === 0) finish(replyNoWindow());
    };
    const timer = setTimeout(() => finish(replyNoWindow()), ASK_MS);
    for (const w of wins) {
      const ch = new MessageChannel();
      ports.push(ch.port1);
      ch.port1.onmessage = (ev) => {
        const r = readShellReply(ev.data);
        if (r && r !== 'skip') finish(r);
        else passed();
      };
      try {
        w.postMessage(msg, [ch.port2]);
      } catch {
        passed();
      }
    }
  });
}
