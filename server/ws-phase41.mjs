// Phase 41 end-to-end (2026-10-26, spec 2026-10-26 unified sources §14.2): a picture from a built-in tool reaches the
// model as a picture. A real server and the real Claude Code against a fake Anthropic upstream; the window hosting the
// built-in browser is this script's own WebSocket (browser.host), answering the screenshot with a real 1×1 PNG. Checks:
//   · the conversation's tool list has mcp__web__browser_screenshot itself, and the model calls it directly;
//   · the screenshot command reaches the hosting window, for this conversation;
//   · the tool_result the model gets holds an image block (base64 PNG), and no text block carries the base64;
//   · the turn ends normally.
//   node server/ws-phase41.mjs   (starts its own server; scripts/e2e.mjs' port/token are ignored)
import WebSocket from 'ws';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-phase41-'));
const home = path.join(root, 'home');
const dataDir = path.join(home, '.claude-web');
fs.mkdirSync(home, { recursive: true });

const results = [];
const checkRaw = (name, ok, detail = '') => { results.push([name, !!ok]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const until = async (fn, ms, step = 200) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await new Promise((r) => setTimeout(r, step)); } };

/** A real 1×1 PNG. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TOOL = 'mcp__web__browser_screenshot';

// ---- the fake upstream ----
const hits = [];
let n = 0;
const lastToolResult = (j) => {
  const last = (j.messages ?? []).at(-1);
  if (last?.role !== 'user' || !Array.isArray(last.content)) return null;
  return last.content.find((b) => b?.type === 'tool_result') ?? null;
};
const textOf = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => typeof p === 'string' ? p : p?.text ?? (typeof p?.content === 'string' ? p.content : Array.isArray(p?.content) ? textOf(p.content) : '')).join('\n') : '';
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
    if (b.type === 'text') out += ev('content_block_start', { index: i, content_block: { type: 'text', text: '' } }) + ev('content_block_delta', { index: i, delta: { type: 'text_delta', text: b.text } });
    else out += ev('content_block_start', { index: i, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } }) + ev('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    out += ev('content_block_stop', { index: i });
  });
  out += ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 3 } }) + ev('message_stop', {});
  s.writeHead(200, { 'content-type': 'text/event-stream' });
  s.end(out);
}

let call = 0;
function anthropic(s, j, h) {
  if (h.url.includes('/count_tokens')) return json(s, 200, { input_tokens: 10 });
  // side requests (the title, …) carry no tools; the title one is streamed too
  if (!j.stream) return json(s, 200, { id: `msg_${++n}`, type: 'message', role: 'assistant', model: j.model, content: [{ type: 'text', text: 'side:ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 2 } });
  if (!(j.tools ?? []).length) return sse(s, j, [{ type: 'text', text: 'side:ok' }], 'end_turn');
  h.main = true;
  h.tools = (j.tools ?? []).map((t) => t.name);
  const tr = lastToolResult(j);
  if (tr) { h.toolResult = tr; return sse(s, j, [{ type: 'text', text: 'main: seen' }], 'end_turn'); }
  if (/SHOT-GO/.test(turnText(j))) {
    const id = `toolu_shot_${++call}`;
    h.sent = { id, name: TOOL };
    return sse(s, j, [{ type: 'tool_use', id, name: TOOL, input: {} }], 'tool_use');
  }
  return sse(s, j, [{ type: 'text', text: 'main:ok' }], 'end_turn');
}
const upstream = http.createServer((q, s) => {
  let raw = '';
  q.on('data', (c) => { raw += c; });
  q.on('end', () => {
    let j = {};
    try { j = JSON.parse(raw || '{}'); } catch { /* keep */ }
    const h = { url: q.url ?? '', model: j.model };
    hits.push(h);
    if (h.url.startsWith('/v1/messages')) return anthropic(s, j, h);
    if (h.url.includes('/models')) return json(s, 200, { data: [{ id: 'claude-sonnet-4-6', type: 'model' }] });
    json(s, 404, { error: { message: 'no' } });
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const up = `http://127.0.0.1:${upstream.address().port}`;

// ---- the server: throwaway HOME ----
const token = randomBytes(12).toString('hex');
const env = { ...process.env, HOME: home, USERPROFILE: home, PORT: '0', CLAUDE_WEB_TOKEN: token, CLAUDE_WEB_DIR: dataDir, CW_NO_MODEL_REFRESH: '1', CW_NO_PUBLIC_BROKERS: '1' };
for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_CONFIG_DIR|OPENAI_)/.test(k) || /^(no_proxy|https?_proxy|all_proxy)$/i.test(k)) delete env[k];
const server = spawn(process.execPath, [path.join(here, 'dist', 'index.js')], { cwd: path.dirname(here), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
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
const req = (r) => new Promise((res, rej) => { const id = String(++seq); pending.set(id, { res, rej }); ws.send(JSON.stringify({ type: 'request', request: { id, req: r } })); });
// this window hosts the built-in browser: a screenshot is answered with the PNG, anything else with a plain page
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type === 'reply') { const p = pending.get(m.reply.id); pending.delete(m.reply.id); m.reply.ok ? p.res(m.reply.data) : p.rej(new Error(m.reply.error)); return; }
  if (m.type !== 'event') return;
  events.push(m.event);
  const c = m.event.kind === 'browser.command' ? m.event.command : null;
  if (!c) return;
  const answer = c.op === 'screenshot'
    ? { image: { mime: 'image/png', data: PNG }, page: { url: 'https://app.example/', title: 'App', text: '' } }
    : { page: { url: 'https://app.example/', title: 'App', text: '' } };
  req({ kind: 'browser.result', id: c.id, ok: true, answer }).catch(() => {});
});
const msgsOf = (sid, from) => events.slice(from).filter((e) => e.kind === 'session.event' && e.sessionId === sid).map((e) => e.message);

