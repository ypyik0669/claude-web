// perf-busy's trace (CW_PERF_TRACE=1 → <out>/trace-running.json) summed up: the renderer main thread's time by event
// name, paints and what they covered, style invalidations by reason / node (the 'StyleRecalc Animation' rows are
// CSS animations ticked on the main thread), function calls by script, animations.
//   node scripts/perf-trace-sum.cjs <trace-running.json>
const fs = require('node:fs');
const { traceEvents: ev } = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
// the renderer main thread: the thread with the most "UpdateLayoutTree" / "FunctionCall" events
const threadCount = {};
for (const e of ev) if (e.name === 'FunctionCall' || e.name === 'UpdateLayoutTree' || e.name === 'Paint') { const k = `${e.pid}:${e.tid}`; threadCount[k] = (threadCount[k] || 0) + 1; }
const main = Object.entries(threadCount).sort((a, b) => b[1] - a[1])[0][0];
const onMain = ev.filter((e) => `${e.pid}:${e.tid}` === main);
const ts = onMain.filter((e) => e.ts).map((e) => e.ts);
const span = (Math.max(...ts) - Math.min(...ts)) / 1e6;
const add = (o, k, v = 1) => { o[k] = (o[k] || 0) + v; };
const byName = {};
for (const e of onMain) if (e.ph === 'X' && e.dur) add(byName, e.name, e.dur / 1000);
console.log(`main thread ${main}, ${span.toFixed(2)} s traced`);
console.log('\ntop events by total ms (complete events, nested time counted in each):');
for (const [k, v] of Object.entries(byName).sort((a, b) => b[1] - a[1]).slice(0, 22)) console.log(`  ${v.toFixed(0).padStart(7)} ms  ${k}`);
const paints = onMain.filter((e) => e.name === 'Paint');
console.log(`\nPaint events: ${paints.length} (${(paints.length / span).toFixed(1)}/s)`);
const paintNodes = {};
for (const p of paints) { const d = p.args && p.args.data; if (d) add(paintNodes, `${d.nodeName || '?'} ${d.clip ? 'clip ' + JSON.stringify(d.clip).slice(0, 60) : ''}`); }
for (const [k, v] of Object.entries(paintNodes).sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${String(v).padStart(5)}x  ${k}`);
const raf = {};
const timers = {};
for (const e of onMain) {
  if (e.name === 'FireAnimationFrame' && e.dur) add(raf, 'FireAnimationFrame', e.dur / 1000);
  if (e.name === 'TimerFire' && e.dur) add(timers, 'TimerFire', e.dur / 1000);
  if (e.name === 'FunctionCall' && e.args && e.args.data) { const d = e.args.data; add(raf, `${(d.url || '').split('/').pop()}:${d.lineNumber} ${d.functionName || ''}`, (e.dur || 0) / 1000); }
}
console.log('\nFunctionCall time by script (url:line fn):');
for (const [k, v] of Object.entries(raf).sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(`  ${v.toFixed(0).padStart(7)} ms  ${k}`);
const inv = {};
for (const e of ev) if (e.name === 'StyleInvalidatorInvalidationTracking' || e.name === 'StyleRecalcInvalidationTracking' || e.name === 'ScheduleStyleInvalidationTracking') { const d = e.args && e.args.data; if (d) add(inv, `${e.name.replace('InvalidationTracking', '')} ${d.reason || ''} ${d.nodeName || ''} ${(d.invalidationList || []).map((x) => x.classes || x.id || '').join(',')}`.slice(0, 140)); }
console.log('\nstyle invalidations (top):');
for (const [k, v] of Object.entries(inv).sort((a, b) => b[1] - a[1]).slice(0, 18)) console.log(`  ${String(v).padStart(6)}x  ${k}`);
const anim = {};
for (const e of ev) if (e.name === 'Animation' && e.args && e.args.data && e.args.data.name) add(anim, e.args.data.name);
console.log('\nanimations started (by name):');
for (const [k, v] of Object.entries(anim).sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${String(v).padStart(5)}x  ${k}`);
const frames = onMain.filter((e) => e.name === 'BeginMainThreadFrame' || e.name === 'BeginFrame');
console.log(`\nBeginMainThreadFrame/BeginFrame on main: ${frames.length} (${(frames.length / span).toFixed(1)}/s)`);
