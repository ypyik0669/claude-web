// Phase 20 end-to-end (2026-09-30 user report: "挂了梯子（非全局）仍连不上" — the provider test answered 403 "Access from
// this region requires trusted account access"): the server's own requests and every CLI it starts go through the
// user's proxy (server/src/net/proxy.ts). A fake ladder (an HTTP CONNECT proxy) is the only way to the relays' names
// (`*.proxy-e2e.test` never resolves), so a request that reaches a relay went through the proxy. Over a real server and
// a real ccb, no model, no token. Checks:
//   · HTTPS_PROXY at start = 跟随系统 picks it up; the provider test (this process's fetch) reaches the relay by name;
//   · a Claude conversation on an OpenAI-format provider: ccb → the local cache shim (loopback stays direct) → the
//     relay through the proxy;
//   · a Claude conversation on an Anthropic-format provider: ccb itself goes through the proxy;
//   · 自定义: the terminal shell gets HTTPS_PROXY and a NO_PROXY with loopback;
//   · 不使用: direct — the relay's name does not resolve and the test says so; a SOCKS address is refused;
//   · back to 跟随系统.
//   node server/ws-phase20.mjs   (starts its own server: it needs its own env; scripts/e2e.mjs' port/token are ignored)
import WebSocket from 'ws';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-phase20-'));
const home = path.join(root, 'home');
const proj = path.join(root, 'proj');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(proj, { recursive: true });
const KEY = 'relay-key-proxy-e2e';

const results = [];
const check = (name, ok, detail = '') => { results.push([name, !!ok]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const until = async (fn, ms, step = 200) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await new Promise((r) => setTimeout(r, step)); } };
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

// ---- two relays: OpenAI-compatible and Anthropic-format ----
const hits = [];
const body = (q) => new Promise((r) => { let b = ''; q.on('data', (c) => { b += c; }); q.on('end', () => r(b)); });
const oai = http.createServer(async (q, s) => {
  const b = await body(q);
  let j = {};
  try { j = JSON.parse(b || '{}'); } catch { /* keep */ }
  hits.push({ relay: 'openai', method: q.method, url: q.url, host: q.headers.host, body: b });
  if (q.headers.authorization !== `Bearer ${KEY}`) { s.writeHead(401, { 'content-type': 'application/json' }).end('{"error":{"message":"无效的令牌"}}'); return; }
  if (q.method === 'GET' && q.url.endsWith('/models')) { s.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-proxy', object: 'model' }] })); return; }
  if (!q.url.endsWith('/chat/completions')) { s.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"message":"not here"}}'); return; }
  const chunk = (o) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: j.model, ...o })}\n\n`;
  if (!j.stream) { s.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'c1', object: 'chat.completion', model: j.model, choices: [{ index: 0, message: { role: 'assistant', content: 'via-proxy-openai' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })); return; }
  s.writeHead(200, { 'content-type': 'text/event-stream' });
  s.end(chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'via-proxy-openai' }, finish_reason: null }] }) + chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + chunk({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 2, total_tokens: 52 } }) + 'data: [DONE]\n\n');
});
const sse = (o) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
const anth = http.createServer(async (q, s) => {
  const b = await body(q);
  let j = {};
  try { j = JSON.parse(b || '{}'); } catch { /* keep */ }
  hits.push({ relay: 'anthropic', method: q.method, url: q.url, host: q.headers.host, body: b });
  if (q.method === 'GET' && q.url.startsWith('/v1/models')) { s.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'claude-proxy-e2e', type: 'model' }] })); return; }
  if (q.url.startsWith('/v1/messages/count_tokens')) { s.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":12}'); return; }
  if (!q.url.startsWith('/v1/messages')) { s.writeHead(404).end(); return; }
  if (!j.stream) { s.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'msg_p', type: 'message', role: 'assistant', model: j.model, content: [{ type: 'text', text: 'via-proxy-anthropic' }], stop_reason: 'end_turn', usage: { input_tokens: 9, output_tokens: 2 } })); return; }
  s.writeHead(200, { 'content-type': 'text/event-stream' });
  s.end([
    sse({ type: 'message_start', message: { id: 'msg_p', type: 'message', role: 'assistant', model: j.model, content: [], usage: { input_tokens: 9, output_tokens: 1 } } }),
    sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'via-proxy-anthropic' } }),
    sse({ type: 'content_block_stop', index: 0 }),
    sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }),
    sse({ type: 'message_stop' }),
  ].join(''));
});
const oaiPort = await listen(oai);
const anthPort = await listen(anth);

// ---- the fake ladder: CONNECT only; the relays' names exist only here ----
const tunnels = []; // CONNECT targets, in order
const NAMES = { 'relay.proxy-e2e.test': oaiPort, 'anth.proxy-e2e.test': anthPort };
const ladder = http.createServer((_q, s) => { tunnels.push('(plain request)'); s.writeHead(400).end('CONNECT only'); });
ladder.on('connect', (q, sock, head) => {
  const target = String(q.url ?? '');
  tunnels.push(target);
  const [h, p] = target.split(':');
  const to = NAMES[h];
  if (!to || (p !== '80' && p !== '443')) { sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  const up = net.connect(to, '127.0.0.1', () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.write(head); up.pipe(sock); sock.pipe(up); });
  up.on('error', () => sock.destroy());
  sock.on('error', () => up.destroy());
});
const ladderUrl = `http://127.0.0.1:${await listen(ladder)}`;

