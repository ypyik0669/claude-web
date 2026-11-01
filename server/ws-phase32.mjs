// Phase 32 end-to-end (2026-10-24, A7): the Claude account's 200K / 1M per family and the 自动压缩 point, over a real
// server and the real engine against a fake Anthropic upstream started here (no model, no token). The temp HOME's
// ~/.claude/settings.json sets CLAUDE_CODE_AUTO_COMPACT_WINDOW=700000 (what the user who reported it had):
//   · the own login (meta settings claude.contextWindows / claude.compactAt): Opus 5.5 by default goes out at 1M (the
//     context-1m beta), the session info says 1M; 自动压缩 500K beats settings.json in the engine's environment; Opus
//     at 200K: a new conversation without the beta, and one already open hears the change;
//   · another Claude account (a claude-account profile's own contextWindows / compactAt): the same;
//   · an API provider's compactAt: CLAUDE_CODE_AUTO_COMPACT_WINDOW in the engine's environment, over settings.json.
// The engine's environment is read the way a turn sees it: the fake model runs `echo` through the Bash tool and reads
// the tool's output in the next request. The account's conversations reach the fake upstream through the conversation's
// own environment (features.env ANTHROPIC_BASE_URL), which wins over the profile's — the runner's account path (model
// picks, `--settings` over settings.json) is the one a real login takes; a relay in settings.json would skip the picks.
//   node server/ws-phase32.mjs   (starts its own server; scripts/e2e.mjs' port/token are ignored)
import WebSocket from 'ws';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-phase32-'));
const home = path.join(root, 'home');
fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '700000' } }));

const results = [];
const check = (name, ok, detail = '') => { results.push([name, !!ok]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const until = async (fn, ms, step = 200) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await new Promise((r) => setTimeout(r, step)); } };

// ---- the fake upstream ----
const hits = [];
let n = 0;
const textOf = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => typeof p === 'string' ? p : p?.text ?? (typeof p?.content === 'string' ? p.content : Array.isArray(p?.content) ? textOf(p.content) : '')).join('\n') : '';
const turnText = (j) => {
  const msgs = j.messages ?? [];
  let i = msgs.length;
  while (i > 0 && msgs[i - 1].role !== 'assistant') i--;
  return msgs.slice(i).filter((m) => m.role === 'user').map((m) => textOf(m.content)).join('\n');
};
const lastToolResult = (j) => {
  // the official binary ends a request with a mid-conversation `system` message (<total_tokens>…): skip it
  const last = (j.messages ?? []).filter((m) => m.role !== 'system').at(-1);
  if (last?.role !== 'user' || !Array.isArray(last.content)) return null;
  return last.content.find((b) => b?.type === 'tool_result') ?? null;
};
const json = (s, status, o) => s.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(o));

function sse(s, j, block, stop) {
  const msg = { id: `msg_${++n}`, type: 'message', role: 'assistant', model: j.model, stop_sequence: null };
  const ev = (type, o) => `event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`;
  let out = ev('message_start', { message: { ...msg, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  if (block.type === 'text') out += ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) + ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: block.text } });
  else out += ev('content_block_start', { index: 0, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } }) + ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
  out += ev('content_block_stop', { index: 0 }) + ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 3 } }) + ev('message_stop', {});
  s.writeHead(200, { 'content-type': 'text/event-stream' });
  s.end(out);
}

