// Where the CPU / disk / GPU time goes while a conversation runs a task (2026-11-17 user report: "as soon as a
// conversation starts running a task, claude-web AND the whole computer become very laggy").
//
//   node scripts/perf-busy.cjs [--out <dir>] [--seconds 60] [--dpr 2] [--show] [--dist <built web dir>]
//        [--history 600] [--convs 300] [--rate 150] [--panel explorer|files|none] [--after 20] [--no-typing]
//        [--runtime ccb|claude] [--keep]
//
// Needs `npm run build:all` first (the server runs from server/dist). The web app is built again with source maps into
// <out>/web-dist (or --dist <dir> reuses one built with `vite build web --outDir <dir> --sourcemap`), so profiles map
// back to web/src file:line. Nothing talks to a real model: a throwaway HOME (scripts/lib/demo.cjs) with ~300 finished
// conversations in four projects, one long conversation (~600 transcript rows) that is opened in the window, and a fake
// Anthropic upstream that drives an agent loop (thinking + text streamed as ~150 small deltas/s, then a Bash / Read /
// Grep / Write / Edit tool call on the demo repo, then the next request) while the window measures.
//
// Three windows of the same length: IDLE (the long conversation open, nothing running), RUNNING (the loop going),
// AFTER (the turn ended; shorter, --after). Each one records:
//   - CPU / memory / I/O per process (server node, engine, its children, Electron main / renderer / GPU / utility,
//     everything else on the machine by name) — Windows: a small C# sampler via PowerShell; elsewhere `ps`
//   - the renderer's CPU profile (CDP Profiler, symbolized through the source maps), Performance.getMetrics, React
//     commits and which components rendered (a devtools hook), store updates and `version` bumps of the running
//     conversation, long tasks / long animation frames, WebSocket messages in / out by kind, input latency of a
//     keystroke typed into the composer every 600 ms
//   - the server's CPU profile (inspector), event-loop delay, fs calls by path / caller, fs.watch events, timers,
//     WebSocket sends by kind (a --require preload: this same file), spawned processes (CW_SPAWN_LOG)
// Output: <out>/summary.json, <out>/report.txt, <out>/{renderer,server}-<window>.cpuprofile (open them in Chrome
// DevTools › Performance), <out>/running.png. Default <out>: %TEMP%/cw-perf-busy/<time>.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const arg = (name, def) => { const i = process.argv.indexOf(name); if (i < 0) return def; const v = process.argv[i + 1]; return v === undefined || v.startsWith('--') ? true : v; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, fallback) => Promise.race([p.catch(() => fallback), new Promise((r) => setTimeout(() => r(fallback), ms))]);
const add = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };

// ============================================================================================ the server's preload
// Loaded with `node --require scripts/perf-busy.cjs server/dist/index.js` (CW_PERF_PRELOAD=1): counts fs calls,
// fs.watch events, timers and WebSocket sends from the very start (watchers are made at startup), and keeps an
// event-loop-delay histogram. The runner reads and resets it through the inspector: globalThis.__cwPerf.take().
function serverPreload() {
  const nodeFs = require('node:fs');
  const timers = require('node:timers');
  const { monitorEventLoopDelay } = require('node:perf_hooks');
  const slash = (s) => String(s).replace(/\\/g, '/');
  const home = slash(process.env.HOME || process.env.USERPROFILE || '');
  const work = slash(process.env.CW_PERF_WORK || '');
  const root = slash(ROOT);
  const P = { counts: {}, paths: {}, callers: {}, ws: {}, wsBytes: {}, timers: {}, fires: {}, watchEv: {}, intervals: {}, watchReg: {} };
  P.h = monitorEventLoopDelay({ resolution: 10 });
  P.h.enable();
  let cpu0 = process.cpuUsage();
  let t0 = Date.now();
  const ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  const cat = (p) => {
    let s = slash(p && typeof p === 'object' && p.href ? decodeURIComponent(p.pathname) : p);
    if (work && s.toLowerCase().startsWith(work.toLowerCase())) s = '<work>' + s.slice(work.length);
    else if (home && s.toLowerCase().startsWith(home.toLowerCase())) s = '~' + s.slice(home.length);
    else if (root && s.toLowerCase().startsWith(root.toLowerCase())) s = '<repo>' + s.slice(root.length);
    s = s.replace(ID, '<id>').replace(/^~\/\.claude\/projects\/[^/]+/, '~/.claude/projects/<proj>').replace(/\/\d{10,}/g, '/<n>');
    return s.length > 110 ? s.slice(0, 107) + '…' : s;
  };
  const SKIP = /perf-busy\.cjs|node:internal|\(native\)|^\s*at (new )?Promise|^\s*at Array\.|^\s*at async Promise/;
  const rootRe = new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/', 'gi');
  const caller = () => {
    const keep = Error.stackTraceLimit;
    Error.stackTraceLimit = 14;
    const lines = String(new Error().stack).split('\n').slice(2);
    Error.stackTraceLimit = keep;
    const out = [];
    for (const l of lines) {
      if (SKIP.test(l)) continue;
      out.push(slash(l.trim().replace(/^at /, '')).replace(/file:\/\/\/?/g, '').replace(rootRe, '').replace(/:(\d+):\d+(\)?)$/, ':$1$2'));
      if (out.length >= 3) break;
    }
    return out.join(' < ') || '?';
  };
  // everything hanging off the original (fs.realpath.native, util.promisify.custom, …) stays reachable
  const copyProps = (from, to) => { for (const k of Reflect.ownKeys(from)) { if (['length', 'name', 'prototype', 'arguments', 'caller'].includes(k)) continue; try { to[k] = from[k]; } catch { /* read-only */ } } Object.defineProperty(to, 'name', { value: from.name }); };
  const where = (p) => (typeof p === 'string' || (p && typeof p === 'object' && p.href) ? cat(p) : Buffer.isBuffer(p) ? cat(p.toString()) : typeof p === 'number' ? '<fd>' : p && p.constructor && p.constructor.name === 'FileHandle' ? '<handle>' : '?');
  const wrap = (obj, name, label, every) => {
    const orig = obj && obj[name];
    if (typeof orig !== 'function' || orig.__cwPerf) return;
    let n = 0;
    const w = function (...a) {
      add(P.counts, label);
      if (!every || ++n % every === 0) {
        const k = every || 1;
        add(P.paths, label + '  ' + where(a[0]), k);
        add(P.callers, label + '  ' + caller(), k);
      }
      return orig.apply(this, a);
    };
    copyProps(orig, w);
    w.__cwPerf = true;
    obj[name] = w;
  };
  for (const n of ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'rename', 'renameSync', 'copyFile', 'copyFileSync', 'unlink', 'unlinkSync', 'rm', 'rmSync', 'mkdir', 'mkdirSync', 'write', 'writeSync', 'createWriteStream', 'utimes', 'utimesSync', 'truncate', 'ftruncate']) wrap(nodeFs, n, 'fs.' + n);
  for (const n of ['writeFile', 'appendFile', 'rename', 'copyFile', 'unlink', 'rm', 'mkdir', 'utimes', 'truncate']) wrap(nodeFs.promises, n, 'fsp.' + n);
  for (const n of ['readFile', 'readFileSync', 'createReadStream', 'readdir', 'readdirSync', 'open', 'openSync', 'opendir', 'opendirSync']) wrap(nodeFs, n, 'fs.' + n, 1);
  for (const n of ['read', 'readSync']) wrap(nodeFs, n, 'fs.' + n, 4);
  for (const n of ['stat', 'statSync', 'lstat', 'lstatSync', 'fstat', 'fstatSync', 'existsSync', 'exists', 'access', 'accessSync', 'realpath', 'realpathSync']) wrap(nodeFs, n, 'fs.' + n, 8);
  for (const n of ['readFile', 'readdir', 'open', 'opendir']) wrap(nodeFs.promises, n, 'fsp.' + n, 1);
  for (const n of ['stat', 'lstat', 'access', 'realpath']) wrap(nodeFs.promises, n, 'fsp.' + n, 8);
  // fs.watch: registrations (kept for the whole run) and events per watched path (per window)
  const ow = nodeFs.watch;
  nodeFs.watch = function (p, ...rest) {
    const w = ow.call(this, p, ...rest);
    const k = cat(p);
    add(P.watchReg, 'fs.watch  ' + k + '  < ' + caller());
    const em = w.emit;
    w.emit = function (ev, ...r) {
      if (ev === 'change') { add(P.counts, 'fs.watch event'); add(P.watchEv, k + '  ' + (r[0] || '') + ' ' + (r[1] ? cat(String(r[1])) : '')); }
      return em.call(this, ev, ...r);
    };
    return w;
  };
  copyProps(ow, nodeFs.watch);
  const owf = nodeFs.watchFile;
  nodeFs.watchFile = function (p, ...rest) {
    const opt = rest.find((x) => x && typeof x === 'object');
    add(P.watchReg, 'fs.watchFile (polling ' + (opt && opt.interval ? opt.interval : 5007) + 'ms)  ' + cat(p) + '  < ' + caller());
    add(P.counts, 'fs.watchFile');
    return owf.call(this, p, ...rest);
  };
  copyProps(owf, nodeFs.watchFile);
  // timers: setInterval registrations (kept) and firings (per window); setTimeout calls by caller (sampled)
  const oST = globalThis.setTimeout;
  let nst = 0;
  const st = function (fn, ms, ...a) {
    add(P.counts, 'setTimeout');
    if (++nst % 8 === 0) add(P.timers, 'setTimeout ' + (ms | 0) + 'ms  ' + caller(), 8);
    return oST.call(this, fn, ms, ...a);
  };
  copyProps(oST, st);
  const oSI = globalThis.setInterval;
  const si = function (fn, ms, ...a) {
    add(P.counts, 'setInterval');
    const k = 'setInterval ' + (ms | 0) + 'ms  ' + caller();
    add(P.intervals, k);
    const f = typeof fn === 'function' ? function (...x) { add(P.fires, k); return fn.apply(this, x); } : fn;
    return oSI.call(this, f, ms, ...a);
  };
  copyProps(oSI, si);
  globalThis.setTimeout = timers.setTimeout = st;
  globalThis.setInterval = timers.setInterval = si;
  // WebSocket sends (the hub's `ws`), by event kind / SDK message type
  try {
    const WS = require(require.resolve('ws', { paths: [path.join(ROOT, 'server')] }));
    const o = WS.prototype.send;
    WS.prototype.send = function (data, ...r) {
      const s = typeof data === 'string' ? data.slice(0, 400) : Buffer.isBuffer(data) ? data.toString('utf8', 0, 400) : '';
      let k = 'binary/other';
      const m = /^\{"type":"(\w+)"/.exec(s);
      if (m) {
        k = m[1];
        if (k === 'event') {
          const e = /"kind":"([^"]+)"/.exec(s);
          k = 'event ' + (e ? e[1] : '?');
          if (e && e[1] === 'session.event') { const t = /"message":\{"type":"([^"]+)"/.exec(s); k += ' ' + (t ? t[1] : '?'); if (t && t[1] !== 'stream_event') { const st = /"subtype":"([^"]+)"/.exec(s); if (st) k += '/' + st[1]; } }
        }
      }
      add(P.ws, k);
      add(P.wsBytes, k, data && data.length ? data.length : 0);
      return o.call(this, data, ...r);
    };
  } catch (e) { P.wsError = String(e && e.message); }
  require('node:module').syncBuiltinESMExports();
  const top = (o, n = 40) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);
  P.take = () => {
    const now = Date.now();
    const cpu = process.cpuUsage(cpu0);
    const mem = process.memoryUsage();
    const out = {
      ms: now - t0, cpuUserMs: cpu.user / 1000, cpuSysMs: cpu.system / 1000,
      loop: { mean: P.h.mean / 1e6, p50: P.h.percentile(50) / 1e6, p99: P.h.percentile(99) / 1e6, max: P.h.max / 1e6 },
      mem: { rssMB: mem.rss / 1048576, heapMB: mem.heapUsed / 1048576 },
      counts: P.counts, paths: top(P.paths, 60), callers: top(P.callers, 60), ws: P.ws, wsBytes: P.wsBytes,
      timers: top(P.timers, 30), fires: top(P.fires, 30), watchEv: top(P.watchEv, 30),
      intervals: top(P.intervals, 60), watchReg: top(P.watchReg, 80), wsError: P.wsError,
    };
    P.counts = {}; P.paths = {}; P.callers = {}; P.ws = {}; P.wsBytes = {}; P.timers = {}; P.fires = {}; P.watchEv = {};
    P.h.reset();
    cpu0 = process.cpuUsage();
    t0 = now;
    return JSON.stringify(out);
  };
  globalThis.__cwPerf = P;
}

