// Phase 25 end-to-end (2026-10-12): 后台 — a workflow's agents seen from the server, over a real server and the real
// Claude Code against a fake Anthropic upstream started here (no model, no token). Checks:
//   · the main loop calls the Workflow tool → background.changed carries the workflow (its name), its phases and
//     agents, they go from queued / running to done, and the turn's events have a feed line per agent;
//   · background.transcript reads a workflow agent's own conversation;
//   · background.list has the conversation; background.history lists the finished run, background.run reads it back;
//   · a workflow whose agent is slow keeps running when the turn is stopped (session.interrupt: the turn's Stop
//     spares background work — perTaskStopAffordance), and session.stopTask stops it;
//   · when the conversation's process ends, what was still running is marked stopped (进程结束了).
//   node server/ws-phase25.mjs   (starts its own server; scripts/e2e.mjs' port/token are ignored)
import WebSocket from 'ws';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-phase25-'));
const home = path.join(root, 'home');
const proj = path.join(root, 'proj');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(proj, { recursive: true });
fs.writeFileSync(path.join(proj, 'README.md'), '# e2e\n');
const RELAY_KEY = 'relay-key-e2e';

const results = [];
const checkRaw = (name, ok, detail = '') => { results.push([name, !!ok]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const until = async (fn, ms, step = 200) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await new Promise((r) => setTimeout(r, step)); } };

// ---- the workflows the fake model writes ----
const QUICK = `export const meta = { name: 'e2e-flow', description: 'two phases, three agents', phases: [{ title: 'One' }, { title: 'Two' }] }
phase('One')
await parallel([() => agent('BGAGENT alpha: answer ok', { label: 'alpha', phase: 'One' }), () => agent('BGAGENT beta: answer ok', { label: 'beta', phase: 'One' })])
phase('Two')
await agent('BGAGENT gamma: answer ok', { label: 'gamma', phase: 'Two' })
return { ok: true }`;
const SLOW = `export const meta = { name: 'e2e-slow', description: 'one slow agent', phases: [{ title: 'Wait' }] }
phase('Wait')
await agent('BGAGENT delta SLOW: answer ok', { label: 'delta', phase: 'Wait' })
return { ok: true }`;

// ---- the fake upstream ----
const hits = [];
let n = 0;
const held = new Set(); // slow agent requests still open (a stopped workflow's agent request is closed by the engine)
let slowClosed = 0;
const textOf = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => typeof p === 'string' ? p : p?.text ?? (typeof p?.content === 'string' ? p.content : Array.isArray(p?.content) ? textOf(p.content) : '')).join('\n') : '';
const allUser = (j) => (j.messages ?? []).filter((m) => m.role === 'user').map((m) => textOf(m.content)).join('\n');
const lastToolResult = (j) => {
  const last = (j.messages ?? []).at(-1);
  if (last?.role !== 'user' || !Array.isArray(last.content)) return null;
  return last.content.find((b) => b?.type === 'tool_result') ?? null;
};
/** The user content of the request's current turn: every user message after the last assistant one (an engine may
 *  add a reminder of its own after the user's words). */
const turnText = (j) => {
  const msgs = j.messages ?? [];
  let i = msgs.length;
  while (i > 0 && msgs[i - 1].role !== 'assistant') i--;
  return msgs.slice(i).filter((m) => m.role === 'user').map((m) => textOf(m.content)).join('\n');
};
const json = (s, status, o) => s.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(o));

