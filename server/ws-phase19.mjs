// Phase 19 end-to-end (2026-09-30 user reports): conversations started away from the composer run on the provider
// the user set up, other agents can use providers, and the earlier relay fixes hold — over a real server and a real
// ccb, against a fake relay and a fake DingTalk started here (no model, no token, no DingTalk account). Checks:
//   · a DingTalk message (the real DingTalk adapter, Stream mode) starts a Claude conversation on the
//     new-conversation default provider — the relay answers, /status names it, a reopen keeps it;
//   · a bot set to another provider uses that one;
//   · Codex (mock app-server that calls its provider like the real one) set to a provider in settings → Agents:
//     its /v1/responses reaches a chat-only relay as chat/completions through the cache shim, the answer comes back;
//   · a scheduled task runs on the default provider;
//   · the model picked for a session is the model the relay gets (not the provider's default);
//   · Stop ends a turn whose relay never answers;
//   · the server runs with a dead system proxy (HTTP(S)_PROXY): everything above goes to 127.0.0.1 anyway;
//   · the terminal panel is a shell.
//   node server/ws-phase19.mjs   (starts its own server: it needs its own env; scripts/e2e.mjs' port/token are ignored)
import WebSocket, { WebSocketServer } from 'ws';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mockCodex = path.join(here, 'src', 'agents', '__mocks__', 'codex-server.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-phase19-'));
const home = path.join(root, 'home');
const proj = path.join(root, 'proj');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(proj, { recursive: true });
fs.writeFileSync(path.join(proj, 'README.md'), '# e2e\n');
const RELAY_KEY = 'relay-key-e2e';

const results = [];
const check = (name, ok, detail = '') => { results.push([name, !!ok]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const until = async (fn, ms, step = 200) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await new Promise((r) => setTimeout(r, step)); } };

// ---- a chat-only OpenAI-compatible relay (no /v1/responses, like most relays): `hang-e2e` never answers ----
const hits = [];
let n = 0;
const relay = http.createServer((q, s) => {
  let body = '';
  q.on('data', (c) => { body += c; });
  q.on('end', () => {
    let j = {};
    try { j = JSON.parse(body || '{}'); } catch { /* keep */ }
    const h = { method: q.method, url: q.url, auth: String(q.headers.authorization ?? ''), ua: String(q.headers['user-agent'] ?? ''), model: j.model, body };
    hits.push(h);
    if (h.auth !== `Bearer ${RELAY_KEY}`) { s.writeHead(401, { 'content-type': 'application/json' }).end('{"error":{"message":"无效的令牌"}}'); return; }
    if (q.method === 'GET' && q.url.endsWith('/models')) { s.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: ['deepseek-e2e', 'kimi-e2e'].map((id) => ({ id, object: 'model' })) })); return; }
    if (q.url.endsWith('/responses')) { s.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"message":"Invalid URL (POST /v1/responses)"}}'); return; }
    if (!q.url.endsWith('/chat/completions')) { s.writeHead(404).end(); return; }
    if (j.model === 'hang-e2e') return; // headers never come
    const text = `relay:${j.model}:${++n}`;
    const chunk = (o) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: j.model, ...o })}\n\n`;
    if (!j.stream) { s.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'c1', object: 'chat.completion', model: j.model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })); return; }
    s.writeHead(200, { 'content-type': 'text/event-stream' });
    s.end(chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] }) + chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + chunk({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 3, total_tokens: 103 } }) + 'data: [DONE]\n\n');
  });
});
await new Promise((r) => relay.listen(0, '127.0.0.1', r));
const relayUrl = `http://127.0.0.1:${relay.address().port}`;
const chatsWith = (pred) => hits.filter((h) => h.method === 'POST' && h.url.endsWith('/chat/completions') && pred(h));

