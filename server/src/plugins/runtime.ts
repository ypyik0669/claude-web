// Executable plugins: each one runs in its own Node child process (spec §4.3).
//  - permissions are declared in plugin.json (network hosts, file read paths, secret names) and approved by the user;
//  - the child gets a minimal environment (no API keys, no proxy credentials from ours, no PATH unless it may start
//    processes), Node's permission model where available (OS-level: file reads limited to its folder, its data
//    folder and declared paths; writes only to its data folder and declared `fileWrite` paths; no child processes /
//    workers unless the approved manifest grants `childProcess` / `workers`; no addons / WASI), no raw sockets
//    (net / http / tls / dns / child_process are refused at require), and a `host.fetch` that goes through this
//    process: host allow-list, netguard (internet only, every hop), the privacy hook, a timeout and a size cap;
//  - resource limits: a V8 heap cap (--max-old-space-size, manifest maxMemoryMb), below-normal CPU priority, a
//    timeout per call (the child is killed when it runs out) and stdout / stderr capped. Windows has no rlimits for
//    a plain child; a Job Object would need a native addon, so memory / CPU are bounded by these instead.
//  - without the permission model ('process' isolation) the child could read and write every file the user can: it
//    starts only after a per-plugin opt-in (unrestrictedAllowed), never when it asks for secrets; every spawn first
//    runs the service's preflight (code re-hashed: code changed after approval never starts).
// Extension points: `requestBefore` / `responseAfter` (gateway, see gatewayPluginHooks) and `sources` (data only).
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import { mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { ChildToHost, HostToChild, PluginHook, PluginManifest } from './protocol.js';
import { parseManifest } from './manifest.js';
import { hostAllowed as sandboxHostAllowed, PluginSandbox } from './sandbox.js';
import { DEFAULT_MEMORY_MB, MAX_MEMORY_MB, MIN_MEMORY_MB } from './manifest.js';
import { guardedFetch, type FetchFn } from '../net/netguard.js';
import os from 'node:os';

const DEFAULT_TIMEOUT = 10_000;
const MAX_TIMEOUT = 60_000;
const DEFAULT_OUTPUT = 64 * 1024;
const MAX_OUTPUT = 1024 * 1024;
const MAX_RESULT = 2 * 1024 * 1024;
const MAX_FETCH_BODY = 4 * 1024 * 1024;
const READY_TIMEOUT = 10_000;

/** The optional privacy boundary (server/src/privacy). Present → every plugin request body passes through it. */
export interface PluginPrivacyHook {
  /** Redact what leaves this machine; throw to refuse sending (the request then fails, it never goes bare). */
  outbound(body: string, ctx: { source: string; url: string }): Promise<string>;
  /** Restore placeholders in what came back. */
  inbound?(body: string, ctx: { source: string; url: string }): Promise<string>;
}
let privacyHook: PluginPrivacyHook | null = null;
/** Called by the privacy module when it starts (optional: plugins work without it, with nothing redacted). */
export function setPluginPrivacyHook(h: PluginPrivacyHook | null): void { privacyHook = h; }

/**
 * The child's bootstrap (CommonJS). It is never a file: it goes to `node -e` on every spawn, so no plugin can
 * rewrite what the next plugin starts with. No template literals inside.
 * Builtins that reach the network / other processes are refused on every path that loads one: CommonJS
 * `require` (Module._load), `process.getBuiltinModule`, ESM `import` / `import()` (module.registerHooks, or
 * module.register on Nodes without it — the child refuses to start when neither works), `process.binding`,
 * and the stdout / stderr pipes (net.Socket objects otherwise: their constructor would open a TCP socket).
 * net.Socket stays reachable without loading net (tty's streams extend it, process.stdin is one), so its connect and
 * net.Server's listen are replaced at the source before any plugin code runs (SEC-02): every way to a socket ends there.
 * `child_process` / `worker_threads` come back only when the approved manifest grants them (CW_PLUGIN_ALLOW).
 */
export const BOOTSTRAP = [
  "'use strict';",
  "const Module = require('module');",
  "const fs = require('fs');",
  "const { Writable } = require('stream');",
  "const entry = process.argv[1];",
  "const BLOCK = new Set(['net','tls','http','https','http2','dgram','dns','child_process','cluster','worker_threads','inspector','vm','v8','repl','trace_events','wasi','test']);",
  "for (const k of String(process.env.CW_PLUGIN_ALLOW || '').split(',')) if (k === 'child_process' || k === 'worker_threads') BLOCK.delete(k);",
  "function blocked(req) {",
  "  const s = String(req).replace(/^node:/, '');",
  "  return BLOCK.has(s.split('/')[0]) || /^_(http|tls)_/.test(s);",
  "}",
  "function refuse(req) { return new Error('a plugin may not load ' + String(req) + ' (use host.fetch)'); }",
  "function lock(obj, key, value) { Object.defineProperty(obj, key, { value: value, writable: false, configurable: false, enumerable: true }); }",
  // stdout / stderr: plain writables over the fds, before anything creates the net.Socket ones
  "function sink(fd) { return new Writable({ write: function (c, e, cb) { try { fs.writeSync(fd, c); } catch (x) {} cb(); } }); }",
  "lock(process, 'stdout', sink(1));",
  "lock(process, 'stderr', sink(2));",
  // the socket classes themselves: loaded here, before Module._load refuses net, so no side door reaches a working one
  "(function () {",
  "  const net = require('net');",
  "  const no = function () { throw new Error('a plugin may not open sockets (use host.fetch)'); };",
  "  lock(net.Socket.prototype, 'connect', no);",
  "  lock(net.Server.prototype, 'listen', no);",
  "  const dgram = require('dgram');",
  "  for (const k of ['bind', 'connect', 'send']) lock(dgram.Socket.prototype, k, no);",
  "})();",
  "const load = Module._load;",
  "lock(Module, '_load', function (req) {",
  "  if (blocked(req)) throw refuse(req);",
  "  return load.apply(this, arguments);",
  "});",
  "if (typeof process.getBuiltinModule === 'function') {",
  "  const gbm = process.getBuiltinModule;",
  "  lock(process, 'getBuiltinModule', function (id) { if (blocked(id)) throw refuse(id); return gbm.call(process, id); });",
  "}",
  "for (const k of ['binding', '_linkedBinding', 'dlopen', '_debugProcess']) {",
  "  if (k in process) lock(process, k, function () { throw new Error('a plugin may not use process.' + k); });",
  "}",
  "const kill = process.kill;",
  "lock(process, 'kill', function (pid, sig) { if (Number(pid) !== process.pid) throw new Error('a plugin may not signal other processes'); return kill.call(process, pid, sig); });",
  // ESM: import 'node:net' / await import('node:https') never pass Module._load
  "let esm = false;",
  "if (typeof Module.registerHooks === 'function') {",
  "  Module.registerHooks({",
  "    resolve: function (s, c, next) { if (blocked(s)) throw refuse(s); return next(s, c); },",
  "    load: function (u, c, next) { if (String(u).indexOf('node:') === 0 && blocked(u)) throw refuse(u); return next(u, c); },",
  "  });",
  "  esm = true;",
  "} else if (typeof Module.register === 'function') {",
  "  const src = \"const B=new Set(\" + JSON.stringify(Array.from(BLOCK)) + \");function b(r){const s=String(r).replace(/^node:/,'');return B.has(s.split('/')[0])||/^_(http|tls)_/.test(s);}\" +",
  "    \"export async function resolve(s,c,n){if(b(s))throw new Error('a plugin may not load '+s+' (use host.fetch)');return n(s,c);}\" +",
  "    \"export async function load(u,c,n){if(String(u).startsWith('node:')&&b(u))throw new Error('a plugin may not load '+u+' (use host.fetch)');return n(u,c);}\";",
  "  try { Module.register('data:text/javascript,' + encodeURIComponent(src)); esm = true; } catch (e) {}",
  "}",
  "if (!esm) { fs.writeSync(2, 'this Node cannot keep a plugin from importing network modules; update Node\\n'); process.exit(70); }",
  "for (const k of ['register', 'registerHooks']) {",
  "  if (k in Module) lock(Module, k, function () { throw new Error('a plugin may not register module hooks'); });",
  "}",
  "let seq = 0; const waiting = new Map();",
  "function ask(msg) { return new Promise(function (res, rej) { const id = ++seq; waiting.set(id, { res: res, rej: rej }); msg.id = id; process.send(msg); }); }",
  "const host = Object.freeze({",
  "  fetch: async function (url, init) {",
  "    init = init || {};",
  "    const r = await ask({ t: 'fetch', url: String(url), method: init.method, headers: init.headers, body: typeof init.body === 'string' ? init.body : undefined });",
  "    return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: r.headers || {}, text: async function () { return r.body || ''; }, json: async function () { return JSON.parse(r.body || 'null'); } };",
  "  },",
  "  secret: function (name) { return ask({ t: 'secret', name: String(name) }).then(function (r) { return r.value; }); },",
  "  log: function () { console.error.apply(console, arguments); },",
  "});",
  "globalThis.fetch = host.fetch;",
  "for (const k of ['WebSocket', 'EventSource', 'XMLHttpRequest']) { try { delete globalThis[k]; } catch (e) {} }",
  "const plugin = require(entry);",
  "const hooks = { 'request-before': plugin.requestBefore, 'response-after': plugin.responseAfter, 'source-provider': plugin.sources };",
  "process.on('message', async function (m) {",
  "  if (!m || typeof m !== 'object') return;",
  "  if (m.t === 'fetchResult' || m.t === 'secretResult') { const w = waiting.get(m.id); if (!w) return; waiting.delete(m.id); if (m.ok) w.res(m); else w.rej(new Error(m.error || 'denied')); return; }",
  "  if (m.t !== 'call') return;",
  "  const fn = hooks[m.hook];",
  "  try {",
  "    if (typeof fn !== 'function') throw new Error('hook not implemented: ' + m.hook);",
  "    const value = await fn(m.payload, host);",
  "    process.send({ t: 'result', id: m.id, ok: true, value: value === undefined ? null : value });",
  "  } catch (e) { process.send({ t: 'result', id: m.id, ok: false, error: String((e && e.message) || e) }); }",
  "});",
  "process.send({ t: 'ready', hooks: Object.keys(hooks).filter(function (k) { return typeof hooks[k] === 'function'; }) });",
].join('\n');

/** Which permission flag this Node has ('--permission' from 22.13 / 23.5, '--experimental-permission' before). */
export function permissionFlag(): string | null {
  const flags = process.allowedNodeEnvironmentFlags;
  if (flags.has('--permission')) return '--permission';
  if (flags.has('--experimental-permission')) return '--experimental-permission';
  return null;
}

/**
 * Whether this Node's permission model also covers the network (`--allow-net`, Node 25+). When it does, the
 * child runs with `--permission` and no `--allow-net`, so sockets are refused by Node itself as well.
 */
export function networkPermission(): boolean {
  return !!permissionFlag() && process.allowedNodeEnvironmentFlags.has('--allow-net');
}

/** `api.example.com` or `*.example.com` (one or more labels). Kept as an export; the policy lives in sandbox.ts. */
export function hostAllowed(host: string, allow: string[] = []): boolean {
  return sandboxHostAllowed(host, allow);
}

const clampTimeout = (m: PluginManifest) => Math.min(MAX_TIMEOUT, Math.max(1000, m.timeoutMs ?? DEFAULT_TIMEOUT));
const clampOutput = (m: PluginManifest) => Math.min(MAX_OUTPUT, Math.max(1024, m.maxOutputBytes ?? DEFAULT_OUTPUT));
const clampMemory = (m: PluginManifest) => Math.min(MAX_MEMORY_MB, Math.max(MIN_MEMORY_MB, m.maxMemoryMb ?? DEFAULT_MEMORY_MB));
/** host.fetch: internet only (no LAN / loopback / metadata), checked again at connect time */
let hostFetch: FetchFn = guardedFetch({ policy: 'public', protocols: ['https:'] });
/** tests swap the plugin host's outbound fetch */
export function setPluginHostFetch(f: FetchFn | null): void { hostFetch = f ?? guardedFetch({ policy: 'public', protocols: ['https:'] }); }

/**
 * The child's command line: the permission flags (when this Node has the model), the heap cap, the bootstrap
 * (inline, `-e`: there is no file a plugin could rewrite), the entry. Pure, for tests.
 * With --permission and no --allow-net / --allow-child-process / --allow-worker: Node refuses those itself (the
 * network only on Nodes that have --allow-net, see networkPermission).
 */
/**
 * `p` and, when it differs, `p` with symlinks resolved: Node's permission model compares resolved paths, so an
 * allow-path under a symlink (macOS `/var/folders` → `/private/var/folders`) alone never matches. A path that does not
 * exist yet (a data folder made on first write) is resolved through its nearest existing parent.
 */
export function withResolved(p: string): string[] {
  const glob = p.endsWith(`${path.sep}*`) || p.endsWith('/*');
  const base = glob ? p.slice(0, -2) : p;
  let head = base;
  const tail: string[] = [];
  const same = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  for (;;) {
    try {
      const realHead = realpathSync.native(head);
      if (same(realHead, path.resolve(head))) return [p];
      const real = path.join(realHead, ...tail);
      return [p, glob ? path.join(real, '*') : real];
    } catch {
      const up = path.dirname(head);
      if (up === head) return [p];
      tail.unshift(path.basename(head));
      head = up;
    }
  }
}

export function childArgs(o: { flag: string | null; read: string[]; write: string[]; manifest: PluginManifest; entry: string }): string[] {
  const args: string[] = [];
  if (o.flag) {
    const all = (l: string[]) => [...new Set(l.flatMap(withResolved))];
    args.push(o.flag, ...all(o.read).map((p) => `--allow-fs-read=${p}`), ...all(o.write).map((p) => `--allow-fs-write=${p}`));
    if (o.manifest.permissions.childProcess) args.push('--allow-child-process');
    if (o.manifest.permissions.workers) args.push('--allow-worker');
  }
  args.push(`--max-old-space-size=${clampMemory(o.manifest)}`);
  // the module loader resolves the entry component by component (lstat on each link): give it the resolved path so it
  // never has to touch a link outside the allow-list
  const entry = o.flag ? withResolved(o.entry).at(-1)! : o.entry;
  return [...args, '-e', BOOTSTRAP, '--', entry];
}

/** The child's environment: nothing of ours (keys, proxies, tokens, CLAUDE_* / ANTHROPIC_* …). Pure, for tests. */
export function childEnv(manifest: PluginManifest, dataDir: string | undefined, from: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = { NODE_ENV: 'production', CW_PLUGIN_ID: manifest.id };
  for (const k of ['SystemRoot', 'TEMP', 'TMP', 'LANG']) if (from[k]) env[k] = from[k]!;
  if (dataDir) env.CW_PLUGIN_DATA = dataDir;
  const allow = [manifest.permissions.childProcess ? 'child_process' : '', manifest.permissions.workers ? 'worker_threads' : ''].filter(Boolean);
  if (allow.length) env.CW_PLUGIN_ALLOW = allow.join(',');
  // a plugin that may start programs needs to find them (still no keys)
  if (manifest.permissions.childProcess) for (const k of ['PATH', 'Path', 'PATHEXT', 'ComSpec']) if (from[k]) env[k] = from[k]!;
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}

export interface RunnerOptions {
  /** an approved secret's value, or undefined (not declared / not approved / not set) */
  secret(name: string): Promise<string | undefined>;
  /** the plugin's own writable folder (created before the child starts; CW_PLUGIN_DATA in its env) */
  dataDir?: string;
  /**
   * Runs before every spawn and throws to refuse it (the service re-hashes the plugin's code here, so code
   * changed after approval never starts).
   */
  preflight?(): Promise<void>;
  /** 'process' isolation (no permission flag): the user opted in to this plugin having the whole filesystem */
  unrestrictedAllowed?(): boolean;
  /** tests: pretend this Node has / has no permission flag */
  isolation?: 'permission' | 'process';
}

/** One executable plugin's child process: started on first call, killed on timeout / stop. */
export class PluginRunner {
  private child: ChildProcess | null = null;
  private ready: Promise<string[]> | null = null;
  private calls = new Map<number, { resolve(v: unknown): void; reject(e: Error): void; timer: NodeJS.Timeout }>();
  private seq = 0;
  private output = '';
  private outputCut = false;
  readonly isolation: 'permission' | 'process';

  constructor(readonly dir: string, readonly manifest: PluginManifest, private opts: RunnerOptions) {
    this.isolation = opts.isolation ?? (permissionFlag() ? 'permission' : 'process');
  }

  get running(): boolean { return !!this.child && this.child.exitCode === null; }
  lastOutput(): string { return this.output + (this.outputCut ? '\n…' : ''); }

  private entry(): string {
    const f = path.resolve(this.dir, this.manifest.main);
    const rel = path.relative(this.dir, f);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('plugin main must be inside its folder');
    return f;
  }

  readPaths(): string[] {
    const list = [this.dir, path.join(this.dir, '*')];
    const own = path.resolve(this.dir);
    for (const abs of new PluginSandbox(this.manifest.permissions, { root: this.dir, ownDir: true }).readRoots) {
      if (abs === own) continue;
      list.push(abs, path.join(abs, '*'));
    }
    if (this.opts.dataDir) list.push(this.opts.dataDir, path.join(this.opts.dataDir, '*'));
    return list;
  }

  /** Its data folder and the declared `fileWrite` paths; nothing else (its own code folder stays read-only). */
  writePaths(): string[] {
    const list: string[] = [];
    if (this.opts.dataDir) list.push(this.opts.dataDir, path.join(this.opts.dataDir, '*'));
    for (const abs of new PluginSandbox(this.manifest.permissions, { root: this.dir, ownDir: true }).writeRoots) list.push(abs, path.join(abs, '*'));
    return list;
  }

  private gen = 0;

  private start(): Promise<string[]> {
    if (this.ready) return this.ready;
    const gen = ++this.gen;
    const ready = (async () => {
      // no permission model = the child could read and write every file the user can: only with a per-plugin opt-in
      if (this.isolation === 'process') {
        if ((this.manifest.permissions.secrets ?? []).length) throw new Error('a plugin that asks for secrets needs Node\'s permission model to run');
        if (!this.opts.unrestrictedAllowed?.()) throw new Error('plugin needs unrestricted file access, which was not allowed');
      }
      await this.opts.preflight?.();
      if (gen !== this.gen) throw new Error('plugin stopped');
      return this.spawnChild();
    })();
    this.ready = ready;
    ready.catch(() => { if (this.ready === ready) this.ready = null; });
    return ready;
  }

  private spawnChild(): Promise<string[]> {
    const entry = this.entry();
    if (this.opts.dataDir) { try { mkdirSync(this.opts.dataDir, { recursive: true }); } catch { /* the child reports it */ } }
    const flag = this.isolation === 'permission' ? permissionFlag() : null;
    const args = childArgs({ flag, read: this.readPaths(), write: this.writePaths(), manifest: this.manifest, entry });
    const child = spawn(process.execPath, args, {
      cwd: this.dir,
      env: childEnv(this.manifest, this.opts.dataDir),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
      serialization: 'json',
    });
    this.child = child;
    this.output = '';
    this.outputCut = false;
    const cap = clampOutput(this.manifest);
    const take = (b: Buffer) => {
      if (this.output.length >= cap) { this.outputCut = true; return; }
      this.output += b.toString('utf8').slice(0, cap - this.output.length);
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    const ready = new Promise<string[]>((resolve, reject) => {
      const t = setTimeout(() => { reject(new Error('plugin did not start in time')); this.stop(); }, READY_TIMEOUT);
      child.on('message', (m: ChildToHost) => {
        if (m?.t === 'ready') {
          clearTimeout(t);
          // once started, below-normal CPU priority: a busy plugin does not starve the server (Windows too); the
          // start itself runs at normal priority so a loaded machine does not push it past READY_TIMEOUT
          if (child.pid) { try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not allowed here */ } }
          resolve(Array.isArray(m.hooks) ? m.hooks : []);
          return;
        }
        void this.onMessage(m);
      });
      child.on('exit', (code) => {
        clearTimeout(t);
        reject(new Error(`plugin exited (${code ?? 'killed'})`));
        for (const [, c] of this.calls) { clearTimeout(c.timer); c.reject(new Error(`plugin exited (${code ?? 'killed'})`)); }
        this.calls.clear();
        if (this.child === child) { this.child = null; this.ready = null; }
      });
      child.on('error', (e) => { clearTimeout(t); reject(e); });
    });
    ready.catch(() => {});
    return ready;
  }

  private send(m: HostToChild) { try { this.child?.send(m); } catch { /* exited */ } }

  private async onMessage(m: ChildToHost) {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'result') {
      const c = this.calls.get(m.id);
      if (!c) return;
      this.calls.delete(m.id);
      clearTimeout(c.timer);
      if (!m.ok) return c.reject(new Error(String(m.error ?? 'plugin error').slice(0, 500)));
      const size = JSON.stringify(m.value ?? null).length;
      if (size > MAX_RESULT) return c.reject(new Error('plugin result too large'));
      return c.resolve(m.value);
    }
    if (m.t === 'secret') {
      const declared = (this.manifest.permissions.secrets ?? []).includes(m.name);
      const value = declared ? await this.opts.secret(m.name).catch(() => undefined) : undefined;
      this.send(value === undefined
        ? { t: 'secretResult', id: m.id, ok: false, error: declared ? 'secret not approved or not set' : 'secret not declared' }
        : { t: 'secretResult', id: m.id, ok: true, value });
      return;
    }
    if (m.t === 'fetch') {
      try {
        this.send({ t: 'fetchResult', id: m.id, ok: true, ...(await this.fetch(m)) });
      } catch (e) {
        this.send({ t: 'fetchResult', id: m.id, ok: false, error: (e as Error).message });
      }
    }
  }

  private async fetch(m: Extract<ChildToHost, { t: 'fetch' }>): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    let u: URL;
    try { u = new URL(m.url); } catch { throw new Error('bad url'); }
    if (u.protocol !== 'https:') throw new Error('only https');
    const allowed = new PluginSandbox(this.manifest.permissions, { root: this.dir, ownDir: true }).check(u.hostname);
    if (!allowed.ok) throw new Error(allowed.message);
    const source = `plugin:${this.manifest.id}`;
    let body = typeof m.body === 'string' ? m.body : undefined;
    if (body !== undefined && body.length > MAX_FETCH_BODY) throw new Error('request body too large');
    if (body !== undefined && privacyHook) body = await privacyHook.outbound(body, { source, url: u.origin });
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(m.headers ?? {})) if (typeof v === 'string' && !/^(host|cookie|proxy-)/i.test(k)) headers[k] = v;
    const r = await hostFetch(u, { method: m.method ?? 'GET', headers, body, redirect: 'manual', signal: AbortSignal.timeout(clampTimeout(this.manifest)) });
    let text = await r.text();
    if (text.length > MAX_FETCH_BODY) text = text.slice(0, MAX_FETCH_BODY);
    if (privacyHook?.inbound) text = await privacyHook.inbound(text, { source, url: u.origin });
    const outHeaders: Record<string, string> = {};
    r.headers.forEach((v, k) => { if (!/^set-cookie$/i.test(k)) outHeaders[k] = v; });
    return { status: r.status, headers: outHeaders, body: text };
  }

  /** One hook call; the child is killed when it runs past the manifest's timeout. */
  async call<T = unknown>(hook: PluginHook, payload: unknown): Promise<T> {
    if (!this.manifest.hooks.includes(hook)) throw new Error(`plugin does not declare ${hook}`);
    const hooks = await this.start();
    if (!hooks.includes(hook)) throw new Error(`plugin does not implement ${hook}`);
    const id = ++this.seq;
    const ms = clampTimeout(this.manifest);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(new Error(`plugin timed out after ${ms} ms`));
        this.stop();
      }, ms);
      this.calls.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.send({ t: 'call', id, hook, payload });
    });
  }

  stop(): void {
    const c = this.child;
    this.gen++;
    this.child = null;
    this.ready = null;
    if (c && c.exitCode === null) { try { c.kill(); } catch { /* gone */ } }
  }
}

/** Read and validate `<dir>/plugin.json` (the checks live in manifest.ts). */
export async function readManifest(dir: string): Promise<PluginManifest> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(path.join(dir, 'plugin.json'), 'utf8'));
  } catch (e) {
    throw new Error(`plugin.json: ${(e as Error).message}`);
  }
  try {
    return parseManifest(raw);
  } catch (e) {
    throw new Error(`plugin.json: ${(e as Error).message}`);
  }
}
