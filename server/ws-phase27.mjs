// Phase 27 end-to-end (2026-10-14): permissions and model switches, over a real server and the real Claude Code against
// a fake Anthropic upstream started here (no model, no token). Checks:
//   · 允许 without updatedInput (what the window's 「允许一次」 sends) lets the tool run (user report: every tool that
//     asks failed with "Tool permission request failed");
//   · the context window of the provider's settings: a Claude model starts with 1M; after switching to a model set to
//     120K the engine says 120K (the official binary only through another process: its earlier-compaction variable);
//   · switching to a model the conversation no longer fits in (110K used, 120K window: over 80%): a line says so, the current
//     model compacts first (the compaction request goes out with the old model), then the next turn uses the new one.
//   node server/ws-phase27.mjs   (starts its own server; scripts/e2e.mjs' port/token are ignored)
import WebSocket from 'ws';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-phase27-'));
const home = path.join(root, 'home');
fs.mkdirSync(home, { recursive: true });

const results = [];
const checkRaw = (name, ok, detail = '') => { results.push([name, !!ok]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const until = async (fn, ms, step = 200) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await new Promise((r) => setTimeout(r, step)); } };

// ---- the fake upstream ----
const hits = [];
let n = 0;
let bigUsage = 0; // input tokens the main turns report: how full the conversation looks to the engine
let writeTarget = '';
const textOf = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => typeof p === 'string' ? p : p?.text ?? (typeof p?.content === 'string' ? p.content : Array.isArray(p?.content) ? textOf(p.content) : '')).join('\n') : '';
const lastToolResult = (j) => {
  const last = (j.messages ?? []).at(-1);
  if (last?.role !== 'user' || !Array.isArray(last.content)) return null;
  return last.content.find((b) => b?.type === 'tool_result') ?? null;
};
const turnText = (j) => {
  const msgs = j.messages ?? [];
  let i = msgs.length;
  while (i > 0 && msgs[i - 1].role !== 'assistant') i--;
  return msgs.slice(i).filter((m) => m.role === 'user').map((m) => textOf(m.content)).join('\n');
};
const json = (s, status, o) => s.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(o));

function sse(s, j, blocks, stop, inputTokens = 10) {
  const msg = { id: `msg_${++n}`, type: 'message', role: 'assistant', model: j.model, stop_sequence: null };
  const ev = (type, o) => `event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`;
  let out = ev('message_start', { message: { ...msg, content: [], stop_reason: null, usage: { input_tokens: inputTokens, output_tokens: 1 } } });
  blocks.forEach((b, i) => {
    if (b.type === 'text') out += ev('content_block_start', { index: i, content_block: { type: 'text', text: '' } }) + ev('content_block_delta', { index: i, delta: { type: 'text_delta', text: b.text } });
    else out += ev('content_block_start', { index: i, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } }) + ev('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    out += ev('content_block_stop', { index: i });
  });
  out += ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 3 } }) + ev('message_stop', {});
  s.writeHead(200, { 'content-type': 'text/event-stream' });
  s.end(out);
}

function anthropic(q, s, j, h) {
  if (q.url.includes('/count_tokens')) return json(s, 200, { input_tokens: 10 });
  const msg = { id: `msg_${++n}`, type: 'message', role: 'assistant', model: j.model, stop_sequence: null };
  const plain = (text) => (j.stream ? sse(s, j, [{ type: 'text', text }], 'end_turn') : json(s, 200, { ...msg, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2 } }));
  const last = textOf((j.messages ?? []).at(-1)?.content);
  // the engine's compaction: summarise the conversation
  if (/detailed summary of the conversation|summary of the conversation so far|Your task is to create a detailed summary/i.test(last)) {
    h.role = 'compact';
    return j.stream ? sse(s, j, [{ type: 'text', text: '<summary>e2e summary: the user asked for a file and hello.</summary>' }], 'end_turn') : json(s, 200, { ...msg, content: [{ type: 'text', text: '<summary>e2e summary</summary>' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } });
  }
  if (!j.stream) return plain('side:ok');
  h.role = 'main';
  const tr = lastToolResult(j);
  if (tr) {
    h.toolResult = { id: tr.tool_use_id, error: !!tr.is_error, text: textOf(tr.content) };
    return sse(s, j, [{ type: 'text', text: `main: after ${tr.tool_use_id}` }], 'end_turn', bigUsage || 10);
  }
  const t = turnText(j);
  if (/RUN-WRITE/.test(t)) return sse(s, j, [{ type: 'tool_use', id: 'toolu_write', name: 'Write', input: { file_path: writeTarget, content: 'written after 允许\n' } }], 'tool_use');
  return sse(s, j, [{ type: 'text', text: 'main:ok' }], 'end_turn', bigUsage || 10);
}