// ---- a fake DingTalk open platform: Stream-mode gateway (http + ws) and per-conversation webhooks ----
const replies = []; // { conv, text }
let stream = null;
const dd = http.createServer((q, s) => {
  let body = '';
  q.on('data', (c) => { body += c; });
  q.on('end', () => {
    if (q.url === '/v1.0/gateway/connections/open') { s.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ endpoint: `ws://127.0.0.1:${dd.address().port}/stream`, ticket: 't-e2e' })); return; }
    const m = /^\/webhook\/(.+)$/.exec(q.url ?? '');
    if (m) { try { replies.push({ conv: decodeURIComponent(m[1]), text: JSON.parse(body).text.content }); } catch { /* bad body */ } s.writeHead(200, { 'content-type': 'application/json' }).end('{"errcode":0}'); return; }
    s.writeHead(404).end();
  });
});
const ddWs = new WebSocketServer({ server: dd, path: '/stream' });
let conns = 0;
ddWs.on('connection', (c) => { stream = c; conns++; });
/** every im.set restarts the adapter: wait for its new stream connection */
const setBot = async (patch) => { const c = conns; await req({ kind: 'im.set', id: 'dd1', patch }); if (patch.enabled !== false) await until(() => conns > c && stream.readyState === 1, 20_000); };
await new Promise((r) => dd.listen(0, '127.0.0.1', r));
const ddBase = `http://127.0.0.1:${dd.address().port}`;
let msgSeq = 0;
/** A user message in conversation `conv` (what DingTalk pushes over the stream) → the bot's next reply there. */
async function ding(conv, text, ms = 150_000) {
  const before = replies.filter((r) => r.conv === conv).length;
  stream.send(JSON.stringify({ specVersion: '1.0', type: 'CALLBACK', headers: { topic: '/v1.0/im/bot/messages/get', messageId: `m${++msgSeq}`, contentType: 'application/json' }, data: JSON.stringify({ conversationId: conv, senderStaffId: 'u-fly', senderNick: 'Fly', text: { content: text }, msgId: `x${msgSeq}`, sessionWebhook: `${ddBase}/webhook/${encodeURIComponent(conv)}`, sessionWebhookExpiredTime: Date.now() + 3600_000 }) }));
  return until(() => replies.filter((r) => r.conv === conv)[before]?.text, ms);
}

// ---- the server: throwaway HOME, a dead system proxy, DingTalk pointed at the fake ----
const token = randomBytes(12).toString('hex');
const env = { ...process.env, HOME: home, USERPROFILE: home, PORT: '0', CLAUDE_WEB_TOKEN: token, CLAUDE_WEB_DIR: path.join(home, '.claude-web'), CODEX_HOME: path.join(home, '.codex'), CW_NO_MODEL_REFRESH: '1', CW_DINGTALK_API: ddBase, HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', http_proxy: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9' };
for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_|OPENAI_)/.test(k) || /^no_proxy$/i.test(k)) delete env[k];
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
const resultOf = (sid, from) => until(() => events.slice(from).find((e) => e.kind === 'session.event' && e.sessionId === sid && e.message.type === 'result')?.message, 120_000);