// ================================================================================================= the demo world
function rngOf(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pick = (rng, a) => a[Math.floor(rng() * a.length)];
const MODS = ['cart', 'coupon', 'orders', 'payment', 'inventory', 'search', 'user', 'session', 'shipping', 'tax', 'pricing', 'catalog', 'review', 'wishlist', 'notify', 'refund', 'invoice', 'address', 'promo', 'report'];
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const THINK = [
  '先确认一下 `applyCoupon` 的调用方，看看有没有别的地方也在用浮点数算钱。', '如果折扣按分取整，订单模块的合计也得跟着改，不然两边会差一分。',
  '测试里有两处直接比较浮点数，需要换成整数分再比较。', '接下来看看 `orders.ts` 里分页是不是也有同样的边界问题。', '每一步都在 perf/ 里记一笔，方便之后回顾。',
  'Grep 一下所有 `toFixed(2)` 的地方，它们大多是展示用的，可以留着。', '金额统一成整数分存，展示的时候再格式化，这样最稳。',
  '这里的循环每次都重新算小计，可以先缓存起来。', '用户说过不要动公开接口，所以只改内部实现。', '还要注意时区：订单的日期是按 UTC 存的。',
  'The reducer recomputes the subtotal on every render; memoizing it should be enough here.', 'Let me double-check the edge case where the coupon is larger than the total.',
];
const SAY = [
  '我先看一下这个文件的结构。', '找到了相关的函数，下面改一下。', '改完了，跑一下看看结果。', '这一处也要同步改。', '记一下这一步做了什么。',
  '结构清楚了：金额在三个地方被重复计算。', '看起来没问题，继续下一个模块。', 'Next I will update the tests to match.',
];
function tsFile(m, rng) {
  const lines = [`// ${m} module`, `import { money, round2 } from './util';`, '', `export interface ${cap(m)}Item { id: string; price: number; qty: number; note?: string }`, ''];
  const nf = 3 + Math.floor(rng() * 5);
  for (let i = 0; i < nf; i++) {
    lines.push(`export function ${m}${['Total', 'Apply', 'Check', 'Load', 'Format', 'Merge', 'Split'][i % 7]}${i}(items: ${cap(m)}Item[], factor = 1): number {`);
    lines.push('  let sum = 0;', '  for (const it of items) {', `    sum += it.price * it.qty * factor; // ${pick(rng, ['TODO: rounding', 'cents', 'see #12', 'fast path', ''])}`, '  }', '  return round2(sum);', '}', '');
  }
  return lines.join('\n');
}
function tsxFile(m, rng) {
  return [`import { useMemo } from 'react';`, `import { ${m}Total0 } from '../${m}';`, '', `export function ${cap(m)}Panel({ items }: { items: any[] }) {`, `  const total = useMemo(() => ${m}Total0(items), [items]);`,
    '  return (', `    <section className="${m}-panel">`, `      <h2>${cap(m)}</h2>`, '      <ul>{items.map((it) => <li key={it.id}>{it.id} × {it.qty}</li>)}</ul>', `      <p className="total">{total.toFixed(2)}</p>`, '    </section>', '  );', '}', `// ${Math.floor(rng() * 1e6)}`, ''].join('\n');
}
function gitIn(cwd) {
  const { execFileSync } = require('node:child_process');
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Dana Lee', GIT_AUTHOR_EMAIL: 'dana@example.invalid', GIT_COMMITTER_NAME: 'Dana Lee', GIT_COMMITTER_EMAIL: 'dana@example.invalid' };
  return (...a) => execFileSync('git', a, { cwd, windowsHide: true, stdio: 'ignore', env });
}
function mkRepo(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  const git = gitIn(dir);
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'Initial commit');
  return git;
}
function repoFiles(name, rng, n) {
  const files = { 'package.json': JSON.stringify({ name, version: '1.0.0', scripts: { test: 'vitest run', build: 'tsc -p .' } }, null, 2) + '\n', 'README.md': `# ${name}\n\nA demo project.\n`, 'tsconfig.json': '{ "compilerOptions": { "strict": true, "jsx": "react-jsx" } }\n', 'src/util.ts': 'export const round2 = (n: number) => Math.round(n * 100) / 100;\nexport const money = (n: number) => n.toFixed(2);\n', 'perf/.keep': '' };
  for (let i = 0; i < n; i++) {
    const m = MODS[i % MODS.length] + (i >= MODS.length ? String(i) : '');
    files[`src/${m}.ts`] = tsFile(m, rng);
    if (i % 2 === 0) files[`src/ui/${cap(m)}Panel.tsx`] = tsxFile(m, rng);
    if (i % 3 === 0) files[`tests/${m}.test.ts`] = `import { expect, it } from 'vitest';\nimport { ${m}Total0 } from '../src/${m}';\n\nit('adds up', () => { expect(${m}Total0([{ id: 'a', price: 2, qty: 3 }])).toBe(6); });\n`;
  }
  for (let i = 0; i < 4; i++) files[`docs/guide-${i}.md`] = `# Guide ${i}\n\n${THINK.slice(i, i + 4).join('\n\n')}\n`;
  return files;
}

/** rows: [{ role, content, at (s), id? }] written the way Claude Code writes them; returns the file */
function writeTranscript(home, cwd, sid, rows, startMs) {
  const dir = path.join(home, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  let parent = null;
  let n = 0;
  const base = { isSidechain: false, userType: 'external', cwd, sessionId: sid, version: '2.1.281', gitBranch: 'main' };
  const lines = rows.map((l) => {
    const uuid = `${sid.slice(0, 24)}${String(++n).padStart(12, '0')}`;
    const timestamp = new Date(startMs + l.at * 1000).toISOString();
    const row = l.role === 'user'
      ? { ...base, parentUuid: parent, type: 'user', message: { role: 'user', content: l.content }, uuid, timestamp }
      : { ...base, parentUuid: parent, type: 'assistant', message: { id: `msg_${sid.slice(-6)}_${l.id ?? n}`, type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: l.content, stop_reason: l.stop ?? 'end_turn', usage: { input_tokens: 3200, output_tokens: 420, cache_read_input_tokens: 48000 } }, uuid, timestamp, requestId: `req_${sid.slice(-6)}_${l.id ?? n}` };
    parent = uuid;
    return JSON.stringify(row);
  });
  const file = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const end = new Date(startMs + rows[rows.length - 1].at * 1000);
  fs.utimesSync(file, end, end);
  return file;
}

const ASKS = ['给 {m} 模块加单元测试', '为什么 {m} 的合计会差一分钱？', '把 {m} 改成按整数分计算', '{m} 页面加载太慢，看一下', '重构一下 {m}，拆成更小的函数', '给 {m} 加分页', '{m} 的接口返回 500，帮我查一下', '写一下 {m} 的文档', 'Add input validation to {m}', 'Why does {m} crash on empty input?', '{m} 里的日期显示不对', '把 {m} 迁移到新的 API'];
const REPLIES = ['好了，改完了，测试都通过。', '原因是浮点数精度：改成整数分之后就对了。', '加了分页，一次 20 条，下面有「加载更多」。', '接口 500 是因为空数组没处理，已经修好并补了测试。', 'Done. The function now validates its input and returns early on empty arrays.', '文档写在 docs/ 里了，包括用法和例子。'];

function seedWorld(home, opts) {
  const rng = rngOf(20261117);
  const work = path.join(home, 'work');
  const shop = path.join(work, 'acme-shop');
  const projects = { shop, notes: path.join(work, 'notes-app'), blog: path.join(work, 'blog-site'), api: path.join(work, 'api-server') };
  const git = mkRepo(shop, repoFiles('acme-shop', rng, 40));
  mkRepo(projects.notes, repoFiles('notes-app', rng, 8));
  mkRepo(projects.blog, repoFiles('blog-site', rng, 6));
  mkRepo(projects.api, repoFiles('api-server', rng, 12));
  // real uncommitted changes in the shop (the review panel / git badge have something to show)
  fs.appendFileSync(path.join(shop, 'src', 'cart.ts'), '\n// rounding: see perf notes\n');
  fs.appendFileSync(path.join(shop, 'README.md'), '\nWork in progress.\n');
  void git;

  // ---- the long conversation the window has open (and the task continues in)
  const sid = 'c0ffee00-0000-4000-8000-0000000a0001';
  const rows = [];
  let at = 0;
  let msg = 0;
  let tu = 0;
  const srcFiles = Object.keys(repoFiles('acme-shop', rngOf(1), 40)).filter((f) => f.startsWith('src/') && f.endsWith('.ts'));
  for (let turn = 0; rows.length < opts.history; turn++) {
    const m = MODS[turn % MODS.length];
    rows.push({ role: 'user', content: pick(rng, ASKS).replace('{m}', m) + (turn % 4 === 0 ? `\n\n具体是 \`src/${m}.ts\` 里的合计，用了优惠券以后会差一分。` : ''), at: at += 30 });
    const steps = 5 + Math.floor(rng() * 12);
    for (let s = 0; s < steps && rows.length < opts.history; s++) {
      msg++;
      rows.push({ role: 'assistant', id: msg, content: [{ type: 'thinking', thinking: Array.from({ length: 2 + Math.floor(rng() * 4) }, () => pick(rng, THINK)).join(''), signature: 'c2lnbmF0dXJl' }], at: at += 4, stop: 'tool_use' });
      const id = `toolu_h${String(++tu).padStart(5, '0')}`;
      const f = path.join(shop, pick(rng, srcFiles));
      const kind = s === 0 && turn % 3 === 0 ? 'TodoWrite' : pick(rng, ['Read', 'Read', 'Bash', 'Grep', 'Edit', 'Edit', 'Write', 'Glob']);
      let input, result;
      if (kind === 'Read') { input = { file_path: f }; result = tsFile(path.basename(f, '.ts'), rng).split('\n').map((l, i) => `${String(i + 1).padStart(6)}\t${l}`).join('\n'); }
      else if (kind === 'Bash') { input = { command: pick(rng, ['npm test', 'git status --short', 'npx tsc --noEmit -p .', 'ls src', 'git diff --stat']), description: pick(rng, ['跑测试', '看改动', '类型检查', '列文件']) }; result = Array.from({ length: 6 + Math.floor(rng() * 14) }, (_, i) => ` ✓ tests/${MODS[i % MODS.length]}.test.ts (${1 + (i % 5)})`).join('\n') + '\n\n Test Files  14 passed (14)\n      Tests  52 passed (52)'; }
      else if (kind === 'Grep') { input = { pattern: pick(rng, ['toFixed\\(2\\)', 'applyCoupon', 'export function', 'round2']), path: path.join(shop, 'src'), output_mode: 'content', '-n': true }; result = Array.from({ length: 4 + Math.floor(rng() * 10) }, (_, i) => `src/${MODS[(i * 3) % MODS.length]}.ts:${3 + i * 7}:export function ${MODS[i % MODS.length]}Total${i}(items: Item[], factor = 1): number {`).join('\n'); }
      else if (kind === 'Edit') { input = { file_path: f, old_string: '    sum += it.price * it.qty * factor;', new_string: '    sum += Math.round(it.price * 100) * it.qty * factor / 100;' }; result = `The file ${f} has been updated.`; }
      else if (kind === 'Write') { input = { file_path: path.join(shop, 'docs', `note-${turn}-${s}.md`), content: `# 笔记 ${turn}-${s}\n\n${THINK.slice(0, 3).join('\n')}\n` }; result = `File created successfully at: ${input.file_path}`; }
      else if (kind === 'Glob') { input = { pattern: 'src/**/*.ts' }; result = srcFiles.slice(0, 20).map((x) => path.join(shop, x)).join('\n'); }
      else { input = { todos: [0, 1, 2, 3].map((i) => ({ content: `${cap(m)}：第 ${i + 1} 步`, status: i === 0 ? 'in_progress' : 'pending', activeForm: `正在做 ${m} 第 ${i + 1} 步` })) }; result = 'Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress.'; }
      rows.push({ role: 'assistant', id: msg, content: [{ type: 'text', text: pick(rng, SAY) }, { type: 'tool_use', id, name: kind, input }], at: at += 1, stop: 'tool_use' });
      rows.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result }], at: at += 2 });
    }
    rows.push({ role: 'assistant', id: ++msg, content: [{ type: 'text', text: `改好了：\n\n- \`src/${m}.ts\`：金额改成整数分计算，展示时再格式化\n- \`tests/${m}.test.ts\`：补了优惠券大于总价、空数组两种情况\n- 顺手把重复计算的小计缓存了一下\n\n| 文件 | 改动 |\n| --- | --- |\n| src/${m}.ts | +12 −5 |\n| tests/${m}.test.ts | +18 |\n\n用法：\n\n\`\`\`ts\nimport { ${m}Total0 } from "./src/${m}";\n${m}Total0([{ id: "a", price: 19.99, qty: 1 }], 0.85); // 16.99\n\`\`\`\n\n所有测试都通过了。` }], at: at += 6 });
  }
  const longStart = Date.now() - (at + 600) * 1000;
  writeTranscript(home, shop, sid, rows, longStart);

  // ---- ~300 finished conversations over the last 60 days in four projects
  const ids = [];
  const where = ['shop', 'shop', 'shop', 'notes', 'notes', 'blog', 'api'];
  for (let i = 0; i < opts.convs; i++) {
    const p = projects[where[i % where.length]];
    const s = `c0ffee00-0000-4000-8000-${String(i).padStart(12, '0')}`;
    const m = pick(rng, MODS);
    const r = [{ role: 'user', content: pick(rng, ASKS).replace('{m}', m), at: 0 }];
    const extra = Math.floor(rng() * 4);
    let t = 0;
    for (let k = 0; k < extra; k++) {
      const id = `toolu_c${i}_${k}`;
      r.push({ role: 'assistant', id: k + 1, content: [{ type: 'text', text: pick(rng, SAY) }, { type: 'tool_use', id, name: 'Read', input: { file_path: path.join(p, 'src', 'util.ts') } }], at: t += 5, stop: 'tool_use' });
      r.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: '     1\texport const round2 = (n: number) => Math.round(n * 100) / 100;' }], at: t += 1 });
    }
    r.push({ role: 'assistant', id: extra + 1, content: [{ type: 'text', text: pick(rng, REPLIES) }], at: t += 12 });
    // the newest a few minutes ago, the rest spread over 60 days
    const ago = i < 8 ? (i + 1) * 15 * 60_000 : (8 * 60 + rng() * 60 * 24 * 60) * 60_000;
    writeTranscript(home, p, s, r, Date.now() - ago);
    ids.push({ sid: s, cwd: p });
  }
  return { work, shop, projects, sid, longRows: rows.length, ids, srcFiles };
}

