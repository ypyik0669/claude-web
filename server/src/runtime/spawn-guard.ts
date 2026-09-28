import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

/**
 * Spawn guard: every child process defaults to `windowsHide: true`, and `CW_SPAWN_LOG=1` records each one.
 *
 * Why: the desktop build runs the server in an Electron utility process and JS agents (ccb, Codex's
 * wrapper, …) under Electron-as-node. Electron is a GUI-subsystem binary, so none of those processes owns
 * a console — and on Windows every console program they start WITHOUT `windowsHide` (git, reg, cmd,
 * powershell, where…) gets a brand-new, visible console window. Our own call sites pass the flag
 * explicitly; this is the backstop for everything else (third-party code, and the agents' own spawns).
 *
 * The implementation is one CommonJS source string so the same code runs in two places:
 *  - in the server itself (`installSpawnGuard()`, evaluated in-process, the first import of index.ts), and
 *  - in Electron-as-node children, as a `--require` preload written to `<dataDir>/runtime/` (a file on disk:
 *    works the same under tsx, the tsc build and a packaged asar, where src/ does not exist).
 * Passing `windowsHide: false` explicitly still shows the window.
 */
export const GUARD_SOURCE = String.raw`'use strict';
var cp = require('child_process');
var util = require('util');
var fs = require('fs');
var KEY = Symbol.for('claude-web.spawn-guard');
var FNS = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork'];
var SECRET_FLAGS = { '-w': 1, '--password': 1, '--token': 1, '--api-key': 1, '--apikey': 1, '--key': 1, '--secret': 1 };

function logEnabled() { var v = process.env.CW_SPAWN_LOG; return !!v && v !== '0' && v !== 'false'; }

/** Where the options object sits: exec(cmd, opts, cb) · spawn/execFile/fork(file, [args], opts, cb). */
function optionsIndex(fn, a) {
  if (fn === 'exec' || fn === 'execSync') return 1;
  return Array.isArray(a[1]) || (a[1] == null && a.length > 2) ? 2 : 1;
}

/** Same call with windowsHide defaulted to true (an explicit value, true or false, is kept). */
function withHide(fn, argv) {
  var a = Array.prototype.slice.call(argv);
  var i = optionsIndex(fn, a);
  var o = a[i];
  if (typeof o === 'function') a.splice(i, 0, { windowsHide: true });
  else if (o == null) a[i] = { windowsHide: true };
  else if (typeof o === 'object' && o.windowsHide === undefined) a[i] = Object.assign({}, o, { windowsHide: true });
  return a;
}

function shortFile(f) {
  var s = String(f).replace(/^file:\/\/\/?/, '').replace(/\\/g, '/');
  var parts = s.split('/');
  return parts.slice(-2).join('/');
}

/** The first few frames that are not this guard or Node internals: "who spawned this". */
function callers() {
  var lines = String(new Error().stack || '').split('\n').slice(1);
  var out = [];
  for (var k = 0; k < lines.length && out.length < 4; k++) {
    var l = lines[k].trim();
    if (l.indexOf('spawn-guard') >= 0 || l.indexOf('node:') >= 0 || l.indexOf('(internal/') >= 0) continue;
    var m = /^at (?:async )?(?:(.*?) \()?(.*?):(\d+):\d+\)?$/.exec(l);
    if (!m) continue;
    out.push((m[1] ? m[1].replace(/^(Object|Module)\./, '') + ' ' : '') + shortFile(m[2]) + ':' + m[3]);
  }
  return out;
}

function redactArgs(args) {
  var out = [];
  for (var k = 0; k < args.length && k < 8; k++) {
    var s = String(args[k]);
    if (k > 0 && SECRET_FLAGS[String(args[k - 1])]) s = '***';
    else if (/^(sk-|ghp_|gho_|github_pat_|xox[abp]-|AIza)/.test(s) || /(token|secret|password|api[_-]?key)=/i.test(s)) s = '***';
    else if (s.length > 80) s = '<' + s.length + ' chars>';
    out.push(s);
  }
  if (args.length > 8) out.push('…+' + (args.length - 8));
  return out;
}

var state = { role: 'node', stderr: false, recent: [], timer: null };

function note(fn, a) {
  try {
    var i = optionsIndex(fn, a);
    var o = a[i] && typeof a[i] === 'object' ? a[i] : {};
    var isExec = fn === 'exec' || fn === 'execSync';
    // exec takes one shell string: log its program and the rest redacted like argv
    var words = isExec ? String(a[0]).trim().split(/\s+/) : [];
    var cmd = isExec ? words[0] : String(a[0]);
    var args = isExec ? words.slice(1) : Array.isArray(a[1]) ? a[1] : [];
    var st = callers();
    var rec = { t: Date.now(), pid: process.pid, role: state.role, fn: fn, cmd: cmd, args: redactArgs(args), hide: o.windowsHide, shell: !!o.shell || isExec, detached: !!o.detached, from: st[0] || '?', stack: st };
    var file = process.env.CW_SPAWN_LOG_FILE;
    if (file) fs.appendFileSync(file, JSON.stringify(rec) + '\n');
    if (state.stderr) process.stderr.write('[spawn] ' + rec.role + ' ' + fn + ' ' + rec.cmd + ' ' + rec.args.join(' ') + '  <- ' + rec.from + '\n');
    state.recent.push(rec.from + '  ' + rec.cmd.split(/[\\/]/).pop());
  } catch (e) { /* logging must never break a spawn */ }
}

function summarize() {
  var r = state.recent; state.recent = [];
  if (!r.length) return;
  var by = {};
  r.forEach(function (k) { by[k] = (by[k] || 0) + 1; });
  var top = Object.keys(by).sort(function (x, y) { return by[y] - by[x]; }).slice(0, 8).map(function (k) { return by[k] + 'x ' + k; });
  process.stderr.write('[spawn] last 60s: ' + r.length + ' spawn(s) in ' + state.role + ' - ' + top.join(' | ') + '\n');
}

/** Wrap the spawning functions of a child_process-shaped object (the real module, or a test double). */
function patch(target) {
  if (!target || target[KEY]) return false;
  FNS.forEach(function (fn) {
    var orig = target[fn];
    if (typeof orig !== 'function') return;
    var wrapped = function () {
      var a = withHide(fn, arguments);
      if (logEnabled()) note(fn, a);
      return orig.apply(this, a);
    };
    // util.promisify(execFile / exec) must keep resolving to { stdout, stderr } (with .child on the promise)
    var custom = orig[util.promisify.custom];
    if (typeof custom === 'function') {
      Object.defineProperty(wrapped, util.promisify.custom, {
        configurable: true,
        value: function () {
          var a = withHide(fn, arguments);
          if (logEnabled()) note(fn, a);
          return custom.apply(this, a);
        },
      });
    }
    Object.defineProperty(wrapped, 'name', { value: orig.name, configurable: true });
    Object.defineProperty(wrapped, '__cwOriginal', { value: orig });
    target[fn] = wrapped;
  });
  Object.defineProperty(target, KEY, { value: true });
  return true;
}

/** Patch the real child_process (CJS exports + the ESM named-export bindings). Idempotent per process. */
function install(opts) {
  opts = opts || {};
  if (opts.role) state.role = opts.role;
  state.stderr = !!opts.stderr;
  var fresh = patch(cp);
  try { require('module').syncBuiltinESMExports(); } catch (e) { /* very old node */ }
  if (opts.summary && logEnabled() && !state.timer) {
    state.timer = setInterval(summarize, 60000);
    if (state.timer.unref) state.timer.unref();
  }
  return fresh;
}

module.exports = { install: install, patch: patch, withHide: withHide, optionsIndex: optionsIndex, redactArgs: redactArgs, logEnabled: logEnabled };
`;