async function main() {
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const A = await req({ kind: 'providers.upsert', provider: { name: '中转A', type: 'openai', baseUrl: `${relayUrl}/v1`, apiKey: RELAY_KEY, defaultModel: 'deepseek-e2e', models: ['deepseek-e2e', 'kimi-e2e', 'hang-e2e'] } });
  const B = await req({ kind: 'providers.upsert', provider: { name: '中转B', type: 'openai', baseUrl: `${relayUrl}/v1`, apiKey: RELAY_KEY, defaultModel: 'kimi-e2e' } });
  await req({ kind: 'settings.set', key: 'defaultProviderId', value: A.id });
  check('first run: no Claude account in this HOME', (await req({ kind: 'config.auth' }).catch(() => ({}))).loggedIn !== true);

  // ---- DingTalk → Claude on the default provider ----
  await setBot({ kind: 'dingtalk', name: '钉钉', enabled: true, config: { clientId: 'cid-e2e', clientSecret: 'secret-e2e' }, openAccess: true, defaultCwd: proj });
  check('the DingTalk adapter connects (Stream mode)', stream?.readyState === 1);
  const r1 = await ding('conv-1', '你好，钉钉');
  check('a DingTalk message is answered by the relay behind the default provider', /relay:deepseek-e2e/.test(r1 ?? ''), (r1 ?? '(no reply)').slice(0, 120));
  const first = chatsWith((h) => h.body.includes('你好，钉钉'));
  check('… sent by ccb through the cache shim (the relay sees the real key and ccb\'s client)', first.length > 0 && first.every((h) => h.auth === `Bearer ${RELAY_KEY}`), first.map((h) => h.ua).join(' | ').slice(0, 120));
  const st = await ding('conv-1', '/status', 20_000);
  check('/status names the provider', (st ?? '').includes('供应商 中转A'), (st ?? '').slice(0, 120));
  const bound = (await req({ kind: 'im.list' })).find((g) => g.id === 'dd1')?.bindings.find((b) => b.chatId === 'conv-1');
  if (bound) {
    await req({ kind: 'session.close', sessionId: bound.sessionId });
    const again = await req({ kind: 'session.open', params: { sessionId: bound.sessionId, cwd: proj } });
    check('the bot\'s conversation was recorded on that provider (a reopen keeps it)', again.info.providerId === A.id, `providerId=${again.info.providerId}`);
    await req({ kind: 'session.close', sessionId: bound.sessionId }).catch(() => {});
  } else check('the bot\'s conversation was recorded on that provider (a reopen keeps it)', false, 'no binding');

  // ---- the bot set to another provider ----
  await setBot({ providerId: B.id });
  const nw = await ding('conv-2', `/new ${proj}`, 60_000);
  check('/new on a bot set to 中转B says so', (nw ?? '').includes('供应商 中转B'), (nw ?? '').slice(0, 120));
  const r2 = await ding('conv-2', '换个供应商');
  check('… and its answers come from 中转B\'s model', /relay:kimi-e2e/.test(r2 ?? ''), (r2 ?? '').slice(0, 120));

  // ---- Codex set to a provider in settings → Agents: through the shim, to a chat-only relay ----
  await req({ kind: 'agents.set', agent: 'codex', patch: { command: process.execPath, args: [mockCodex, 'app-server'], providerId: A.id, enabled: true } });
  await setBot({ agent: 'codex', providerId: '' });
  const before = hits.length;
  const cn = await ding('conv-3', `/new ${proj}`, 60_000);
  check('a Codex bot conversation starts on the provider set for Codex', (cn ?? '').includes('供应商 中转A'), (cn ?? '').slice(0, 120));
  const r3 = await ding('conv-3', 'relay please');
  const cx = hits.slice(before).filter((h) => h.method === 'POST');
  check('Codex\'s /v1/responses reaches the chat-only relay as chat/completions and the answer comes back', /relay:deepseek-e2e/.test(r3 ?? '') && cx.some((h) => h.url.endsWith('/responses')) && cx.some((h) => h.url.endsWith('/chat/completions') && h.model === 'deepseek-e2e'), `${(r3 ?? '(no reply)').slice(0, 80)} · ${cx.map((h) => h.url.replace(/^.*\/v1/, '')).join(', ')}`);
  check('… with the relay key only on the relay side (Codex got the shim\'s key)', cx.every((h) => h.auth === `Bearer ${RELAY_KEY}`));
  const before2 = hits.length;
  await ding('conv-3', 'relay again');
  check('… the chat-only relay is remembered (the next request goes straight to chat/completions)', hits.slice(before2).filter((h) => h.method === 'POST').every((h) => h.url.endsWith('/chat/completions')) && hits.length > before2);
  await setBot({ enabled: false });

  // ---- a scheduled task runs on the default provider ----
  const sc = await req({ kind: 'schedules.upsert', schedule: { name: 'e2e', cwd: proj, prompt: '定时任务 e2e', everyMinutes: 600, enabled: false, freshSession: true, permissionMode: 'default' } });
  await req({ kind: 'schedules.runNow', id: sc.id });
  const sh = chatsWith((h) => h.body.includes('定时任务 e2e'));
  check('a scheduled task runs on the default provider', sh.length > 0 && sh.some((h) => h.model === 'deepseek-e2e'), sh.map((h) => h.model).join(','));

  // ---- the picked model is the model sent ----
  const o = await req({ kind: 'session.open', params: { cwd: proj, providerId: A.id, model: 'kimi-e2e', permissionMode: 'default' } });
  await until(() => events.some((e) => e.kind === 'session.state' && e.sessionId === o.sessionId && e.state === 'idle'), 90_000);
  let from = events.length;
  await req({ kind: 'session.send', params: { sessionId: o.sessionId, text: '选的模型' } });
  await resultOf(o.sessionId, from);
  const picked = chatsWith((h) => h.body.includes('选的模型'));
  check('the model picked for a conversation is the one the relay gets', picked.length > 0 && picked.every((h) => h.model === 'kimi-e2e'), picked.map((h) => h.model).join(','));
  await req({ kind: 'session.close', sessionId: o.sessionId }).catch(() => {});

  // ---- Stop on a relay that never answers ----
  const hs = await req({ kind: 'session.open', params: { cwd: proj, providerId: A.id, model: 'hang-e2e', permissionMode: 'default' } });
  await until(() => events.some((e) => e.kind === 'session.state' && e.sessionId === hs.sessionId && e.state === 'idle'), 90_000);
  from = events.length;
  await req({ kind: 'session.send', params: { sessionId: hs.sessionId, text: '永远等不到' } });
  await until(() => chatsWith((h) => h.model === 'hang-e2e' && h.body.includes('永远等不到')).length > 0, 60_000);
  const t0 = Date.now();
  await req({ kind: 'session.interrupt', sessionId: hs.sessionId });
  const stopped = await until(() => events.slice(from).find((e) => e.kind === 'session.event' && e.sessionId === hs.sessionId && e.message.type === 'result'), 20_000);
  check('Stop ends a turn whose relay never answers', !!stopped, stopped ? `${Math.round((Date.now() - t0) / 100) / 10}s, ${stopped.message.subtype ?? ''} ${stopped.message.terminal_reason ?? ''}` : 'no result in 20 s');
  await req({ kind: 'session.close', sessionId: hs.sessionId }).catch(() => {});

  // ---- the terminal panel is a shell ----
  const term = await req({ kind: 'terminal.open', cwd: proj, cols: 100, rows: 30 }).catch((e) => ({ error: e.message }));
  if (term.termId) {
    const tf = events.length;
    await new Promise((r) => setTimeout(r, 1500));
    await req({ kind: 'terminal.input', termId: term.termId, data: 'echo cw-term-%OS%$((6*7))\r' });
    const out = await until(() => { const s = events.slice(tf).filter((e) => e.kind === 'terminal.data' && e.termId === term.termId).map((e) => e.data).join(''); return /cw-term-(Windows_NT|%OS%42)/.test(s) ? s : null; }, 15_000);
    check('the terminal panel runs a shell (a command typed there runs)', !!out);
    await req({ kind: 'terminal.close', termId: term.termId }).catch(() => {});
  } else check('the terminal panel runs a shell (a command typed there runs)', false, term.error);
}

main().catch((e) => { check('phase19 ran to the end', false, e.stack || e.message); }).finally(async () => {
  try { ws.close(); } catch { /* */ }
  server.kill();
  relay.closeAllConnections(); relay.close();
  for (const c of ddWs.clients) c.terminate();
  dd.closeAllConnections(); dd.close();
  await new Promise((r) => setTimeout(r, 800));
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows may still hold a handle */ }
  const bad = results.filter(([, ok]) => !ok);
  if (bad.length) console.log(`\n--- server log (tail) ---\n${slog.split('\n').slice(-60).join('\n')}`);
  console.log(`\nphase19: ${results.length - bad.length}/${results.length} passed`);
  process.exit(bad.length ? 1 : 0);
});