const upstream = http.createServer((q, s) => {
  let raw = '';
  q.on('data', (c) => { raw += c; });
  q.on('end', () => {
    let j = {};
    try { j = JSON.parse(raw || '{}'); } catch { /* keep */ }
    const h = { method: q.method, url: q.url ?? '', body: j, model: j.model, beta: String(q.headers['anthropic-beta'] ?? ''), at: Date.now() };
    hits.push(h);
    if (h.url.startsWith('/v1/messages')) return anthropic(q, s, j, h);
    if (h.url.includes('/models')) return json(s, 200, { data: [{ id: 'claude-sonnet-4-6', type: 'model' }, { id: 'small-model', type: 'model' }] });
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
const msgsOf = (sid, from) => events.slice(from).filter((e) => e.kind === 'session.event' && e.sessionId === sid).map((e) => e.message);
const resultOf = (sid, from, ms = 120_000) => until(() => msgsOf(sid, from).find((m) => m.type === 'result'), ms);
let lastUsage;
const windowOf = async (sid) => (await until(async () => { const u = await req({ kind: 'session.contextUsage', sessionId: sid }).catch((e) => ({ error: e.message })); lastUsage = u; return u?.rawMaxTokens ? u : null; }, 30_000, 1000))?.rawMaxTokens ?? (console.log('contextUsage said', JSON.stringify(lastUsage)?.slice(0, 400)), undefined);

async function main() {
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  await req({ kind: 'settings.set', key: 'network.proxy', value: 'off' });
  await suite('claude');
}

async function suite(runtime) {
  const check = (name, ok, detail) => checkRaw(name, ok, detail);
  hits.length = 0;
  bigUsage = 0;
  const proj = path.join(root, `proj-${runtime}`);
  fs.mkdirSync(proj, { recursive: true });
  writeTarget = path.join(proj, 'allowed.txt');
  const A = await req({ kind: 'providers.upsert', provider: { name: `中转${runtime}`, type: 'anthropic', baseUrl: up, apiKey: 'relay-key-e2e', defaultModel: 'claude-sonnet-4-6', models: ['claude-sonnet-4-6', 'small-model'], contextWindows: { 'small-model': 120_000 } } });
  const o = await req({ kind: 'session.open', params: { cwd: proj, providerId: A.id, model: 'claude-sonnet-4-6', permissionMode: 'default' } });
  const sid = o.sessionId;

  // ---- 允许 without updatedInput ----
  let from = events.length;
  await req({ kind: 'session.send', params: { sessionId: sid, text: 'RUN-WRITE please' } });
  const ask = await until(() => events.slice(from).find((e) => e.kind === 'permission.request' && e.request.sessionId === sid)?.request, 90_000);
  check('the Write asks first (default permission mode)', ask?.toolName === 'Write', JSON.stringify(ask?.toolName));
  if (ask) await req({ kind: 'permission.respond', requestId: ask.requestId, response: { behavior: 'allow' } });
  const r1 = await resultOf(sid, from);
  const tr = hits.find((h) => h.toolResult?.id === 'toolu_write')?.toolResult;
  check('允许 without updatedInput: the tool ran (no "Tool permission request failed")', !!tr && !tr.error && fs.existsSync(writeTarget), JSON.stringify({ tr, file: fs.existsSync(writeTarget), result: r1?.subtype }));

  // ---- the window of the provider's settings ----
  const w1 = await windowOf(sid);
  check('a Claude model on a relay starts with 1M (not the 200K the engines assume)', w1 === 1_000_000, String(w1));
  const init = msgsOf(sid, 0).find((m) => m.type === 'system' && m.subtype === 'init');
  check('… through `[1m]` (and the 1M beta goes out)', /\[1m\]$/.test(init?.model ?? '') && hits.some((h) => h.role === 'main' && /context-1m/.test(h.beta)), JSON.stringify({ model: init?.model, beta: hits.find((h) => h.role === 'main')?.beta }));

  // ---- a conversation too big for the next model ----
  bigUsage = 110_000;
  from = events.length;
  await req({ kind: 'session.send', params: { sessionId: sid, text: 'hello' } });
  await resultOf(sid, from);
  const before = hits.length;
  from = events.length;
  await req({ kind: 'session.setModel', sessionId: sid, model: 'small-model' });
  bigUsage = 0;
  const notice = msgsOf(sid, from).find((m) => m.type === 'system' && m.subtype === 'cw_notice');
  check('switching to a model it no longer fits in: a line says so', !!notice && /110K/.test(notice.text) && /120K/.test(notice.text), notice?.text);
  const compactHit = hits.slice(before).find((h) => h.role === 'compact');
  check('… the current model compacts it first', compactHit?.model === 'claude-sonnet-4-6' && !!msgsOf(sid, from).find((m) => m.type === 'system' && m.subtype === 'compact_boundary'), JSON.stringify({ model: compactHit?.model, boundary: !!msgsOf(sid, from).find((m) => m.subtype === 'compact_boundary') }));
  from = events.length;
  const mark = hits.length;
  await until(async () => { const s = await req({ kind: 'sessions.list' }).catch(() => []); return true; }, 1000);
  await req({ kind: 'session.send', params: { sessionId: sid, text: 'after the switch' } });
  await resultOf(sid, from);
  const next = hits.slice(mark).find((h) => h.role === 'main');
  check('… then the next turn goes out with the new model', next?.model === 'small-model', next?.model);
  const w2 = await windowOf(sid);
  check('… and the window is its 120K (another process: the official binary reads it at start)', w2 === 120_000, String(w2));
  await req({ kind: 'session.close', sessionId: sid }).catch(() => {});
}

try {
  await main();
} catch (e) {
  checkRaw('ran without throwing', false, e?.stack ?? String(e));
} finally {
  ws.close();
  server.kill();
  upstream.close();
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\nphase27: ${results.length - failed}/${results.length} passed`);
  if (failed) console.log(slog.split('\n').slice(-30).join('\n'));
  process.exit(failed ? 1 : 0);
}