function sse(s, j, blocks, stop) {
  const msg = { id: `msg_${++n}`, type: 'message', role: 'assistant', model: j.model, stop_sequence: null };
  const ev = (type, o) => `event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`;
  let out = ev('message_start', { message: { ...msg, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  blocks.forEach((b, i) => {
    if (b.type === 'text') {
      out += ev('content_block_start', { index: i, content_block: { type: 'text', text: '' } }) + ev('content_block_delta', { index: i, delta: { type: 'text_delta', text: b.text } });
    } else {
      out += ev('content_block_start', { index: i, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } }) + ev('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    }
    out += ev('content_block_stop', { index: i });
  });
  out += ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 3 } }) + ev('message_stop', {});
  s.writeHead(200, { 'content-type': 'text/event-stream' });
  s.end(out);
}

function anthropic(q, s, j, h) {
  if (q.url.includes('/count_tokens')) return json(s, 200, { input_tokens: 10 });
  const msg = { id: `msg_${++n}`, type: 'message', role: 'assistant', model: j.model, stop_sequence: null };
  const tr = lastToolResult(j);
  h.tools = (j.tools ?? []).map((t) => t.name);
  const plain = (text) => (j.stream ? sse(s, j, [{ type: 'text', text }], 'end_turn') : json(s, 200, { ...msg, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2 } }));
  // a workflow's agent (streamed or not, depending on the CLI; it may carry the parent's conversation before its prompt)
  if (/BGAGENT/.test(textOf((j.messages ?? []).at(-1)?.content))) {
    h.role = 'agent';
    if (/SLOW/.test(textOf((j.messages ?? []).at(-1)?.content))) {
      held.add(s);
      s.on('close', () => { if (held.delete(s)) slowClosed++; });
      setTimeout(() => { if (held.delete(s)) plain('agent-ok (slow)'); }, 45_000);
      return;
    }
    // a moment of work, so a push (1 s apart at most) finds it running
    setTimeout(() => plain('agent-ok'), 1500);
    return;
  }
  if (!j.stream) return plain('side:ok');
  h.role = 'main';
  if (/<task-notification>|task-notification/.test(textOf((j.messages ?? []).at(-1)?.content))) return sse(s, j, [{ type: 'text', text: 'main: the workflow finished' }], 'end_turn');
  if (tr) {
    if (tr.tool_use_id === 'toolu_wf_slow') return sse(s, j, [{ type: 'tool_use', id: 'toolu_wait', name: 'Bash', input: { command: 'node -e "setTimeout(()=>{},30000)"', description: 'Wait a while' } }], 'tool_use');
    return sse(s, j, [{ type: 'text', text: `main: after ${tr.tool_use_id}` }], 'end_turn');
  }
  const lastUser = turnText(j);
  if (/RUN-QUICK/.test(lastUser)) return sse(s, j, [{ type: 'tool_use', id: 'toolu_wf_quick', name: 'Workflow', input: { script: QUICK } }], 'tool_use');
  if (/RUN-SLOW/.test(lastUser)) return sse(s, j, [{ type: 'tool_use', id: 'toolu_wf_slow', name: 'Workflow', input: { script: SLOW } }], 'tool_use');
  return sse(s, j, [{ type: 'text', text: 'main:ok' }], 'end_turn');
}

const upstream = http.createServer((q, s) => {
  let raw = '';
  q.on('data', (c) => { raw += c; });
  q.on('end', () => {
    let j = {};
    try { j = JSON.parse(raw || '{}'); } catch { /* keep */ }
    const h = { method: q.method, url: q.url ?? '', body: j, status: 200 };
    hits.push(h);
    if (h.url.startsWith('/v1/messages')) return anthropic(q, s, j, h);
    if (h.url.includes('/models')) return json(s, 200, { data: [{ id: 'claude-sonnet-4-6', type: 'model' }] });
    json(s, 404, { error: { message: 'no' } });
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const up = `http://127.0.0.1:${upstream.address().port}`;

// ---- the server: throwaway HOME, no proxy ----
const token = randomBytes(12).toString('hex');
const env = { ...process.env, HOME: home, USERPROFILE: home, PORT: '0', CLAUDE_WEB_TOKEN: token, CLAUDE_WEB_DIR: path.join(home, '.claude-web'), CW_NO_MODEL_REFRESH: '1', CW_NO_PUBLIC_BROKERS: '1' };
for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_CONFIG_DIR|OPENAI_|GEMINI_|GROK_|XAI_)/.test(k) || /^(no_proxy|https?_proxy|all_proxy)$/i.test(k)) delete env[k];
const server = spawn(process.execPath, [path.join(here, 'dist', 'index.js')], { cwd: path.dirname(here), env, stdio: ['ignore', 'pipe', 'pipe'] });
let slog = '';
server.stderr.on('data', (d) => { slog += d; });
const port = await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`server did not start in 60s\n${slog}`)), 60_000);
  server.stdout.on('data', (d) => { slog += d; const m = /listening on http:\/\/[^:]+:(\d+)/.exec(slog); if (m) { clearTimeout(t); res(m[1]); } });
  server.on('exit', (c) => rej(new Error(`server exited (${c})\n${slog}`)));
});