// ================================================================================== the fake upstream: an agent loop
// Every main-loop request (it carries tools) whose last user words contain the marker gets the next step: a thinking
// block and a text block streamed as small deltas at `rate` per second, then a tool call; once `ctl.stopAt` has passed
// the next step is the final answer. Anything else (titles, summaries, count_tokens) gets a short answer at once.
const MARK = 'PERF-LOOP';
const PROMPT = `${MARK} 继续重构 acme-shop：把购物车、优惠券和订单模块整理一遍，每一步在 perf/ 目录里记一笔，改完跑一下。`;
function startLoopUpstream(shop, srcFiles, rate, port = 0) {
  const http = require('node:http');
  const ctl = { stopAt: Infinity, main: [], other: 0, deltas: 0, bytesIn: 0, active: 0 };
  const sse = (type, o) => `event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`;
  const pieces = (s, n) => { const cps = Array.from(s); const k = Math.max(1, Math.ceil(cps.length / n)); const out = []; for (let i = 0; i < cps.length; i += k) out.push(cps.slice(i, i + k).join('')); return out; };
  const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b && b.type === 'text' && !String(b.text).startsWith('<')).map((b) => b.text).join('\n') : '');
  const lastAsk = (msgs) => { for (let k = msgs.length - 1; k >= 0; k--) { const m = msgs[k]; if (m && m.role === 'user') { const t = textOf(m.content); if (t) return { text: t, at: k }; } } return { text: '', at: -1 }; };
  const isResult = (m) => m && m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b && b.type === 'tool_result');
  let n = 0;
  const head = (model, k) => sse('message_start', { message: { id: `msg_loop_${++n}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 2400, cache_read_input_tokens: 60000 + k * 900, cache_creation_input_tokens: 900, output_tokens: 1 } } });
  const fill = (pool, nDeltas, k) => { let s = ''; let i = k; while (Array.from(s).length < nDeltas * 3) s += pool[i++ % pool.length]; return s; };
  function tool(k) {
    const f = srcFiles[k % srcFiles.length];
    switch (k % 6) {
      case 0: return ['Bash', { command: `echo "step ${k}" && ls src | head -20`, description: `列出 src（第 ${k} 步）` }];
      case 1: return ['Read', { file_path: path.join(shop, f) }];
      case 2: return ['Grep', { pattern: 'export function', path: path.join(shop, 'src'), output_mode: 'content', '-n': true, head_limit: 40 }];
      case 3: return ['Write', { file_path: path.join(shop, 'perf', `step-${k}.md`), content: `# 第 ${k} 步\n\nstatus: draft\n\n${THINK.slice(0, 4).join('\n')}\n` }];
      case 4: return ['Edit', { file_path: path.join(shop, 'perf', `step-${k - 1}.md`), old_string: 'status: draft', new_string: 'status: done' }];
      default: return ['Bash', { command: 'dir src && git status --short | head -20', description: '看一下改动' }];
    }
  }
  function stepEvents(model, k, final) {
    const ev = [];
    const now = (s) => ev.push({ s, paced: false });
    const paced = (s) => ev.push({ s, paced: true });
    now(head(model, k));
    const nThink = Math.round(rate * 1.6);
    const nText = Math.round(rate * 0.8);
    now(sse('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }));
    for (const p of pieces(fill(THINK, nThink, k), nThink)) paced(sse('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: p } }));
    now(sse('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'c2lnbmF0dXJl' } }));
    now(sse('content_block_stop', { index: 0 }));
    now(sse('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }));
    const text = final ? `这一轮先到这里：一共走了 ${k} 步，perf/ 里每一步都有记录，测试全部通过。\n\n- 购物车、优惠券、订单三个模块的金额都改成了整数分\n- 记录在 \`perf/step-*.md\`` : fill(SAY, nText, k);
    for (const p of pieces(text, final ? 40 : nText)) paced(sse('content_block_delta', { index: 1, delta: { type: 'text_delta', text: p } }));
    now(sse('content_block_stop', { index: 1 }));
    if (!final) {
      const [name, input] = tool(k);
      now(sse('content_block_start', { index: 2, content_block: { type: 'tool_use', id: `toolu_loop_${String(k).padStart(4, '0')}_${n}`, name, input: {} } }));
      for (const p of pieces(JSON.stringify(input), 8)) paced(sse('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: p } }));
      now(sse('content_block_stop', { index: 2 }));
    }
    now(sse('message_delta', { delta: { stop_reason: final ? 'end_turn' : 'tool_use', stop_sequence: null }, usage: { output_tokens: nThink + nText } }));
    now(sse('message_stop', {}));
    return ev;
  }
  async function out(res, ev) {
    ctl.active++;
    const t0 = performance.now();
    let sent = 0;
    let i = 0;
    try {
      while (i < ev.length) {
        const allowed = Math.floor(((performance.now() - t0) * rate) / 1000) + 1;
        let chunk = '';
        while (i < ev.length && (!ev[i].paced || sent < allowed)) { chunk += ev[i].s; if (ev[i].paced) { sent++; ctl.deltas++; } i++; }
        if (chunk) res.write(chunk);
        if (res.destroyed) return;
        if (i < ev.length) await sleep(4);
      }
      res.end();
    } finally { ctl.active--; }
  }
  const server = http.createServer((q, s) => {
    let raw = '';
    q.setEncoding('utf8');
    q.on('data', (c) => { raw += c; });
    q.on('end', () => {
      ctl.bytesIn += raw.length;
      let j = {};
      try { j = JSON.parse(raw || '{}'); } catch { /* keep */ }
      const json = (status, o) => s.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(o));
      if (q.url.includes('/count_tokens')) return json(200, { input_tokens: 60000 });
      if (q.url.includes('/models')) return json(200, { data: [{ id: 'claude-sonnet-5-5', type: 'model' }] });
      if (!q.url.startsWith('/v1/messages')) return json(404, { error: { type: 'not_found_error', message: 'no' } });
      const msgs = Array.isArray(j.messages) ? j.messages : [];
      const tools = Array.isArray(j.tools) ? j.tools.map((t) => t && t.name) : [];
      const ask = lastAsk(msgs);
      if (j.stream && tools.length && ask.text.includes(MARK)) {
        const k = msgs.slice(ask.at + 1).filter(isResult).length;
        const final = Date.now() >= ctl.stopAt || k >= 400;
        ctl.main.push({ t: Date.now(), k, kb: Math.round(raw.length / 1024), final });
        s.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        void out(s, stepEvents(j.model, k, final));
        return;
      }
      ctl.other++;
      if (!j.stream) return json(200, { id: `msg_o_${++n}`, type: 'message', role: 'assistant', model: j.model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 2 } });
      s.writeHead(200, { 'content-type': 'text/event-stream' });
      s.end(head(j.model, 0) + sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) + sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } }) + sse('content_block_stop', { index: 0 }) + sse('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }) + sse('message_stop', {}));
    });
  });
  // the CLI keeps its connections: Node's default 5 s keep-alive closes them under it, and its next request waits on a
  // dead socket ("Request timed out" / "Connection error" retries, a minute's stall between steps — 2026-11-17)
  server.keepAliveTimeout = 10 * 60_000;
  server.headersTimeout = 10 * 60_000 + 1000;
  return new Promise((res) => server.listen(port, '127.0.0.1', () => res({ server, ctl, url: `http://127.0.0.1:${server.address().port}` })));
}

// ======================================================================================== per-process CPU sampler
// One sample a second: [pid, ppid, name, cpu (100 ns), private bytes, working set, read bytes, write bytes, other
// bytes, created (ms epoch)] for every process on the machine; command lines only for processes under `roots`.
const WIN_SAMPLER = String.raw`param([int]$IntervalMs = 1000, [string]$Roots = '')
$src = @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
public static class CwSampler {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct PE32 { public uint dwSize; public uint cntUsage; public uint th32ProcessID; public IntPtr th32DefaultHeapID; public uint th32ModuleID; public uint cntThreads; public uint th32ParentProcessID; public int pcPriClassBase; public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile; }
  [StructLayout(LayoutKind.Sequential)] public struct IOC { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
  [StructLayout(LayoutKind.Sequential)] public struct PMC { public uint cb; public uint PageFaultCount; public UIntPtr PeakWorkingSetSize, WorkingSetSize, QuotaPeakPagedPoolUsage, QuotaPagedPoolUsage, QuotaPeakNonPagedPoolUsage, QuotaNonPagedPoolUsage, PagefileUsage, PeakPagefileUsage, PrivateUsage; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint f, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr h, ref PE32 e);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr h, ref PE32 e);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint a, bool i, uint pid);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h, out long c, out long e, out long k, out long u);
  [DllImport("kernel32.dll")] static extern bool GetProcessIoCounters(IntPtr h, out IOC io);
  [DllImport("psapi.dll")] static extern bool GetProcessMemoryInfo(IntPtr h, ref PMC m, uint cb);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, IntPtr buf, int len, out int ret);
  static HashSet<uint> named = new HashSet<uint>();
  static string Esc(string s) { if (s == null) return ""; var b = new StringBuilder(s.Length + 8); foreach (char ch in s) { if (ch == '"' || ch == '\\') { b.Append('\\'); b.Append(ch); } else if (ch < 0x20) { b.Append("\\u"); b.Append(((int)ch).ToString("x4")); } else b.Append(ch); } return b.ToString(); }
  static string Cmd(IntPtr h) {
    int len = 8192; IntPtr buf = Marshal.AllocHGlobal(len);
    try {
      int ret; int st = NtQueryInformationProcess(h, 60, buf, len, out ret);
      if (st != 0 && ret > len) { Marshal.FreeHGlobal(buf); len = ret; buf = Marshal.AllocHGlobal(len); st = NtQueryInformationProcess(h, 60, buf, len, out ret); }
      if (st != 0) return null;
      int n = Marshal.ReadInt16(buf) & 0xffff; IntPtr p = Marshal.ReadIntPtr(buf, IntPtr.Size);
      return Marshal.PtrToStringUni(p, n / 2);
    } finally { Marshal.FreeHGlobal(buf); }
  }
  public static string Sample(uint[] roots) {
    var ents = new List<PE32>();
    IntPtr snap = CreateToolhelp32Snapshot(2, 0);
    var e = new PE32(); e.dwSize = (uint)Marshal.SizeOf(typeof(PE32));
    if (Process32FirstW(snap, ref e)) { do { ents.Add(e); } while (Process32NextW(snap, ref e)); }
    CloseHandle(snap);
    var kids = new Dictionary<uint, List<uint>>();
    foreach (var x in ents) { List<uint> l; if (!kids.TryGetValue(x.th32ParentProcessID, out l)) { l = new List<uint>(); kids[x.th32ParentProcessID] = l; } l.Add(x.th32ProcessID); }
    var tree = new HashSet<uint>(); var stack = new Stack<uint>(roots);
    while (stack.Count > 0) { var p = stack.Pop(); if (!tree.Add(p)) continue; List<uint> c; if (kids.TryGetValue(p, out c)) foreach (var k in c) if (k != p && k != 0) stack.Push(k); }
    var sb = new StringBuilder(64 * 1024);
    sb.Append("{\"t\":"); sb.Append(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()); sb.Append(",\"p\":[");
    var cmds = new StringBuilder(); bool first = true; bool firstCmd = true;
    foreach (var x in ents) {
      uint pid = x.th32ProcessID; if (pid == 0) continue;
      IntPtr h = OpenProcess(0x1000 | 0x0010, false, pid);
      if (h == IntPtr.Zero) h = OpenProcess(0x1000, false, pid);
      if (h == IntPtr.Zero) continue;
      long c, ex, k, u; long cpu = -1, created = 0; ulong rd = 0, wr = 0, ot = 0, priv = 0, ws = 0;
      if (GetProcessTimes(h, out c, out ex, out k, out u)) { cpu = k + u; created = c / 10000 - 11644473600000; }
      IOC io; if (GetProcessIoCounters(h, out io)) { rd = io.ReadBytes; wr = io.WriteBytes; ot = io.OtherBytes; }
      PMC m = new PMC(); m.cb = (uint)Marshal.SizeOf(typeof(PMC)); if (GetProcessMemoryInfo(h, ref m, m.cb)) { priv = m.PrivateUsage.ToUInt64(); ws = m.WorkingSetSize.ToUInt64(); }
      if (tree.Contains(pid) && !named.Contains(pid)) { named.Add(pid); string cl = Cmd(h); if (cl != null) { if (!firstCmd) cmds.Append(','); firstCmd = false; cmds.Append('"'); cmds.Append(pid); cmds.Append("\":\""); cmds.Append(Esc(cl.Length > 600 ? cl.Substring(0, 600) : cl)); cmds.Append('"'); } }
      CloseHandle(h);
      if (cpu < 0) continue;
      if (!first) sb.Append(','); first = false;
      sb.Append('['); sb.Append(pid); sb.Append(','); sb.Append(x.th32ParentProcessID); sb.Append(",\""); sb.Append(Esc(x.szExeFile)); sb.Append("\",");
      sb.Append(cpu); sb.Append(','); sb.Append(priv); sb.Append(','); sb.Append(ws); sb.Append(','); sb.Append(rd); sb.Append(','); sb.Append(wr); sb.Append(','); sb.Append(ot); sb.Append(','); sb.Append(created); sb.Append(']');
    }
    sb.Append("],\"c\":{"); sb.Append(cmds.ToString()); sb.Append("}}");
    return sb.ToString();
  }
}
'@
Add-Type -TypeDefinition $src -Language CSharp
$r = [uint32[]]@($Roots.Split(',') | Where-Object { $_ } | ForEach-Object { [uint32]$_ })
while ($true) { [Console]::Out.WriteLine([CwSampler]::Sample($r)); Start-Sleep -Milliseconds $IntervalMs }
`;

function startSampler(out, roots, onSample) {
  const { spawn, execFile } = require('node:child_process');
  if (process.platform === 'win32') {
    const ps1 = path.join(out, 'sampler.ps1');
    fs.writeFileSync(ps1, WIN_SAMPLER);
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-IntervalMs', '1000', '-Roots', roots.join(',')], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let buf = '';
    let err = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line.startsWith('{')) { try { onSample(JSON.parse(line)); } catch { /* partial */ } } } });
    p.stderr.on('data', (d) => { err += d; });
    return { pid: p.pid, stop: () => { try { p.kill(); } catch { /* gone */ } }, err: () => err };
  }
  // macOS / Linux: ps (cumulative CPU time, RSS); command lines for new processes under the roots
  let stopped = false;
  const named = new Set();
  const secs = (t) => { const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(t.trim()); return m ? (+(m[1] || 0)) * 86400 + (+(m[2] || 0)) * 3600 + (+m[3]) * 60 + parseFloat(m[4]) : 0; };
  const tick = () => execFile('ps', ['-A', '-o', 'pid=,ppid=,time=,rss=,comm='], { maxBuffer: 1 << 24 }, (e, stdout) => {
    if (stopped) return;
    const t = Date.now();
    const p = [];
    for (const line of String(stdout || '').split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/.exec(line);
      if (m) p.push([+m[1], +m[2], path.basename(m[5]), Math.round(secs(m[3]) * 1e7), +m[4] * 1024, +m[4] * 1024, 0, 0, 0, 0]);
    }
    const kids = new Map();
    for (const x of p) { if (!kids.has(x[1])) kids.set(x[1], []); kids.get(x[1]).push(x[0]); }
    const tree = new Set();
    const st = [...roots];
    while (st.length) { const q = st.pop(); if (tree.has(q)) continue; tree.add(q); for (const k of kids.get(q) || []) if (k !== q) st.push(k); }
    const fresh = [...tree].filter((x) => !named.has(x));
    const c = {};
    if (fresh.length) {
      try {
        const o = require('node:child_process').execFileSync('ps', ['-o', 'pid=,args=', '-p', fresh.join(',')], { encoding: 'utf8' });
        for (const l of o.split('\n')) { const m = /^\s*(\d+)\s+(.*)$/.exec(l); if (m) c[m[1]] = m[2].slice(0, 600); }
      } catch { /* exited */ }
      for (const x of fresh) named.add(x);
    }
    onSample({ t, p, c });
    setTimeout(tick, 1000);
  });
  tick();
  return { pid: 0, stop: () => { stopped = true; }, err: () => '' };
}

/** CPU / memory / I/O per labelled process group over [t0, t1] from the samples. */
function processWindow(samples, t0, t1, label) {
  const base = [...samples].reverse().find((s) => s.t <= t0) ?? samples[0];
  const end = [...samples].reverse().find((s) => s.t <= t1) ?? samples[samples.length - 1];
  if (!base || !end || end.t <= base.t) return null;
  const inWin = samples.filter((s) => s.t > base.t && s.t <= end.t);
  const basePid = new Map(base.p.map((x) => [x[0], x]));
  const last = new Map();
  for (const s of inWin) for (const x of s.p) last.set(x[0], x);
  const span = end.t - base.t;
  const groups = {};
  const others = {};
  let totalCpu = 0;
  for (const [pid, x] of last) {
    const b = basePid.get(pid);
    const same = b && b[9] === x[9];
    const cpu = (x[3] - (same ? b[3] : 0)) / 1e4; // ms
    const rd = x[6] - (same ? b[6] : 0);
    const wr = x[7] - (same ? b[7] : 0);
    totalCpu += Math.max(0, cpu);
    const l = label(pid, x);
    const g = l ? (groups[l] ??= { cpuMs: 0, privMB: 0, wsMB: 0, readB: 0, writeB: 0, pids: new Set() }) : (others[x[2]] ??= { cpuMs: 0, privMB: 0, wsMB: 0, readB: 0, writeB: 0, pids: new Set() });
    g.cpuMs += Math.max(0, cpu);
    g.privMB += x[4] / 1048576;
    g.wsMB += x[5] / 1048576;
    g.readB += Math.max(0, rd);
    g.writeB += Math.max(0, wr);
    g.pids.add(pid);
  }
  const fmt = (g) => ({ cpuPct: +(g.cpuMs / span * 100).toFixed(1), cpuMs: Math.round(g.cpuMs), privMB: Math.round(g.privMB), wsMB: Math.round(g.wsMB), readKBs: +(g.readB / span).toFixed(1), writeKBs: +(g.writeB / span).toFixed(1), procs: g.pids.size });
  const out = {};
  for (const [k, g] of Object.entries(groups)) out[k] = fmt(g);
  const oth = Object.entries(others).map(([k, g]) => [k, fmt(g)]).sort((a, b) => b[1].cpuMs - a[1].cpuMs).slice(0, 12);
  return { spanMs: span, samples: inWin.length, groups: out, others: Object.fromEntries(oth), sampledMachineCpuPct: +(totalCpu / span * 100).toFixed(1) };
}

// ============================================================================================ profiles → hotspots
const nmShort = (s) => { const i = s.lastIndexOf('node_modules/'); return i >= 0 ? 'nm:' + s.slice(i + 13) : null; };
function normSource(s) {
  const t = String(s).replace(/\\/g, '/');
  const nm = nmShort(t);
  if (nm) return nm;
  for (const k of ['web/src/', 'server/src/', 'server/dist/']) { const i = t.lastIndexOf(k); if (i >= 0) return t.slice(i); }
  const i = t.lastIndexOf('/src/');
  return i >= 0 ? 'web' + t.slice(i) : t.replace(/^(\.\.\/)+/, '');
}
function webSymbolizer(distDir) {
  let SMC = null;
  try { SMC = require(path.join(ROOT, 'node_modules', 'source-map-js')).SourceMapConsumer; } catch { /* no maps */ }
  const maps = new Map();
  const lines = new Map();
  const memo = new Map();
  return (cf) => {
    const mk = `${cf.url}|${cf.lineNumber}|${cf.columnNumber}|${cf.functionName}`;
    if (memo.has(mk)) return memo.get(mk);
    let r;
    const m = /\/assets\/([^/?#]+\.js)/.exec(cf.url || '');
    if (!cf.url) r = { key: cf.functionName || '(anonymous)', file: cf.functionName && cf.functionName.startsWith('(') ? cf.functionName : '(native / harness)', name: cf.functionName };
    else if (!m) r = { key: `${cf.functionName || '(anon)'} ${cf.url.slice(-60)}`, file: cf.url.slice(-60), name: cf.functionName };
    else {
      let c = maps.get(m[1]);
      if (c === undefined) { try { c = SMC ? new SMC(JSON.parse(fs.readFileSync(path.join(distDir, 'assets', m[1] + '.map'), 'utf8'))) : null; } catch { c = null; } maps.set(m[1], c); }
      const pos = c ? c.originalPositionFor({ line: cf.lineNumber + 1, column: cf.columnNumber }) : null;
      if (!pos || !pos.source) r = { key: `${cf.functionName || '(anon)'} ${m[1]}:${cf.lineNumber + 1}:${cf.columnNumber}`, file: m[1], name: cf.functionName };
      else {
        const src = normSource(pos.source);
        let name = pos.name;
        if (!name) {
          let ls = lines.get(pos.source);
          if (ls === undefined) { const content = c.sourceContentFor(pos.source, true); ls = content ? content.split('\n') : null; lines.set(pos.source, ls); }
          const text = ls ? ls[pos.line - 1] || '' : '';
          const g = /function\s*\*?\s*([\w$]+)/.exec(text) || /([\w$]+)\s*[:=]\s*(?:async\s*)?(?:function|\(|[\w$]+\s*=>)/.exec(text) || /^\s*(?:async\s+)?([\w$]+)\s*\(/.exec(text);
          name = g ? g[1] : null;
        }
        name = name || cf.functionName || '(anon)';
        r = { key: `${name} (${src}:${pos.line})`, file: src, name, line: pos.line };
      }
    }
    memo.set(mk, r);
    return r;
  };
}
function nodeSymbolizer() {
  return (cf) => {
    const u = String(cf.url || '').replace(/\\/g, '/').replace(/^file:\/\/\/?/, '');
    let file = u ? (nmShort(u) || (u.includes('/server/dist/') ? u.slice(u.indexOf('server/dist/')) : u.includes('perf-busy.cjs') ? 'harness (perf-busy preload)' : u)) : (cf.functionName && cf.functionName.startsWith('(') ? cf.functionName : '(native)');
    if (file.startsWith('node:')) file = file.replace(/^node:internal\//, 'node:');
    const name = cf.functionName || '(anon)';
    return { key: u ? `${name} (${file}:${cf.lineNumber + 1})` : name, file, name, line: cf.lineNumber + 1 };
  };
}
const SPECIAL = new Set(['(idle)', '(program)', '(garbage collector)', '(root)']);
function analyzeProfile(profile, sym, opts = {}) {
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
  const keyOf = new Map();
  for (const n of profile.nodes) keyOf.set(n.id, sym(n.callFrame));
  const self = new Map();
  const byFile = new Map();
  const incl = new Map();
  const comp = new Map();
  let total = 0;
  const spec = { '(idle)': 0, '(program)': 0, '(garbage collector)': 0, '(root)': 0 };
  const { samples = [], timeDeltas = [] } = profile;
  for (let i = 0; i < samples.length; i++) {
    const d = (timeDeltas[i + 1] ?? timeDeltas[i] ?? 0) / 1000; // ms
    if (d <= 0) continue;
    total += d;
    const id = samples[i];
    const k = keyOf.get(id);
    if (!k) continue;
    if (SPECIAL.has(k.name) && !nodes.get(id).callFrame.url) { spec[k.name] += d; continue; }
    self.set(k.key, (self.get(k.key) || 0) + d);
    byFile.set(k.file, (byFile.get(k.file) || 0) + d);
    const seen = new Set();
    const seenC = new Set();
    for (let p = id; p != null; p = parent.get(p)) {
      const kk = keyOf.get(p);
      if (!kk || seen.has(kk.key)) continue;
      seen.add(kk.key);
      incl.set(kk.key, (incl.get(kk.key) || 0) + d);
      // a React component: a capitalised function in a .tsx file of web/src
      if (opts.components && /^web\/src\/.*\.tsx$/.test(kk.file) && /^[A-Z]/.test(kk.name) && !seenC.has(kk.name)) { seenC.add(kk.name); comp.set(kk.key, (comp.get(kk.key) || 0) + d); }
    }
  }
  const busy = total - spec['(idle)'];
  const rows = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, ms]) => ({ fn: k, ms: Math.round(ms), pctBusy: +(ms / Math.max(1, busy) * 100).toFixed(1) }));
  return {
    wallMs: Math.round(total), busyMs: Math.round(busy), busyPct: +(busy / Math.max(1, total) * 100).toFixed(1),
    idleMs: Math.round(spec['(idle)']), programMs: Math.round(spec['(program)']), gcMs: Math.round(spec['(garbage collector)']),
    selfTop: rows(self, 40), inclusiveTop: rows(incl, 40).filter((r) => !SPECIAL.has(r.fn)), byFile: rows(byFile, 25), components: opts.components ? rows(comp, 30) : undefined,
  };
}

// ======================================================================================= the in-page instrumentation
// Added with Page.addScriptToEvaluateOnNewDocument (main world, before the app's scripts): WebSocket counts, a React
// devtools hook (commits; which components rendered — fibers with PerformedWork, pruned by subtreeFlags), store
// updates, long tasks / long animation frames / slow events, and input → next-frame latency.
function pageInstr() {
  const P = { t0: performance.now(), wsIn: {}, wsInBytes: {}, wsOut: {}, commits: 0, renders: new Map(), storeUpdates: 0, bumps: 0, longTasks: [], loaf: [], input: [], events: [], streamTotal: 0, probe: false, sid: null, walk: true };
  window.__cwPerf = P;
  const add = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };
  const kindIn = (s) => {
    const m = /^\{"type":"(\w+)"/.exec(s);
    if (!m) return 'other';
    if (m[1] !== 'event') return m[1];
    const h = s.slice(0, 400);
    const e = /"kind":"([^"]+)"/.exec(h);
    let k = 'event ' + (e ? e[1] : '?');
    if (e && e[1] === 'session.event') { const t = /"message":\{"type":"([^"]+)"/.exec(h); k += ' ' + (t ? t[1] : '?'); if (t && t[1] !== 'stream_event') { const st = /"subtype":"([^"]+)"/.exec(h); if (st) k += '/' + st[1]; } }
    return k;
  };
  const Orig = window.WebSocket;
  class PerfWS extends Orig {
    constructor(...a) {
      super(...a);
      this.addEventListener('message', (ev) => { const s = typeof ev.data === 'string' ? ev.data : ''; const k = kindIn(s); add(P.wsIn, k); add(P.wsInBytes, k, s.length); if (k === 'event session.event stream_event') P.streamTotal++; });
    }
    send(d) { const s = typeof d === 'string' ? d.slice(0, 300) : ''; const m = /"req":\{"kind":"([^"]+)"/.exec(s); add(P.wsOut, m ? m[1] : 'other'); return super.send(d); }
  }
  window.WebSocket = PerfWS;
  const TAGS = new Set([0, 1, 11, 14, 15]);
  const walk = (root) => {
    const st = [root.current];
    while (st.length) {
      const f = st.pop();
      if ((f.flags & 1) && TAGS.has(f.tag)) { let t = f.type; if (t && typeof t === 'object') t = t.type || t.render; if (typeof t === 'function') P.renders.set(t, (P.renders.get(t) || 0) + 1); }
      if (f.subtreeFlags & 1) for (let c = f.child; c; c = c.sibling) st.push(c);
    }
  };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, isDisabled: false, renderers: new Map(),
    inject(r) { const id = this.renderers.size + 1; this.renderers.set(id, r); return id; },
    onCommitFiberRoot(_id, root) { P.commits++; if (P.walk) { try { walk(root); } catch (e) { P.walkErr = String(e); } } },
    onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, onScheduleFiberRoot() {}, checkDCE() {}, setStrictMode() {},
  };
  const iv = setInterval(() => {
    const s = window.__store;
    if (!s) return;
    clearInterval(iv);
    let prevV = -1;
    let prevSid = null;
    s.subscribe((st) => {
      P.storeUpdates++;
      const sid = P.sid;
      if (!sid) return;
      const o = st.open && st.open[sid];
      const v = o ? o.version : -1;
      if (sid !== prevSid) { prevSid = sid; prevV = v; return; }
      if (v !== prevV) { P.bumps++; prevV = v; }
    });
  }, 200);
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) P.longTasks.push(e.duration); }).observe({ type: 'longtask' }); } catch { /* unsupported */ }
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) P.loaf.push({ d: e.duration, b: e.blockingDuration, render: e.renderStart ? e.startTime + e.duration - e.renderStart : 0, style: e.styleAndLayoutStart ? e.startTime + e.duration - e.styleAndLayoutStart : 0, s: (e.scripts || []).map((x) => [x.invoker, x.sourceURL, x.sourceFunctionName, x.sourceCharPosition, x.duration, x.forcedStyleAndLayoutDuration]) }); }).observe({ type: 'long-animation-frame' }); } catch { /* unsupported */ }
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) P.events.push([e.name, e.duration, e.processingStart - e.startTime, e.processingEnd - e.processingStart]); }).observe({ type: 'event', durationThreshold: 16 }); } catch { /* unsupported */ }
  document.addEventListener('input', (e) => {
    if (!P.probe) return;
    const t0 = e.timeStamp;
    requestAnimationFrame(() => { const ch = new MessageChannel(); ch.port1.onmessage = () => P.input.push(performance.now() - t0); ch.port2.postMessage(0); });
  }, true);
  P.reset = () => { P.wsIn = {}; P.wsInBytes = {}; P.wsOut = {}; P.commits = 0; P.renders = new Map(); P.storeUpdates = 0; P.bumps = 0; P.longTasks = []; P.loaf = []; P.input = []; P.events = []; P.t0 = performance.now(); };
  P.topRenderFns = () => P.frozen || [];
  P.take = () => {
    const top = [...P.renders].sort((a, b) => b[1] - a[1]).slice(0, 50);
    P.frozen = top.map((x) => x[0]); // the same order for the [[FunctionLocation]] lookup that follows
    return {
      ms: performance.now() - P.t0, wsIn: P.wsIn, wsInBytes: P.wsInBytes, wsOut: P.wsOut, commits: P.commits, storeUpdates: P.storeUpdates, bumps: P.bumps,
      renders: top.map(([f, n]) => [f.displayName || f.name || '(anon)', n]),
      longTasks: P.longTasks, loaf: P.loaf, input: P.input, events: P.events, walkErr: P.walkErr,
      dpr: window.devicePixelRatio, domNodes: document.getElementsByTagName('*').length, streamTotal: P.streamTotal,
    };
  };
}