let toolRun = 0;
const upstream = http.createServer((q, s) => {
  let raw = '';
  q.on('data', (c) => { raw += c; });
  q.on('end', () => {
    let j = {};
    try { j = JSON.parse(raw || '{}'); } catch { /* keep */ }
    const url = q.url ?? '';
    if (url.includes('/count_tokens')) return json(s, 200, { input_tokens: 10 });
    if (!url.startsWith('/v1/messages')) return json(s, 404, { error: { type: 'not_found_error', message: 'no' } });
    const h = { model: j.model, beta: String(q.headers['anthropic-beta'] ?? ''), auth: String(q.headers.authorization ?? q.headers['x-api-key'] ?? ''), stream: !!j.stream, turn: turnText(j) };
    hits.push(h);
    const msg = { id: `msg_${++n}`, type: 'message', role: 'assistant', model: j.model, stop_sequence: null };
    if (!j.stream) return json(s, 200, { ...msg, content: [{ type: 'text', text: 'side:ok' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2 } });
    const tr = lastToolResult(j);
    if (tr) { h.toolOut = textOf(tr.content); return sse(s, j, { type: 'text', text: 'env:seen' }, 'end_turn'); }
    if (/SHOW-ENV/.test(h.turn)) {
      h.main = true;
      return sse(s, j, { type: 'tool_use', id: `toolu_env_${++toolRun}`, name: 'Bash', input: { command: 'echo "CW_COMPACT=${CLAUDE_CODE_AUTO_COMPACT_WINDOW:-unset}"', description: 'Show the compaction point' } }, 'tool_use');
    }
    return sse(s, j, { type: 'text', text: 'main:ok' }, 'end_turn');
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const up = `http://127.0.0.1:${upstream.address().port}`;

// ---- the server: throwaway HOME, no proxy ----
const token = randomBytes(12).toString('hex');
const env = { ...process.env, HOME: home, USERPROFILE: home, PORT: '0', CLAUDE_WEB_TOKEN: token, CLAUDE_WEB_DIR: path.join(home, '.claude-web'), CW_NO_MODEL_REFRESH: '1', CW_NO_PUBLIC_BROKERS: '1', CLAUDE_WEB_SYSTEM_LANG: 'zh-CN' };
for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_CONFIG_DIR|CLAUDE_WEB_CONTEXT_WINDOWS|CLAUDE_WEB_MODEL_CAPS|OPENAI_|GEMINI_|GROK_|XAI_)/.test(k) || /^(no_proxy|https?_proxy|all_proxy)$/i.test(k)) delete env[k];
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
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type === 'reply') { const p = pending.get(m.reply.id); pending.delete(m.reply.id); m.reply.ok ? p.res(m.reply.data) : p.rej(new Error(m.reply.error)); return; }
  if (m.type === 'event') events.push(m.event);
});
const req = (r) => new Promise((res, rej) => { const id = String(++seq); pending.set(id, { res, rej }); ws.send(JSON.stringify({ type: 'request', request: { id, req: r } })); });
const resultOf = (sid, from, ms = 120_000) => until(() => events.slice(from).find((e) => e.kind === 'session.event' && e.sessionId === sid && e.message?.type === 'result')?.message, ms);

/** One turn that shows the engine's CLAUDE_CODE_AUTO_COMPACT_WINDOW: the main request's model / beta header and the echo. */
async function envTurn(sid) {
  const mark = hits.length;
  const from = events.length;
  await req({ kind: 'session.send', params: { sessionId: sid, text: 'SHOW-ENV please' } });
  const asked = until(() => events.slice(from).find((e) => e.kind === 'permission.request' && e.request.sessionId === sid)?.request, 120_000, 300);
  void asked.then((a) => a && req({ kind: 'permission.respond', requestId: a.requestId, response: { behavior: 'allow' } }).catch(() => {}));
  const r = await resultOf(sid, from);
  const mine = hits.slice(mark);
  const main = mine.find((h) => h.main);
  const out = mine.find((h) => h.toolOut !== undefined)?.toolOut ?? '';
  const info = (await req({ kind: 'session.info', sessionId: sid }).catch(() => null))?.info;
  return { result: r?.subtype, model: main?.model, beta: main?.beta ?? '', auth: main?.auth ?? '', compact: /CW_COMPACT=(\w+)/.exec(out)?.[1] ?? null, contextWindow: info?.contextWindow, compactWindow: info?.compactWindow };
}
const oneM = (t) => /context-1m/.test(t.beta);
const brief = (t) => JSON.stringify({ ...t, auth: t.auth.slice(0, 14) });