export interface GuardApi {
  install(opts?: { role?: string; stderr?: boolean; summary?: boolean }): boolean;
  patch(target: Record<string, unknown>): boolean;
  withHide(fn: string, args: unknown[]): unknown[];
  optionsIndex(fn: string, args: unknown[]): number;
  redactArgs(args: unknown[]): string[];
  logEnabled(): boolean;
}

let api: GuardApi | null = null;
/** The guard evaluated in this process (a module of its own, like the preload file children get). */
export function guardApi(): GuardApi {
  if (api) return api;
  const m = { exports: {} as GuardApi };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', `${GUARD_SOURCE}\n//# sourceURL=claude-web-spawn-guard.cjs`)(m, m.exports, createRequire(import.meta.url));
  return (api = m.exports);
}

/** Same resolution as files/service `dataDir()` — duplicated because this module must import nothing of ours. */
function dataDir(): string {
  return process.env.CLAUDE_WEB_DIR ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.claude-web');
}

export function spawnLogEnabled(): boolean {
  const v = process.env.CW_SPAWN_LOG;
  return !!v && v !== '0' && v !== 'false';
}

/**
 * Install in this process. With `CW_SPAWN_LOG=1` every spawn is also printed to stderr (+ a per-minute
 * summary) and appended as JSON lines to `CW_SPAWN_LOG_FILE` (default `<dataDir>/spawn-log.jsonl`; the
 * variable is exported so guarded children append to the same file).
 */