// ===================================================================================================== the driver
async function driver() {
  const { app, BrowserWindow } = require('electron');
  const C = JSON.parse(process.env.PERF_CFG);
  const emit = (o) => process.stdout.write('@@CW ' + JSON.stringify(o) + '\n');
  const log = (...a) => emit({ ev: 'log', text: a.join(' ') });
  app.setPath('userData', path.join(C.out, 'electron-profile'));
  if (C.dpr) app.commandLine.appendSwitch('force-device-scale-factor', String(C.dpr));
  if (C.show) app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  const result = { windows: {}, notes: [] };
  const save = () => { try { fs.writeFileSync(C.result, JSON.stringify(result)); } catch { /* */ } };
  const done = (code) => { save(); app.exit(code); };
  await app.whenReady();
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, webPreferences: { offscreen: !C.show, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false } });
  if (C.show) win.showInactive(); else win.webContents.setFrameRate(60);
  let paints = 0;
  if (!C.show) win.webContents.on('paint', () => { paints++; });
  // a page (and its renderer) first: CDP commands to a webContents that has none never answer
  await win.loadURL('about:blank');
  log('window up');
  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  const cdp = (m, p) => dbg.sendCommand(m, p || {});
  const scriptUrls = new Map();
  dbg.on('message', (_e, method, params) => { if (method === 'Debugger.scriptParsed' && params.url) scriptUrls.set(params.scriptId, params.url); });
  // CW_PERF_TRACE=1: a few seconds of a Chromium trace in the middle of the running window, with style invalidation
  // tracking (which elements' styles each recalc redoes, and why) — trace-running.json, open it in DevTools › Performance
  const traceEvents = [];
  dbg.on('message', (_e, method, params) => { if (method === 'Tracing.dataCollected') traceEvents.push(...params.value); });
  const traceFor = async (ms, file) => {
    traceEvents.length = 0;
    const done = new Promise((res) => { const h = (_e, m) => { if (m === 'Tracing.tracingComplete') { dbg.removeListener('message', h); res(); } }; dbg.on('message', h); });
    await cdp('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.invalidationTracking'] } });
    await sleep(ms);
    await cdp('Tracing.end');
    await withTimeout(done, 60_000, null);
    fs.writeFileSync(file, JSON.stringify({ traceEvents }));
  };
  await cdp('Page.enable');
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `(${pageInstr.toString()})(); window.__cwPerf.walk = ${C.walk ? 'true' : 'false'};` });
  await cdp('Performance.enable');
  await cdp('Profiler.enable');
  await cdp('Profiler.setSamplingInterval', { interval: 500 });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const waitFor = async (code, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await withTimeout(js(code), Math.max(1000, end - Date.now()), false)) return true; } catch { /* not ready */ } await sleep(200); } return false; };

  await win.loadURL(C.url);
  log('page loaded');
  if (!await waitFor('!!document.querySelector(".composer")', 60_000)) result.notes.push('composer never showed');
  await waitFor('window.__store && window.__store.getState().metaLoaded', 30_000);
  await waitFor('window.__store.getState().agents.length > 0', 60_000);
  log('app ready');
  await sleep(2000);
  // a few conversations open as tabs, then the long one in front
  for (const t of C.tabs) { await js(`window.__store.getState().loadHistory(${JSON.stringify(t)}, { focus: true, mode: 'tab' })`).catch((e) => result.notes.push('tab: ' + e.message)); await sleep(1200); }
  await js(`window.__store.getState().loadHistory(${JSON.stringify(C.sid)}, { focus: true, mode: 'tab' })`).catch((e) => result.notes.push('long: ' + e.message));
  await waitFor(`(() => { const o = window.__store.getState().open[${JSON.stringify(C.sid)}]; return o && !o.loading && o.conv.items.length > 0; })()`, 60_000);
  if (C.panel !== 'none') await js(`window.__store.getState().dispatchLayout({ t: 'dock.show', panel: ${JSON.stringify(C.panel)} })`).catch((e) => result.notes.push('dock: ' + e.message));
  await js(`window.__cwPerf.sid = ${JSON.stringify(C.sid)}`);
  result.layout = await js(`(() => { const st = window.__store.getState(); const o = st.open[${JSON.stringify(C.sid)}]; return { items: o.conv.items.length, sessions: st.sessions.length, openTabs: Object.keys(st.open).length, info: st.settings['ui.infoPanel'] !== false, viewMode: st.settings['ui.viewMode'] || 'normal', showThinking: st.settings['ui.showThinking'], theme: st.settings['ui.theme'], dock: JSON.stringify(st.layout.dock || null).slice(0, 200), dpr: devicePixelRatio, size: innerWidth + 'x' + innerHeight }; })()`).catch((e) => ({ error: e.message }));
  log('layout', JSON.stringify(result.layout));
  await sleep(C.settle * 1000);

  const typeKey = (back) => {
    if (back) { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' }); return; }
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'a' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A' });
  };
  const focusComposer = () => js(`(() => { const t = [...document.querySelectorAll('.composer textarea')].find((x) => x.offsetParent); if (!t) return false; t.focus(); return true; })()`);
  const metricsMap = (m) => Object.fromEntries(m.metrics.map((x) => [x.name, x.value]));
  // percentCPUUsage / idleWakeupsPerSecond are "since the last call": one call at the start of a window, one at its end
  const appCpu = () => Object.fromEntries(app.getAppMetrics().map((x) => [x.pid, { type: x.type, name: x.name || x.serviceName || '', cum: x.cpu.cumulativeCPUUsage, wake: x.cpu.idleWakeupsPerSecond, pct: x.cpu.percentCPUUsage, mem: x.memory.workingSetSize }]));

  async function measure(name, seconds) {
    emit({ ev: 'window-start', name, seconds });
    await sleep(400);
    await js('window.__cwPerf.reset()');
    const m0 = metricsMap(await cdp('Performance.getMetrics'));
    const a0 = appCpu();
    paints = 0;
    await cdp('Profiler.start');
    const t0 = Date.now();
    let typed = 0;
    let typedOk = null;
    if (C.typing) { await focusComposer(); await js('window.__cwPerf.probe = true'); }
    let back = false;
    // how long a script waits for the page's main thread (executeJavaScript round trip), every second, not awaited
    const scriptRtt = [];
    let rttOpen = 0;
    let lastRtt = 0;
    // CW_PERF_PRE_JS=<expression>: evaluated in the page as each window starts (an A/B switch: a stylesheet that turns
    // one animation off, say). The window's numbers include it.
    if (process.env.CW_PERF_PRE_JS) await withTimeout(js(process.env.CW_PERF_PRE_JS), 30_000, null);
    let traced = !process.env.CW_PERF_TRACE || name !== 'running';
    while (Date.now() - t0 < seconds * 1000) {
      if (!traced && Date.now() - t0 > 4000) { traced = true; await traceFor(3000, path.join(C.out, 'trace-running.json')); }
      if (C.typing) { typeKey(back); back = !back; typed++; if (typed === 3) typedOk = await withTimeout(js(`(() => { const t = document.activeElement; return !!t && t.tagName === 'TEXTAREA'; })()`), 3000, null); }
      if (Date.now() - lastRtt >= 1000 && rttOpen < 3) {
        lastRtt = Date.now();
        rttOpen++;
        const ts = Date.now();
        js('0').then(() => { scriptRtt.push(Date.now() - ts); rttOpen--; }, () => { rttOpen--; });
      }
      await sleep(C.typing ? 400 : 500);
    }
    if (C.typing) { if (back) typeKey(true); void js('window.__cwPerf.probe = false').catch(() => {}); }
    const wallMs = Date.now() - t0;
    // the profile first (the inspector interrupts a busy page; a script waits its turn behind everything else)
    const { profile } = await cdp('Profiler.stop');
    fs.writeFileSync(path.join(C.out, `renderer-${name}.cpuprofile`), JSON.stringify(profile));
    const m1 = metricsMap(await cdp('Performance.getMetrics'));
    const a1 = appCpu();
    emit({ ev: 'window-end', name });
    // CW_PERF_PAGE_JS=<expression>: evaluated in the page at the end of each window, saved as page-js-<window>.json
    // (e.g. what document.getAnimations() is running while a task runs)
    if (process.env.CW_PERF_PAGE_JS) {
      const r = await withTimeout(js(process.env.CW_PERF_PAGE_JS), 60_000, null);
      fs.writeFileSync(path.join(C.out, `page-js-${name}.json`), JSON.stringify(r, null, 1));
    }
    // the page's own counters: how long the page took to answer is itself a measurement (a starved main thread)
    const tAsk = Date.now();
    const page = await withTimeout(js('window.__cwPerf.take()'), 120_000, null);
    const pageAnswerMs = Date.now() - tAsk;
    if (!page) result.notes.push(`${name}: the page did not answer in 120 s`);
    // where the components that rendered most are: [[FunctionLocation]] of each function object
    const renderLocs = [];
    if (page) {
      try {
        await withTimeout((async () => {
          await cdp('Debugger.enable');
          const arr = await cdp('Runtime.evaluate', { expression: 'window.__cwPerf.topRenderFns()', returnByValue: false });
          const props = await cdp('Runtime.getProperties', { objectId: arr.result.objectId, ownProperties: true });
          for (const p of props.result.filter((x) => /^\d+$/.test(x.name)).sort((a, b) => a.name - b.name)) {
            const fp = await cdp('Runtime.getProperties', { objectId: p.value.objectId, ownProperties: true });
            const loc = (fp.internalProperties || []).find((x) => x.name === '[[FunctionLocation]]');
            renderLocs.push(loc ? { url: scriptUrls.get(loc.value.value.scriptId) || '', lineNumber: loc.value.value.lineNumber, columnNumber: loc.value.value.columnNumber } : null);
          }
          await cdp('Debugger.disable');
        })(), 60_000, null);
      } catch (e) { result.notes.push('render locations: ' + e.message); }
    }
    const md = (k) => +((m1[k] - m0[k]) || 0).toFixed(3);
    const procs = {};
    for (const [pid, x] of Object.entries(a1)) {
      const b = a0[pid];
      procs[pid] = { type: x.type, name: x.name, cpuPct: b && x.cum != null && b.cum != null ? +(((x.cum - b.cum) / (wallMs / 1000)) * 100).toFixed(1) : +(x.pct || 0).toFixed(1), wakeupsPerSec: x.wake, memMB: Math.round(x.mem / 1024) };
    }
    const r = {
      wallMs, typed, typedOk, paints, page: page || {}, pageAnswerMs, renderLocs, scriptRtt, scriptRttPending: rttOpen,
      metrics: { taskMs: md('TaskDuration') * 1000, scriptMs: md('ScriptDuration') * 1000, layoutMs: md('LayoutDuration') * 1000, styleMs: md('RecalcStyleDuration') * 1000, layouts: md('LayoutCount'), styles: md('RecalcStyleCount'), nodes: m1.Nodes, layoutObjects: m1.LayoutObjects, heapMB: +(m1.JSHeapUsedSize / 1048576).toFixed(1), listeners: m1.JSEventListeners },
      electron: procs,
    };
    return r;
  }

  try {
    result.windows.idle = await measure('idle', C.seconds);
    save();
    // the task: sent from the window the way a user sends it
    const sent = await js(`window.__store.getState().send(${JSON.stringify(C.sid)}, ${JSON.stringify(C.prompt)}).then(() => 'ok', (e) => String(e && e.message || e))`);
    log('send:', sent);
    const t0 = Date.now();
    const started = await waitFor('window.__cwPerf.streamTotal > 30', 180_000);
    result.startupMs = Date.now() - t0;
    if (!started) { result.notes.push('the task never started streaming'); emit({ ev: 'stop-loop' }); done(3); return; }
    log(`streaming after ${result.startupMs} ms`);
    await sleep(C.warmup * 1000);
    result.windows.running = await measure('running', C.seconds);
    save();
    result.stillRunningAtEnd = await withTimeout(js(`window.__store.getState().open[${JSON.stringify(C.sid)}].state`), 30_000, '(page did not answer)');
    emit({ ev: 'stop-loop' });
    try { const img = await withTimeout(win.webContents.capturePage(), 20_000, null); if (img) fs.writeFileSync(path.join(C.out, 'running.png'), img.toPNG()); } catch { /* */ }
    await waitFor(`(() => { const o = window.__store.getState().open[${JSON.stringify(C.sid)}]; return o && o.state !== 'running' && o.state !== 'waiting'; })()`, 90_000);
    await sleep(3000);
    if (C.after > 0) result.windows.after = await measure('after', C.after);
    result.final = await withTimeout(js(`(() => { const st = window.__store.getState(); const o = st.open[${JSON.stringify(C.sid)}]; return { items: o.conv.items.length, state: o.state, version: o.version }; })()`), 30_000, { error: 'page did not answer' });
    done(0);
  } catch (e) {
    result.notes.push('driver: ' + (e.stack || e.message));
    emit({ ev: 'stop-loop' });
    done(2);
  }
}