async function main() {
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  await req({ kind: 'settings.set', key: 'network.proxy', value: 'off' });
  const proj = path.join(root, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  const open = (extra) => req({ kind: 'session.open', params: { cwd: proj, model: 'claude-opus-5-5', permissionMode: 'bypassPermissions', ...extra } });

  // ---- the own login ----
  const ownEnv = { features: { env: { ANTHROPIC_BASE_URL: up, ANTHROPIC_AUTH_TOKEN: 'own-login-e2e' } } };
  const o1 = await open(ownEnv);
  check('own login, nothing set: Opus 5.5 opens at 1M (session info)', o1.info?.contextWindow === 1_000_000 && !o1.info?.providerId, JSON.stringify({ w: o1.info?.contextWindow, p: o1.info?.providerId }));
  const t1 = await envTurn(o1.sessionId);
  check('… its requests go out at 1M (the context-1m beta)', t1.result === 'success' && /^claude-opus-5-5/.test(t1.model ?? '') && oneM(t1) && /own-login-e2e/.test(t1.auth), brief(t1));
  check('… no 自动压缩 set: settings.json’s 700000 is the one in the engine', t1.compact === '700000' && t1.compactWindow === 700_000, brief(t1));
  await req({ kind: 'session.close', sessionId: o1.sessionId }).catch(() => {});

  await req({ kind: 'settings.set', key: 'claude.compactAt', value: 500_000 });
  const o2 = await open(ownEnv);
  const t2 = await envTurn(o2.sessionId);
  check('own login, 自动压缩 500K: it beats settings.json’s 700000 in the engine', t2.result === 'success' && t2.compact === '500000' && t2.compactWindow === 500_000 && oneM(t2), brief(t2));

  // Opus at 200K (and the point back to 跟着上下文窗口): the conversation still open hears it, a new one has no 1M
  await until(async () => (await req({ kind: 'session.info', sessionId: o2.sessionId }).catch(() => null))?.info?.state === 'idle', 30_000, 300);
  const from = events.length;
  await req({ kind: 'settings.set', key: 'claude.contextWindows', value: { opus: 200_000 } });
  await req({ kind: 'settings.set', key: 'claude.compactAt', value: null });
  const heard = await until(() => events.slice(from).some((e) => e.kind === 'session.info' && e.info?.sessionId === o2.sessionId && e.info.contextWindow === 200_000), 15_000);
  check('… Opus set to 200K: the conversation already open says 200K', !!heard, '');
  const t2b = await envTurn(o2.sessionId);
  check('… and its next turn goes out without the 1M beta (the process restarted, the conversation went on)', t2b.result === 'success' && !oneM(t2b) && /^claude-opus-5-5/.test(t2b.model ?? ''), brief(t2b));
  await req({ kind: 'session.close', sessionId: o2.sessionId }).catch(() => {});
  const o3 = await open(ownEnv);
  check('… a new Opus conversation opens at 200K', o3.info?.contextWindow === 200_000, String(o3.info?.contextWindow));
  const t3 = await envTurn(o3.sessionId);
  check('… its requests carry no 1M beta, settings.json’s 700000 is back (no 自动压缩 set)', t3.result === 'success' && !oneM(t3) && t3.compact === '700000', brief(t3));
  await req({ kind: 'session.close', sessionId: o3.sessionId }).catch(() => {});
  await req({ kind: 'settings.set', key: 'claude.contextWindows', value: null });

  // ---- another Claude account ----
  const tok = 'sk-ant-oat01-' + randomBytes(48).toString('base64url');
  const acct = await req({ kind: 'providers.upsert', provider: { name: '工作号', type: 'claude-account', apiKey: tok, baseUrl: '' } });
  const acctEnv = { providerId: acct.id, features: { env: { ANTHROPIC_BASE_URL: up } } };
  const a1 = await open(acctEnv);
  check('a Claude account, nothing set: Opus 5.5 opens at 1M', a1.info?.contextWindow === 1_000_000 && a1.info?.providerId === acct.id, JSON.stringify({ w: a1.info?.contextWindow, p: a1.info?.providerId }));
  const ta1 = await envTurn(a1.sessionId);
  check('… its requests go out at 1M, with the account’s token', ta1.result === 'success' && oneM(ta1) && ta1.auth.includes(tok.slice(0, 30)), brief(ta1));
  await req({ kind: 'session.close', sessionId: a1.sessionId }).catch(() => {});
  await req({ kind: 'providers.upsert', provider: { id: acct.id, contextWindows: { opus: 200_000 }, compactAt: 150_000 } });
  const a2 = await open(acctEnv);
  const ta2 = await envTurn(a2.sessionId);
  check('… the profile’s Opus 200K + 自动压缩 150K: 200K, no 1M beta, 150000 over settings.json', a2.info?.contextWindow === 200_000 && ta2.result === 'success' && !oneM(ta2) && ta2.compact === '150000' && ta2.compactWindow === 150_000, brief({ ...ta2, opened: a2.info?.contextWindow }));
  await req({ kind: 'session.close', sessionId: a2.sessionId }).catch(() => {});

  // ---- an API provider's 自动压缩 ----
  const P = await req({ kind: 'providers.upsert', provider: { name: '中转', type: 'anthropic', baseUrl: up, apiKey: 'relay-key-e2e', defaultModel: 'claude-sonnet-4-6', models: ['claude-sonnet-4-6'], contextWindows: { 'claude-sonnet-4-6': 1_000_000 }, compactAt: 400_000 } });
  const p1 = await req({ kind: 'session.open', params: { cwd: proj, providerId: P.id, model: 'claude-sonnet-4-6', permissionMode: 'bypassPermissions' } });
  const tp = await envTurn(p1.sessionId);
  check('a provider’s 自动压缩 400K: CLAUDE_CODE_AUTO_COMPACT_WINDOW=400000 in the engine, over settings.json', tp.result === 'success' && tp.compact === '400000' && tp.compactWindow === 400_000 && /relay-key-e2e/.test(tp.auth), brief(tp));
  await req({ kind: 'session.close', sessionId: p1.sessionId }).catch(() => {});
}

try {
  await main();
} catch (e) {
  check('ran without throwing', false, e?.stack ?? String(e));
} finally {
  ws.close();
  server.kill();
  upstream.close();
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\nphase32: ${results.length - failed}/${results.length} passed`);
  if (failed) console.log(slog.split('\n').slice(-30).join('\n'));
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows may still hold a handle */ }
  process.exit(failed ? 1 : 0);
}