const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
let seq = 0;
const pending = new Map();
const events = [];
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type === 'reply') { const p = pending.get(m.reply.id); pending.delete(m.reply.id); m.reply.ok ? p.res(m.reply.data) : p.rej(new Error(m.reply.error)); return; }
  if (m.type === 'event') events.push(m.event);
});
const req = (r) => new Promise((res, rej) => { const id = String(++seq); pending.set(id, { res, rej }); ws.send(JSON.stringify({ type: 'request', request: { id, req: r } })); });
const resultOf = (sid, from, ms = 120_000) => until(() => events.slice(from).find((e) => e.kind === 'session.event' && e.sessionId === sid && e.message.type === 'result')?.message, ms);
/** the latest background push of a conversation */
const bgOf = (sid) => events.filter((e) => e.kind === 'background.changed' && e.session.sessionId === sid).at(-1)?.session;
const wfOf = (sid, name) => bgOf(sid)?.tasks.find((t) => t.kind === 'workflow' && (t.name === name || t.description.includes(name)));

let sid = '';
const opened = [];
async function main() {
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  await req({ kind: 'settings.set', key: 'network.proxy', value: 'off' });
  await suite('claude');
}

async function suite(runtime) {
  const check = (name, ok, detail) => checkRaw(name, ok, detail);
  hits.length = 0; held.clear(); slowClosed = 0;
  const A = await req({ kind: 'providers.upsert', provider: { name: `中转${runtime}`, type: 'anthropic', baseUrl: up, apiKey: RELAY_KEY, defaultModel: 'claude-sonnet-4-6', models: ['claude-sonnet-4-6'] } });
  const o = await req({ kind: 'session.open', params: { cwd: proj, providerId: A.id, model: 'claude-sonnet-4-6', permissionMode: 'bypassPermissions' } });
  sid = o.sessionId;
  opened.push(sid);
  await until(() => events.some((e) => e.kind === 'session.state' && e.sessionId === sid && e.state === 'idle'), 90_000);

  // ---- a quick workflow: two phases, three agents ----
  let from = events.length;
  await req({ kind: 'session.send', params: { sessionId: sid, text: 'RUN-QUICK 跑一个工作流' } });
  const mainReq = await until(() => hits.find((h) => h.role === 'main'), 60_000);
  check('the main loop is offered the Workflow tool', mainReq?.tools?.includes('Workflow'), (mainReq?.tools ?? []).join(',').slice(0, 300));
  // the turn that launched it ends while it runs (the composer is free again); the workflow's end starts a turn of its own
  const launched = await resultOf(sid, from);
  const whileRunning = wfOf(sid, 'e2e-flow')?.status === 'running';
  check('the launching turn ends while the workflow still runs', !!launched && whileRunning, `${launched?.subtype} ${String(launched?.result ?? '').slice(0, 60)} · workflow ${wfOf(sid, 'e2e-flow')?.status}`);
  const done = await until(() => { const t = wfOf(sid, 'e2e-flow'); return t && t.status !== 'running' && t; }, 120_000);
  const afterFrom = events.indexOf(events.find((e) => e.kind === 'session.event' && e.sessionId === sid && e.message === launched)) + 1;
  const notified = await until(() => events.slice(afterFrom).find((e) => e.kind === 'session.event' && e.sessionId === sid && e.message.type === 'result')?.message, 60_000);
  check('… and when it ends, a turn of its own answers the notification', /the workflow finished/.test(String(notified?.result ?? '')), String(notified?.result ?? notified?.subtype ?? '(no second result)').slice(0, 120));
  const wf = wfOf(sid, 'e2e-flow');
  check('background.changed carries the workflow by its name', !!wf, JSON.stringify(bgOf(sid)?.tasks.map((t) => ({ k: t.kind, n: t.name, d: t.description, s: t.status })) ?? null));
  check('… with its two phases', wf?.phases?.map((p) => p.title).join(',') === 'One,Two', JSON.stringify(wf?.phases));
  check('… and its three agents, each in its phase', wf?.agents?.map((a) => `${a.label}:${a.phaseTitle}`).sort().join(',') === 'alpha:One,beta:One,gamma:Two', JSON.stringify(wf?.agents?.map((a) => [a.label, a.phaseTitle, a.state])));
  check('… the workflow completes and every agent is done', done?.status === 'completed' && done.agents.every((a) => a.state === 'done'), `${done?.status} ${JSON.stringify(done?.agents?.map((a) => a.state))}`);
  const states = new Set(events.slice(from).filter((e) => e.kind === 'background.changed' && e.session.sessionId === sid).flatMap((e) => e.session.tasks.flatMap((t) => t.agents.map((a) => `${a.label}:${a.state}`))));
  check('… an agent was seen running before it was done', [...states].some((x) => x.endsWith(':running')), [...states].join(' '));
  const feed = bgOf(sid)?.events ?? [];
  check('the feed says when each agent started and finished', ['alpha', 'beta', 'gamma'].every((w) => feed.some((e) => e.who === w && e.tone === 'start') && feed.some((e) => e.who === w && e.tone === 'done')), feed.map((e) => `${e.who}|${e.tone}|${e.text}`).join(' · ').slice(0, 300));
  const alpha = wf?.agents?.find((a) => a.label === 'alpha');
  const tx = alpha?.agentId ? await until(async () => { const m = await req({ kind: 'background.transcript', sessionId: sid, agentId: alpha.agentId }); return m.length ? m : null; }, 15_000) : null;
  check('background.transcript reads a workflow agent\'s own conversation', Array.isArray(tx) && tx.some((m) => m.type === 'assistant'), `agentId=${alpha?.agentId} messages=${tx?.length ?? 0}`);
  const list = await req({ kind: 'background.list' });
  check('background.list has the conversation', list.some((s) => s.sessionId === sid && s.tasks.some((t) => t.kind === 'workflow')));
  const runs = await until(async () => { const r = await req({ kind: 'background.history', sessionId: sid }); return r.length ? r : null; }, 15_000);
  check('background.history lists the finished run', runs?.some((r) => r.name === 'e2e-flow'), JSON.stringify(runs));
  const run = runs?.[0] ? await req({ kind: 'background.run', sessionId: sid, runId: runs[0].runId }) : null;
  check('… and background.run reads it back with its agents', run?.agents?.length === 3, JSON.stringify(run?.agents?.map((a) => [a.label, a.state])));
  await until(() => events.some((e) => e.kind === 'session.state' && e.sessionId === sid && e.state === 'idle') && !events.slice(-3).some((e) => e.kind === 'session.state' && e.sessionId === sid && e.state === 'running'), 30_000);

  // ---- a slow workflow: the turn's Stop spares it, stopTask stops it ----
  from = events.length;
  await req({ kind: 'session.send', params: { sessionId: sid, text: 'RUN-SLOW 跑一个慢的工作流' } });
  const waiting = await until(() => held.size > 0 && events.slice(from).some((e) => e.kind === 'session.event' && e.sessionId === sid && e.message.type === 'assistant' && JSON.stringify(e.message.message?.content ?? '').includes('toolu_wait')), 90_000);
  check('the slow agent is working and the turn is busy with a command', !!waiting, `held=${held.size}`);
  await req({ kind: 'session.interrupt', sessionId: sid });
  const stopped = await resultOf(sid, from, 30_000);
  check('the turn\'s Stop ends the turn', !!stopped, stopped?.subtype);
  await new Promise((r) => setTimeout(r, 2500));
  const slow = wfOf(sid, 'e2e-slow');
  check('… and the workflow keeps running (perTaskStopAffordance)', slow?.status === 'running' && held.size === 1 && slowClosed === 0, `status=${slow?.status} held=${held.size} closed=${slowClosed}`);
  await req({ kind: 'session.stopTask', sessionId: sid, taskId: slow?.id });
  const killed = await until(() => { const t = wfOf(sid, 'e2e-slow'); return t && t.status !== 'running' && t; }, 30_000);
  check('session.stopTask stops the workflow', killed?.status === 'stopped' || killed?.status === 'failed', `${killed?.status}`);

  // ---- the process going takes what runs with it ----
  from = events.length;
  await req({ kind: 'session.send', params: { sessionId: sid, text: 'RUN-SLOW 再跑一个' } });
  await until(() => wfOf(sid, 'e2e-slow') && bgOf(sid).tasks.filter((t) => t.name === 'e2e-slow' && t.status === 'running').length, 60_000);
  await req({ kind: 'session.close', sessionId: sid });
  const gone = await until(() => { const t = bgOf(sid)?.tasks.filter((x) => x.name === 'e2e-slow').at(-1); return t && t.status !== 'running' && t; }, 30_000);
  // (the CLI may say so itself on its way out — a task_notification `stopped` — or just go: then 进程结束了)
  check('closing the conversation\'s process ends what ran in its background', gone?.status === 'stopped', `${gone?.status} ${gone?.reason ?? '(the CLI said so)'}`);
}