// ===================================================================================================== the runner
function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CLAUDE|ANTHROPIC)/.test(k) || k === 'ELECTRON_RUN_AS_NODE') delete env[k];
  return env;
}
/** A free port from a fixed high range: this machine's dynamic range starts at 1024, and connections to some ports
 *  OS-picked there (seen: 9669, 9699, 9702) hang in SYN_RECEIVED — a filter on the machine, not the app. */
async function freePort() {
  const net = require('node:net');
  for (let i = 0; i < 50; i++) {
    const port = 41000 + Math.floor(Math.random() * 8000);
    const ok = await new Promise((res) => { const s = net.createServer(); s.once('error', () => res(false)); s.listen(port, '127.0.0.1', () => s.close(() => res(true))); });
    if (ok) return port;
  }
  return 0;
}
function newestMtime(dir, re) { let t = 0; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) t = Math.max(t, newestMtime(p, re)); else if (re.test(e.name)) t = Math.max(t, fs.statSync(p).mtimeMs); } return t; }

async function inspectorClient(url) {
  const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
  const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 1 << 30, handshakeTimeout: 8000 });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('error', () => { /* after the run */ });
  let id = 0;
  const pend = new Map();
  ws.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); if (m.error) p.rej(new Error(m.error.message)); else p.res(m.result); } });
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  return { send, close: () => ws.close() };
}