// ---- the server: throwaway HOME, the ladder in HTTPS_PROXY (a user who exported it; the system proxy is read-only here) ----
const token = randomBytes(12).toString('hex');
const env = { ...process.env, HOME: home, USERPROFILE: home, PORT: '0', CLAUDE_WEB_TOKEN: token, CLAUDE_WEB_DIR: path.join(home, '.claude-web'), CODEX_HOME: path.join(home, '.codex'), CW_NO_MODEL_REFRESH: '1' };
for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_|OPENAI_)/.test(k) || /^(no|http|https|all)_proxy$/i.test(k)) delete env[k];
Object.assign(env, { HTTPS_PROXY: ladderUrl, HTTP_PROXY: ladderUrl });
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
const assistantText = (sid, from) => events.slice(from).filter((e) => e.kind === 'session.event' && e.sessionId === sid && e.message.type === 'assistant').flatMap((e) => e.message.message?.content ?? []).map((c) => c.text ?? '').join('');

/** A one-turn conversation on `providerId`: its answer text (or the result error). */
async function ask(providerId, text) {
  const o = await req({ kind: 'session.open', params: { cwd: proj, providerId, permissionMode: 'default' } });
  await until(() => events.some((e) => e.kind === 'session.state' && e.sessionId === o.sessionId && e.state === 'idle'), 90_000);
  const from = events.length;
  await req({ kind: 'session.send', params: { sessionId: o.sessionId, text } });
  const res = await until(() => events.slice(from).find((e) => e.kind === 'session.event' && e.sessionId === o.sessionId && e.message.type === 'result')?.message, 120_000);
  await req({ kind: 'session.close', sessionId: o.sessionId }).catch(() => {});
  return { text: assistantText(o.sessionId, from), result: res };
}