main().catch((e) => { checkRaw('phase25 ran to the end', false, e.stack || e.message); }).finally(async () => {
  for (const x of opened) await req({ kind: 'session.close', sessionId: x }).catch(() => {});
  for (const s of held) { try { s.destroy(); } catch { /* */ } }
  try { ws.close(); } catch { /* */ }
  server.kill();
  upstream.closeAllConnections(); upstream.close();
  await new Promise((r) => setTimeout(r, 800));
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows may still hold a handle */ }
  const bad = results.filter(([, ok]) => !ok);
  if (bad.length) {
    const brief = (e) => e.kind === 'session.state' ? `${e.sessionId.slice(0, 8)} state ${e.state}${e.error ? ` (${e.error})` : ''}` : e.kind === 'background.changed' ? `bg ${e.session.tasks.map((t) => `${t.kind}:${t.name ?? t.description}:${t.status}[${t.agents.map((a) => `${a.label}=${a.state}`).join(',')}]`).join(' ')}` : `${e.sessionId.slice(0, 8)} ${e.message.type}${e.message.subtype ? `/${e.message.subtype}` : ''}${e.message.type === 'result' ? ` ${String(e.message.result ?? e.message.errors ?? '').slice(0, 160)}` : ''}${e.message.subtype?.startsWith?.('task_') ? ` ${JSON.stringify(e.message).slice(0, 300)}` : ''}`;
    console.log(`\n--- events ---\n${events.filter((e) => e.kind === 'session.state' || e.kind === 'background.changed' || (e.kind === 'session.event' && e.message.type !== 'stream_event')).map(brief).join('\n')}`);
    console.log(`\n--- upstream requests ---\n${hits.map((h) => `${h.status} ${h.method} ${h.url} ${h.role ?? ''} ${h.body.stream ? 'stream' : ''}`).join('\n')}`);
    console.log(`\n--- server log (tail) ---\n${slog.split('\n').slice(-60).join('\n')}`);
  }
  console.log(`\nphase25: ${results.length - bad.length}/${results.length} passed`);
  process.exit(bad.length ? 1 : 0);
});