async function runner() {
  const demo = require('./lib/demo.cjs');
  const { spawn, execFileSync } = require('node:child_process');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = path.resolve(String(arg('--out', path.join(os.tmpdir(), 'cw-perf-busy', stamp))));
  fs.mkdirSync(out, { recursive: true });
  const cfg = {
    seconds: Number(arg('--seconds', 60)), after: Number(arg('--after', 20)), dpr: arg('--dpr', 0) ? Number(arg('--dpr', 0)) : 0, show: !!arg('--show', false),
    history: Number(arg('--history', 600)), convs: Number(arg('--convs', 300)), rate: Number(arg('--rate', 150)), panel: String(arg('--panel', 'explorer')),
    typing: !arg('--no-typing', false), walk: !arg('--no-walk', false), runtime: String(arg('--runtime', 'auto')), model: String(arg('--model', 'claude-sonnet-5-5')), settle: 8, warmup: 5,
  };
  console.log(`perf-busy → ${out}`);
  console.log(JSON.stringify(cfg));

  // the server runs from server/dist: say so when the sources are newer
  const distIndex = path.join(ROOT, 'server', 'dist', 'index.js');
  if (!fs.existsSync(distIndex)) throw new Error('server/dist is missing: npm run build:all first');
  if (newestMtime(path.join(ROOT, 'server', 'src'), /\.ts$/) > fs.statSync(distIndex).mtimeMs + 1000) console.log('WARNING: server/src is newer than server/dist — run `npm run build -w server` to measure the current code');
  // the web app, with source maps, where nothing else looks
  let dist = arg('--dist', '');
  if (dist) dist = path.resolve(String(dist));
  else {
    dist = path.join(out, 'web-dist');
    console.log('building the web app with source maps …');
    const t = Date.now();
    execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', path.join(ROOT, 'web'), '--outDir', dist, '--emptyOutDir', '--sourcemap', '--logLevel', 'warn'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true, env: cleanEnv() });
    console.log(`  built in ${((Date.now() - t) / 1000).toFixed(0)} s`);
  }

  const home = demo.tmpHome('cw-perf-');
  console.log(`seeding (HOME=${home}) …`);
  const world = seedWorld(home, cfg);
  console.log(`  ${cfg.convs} conversations + the long one (${world.longRows} transcript rows)`);
  // settings: the user's defaults, plus: bypass permissions (no card waits), no proxy, the gateway off the desktop
  // app's fixed port, Chinese
  const dataDir = path.join(home, '.claude-web');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'meta.json'), JSON.stringify({ version: 1, settings: { 'ui.language': 'zh', 'ui.sidebarFolded': false, 'ui.defaultMode': 'bypassPermissions', 'network.proxy': 'off' }, gateway: { localPort: 0 } }));
  const up = await startLoopUpstream(world.shop, world.srcFiles, cfg.rate, await freePort());
  const spawnLog = path.join(out, 'spawn-log.jsonl');
  fs.rmSync(spawnLog, { force: true });
  const srv = await demo.startServer(home, {
    lang: 'zh', shop: world.shop, dist,
    nodeArgs: [`--inspect=127.0.0.1:${await freePort()}`, '--require', __filename],
    env: { PORT: String(await freePort()), CW_PERF_PRELOAD: '1', CW_PERF_WORK: world.work, CW_SPAWN_LOG: '1', CW_SPAWN_LOG_FILE: spawnLog, ...(cfg.runtime === 'claude' ? { CLAUDE_WEB_RUNTIME: 'claude' } : {}) },
  });
  console.log(`server up on ${srv.port} (pid ${srv.server.pid})`);
  process.on('exit', () => { try { srv.server.kill(); } catch { /* gone */ } });
  const insp = /Debugger listening on (ws:\/\/\S+)/.exec(srv.log());
  let ins = null;
  for (let i = 0; insp && !ins && i < 4; i++) { try { ins = await inspectorClient(insp[1]); } catch (e) { console.log(`  inspector: ${e.message}, again`); await sleep(1000); } }
  if (!ins) console.log('WARNING: no inspector on the server: no server profile');
  if (ins) { await ins.send('Profiler.enable'); await ins.send('Profiler.setSamplingInterval', { interval: 1000 }); }
  const take = async () => { if (!ins) return null; const r = await ins.send('Runtime.evaluate', { expression: 'globalThis.__cwPerf ? globalThis.__cwPerf.take() : null', returnByValue: true }); return r.result.value ? JSON.parse(r.result.value) : null; };

  const c = demo.client(srv.port, srv.token);
  await c.ready;
  const prov = await c.req({ kind: 'providers.upsert', provider: { name: '中转', type: 'anthropic', baseUrl: up.url, apiKey: 'sk-demo-not-real', defaultModel: cfg.model, models: [...new Set([cfg.model, 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001'])], ...(cfg.runtime !== 'auto' ? { runtime: cfg.runtime } : {}) } });
  await c.req({ kind: 'settings.set', key: 'defaultProviderId', value: prov.id });
  for (const p of Object.values(world.projects)) await c.req({ kind: 'workspaces.add', path: p });
  c.ws.close();

  // the window
  const samples = [];
  const electron = require(path.join(ROOT, 'node_modules', 'electron'));
  const result = path.join(out, 'driver.json');
  fs.rmSync(result, { force: true });
  const tabs = world.ids.filter((x) => x.cwd === world.shop).slice(0, 2).map((x) => x.sid).concat(world.ids.filter((x) => x.cwd === world.projects.notes).slice(0, 1).map((x) => x.sid));
  const env = { ...cleanEnv(), ELECTRON_DISABLE_SECURITY_WARNINGS: 'true', PERF_CFG: JSON.stringify({ ...cfg, url: srv.url, out, result, sid: world.sid, tabs, prompt: PROMPT }) };
  const el = spawn(electron, [__filename], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
  const sampler = startSampler(out, [process.pid], (s) => samples.push(s));
  // whatever happens to this process, nothing it started stays behind
  const reap = () => { for (const p of [el, srv.server]) { try { p.kill(); } catch { /* gone */ } } sampler.stop(); };
  process.on('exit', reap);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { reap(); process.exit(130); });
  const wins = {};
  const pending = [];
  let lineBuf = '';
  const onEvent = async (o) => {
    if (o.ev === 'log') { console.log('  [window]', o.text); return; }
    if (o.ev === 'stop-loop') { up.ctl.stopAt = Date.now(); console.log(`  task told to wrap up (${up.ctl.main.length} steps so far)`); return; }
    if (o.ev === 'window-start') {
      console.log(`  ${o.name}: ${o.seconds} s …`);
      const w = wins[o.name] = { t0: Date.now(), cpus0: os.cpus(), up0: { main: up.ctl.main.length, deltas: up.ctl.deltas, other: up.ctl.other, bytesIn: up.ctl.bytesIn }, spawnFrom: fs.existsSync(spawnLog) ? fs.statSync(spawnLog).size : 0 };
      await take();
      if (ins) await ins.send('Profiler.start');
      w.started = true;
      return;
    }
    if (o.ev === 'window-end') {
      const w = wins[o.name];
      w.t1 = Date.now();
      w.cpus1 = os.cpus();
      w.up1 = { main: up.ctl.main.length, deltas: up.ctl.deltas, other: up.ctl.other, bytesIn: up.ctl.bytesIn };
      w.server = await take();
      if (ins) { const { profile } = await ins.send('Profiler.stop'); fs.writeFileSync(path.join(out, `server-${o.name}.cpuprofile`), JSON.stringify(profile)); }
      w.spawnTo = fs.existsSync(spawnLog) ? fs.statSync(spawnLog).size : 0;
    }
  };
  el.stdout.setEncoding('utf8');
  el.stdout.on('data', (d) => { lineBuf += d; let i; while ((i = lineBuf.indexOf('\n')) >= 0) { const line = lineBuf.slice(0, i); lineBuf = lineBuf.slice(i + 1); if (line.startsWith('@@CW ')) { try { pending.push(onEvent(JSON.parse(line.slice(5))).catch((e) => console.log('  event failed:', e.message))); } catch { /* */ } } else if (line.trim()) console.log('  [electron]', line.slice(0, 300)); } });
  el.stderr.on('data', (d) => { const s = String(d).trim(); if (s && !/Electron Security Warning|DevTools listening/.test(s)) console.log('  [electron!]', s.slice(0, 300)); });
  const total = (cfg.seconds * 2 + cfg.after + 600) * 1000;
  const code = await new Promise((res) => { const t = setTimeout(() => { el.kill(); res(-1); }, total); el.on('exit', (cd) => { clearTimeout(t); res(cd); }); });
  await Promise.all(pending);
  await sleep(1500);
  sampler.stop();

  // ---------------------------------------------------------------------------------------------- the summary
  const drv = fs.existsSync(result) ? JSON.parse(fs.readFileSync(result, 'utf8')) : { windows: {}, notes: ['no driver result'] };
  const cmds = {};
  for (const s of samples) Object.assign(cmds, s.c || {});
  const parentOf = new Map();
  const nameOf = new Map();
  for (const s of samples) for (const x of s.p) { parentOf.set(x[0], x[1]); nameOf.set(x[0], x[2]); }
  const under = (pid, anc) => { for (let p = pid, n = 0; p && n < 40; p = parentOf.get(p), n++) if (p === anc) return true; return false; };
  const engineOf = (pid) => { for (let p = pid, n = 0; p && n < 40; p = parentOf.get(p), n++) { const cm = cmds[p] || ''; if (/cli-node\.js|claude-web-engine/.test(cm) || /^claude(\.exe)?$/i.test(nameOf.get(p) || '')) return p; if (p === srv.server.pid) return null; } return null; };
  const label = (pid, x) => {
    if (pid === process.pid) return 'harness: runner + fake upstream';
    if (pid === sampler.pid || under(pid, sampler.pid)) return 'harness: sampler';
    if (pid === srv.server.pid) return 'server (node)';
    if (pid === el.pid) return 'electron main';
    if (under(pid, el.pid)) {
      const cm = cmds[pid] || '';
      const t = /--type=([\w-]+)/.exec(cm);
      if (!t) return 'electron: ' + x[2];
      if (t[1] === 'utility') { const s = /--utility-sub-type=([\w.]+)/.exec(cm); return 'electron utility: ' + (s ? s[1].replace(/\.mojom\./, ' ').split('.').pop() : '?'); }
      return t[1] === 'gpu-process' ? 'electron gpu' : 'electron ' + t[1];
    }
    if (under(pid, srv.server.pid)) {
      const eng = engineOf(pid);
      if (eng === pid) return /cli-node/.test(cmds[pid] || '') ? 'engine (claude-web-engine, node)' : 'engine (' + x[2] + ')';
      if (eng) return 'engine child: ' + x[2];
      return 'server child: ' + x[2];
    }
    if (under(pid, process.pid)) return 'harness child: ' + x[2];
    return null;
  };
  const spawnLines = fs.existsSync(spawnLog) ? fs.readFileSync(spawnLog, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
  const webSym = webSymbolizer(dist);
  const nodeSym = nodeSymbolizer();
  const summary = { config: { ...cfg, out, dist, home: arg('--keep', false) ? home : '(removed)', electronExit: code, platform: `${process.platform} ${os.release()}`, cpus: os.cpus().length, cpuModel: os.cpus()[0].model }, layout: drv.layout, startupMs: drv.startupMs, stillRunningAtEnd: drv.stillRunningAtEnd, final: drv.final, notes: drv.notes, windows: {} };
  for (const name of ['idle', 'running', 'after']) {
    const w = wins[name];
    const d = drv.windows[name];
    if (!w || !w.t1 || !d) continue;
    const secs = (w.t1 - w.t0) / 1000;
    const busy = (() => { let tot = 0; let idle = 0; w.cpus1.forEach((c1, i) => { const c0 = w.cpus0[i]; const t1 = Object.values(c1.times).reduce((a, b) => a + b, 0); const t0 = Object.values(c0.times).reduce((a, b) => a + b, 0); tot += t1 - t0; idle += c1.times.idle - c0.times.idle; }); return +(((tot - idle) / Math.max(1, tot)) * 100).toFixed(1); })();
    const procs = processWindow(samples, w.t0, w.t1, label);
    const sp = spawnLines.filter((r) => r.t >= w.t0 && r.t <= w.t1);
    const spBy = {};
    const spFrom = {};
    for (const r of sp) { add(spBy, `${r.role}: ${path.basename(String(r.cmd))} ${(r.args || []).slice(0, 2).join(' ')}`.trim()); add(spFrom, `${r.role}: ${path.basename(String(r.cmd))} <- ${String(r.from).replace(/\\/g, '/').replace(/^.*?(server\/dist\/|node_modules\/)/, '$1')}`); }
    const rate = (o) => Object.fromEntries(Object.entries(o || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, +(v / secs).toFixed(2)]));
    const pg = d.page || {};
    const pct = (a, q) => { if (!a || !a.length) return null; const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(q * s.length))].toFixed(1); };
    const renderers = (pg.renders || []).map(([nm, n], i) => { const loc = d.renderLocs && d.renderLocs[i]; const s = loc ? webSym({ url: loc.url, lineNumber: loc.lineNumber, columnNumber: loc.columnNumber, functionName: nm }) : null; return { component: s ? s.key : nm, perSec: +(n / secs).toFixed(1) }; });
    const loafScripts = {};
    for (const f of pg.loaf || []) for (const s of f.s || []) add(loafScripts, `${s[0]} ${s[2] || ''} ${String(s[1] || '').split('/').pop()}`.trim(), s[4]);
    const rProf = fs.existsSync(path.join(out, `renderer-${name}.cpuprofile`)) ? analyzeProfile(JSON.parse(fs.readFileSync(path.join(out, `renderer-${name}.cpuprofile`), 'utf8')), webSym, { components: true }) : null;
    const sProf = fs.existsSync(path.join(out, `server-${name}.cpuprofile`)) ? analyzeProfile(JSON.parse(fs.readFileSync(path.join(out, `server-${name}.cpuprofile`), 'utf8')), nodeSym) : null;
    const sv = w.server || {};
    const steps = up.ctl.main.slice(w.up0.main, w.up1.main);
    summary.windows[name] = {
      seconds: +secs.toFixed(1),
      machineBusyPct: busy,
      processes: procs,
      electronAppMetrics: d.electron,
      renderer: {
        metricsPerSec: Object.fromEntries(Object.entries(d.metrics).map(([k, v]) => [k, ['nodes', 'layoutObjects', 'heapMB', 'listeners'].includes(k) ? v : +(v / secs).toFixed(1)])),
        reactCommitsPerSec: +(pg.commits / secs).toFixed(1), storeUpdatesPerSec: +(pg.storeUpdates / secs).toFixed(1), runningConvVersionBumpsPerSec: +(pg.bumps / secs).toFixed(1),
        osrPaintsPerSec: d.paints != null ? +(d.paints / secs).toFixed(1) : null,
        longTasks: { count: (pg.longTasks || []).length, totalMs: Math.round((pg.longTasks || []).reduce((a, b) => a + b, 0)), maxMs: Math.round(Math.max(0, ...(pg.longTasks || []))) },
        longAnimationFrames: { count: (pg.loaf || []).length, totalMs: Math.round((pg.loaf || []).reduce((a, b) => a + b.d, 0)), blockingMs: Math.round((pg.loaf || []).reduce((a, b) => a + (b.b || 0), 0)), renderMs: Math.round((pg.loaf || []).reduce((a, b) => a + (b.render || 0), 0)), topScripts: Object.entries(loafScripts).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => ({ script: k, ms: Math.round(v) })) },
        inputToNextFrameMs: { n: (pg.input || []).length, p50: pct(pg.input, 0.5), p95: pct(pg.input, 0.95), max: pct(pg.input, 1), typedOk: d.typedOk },
        // executeJavaScript round trips sent once a second: how long any task waits for the page's main thread
        scriptQueueMs: { n: (d.scriptRtt || []).length, p50: pct(d.scriptRtt, 0.5), p95: pct(d.scriptRtt, 0.95), max: pct(d.scriptRtt, 1), stillWaiting: d.scriptRttPending, pageAnswerAfterWindowMs: d.pageAnswerMs },
        slowEvents: (pg.events || []).length,
        wsInPerSec: rate(pg.wsIn), wsInKBPerSec: +(Object.values(pg.wsInBytes || {}).reduce((a, b) => a + b, 0) / 1024 / secs).toFixed(1), wsOutPerSec: rate(pg.wsOut),
        componentsRenderedPerSec: renderers.slice(0, 30),
        domNodes: pg.domNodes, dpr: pg.dpr, walkErr: pg.walkErr,
        profile: rProf,
      },
      server: {
        cpuPctSelf: sv.ms ? +(((sv.cpuUserMs + sv.cpuSysMs) / sv.ms) * 100).toFixed(1) : null, eventLoopDelayMs: sv.loop, mem: sv.mem,
        fsCallsPerSec: rate(sv.counts), fsByPathPerSec: (sv.paths || []).map(([k, v]) => [k, +(v / secs).toFixed(2)]).slice(0, 40), fsByCallerPerSec: (sv.callers || []).map(([k, v]) => [k, +(v / secs).toFixed(2)]).slice(0, 40),
        watchEventsPerSec: (sv.watchEv || []).map(([k, v]) => [k, +(v / secs).toFixed(2)]), intervalFiresPerSec: (sv.fires || []).map(([k, v]) => [k, +(v / secs).toFixed(2)]), setTimeoutByCallerPerSec: (sv.timers || []).map(([k, v]) => [k, +(v / secs).toFixed(2)]).slice(0, 20),
        wsSendPerSec: rate(sv.ws), wsSendKBPerSec: +(Object.values(sv.wsBytes || {}).reduce((a, b) => a + b, 0) / 1024 / secs).toFixed(1),
        spawnsPerSec: rate(spBy), spawnsByCaller: rate(spFrom), spawnsTotal: sp.length,
        profile: sProf,
      },
      upstream: { mainLoopRequests: steps.length, stepsPerMin: +(steps.length / secs * 60).toFixed(1), requestKB: steps.length ? Math.round(steps.reduce((a, b) => a + b.kb, 0) / steps.length) : 0, deltasPerSec: +((w.up1.deltas - w.up0.deltas) / secs).toFixed(1), otherRequests: w.up1.other - w.up0.other },
    };
    if (name === 'idle') { summary.serverWatchers = sv.watchReg; summary.serverIntervals = sv.intervals; }
    if (name === 'running') summary.serverIntervalsAfterRun = sv.intervals;
  }
  summary.upstreamSteps = up.ctl.main.map((x) => ({ t: x.t, k: x.k, kb: x.kb, final: x.final }));
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  const report = formatReport(summary);
  fs.writeFileSync(path.join(out, 'report.txt'), report);
  console.log('\n' + report);
  console.log(`\nfull results: ${path.join(out, 'summary.json')}`);

  try { fs.writeFileSync(path.join(out, "server.log"), srv.log()); } catch { /* */ }
  if (ins) ins.close();
  srv.server.kill();
  up.server.close();
  if (!arg('--keep', false)) { await sleep(800); try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* a handle may still be held */ } }
  process.exit(code === 0 ? 0 : 1);
}

function formatReport(S) {
  const W = ['idle', 'running', 'after'].filter((n) => S.windows[n]);
  const L = [];
  const pad = (s, n) => String(s ?? '').padEnd(n);
  const rpad = (s, n) => String(s ?? '').padStart(n);
  L.push(`perf-busy  ${S.config.platform}, ${S.config.cpus} logical CPUs (${S.config.cpuModel})  window ${S.layout && S.layout.size} @${S.layout && S.layout.dpr}x  ${S.config.show ? 'visible window' : 'offscreen'}`);
  L.push(`conversation: ${S.layout && S.layout.items} items open, ${S.layout && S.layout.sessions} conversations listed, ${S.layout && S.layout.openTabs} tabs; engine ${S.config.runtime} / ${S.config.model}; task started streaming ${S.startupMs} ms after send; state at end of running window: ${S.stillRunningAtEnd}`);
  if (S.notes && S.notes.length) L.push('notes: ' + S.notes.join(' | '));
  L.push('');
  L.push('CPU % of one core (100 = one core busy), averaged over each window');
  L.push(pad('process', 44) + W.map((n) => rpad(n, 10)).join('') + rpad('MB(run)', 9) + rpad('wrKB/s', 9) + rpad('rdKB/s', 9));
  const keys = new Set();
  for (const n of W) for (const k of Object.keys((S.windows[n].processes || {}).groups || {})) keys.add(k);
  const run = (S.windows.running && S.windows.running.processes && S.windows.running.processes.groups) || {};
  const sorted = [...keys].sort((a, b) => ((run[b] && run[b].cpuPct) || 0) - ((run[a] && run[a].cpuPct) || 0));
  for (const k of sorted) L.push(pad(k, 44) + W.map((n) => { const g = S.windows[n].processes && S.windows[n].processes.groups[k]; return rpad(g ? g.cpuPct : '-', 10); }).join('') + rpad(run[k] ? run[k].privMB : '', 9) + rpad(run[k] ? run[k].writeKBs : '', 9) + rpad(run[k] ? run[k].readKBs : '', 9));
  L.push(pad('machine busy (% of all cores, os.cpus)', 44) + W.map((n) => rpad(S.windows[n].machineBusyPct, 10)).join(''));
  for (const n of W) { const o = S.windows[n].processes && S.windows[n].processes.others; if (o) L.push(`  other processes (${n}): ` + Object.entries(o).slice(0, 6).map(([k, v]) => `${k} ${v.cpuPct}%`).join(', ')); }
  L.push('');
  const row = (label, f) => L.push(pad(label, 44) + W.map((n) => rpad(f(S.windows[n]), 10)).join(''));
  L.push('renderer');
  row('main-thread task ms/s (Performance)', (w) => w.renderer.metricsPerSec.taskMs);
  row('  script ms/s', (w) => w.renderer.metricsPerSec.scriptMs);
  row('  style recalc ms/s', (w) => w.renderer.metricsPerSec.styleMs);
  row('  layout ms/s', (w) => w.renderer.metricsPerSec.layoutMs);
  row('  layouts/s', (w) => w.renderer.metricsPerSec.layouts);
  row('profile busy % of wall', (w) => w.renderer.profile && w.renderer.profile.busyPct);
  row('React commits/s', (w) => w.renderer.reactCommitsPerSec);
  row('store updates/s', (w) => w.renderer.storeUpdatesPerSec);
  row('running conv version bumps/s', (w) => w.renderer.runningConvVersionBumpsPerSec);
  row('offscreen paints/s', (w) => w.renderer.osrPaintsPerSec);
  row('long tasks (count)', (w) => w.renderer.longTasks.count);
  row('long tasks total ms', (w) => w.renderer.longTasks.totalMs);
  row('long animation frames (count)', (w) => w.renderer.longAnimationFrames.count);
  row('input → next frame p50 ms', (w) => w.renderer.inputToNextFrameMs.p50);
  row('input → next frame p95 ms', (w) => w.renderer.inputToNextFrameMs.p95);
  row('input → next frame max ms', (w) => w.renderer.inputToNextFrameMs.max);
  row('script waits for main thread p50 ms', (w) => w.renderer.scriptQueueMs.p50);
  row('script waits for main thread max ms', (w) => w.renderer.scriptQueueMs.max);
  row('page answered after window (ms)', (w) => w.renderer.scriptQueueMs.pageAnswerAfterWindowMs);
  row('WS messages in/s', (w) => +Object.values(w.renderer.wsInPerSec).reduce((a, b) => a + b, 0).toFixed(1));
  row('WS KB in/s', (w) => w.renderer.wsInKBPerSec);
  row('WS requests out/s', (w) => +Object.values(w.renderer.wsOutPerSec).reduce((a, b) => a + b, 0).toFixed(1));
  row('DOM nodes', (w) => w.renderer.domNodes);
  row('JS heap MB', (w) => w.renderer.metricsPerSec.heapMB);
  L.push('');
  L.push('server');
  row('self CPU % (process.cpuUsage)', (w) => w.server.cpuPctSelf);
  row('event loop delay p99 ms', (w) => w.server.eventLoopDelayMs && w.server.eventLoopDelayMs.p99 && +w.server.eventLoopDelayMs.p99.toFixed(1));
  row('event loop delay max ms', (w) => w.server.eventLoopDelayMs && w.server.eventLoopDelayMs.max && +w.server.eventLoopDelayMs.max.toFixed(1));
  row('WS sends/s', (w) => +Object.values(w.server.wsSendPerSec).reduce((a, b) => a + b, 0).toFixed(1));
  row('WS KB sent/s', (w) => w.server.wsSendKBPerSec);
  row('spawned processes (total)', (w) => w.server.spawnsTotal);
  row('fs.watch events/s', (w) => w.server.fsCallsPerSec['fs.watch event'] || 0);
  row('upstream steps/min', (w) => w.upstream.stepsPerMin);
  row('upstream deltas/s', (w) => w.upstream.deltasPerSec);
  row('upstream request KB (avg)', (w) => w.upstream.requestKB);
  const R = S.windows.running;
  if (R) {
    const list = (title, arr, f) => { L.push(''); L.push(title); for (const x of (arr || []).slice(0, 18)) L.push('  ' + f(x)); };
    if (R.renderer.profile) {
      list(`renderer self time, running (busy ${R.renderer.profile.busyMs} ms of ${R.renderer.profile.wallMs}; (program) ${R.renderer.profile.programMs} ms, GC ${R.renderer.profile.gcMs} ms)`, R.renderer.profile.selfTop, (x) => `${rpad(x.ms, 7)} ms ${rpad(x.pctBusy, 5)}%  ${x.fn}`);
      list('renderer inclusive time by React component, running', R.renderer.profile.components, (x) => `${rpad(x.ms, 7)} ms ${rpad(x.pctBusy, 5)}%  ${x.fn}`);
      list('renderer self time by source file, running', R.renderer.profile.byFile, (x) => `${rpad(x.ms, 7)} ms ${rpad(x.pctBusy, 5)}%  ${x.fn}`);
    }
    list('components rendered per second, running', R.renderer.componentsRenderedPerSec, (x) => `${rpad(x.perSec, 7)}/s ${rpad(R.renderer.reactCommitsPerSec ? (x.perSec / R.renderer.reactCommitsPerSec).toFixed(1) : "", 6)}/commit  ${x.component}`);
    list('WS in per second, running', Object.entries(R.renderer.wsInPerSec), ([k, v]) => `${rpad(v, 7)}/s  ${k}`);
    list('WS requests out per second, running', Object.entries(R.renderer.wsOutPerSec), ([k, v]) => `${rpad(v, 7)}/s  ${k}`);
    list('long animation frames: scripts by time, running', R.renderer.longAnimationFrames.topScripts, (x) => `${rpad(x.ms, 7)} ms  ${x.script}`);
    list('electron processes (app.getAppMetrics), running', Object.values(R.electronAppMetrics || {}), (x) => `${rpad(x.cpuPct, 7)}%  ${x.type} ${x.name}  wakeups/s ${x.wakeupsPerSec}  ${x.memMB} MB`);
    if (R.server.profile) list(`server self time, running (busy ${R.server.profile.busyMs} ms of ${R.server.profile.wallMs}; GC ${R.server.profile.gcMs} ms)`, R.server.profile.selfTop, (x) => `${rpad(x.ms, 7)} ms ${rpad(x.pctBusy, 5)}%  ${x.fn}`);
    if (R.server.profile) list('server inclusive time, running', R.server.profile.inclusiveTop, (x) => `${rpad(x.ms, 7)} ms ${rpad(x.pctBusy, 5)}%  ${x.fn}`);
    list('server fs calls per second, running', Object.entries(R.server.fsCallsPerSec), ([k, v]) => `${rpad(v, 7)}/s  ${k}`);
    list('server fs by path, running', R.server.fsByPathPerSec, ([k, v]) => `${rpad(v, 7)}/s  ${k}`);
    list('server fs by caller, running', R.server.fsByCallerPerSec, ([k, v]) => `${rpad(v, 7)}/s  ${k}`);
    list('fs.watch events, running', R.server.watchEventsPerSec, ([k, v]) => `${rpad(v, 7)}/s  ${k}`);
    list('setInterval firings, running', R.server.intervalFiresPerSec, ([k, v]) => `${rpad(v, 7)}/s  ${k}`);
    list('spawns, running', Object.entries(R.server.spawnsPerSec), ([k, v]) => `${rpad(v, 7)}/s  ${k}`);
    list('spawns by caller, running', Object.entries(R.server.spawnsByCaller), ([k, v]) => `${rpad(v, 7)}/s  ${k}`);
    list('server WS sends per second, running', Object.entries(R.server.wsSendPerSec), ([k, v]) => `${rpad(v, 7)}/s  ${k}`);
  }
  return L.join('\n');
}

// ======================================================================================================= dispatch
// (Electron loads its main script without making it require.main)
if (process.versions.electron) driver().catch((e) => { console.error(e); process.exit(2); });
else if (process.env.CW_PERF_PRELOAD === '1' && require.main !== module) serverPreload();
else if (require.main === module) runner().catch((e) => { console.error(e); process.exit(2); });

module.exports = { analyzeProfile, webSymbolizer, nodeSymbolizer, formatReport };
