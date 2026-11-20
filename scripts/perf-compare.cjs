// Two perf-busy runs side by side (their running windows, and the machine's idle load): what changed.
//   node scripts/perf-compare.cjs <before out dir> <after out dir> [label]
// Rates per second move with how fast the fake upstream got on (a busy machine): compare per streamed event / step too.
const fs = require('node:fs');
const path = require('node:path');
const [a, b, label] = process.argv.slice(2);
const A = JSON.parse(fs.readFileSync(path.join(a, 'summary.json'), 'utf8'));
const B = JSON.parse(fs.readFileSync(path.join(b, 'summary.json'), 'utf8'));
const g = (S, w, f) => { try { const v = f(S.windows[w]); return v == null ? '-' : v; } catch { return '-'; } };
const grp = (S, w, k) => g(S, w, (x) => x.processes.groups[k] && x.processes.groups[k].cpuPct);
const rows = [
  ['machine busy % (idle, all cores)', (S) => g(S, 'idle', (x) => x.machineBusyPct)],
  ['renderer main thread ms/s', (S) => g(S, 'running', (x) => x.renderer.metricsPerSec.taskMs)],
  ['  script ms/s', (S) => g(S, 'running', (x) => x.renderer.metricsPerSec.scriptMs)],
  ['  style recalc ms/s', (S) => g(S, 'running', (x) => x.renderer.metricsPerSec.styleMs)],
  ['  layout ms/s', (S) => g(S, 'running', (x) => x.renderer.metricsPerSec.layoutMs)],
  ['renderer profile busy %', (S) => g(S, 'running', (x) => x.renderer.profile && x.renderer.profile.busyPct)],
  ['React commits/s', (S) => g(S, 'running', (x) => x.renderer.reactCommitsPerSec)],
  ['long tasks total ms', (S) => g(S, 'running', (x) => x.renderer.longTasks.totalMs)],
  ['input → next frame p50 ms', (S) => g(S, 'running', (x) => x.renderer.inputToNextFrameMs.p50)],
  ['input → next frame p95 ms', (S) => g(S, 'running', (x) => x.renderer.inputToNextFrameMs.p95)],
  ['input → next frame max ms', (S) => g(S, 'running', (x) => x.renderer.inputToNextFrameMs.max)],
  ['offscreen paints/s', (S) => g(S, 'running', (x) => x.renderer.osrPaintsPerSec)],
  ['3D cafe frames/s', (S) => g(S, 'running', (x) => x.renderer.cafeFramesPerSec)],
  ['3D cafe draw calls (last frame)', (S) => g(S, 'running', (x) => x.renderer.cafeDraw && x.renderer.cafeDraw.calls)],
  ['WS messages in/s', (S) => g(S, 'running', (x) => +Object.values(x.renderer.wsInPerSec).reduce((p, q) => p + q, 0).toFixed(1))],
  ['server CPU %', (S) => g(S, 'running', (x) => x.server.cpuPctSelf)],
  ['server WS sends/s', (S) => g(S, 'running', (x) => +Object.values(x.server.wsSendPerSec).reduce((p, q) => p + q, 0).toFixed(1))],
  ['server event loop max ms', (S) => g(S, 'running', (x) => x.server.eventLoopDelayMs && Math.round(x.server.eventLoopDelayMs.max))],
  ['CPU% electron renderer', (S) => grp(S, 'running', 'electron renderer')],
  ['CPU% electron gpu', (S) => grp(S, 'running', 'electron gpu')],
  ['CPU% server (node)', (S) => grp(S, 'running', 'server (node)')],
  ['CPU% engines', (S) => grp(S, 'running', 'engine (claude.exe)')],
  ['MB engines', (S) => g(S, 'running', (x) => x.processes.groups['engine (claude.exe)'] && x.processes.groups['engine (claude.exe)'].privMB)],
  ['upstream steps/min', (S) => g(S, 'running', (x) => x.upstream.stepsPerMin)],
  // per unit of work: what one streamed event / one step of the task cost the renderer and the server
  ['renderer ms per streamed event', (S) => g(S, 'running', (x) => { const n = x.renderer.wsInPerSec['event session.event stream_event']; return n ? +(x.renderer.metricsPerSec.taskMs / n).toFixed(2) : null; })],
  ['renderer ms per step', (S) => g(S, 'running', (x) => (x.upstream.stepsPerMin ? Math.round(x.renderer.metricsPerSec.taskMs / (x.upstream.stepsPerMin / 60)) : null))],
  ['server CPU ms per step', (S) => g(S, 'running', (x) => (x.upstream.stepsPerMin && x.server.cpuPctSelf != null ? Math.round((x.server.cpuPctSelf * 10) / (x.upstream.stepsPerMin / 60)) : null))],
];
const pad = (s, n) => String(s).padEnd(n);
const rp = (s, n) => String(s).padStart(n);
console.log(`${label || ''}\n${pad('', 36)}${rp('before', 10)}${rp('after', 10)}`);
for (const [k, f] of rows) console.log(pad(k, 36) + rp(f(A), 10) + rp(f(B), 10));