async function main() {
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  await req({ kind: 'settings.set', key: 'network.proxy', value: 'off' });
  // the built-in browser is the Agents' browser (no ego lite in play), and this window hosts it
  await req({ kind: 'settings.set', key: 'web.browser.agent', value: 'builtin' });
  const hosted = await req({ kind: 'browser.host', on: true });
  checkRaw('this window hosts the built-in browser', hosted?.host === true, JSON.stringify({ host: hosted?.host }));
  await suite('claude');
}

async function suite(runtime) {
  const check = (name, ok, detail) => checkRaw(name, ok, detail);
  const proj = path.join(root, `proj-${runtime}`);
  fs.mkdirSync(proj, { recursive: true });
  const A = await req({ kind: 'providers.upsert', provider: { name: `中转${runtime}`, type: 'anthropic', baseUrl: up, apiKey: 'relay-key-e2e', defaultModel: 'claude-sonnet-4-6', models: ['claude-sonnet-4-6'] } });
  const o = await req({ kind: 'session.open', params: { cwd: proj, providerId: A.id, model: 'claude-sonnet-4-6', permissionMode: 'default' } });
  const sid = o.sessionId;
  const mark = hits.length;
  const from = events.length;
  await req({ kind: 'session.send', params: { sessionId: sid, text: 'SHOT-GO look at the page' } });
  // allow whatever asks on the way (a screenshot is read-only; nothing should, but a card must not stall the turn)
  const answered = new Set();
  const r = await until(() => {
    for (const e of events.slice(from)) {
      if (e.kind !== 'permission.request' || e.request.sessionId !== sid || answered.has(e.request.requestId)) continue;
      answered.add(e.request.requestId);
      void req({ kind: 'permission.respond', requestId: e.request.requestId, response: { behavior: 'allow' } }).catch(() => {});
    }
    return msgsOf(sid, from).find((m) => m.type === 'result');
  }, 180_000, 300);

  const mine = hits.slice(mark).filter((h) => h.main);
  const first = mine[0];
  check('the conversation has browser_screenshot in its own tool list (alwaysLoad: not deferred behind a tool search)', !!first?.tools?.includes(TOOL), JSON.stringify(first?.tools?.filter((t) => /browser_screenshot|browser_computer/.test(t))));
  // independent of the tool list: Claude Code answered the very tool_use naming browser_screenshot — the next request
  // upstream carries a tool_result for that id
  const sentAt = mine.findIndex((h) => h.sent);
  const sent = mine[sentAt]?.sent;
  const answeredId = mine.slice(sentAt + 1).find((h) => h.toolResult)?.toolResult?.tool_use_id;
  check('… and the model calls it directly: the next request\'s tool_result answers the browser_screenshot tool_use', sent?.name === TOOL && !!answeredId && answeredId === sent.id, JSON.stringify({ sent, answeredId }));
  const shots = events.slice(from).filter((e) => e.kind === 'browser.command' && e.command.op === 'screenshot');
  check('the screenshot is taken in the window hosting the built-in browser, for this conversation', shots.length === 1 && shots[0].command.sessionId === sid, JSON.stringify(shots.map((e) => ({ op: e.command.op, sessionId: e.command.sessionId }))));
  const tr = mine.find((h) => h.toolResult)?.toolResult;
  const blocks = Array.isArray(tr?.content) ? tr.content : [];
  const img = blocks.find((b) => b?.type === 'image');
  check('the tool_result reaching the model holds an image block: the very PNG the window answered', img?.source?.type === 'base64' && /^image\/png$/.test(img.source.media_type ?? '') && img.source.data === PNG && !tr?.is_error, JSON.stringify(blocks.map((b) => (b?.type === 'image' ? { type: 'image', media_type: b.source?.media_type, chars: b.source?.data?.length, same: b.source?.data === PNG } : { type: b?.type, text: String(b?.text ?? '').slice(0, 120) }))));
  const leaked = blocks.filter((b) => b?.type !== 'image').some((b) => textOf([b]).includes(PNG.slice(0, 24))) || (typeof tr?.content === 'string' && tr.content.includes(PNG.slice(0, 24)));
  check('… and no text block carries the picture as base64', !!tr && !leaked, typeof tr?.content === 'string' ? tr.content.slice(0, 200) : '');
  check('… and the turn ends normally', r?.subtype === 'success', r?.subtype);
  await req({ kind: 'session.close', sessionId: sid }).catch(() => {});
}

try {
  await main();
} catch (e) {
  checkRaw('ran without throwing', false, e?.stack ?? String(e));
} finally {
  ws.close();
  const gone = new Promise((r) => server.once('exit', r));
  server.kill();
  upstream.close();
  await Promise.race([gone, new Promise((r) => setTimeout(r, 10_000))]);
  // the throwaway HOME (Windows may hold a file a moment longer: retried)
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch (e) { console.log(`(could not remove ${root}: ${e.message})`); }
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\nphase41: ${results.length - failed}/${results.length} passed`);
  if (failed) console.log(slog.split('\n').slice(-30).join('\n'));
  process.exit(failed ? 1 : 0);
}