export function installSpawnGuard(opts: { role?: string } = {}): boolean {
  if (spawnLogEnabled() && !process.env.CW_SPAWN_LOG_FILE) {
    try {
      fs.mkdirSync(dataDir(), { recursive: true });
      process.env.CW_SPAWN_LOG_FILE = path.join(dataDir(), 'spawn-log.jsonl');
    } catch { /* stderr only */ }
  }
  return guardApi().install({ role: opts.role ?? 'server', stderr: true, summary: true });
}

const PRELOAD = Buffer.from(`${GUARD_SOURCE}\nmodule.exports.install({ role: require('path').basename(process.argv[1] || 'node') });\n`);
const PRELOAD_HASH = createHash('sha256').update(PRELOAD).digest('hex');
const PRELOAD_NAME = `spawn-guard-${PRELOAD_HASH.slice(0, 10)}.cjs`;

/** Is `file` exactly the preload (size first, then the full hash)? */
function isPreload(file: string): boolean {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size !== PRELOAD.length) return false;
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex') === PRELOAD_HASH;
  } catch {
    return false;
  }
}

/**
 * The guard as a `--require`-able file, content-addressed. Reused only when its bytes are the guard's (a
 * truncated or altered file is rewritten); written to a .tmp and renamed into place. Null when it cannot be
 * put in place — the child then runs unguarded rather than failing to start — and no .tmp is left behind.
 */
export function preloadFile(dir = path.join(dataDir(), 'runtime')): string | null {
  const file = path.join(dir, PRELOAD_NAME);
  if (isPreload(file)) return file;
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, PRELOAD);
    fs.renameSync(tmp, file);
    return file;
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    return isPreload(file) ? file : null; // another process may have put the same bytes there first
  }
}

/**
 * Node CLI args that put the guard into a JS child we start (ccb, npm-shimmed agents). Needed where the
 * "node" is Electron-as-node on Windows (no console of its own → its console children pop windows);
 * a real node.exe gets a hidden console from `windowsHide` that its own children inherit. Also added
 * whenever spawn logging is on, so the children's spawns land in the same log.
 */
export function guardNodeArgs(host: { platform: NodeJS.Platform; electron: boolean } = { platform: process.platform, electron: !!process.versions.electron }): string[] {
  const needed = (host.platform === 'win32' && host.electron) || spawnLogEnabled();
  if (!needed) return [];
  // <dataDir>/runtime, else the OS temp dir (a read-only / redirected profile); else unguarded, said once
  const f = preloadFile() ?? preloadFile(path.join(os.tmpdir(), 'claude-web-runtime'));
  if (f) return ['--require', f];
  if (!preloadWarned) {
    preloadWarned = true;
    console.warn(`[spawn guard] could not write the preload to ${path.join(dataDir(), 'runtime')} or ${path.join(os.tmpdir(), 'claude-web-runtime')}: agents started from here run without it (their console programs may flash windows on Windows)`);
  }
  return [];
}
let preloadWarned = false;
/** Tests: allow the "preload unavailable" warning again. */
export function resetPreloadWarning() { preloadWarned = false; }