async function main() {
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const st0 = await req({ kind: 'network.proxy' });
  check('跟随系统 picks up HTTPS_PROXY from the start environment', st0.setting === 'system' && st0.source === 'env' && st0.active === ladderUrl, JSON.stringify(st0));

  const O = await req({ kind: 'providers.upsert', provider: { name: '梯子后的中转', type: 'openai', baseUrl: 'http://relay.proxy-e2e.test/v1', apiKey: KEY, defaultModel: 'deepseek-proxy', models: ['deepseek-proxy'] } });
  const N = await req({ kind: 'providers.upsert', provider: { name: '梯子后的 Anthropic', type: 'anthropic', baseUrl: 'http://anth.proxy-e2e.test', apiKey: KEY, defaultModel: 'claude-proxy-e2e' } });

  let t = tunnels.length;
  const p1 = await req({ kind: 'providers.probe', id: O.id, listOnly: true });
  check('the provider test reaches a relay only the proxy can reach (this process\'s fetch goes through it)', p1.ok && p1.models?.includes('deepseek-proxy') && tunnels.slice(t).includes('relay.proxy-e2e.test:80'), `${p1.error ?? ''} ${tunnels.slice(t).join(',')}`);

  t = tunnels.length;
  const h0 = hits.length;
  const a1 = await ask(O.id, '经过梯子 openai');
  const oaiChats = hits.slice(h0).filter((h) => h.relay === 'openai' && h.method === 'POST' && h.body.includes('经过梯子 openai'));
  check('a Claude conversation on an OpenAI-format provider: ccb → local shim → relay through the proxy', a1.text.includes('via-proxy-openai') && oaiChats.length > 0, (a1.text || JSON.stringify(a1.result ?? {})).slice(0, 160));
  check('… the local cache shim is reached directly (no tunnel to 127.0.0.1)', !tunnels.slice(t).some((x) => x.startsWith('127.0.0.1') || x.startsWith('localhost')), tunnels.slice(t).join(','));

  const h1 = hits.length;
  const a2 = await ask(N.id, '经过梯子 anthropic');
  check('a Claude conversation on an Anthropic-format provider: ccb itself goes through the proxy', a2.text.includes('via-proxy-anthropic') && hits.slice(h1).some((h) => h.relay === 'anthropic' && h.url.startsWith('/v1/messages')), (a2.text || JSON.stringify(a2.result ?? {})).slice(0, 160));

  const st1 = await req({ kind: 'settings.set', key: 'network.proxy', value: ladderUrl });
  check('自定义: the address is in use', st1.setting === 'custom' && st1.source === 'setting' && st1.active === ladderUrl && !st1.note, JSON.stringify(st1));
  const term = await req({ kind: 'terminal.open', cwd: proj, cols: 160, rows: 30 }).catch((e) => ({ error: e.message }));
  if (term.termId) {
    const tf = events.length;
    await new Promise((r) => setTimeout(r, 1500));
    await req({ kind: 'terminal.input', termId: term.termId, data: 'echo cw-p=%HTTPS_PROXY%$HTTPS_PROXY=cw-n=%NO_PROXY%$NO_PROXY=\r' });
    const out = await until(() => { const s = events.slice(tf).filter((e) => e.kind === 'terminal.data' && e.termId === term.termId).map((e) => e.data).join(''); return /cw-p=.*=cw-n=.*127\.0\.0\.1.*=/.test(s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')) ? s : null; }, 15_000);
    const clean = (out ?? '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    check('the terminal shell gets HTTPS_PROXY and a NO_PROXY with loopback', clean.includes(`cw-p=${ladderUrl}`) || clean.includes(`${ladderUrl}=cw-n=`), clean.split(/\r?\n/).find((l) => l.includes('cw-p=') && !l.includes('%HTTPS'))?.slice(0, 200) ?? '(no output)');
    await req({ kind: 'terminal.close', termId: term.termId }).catch(() => {});
  } else check('the terminal shell gets HTTPS_PROXY and a NO_PROXY with loopback', false, term.error);

  const st2 = await req({ kind: 'settings.set', key: 'network.proxy', value: 'off' });
  t = tunnels.length;
  const p2 = await req({ kind: 'providers.probe', id: O.id, listOnly: true });
  check('不使用: direct — the relay\'s name does not resolve, the test says so, the proxy sees nothing', st2.setting === 'off' && st2.active === null && !p2.ok && tunnels.length === t, `${p2.error ?? ''}`.slice(0, 120));

  const bad = await req({ kind: 'settings.set', key: 'network.proxy', value: 'socks5://127.0.0.1:1080' }).then(() => null, (e) => e.message);
  check('a SOCKS address is refused with a sentence', /SOCKS/.test(bad ?? ''), bad ?? 'accepted');
  const st3 = await req({ kind: 'network.proxy' });
  check('… and the setting stays what it was', st3.setting === 'off', JSON.stringify(st3));

  const st4 = await req({ kind: 'settings.set', key: 'network.proxy', value: 'system' });
  const p3 = await req({ kind: 'providers.probe', id: O.id, listOnly: true });
  check('back to 跟随系统: the environment\'s proxy again', st4.source === 'env' && p3.ok, JSON.stringify(st4));
  const saved = (await req({ kind: 'settings.get' }))['network.proxy'];
  check('跟随系统 is stored as nothing (meta.json has no network.proxy)', saved === undefined, String(saved));
}

main().catch((e) => { check('phase20 ran to the end', false, e.stack || e.message); }).finally(async () => {
  try { ws.close(); } catch { /* */ }
  server.kill();
  for (const s of [oai, anth, ladder]) { s.closeAllConnections?.(); s.close(); }
  await new Promise((r) => setTimeout(r, 800));
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows may still hold a handle */ }
  const bad = results.filter(([, ok]) => !ok);
  if (bad.length) console.log(`\n--- server log (tail) ---\n${slog.split('\n').slice(-60).join('\n')}\n--- tunnels ---\n${tunnels.join('\n')}`);
  console.log(`\nphase20: ${results.length - bad.length}/${results.length} passed`);
  process.exit(bad.length ? 1 : 0);
});
