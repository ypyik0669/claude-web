// Phase 22 end-to-end (2026-10-08): thinking strength (智能程度), 深度编排 and 自动判断 are the same on every provider
// and model — over a real server and the real claude-web-engine, against one fake upstream started here that speaks
// OpenAI chat/completions, Anthropic /v1/messages and Gemini streamGenerateContent and records every request body
// (no model, no token). Checks:
//   · the provider's /v1/models declares each model's levels (DeepSeek's `effort.supported_levels`) and they are kept;
//   · an Anthropic-format provider on our engine: claude-opus-5-5 + max → output_config.effort "max";
//     claude-sonnet-4-6 + high → adaptive thinking with output_config.effort "high";
//   · an OpenAI-format provider, deepseek-flash + 更深 (xhigh) → reasoning_effort "max" (DeepSeek has low/high/max);
//   · the same conversation changed to low → the next request says "low", and the process was not restarted;
//   · 深度编排 turned on → the next request carries the ultracode reminder; picked before the conversation starts
//     (the welcome page) → its first request does;
//   · gpt-4o (no parameter) + high → no effort field, the turn's user message carries "Reasoning depth: high.";
//   · a relay that refuses reasoning_effort (400 naming it) → the turn is answered anyway, the provider remembers the
//     model as prompt-only, the next turn goes the prompt way;
//   · a Gemini-format provider, gemini-3-pro + high → generationConfig.thinkingConfig.thinkingLevel "high";
//   · 自动判断 + deepseek-flash running a Bash command → the classifier request goes with thinking off and tool_choice
//     naming classify_result, the command runs without a permission prompt.
//   node server/ws-phase22.mjs   (starts its own server: it needs its own env; scripts/e2e.mjs' port/token are ignored)
import WebSocket from 'ws';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-phase22-'));
const home = path.join(root, 'home');
const proj = path.join(root, 'proj');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(proj, { recursive: true });
fs.writeFileSync(path.join(proj, 'README.md'), '# e2e\n');
const RELAY_KEY = 'relay-key-e2e';
const spawnLog = path.join(root, 'spawn-log.jsonl');

const results = [];
const check = (name, ok, detail = '') => { results.push([name, !!ok]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const until = async (fn, ms, step = 200) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await new Promise((r) => setTimeout(r, step)); } };

// ---- the fake upstream ----
const hits = []; // { fmt: 'openai'|'anthropic'|'gemini', url, body, status }
let n = 0;
const textOf = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => typeof p === 'string' ? p : p?.text ?? (typeof p?.content === 'string' ? p.content : '')).join('\n') : '';
/** The user content of the request's current turn: every user message after the last assistant one. */
const turnText = (h) => {
  const msgs = h.fmt === 'gemini' ? (h.body.contents ?? []).map((c) => ({ role: c.role === 'model' ? 'assistant' : c.role, content: c.parts })) : (h.body.messages ?? []);
  let i = msgs.length;
  while (i > 0 && msgs[i - 1].role !== 'assistant') i--;
  return msgs.slice(i).filter((m) => m.role === 'user').map((m) => textOf(m.content)).join('\n');
};
const json = (s, status, o) => s.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(o));
const LIST = [
  { id: 'deepseek-flash', object: 'model', effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' } },
  { id: 'qwen-e2e', object: 'model', effort: { supported_levels: ['low', 'medium', 'high'] } },
  { id: 'gpt-4o', object: 'model' },
];

function openai(q, s, j, h) {
  if (h.auth !== `Bearer ${RELAY_KEY}`) return json(s, 401, { error: { message: '无效的令牌' } });
  if (q.method === 'GET' && q.url.endsWith('/models')) return json(s, 200, { object: 'list', data: LIST });
  if (!q.url.endsWith('/chat/completions')) return json(s, 404, { error: { message: `Invalid URL (${q.method} ${q.url})` } });
  if (j.model === 'qwen-e2e' && 'reasoning_effort' in j) { h.status = 400; return json(s, 400, { error: { message: 'Unrecognized request argument supplied: reasoning_effort', type: 'invalid_request_error' } }); }
  const base = { id: `c${++n}`, created: 1, model: j.model };
  const usage = { prompt_tokens: 100, completion_tokens: 3, total_tokens: 103 };
  if (j.tool_choice?.function?.name === 'classify_result') {
    return json(s, 200, { ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_cls', type: 'function', function: { name: 'classify_result', arguments: JSON.stringify({ thinking: 'prints a number', shouldBlock: false, reason: 'harmless' }) } }] }, finish_reason: 'tool_calls' }], usage });
  }
  if (!j.stream) return json(s, 200, { ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'side:ok' }, finish_reason: 'stop' }], usage });
  const chunk = (o) => `data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', ...o })}\n\n`;
  const last = (j.messages ?? []).at(-1);
  let body;
  if (last?.role !== 'tool' && turnText(h).includes('AUTO-BASH')) {
    const args = JSON.stringify({ command: 'node -e "console.log(6*7)"', description: 'Print a number' });
    body = chunk({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_bash', type: 'function', function: { name: 'Bash', arguments: '' } }] }, finish_reason: null }] })
      + chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] })
      + chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  } else {
    const text = last?.role === 'tool' ? 'auto:done' : `relay:${j.model}:${n}`;
    body = chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] }) + chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  }
  s.writeHead(200, { 'content-type': 'text/event-stream' });
  s.end(body + chunk({ choices: [], usage }) + 'data: [DONE]\n\n');
}

function anthropic(q, s, j) {
  if (q.url.includes('/count_tokens')) return json(s, 200, { input_tokens: 10 });
  const msg = { id: `msg_${++n}`, type: 'message', role: 'assistant', model: j.model, stop_sequence: null };
  if (!j.stream) return json(s, 200, { ...msg, content: [{ type: 'text', text: 'side:ok' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2 } });
  const ev = (type, o) => `event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`;
  s.writeHead(200, { 'content-type': 'text/event-stream' });
  s.end(ev('message_start', { message: { ...msg, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } })
    + ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    + ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'anthropic:ok' } })
    + ev('content_block_stop', { index: 0 })
    + ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } })
    + ev('message_stop', {}));
}

function gemini(q, s) {
  s.writeHead(200, { 'content-type': 'text/event-stream' });
  s.end(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'gemini:ok' }] }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 } })}\n\n`);
}

const upstream = http.createServer((q, s) => {
  let raw = '';
  q.on('data', (c) => { raw += c; });
  q.on('end', () => {
    let j = {};
    try { j = JSON.parse(raw || '{}'); } catch { /* keep */ }
    const url = q.url ?? '';
    const fmt = url.startsWith('/v1beta/') ? 'gemini' : url.startsWith('/v1/messages') ? 'anthropic' : 'openai';
    const h = { fmt, method: q.method, url, auth: String(q.headers.authorization ?? ''), body: j, status: 200 };
    hits.push(h);
    if (fmt === 'gemini') return gemini(q, s);
    if (fmt === 'anthropic') return anthropic(q, s, j);
    openai(q, s, j, h);
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const up = `http://127.0.0.1:${upstream.address().port}`;
/** The main-loop request(s) of the turn whose prompt contains `marker` (streamed; side queries are not). */
const mainOf = (fmt, marker) => hits.filter((h) => h.fmt === fmt && h.method === 'POST' && (fmt === 'gemini' || h.body.stream === true) && turnText(h).includes(marker));

// ---- the server: throwaway HOME, no proxy, every spawn logged ----
const token = randomBytes(12).toString('hex');
const env = { ...process.env, HOME: home, USERPROFILE: home, PORT: '0', CLAUDE_WEB_TOKEN: token, CLAUDE_WEB_DIR: path.join(home, '.claude-web'), CW_NO_MODEL_REFRESH: '1', CW_NO_PUBLIC_BROKERS: '1', CW_SPAWN_LOG: '1', CW_SPAWN_LOG_FILE: spawnLog };
for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_|OPENAI_|GEMINI_|GROK_|XAI_)/.test(k) || /^(no_proxy|https?_proxy|all_proxy)$/i.test(k)) delete env[k];
const server = spawn(process.execPath, [path.join(here, 'dist', 'index.js')], { cwd: path.dirname(here), env, stdio: ['ignore', 'pipe', 'pipe'] });
let slog = '';
server.stderr.on('data', (d) => { slog += d; });
const port = await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`server did not start in 60s\n${slog}`)), 60_000);
  server.stdout.on('data', (d) => { slog += d; const m = /listening on http:\/\/[^:]+:(\d+)/.exec(slog); if (m) { clearTimeout(t); res(m[1]); } });
  server.on('exit', (c) => rej(new Error(`server exited (${c})\n${slog}`)));
});
/** engine processes the server started so far (the spawn guard's log) */
const engineSpawns = () => {
  let lines = [];
  try { lines = fs.readFileSync(spawnLog, 'utf8').split('\n').filter(Boolean); } catch { /* none yet */ }
  return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && r.role === 'server' && r.args.some((a) => /cli-node\.js/.test(a))).length;
};

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
const opened = [];
async function openOn(providerId, model, extra = {}) {
  const o = await req({ kind: 'session.open', params: { cwd: proj, providerId, model, permissionMode: 'default', ...extra } });
  opened.push(o.sessionId);
  await until(() => events.some((e) => e.kind === 'session.state' && e.sessionId === o.sessionId && e.state === 'idle'), 90_000);
  return o;
}
async function turn(sid, text) {
  const from = events.length;
  await req({ kind: 'session.send', params: { sessionId: sid, text } });
  return { result: await resultOf(sid, from), from };
}
const starts = (sid, from = 0) => events.slice(from).filter((e) => e.kind === 'session.state' && e.sessionId === sid && e.state === 'starting').length;
const providerNow = async (id) => (await req({ kind: 'providers.list' })).find((p) => p.id === id);

async function main() {
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  await req({ kind: 'settings.set', key: 'network.proxy', value: 'off' });
  const O = await req({ kind: 'providers.upsert', provider: { name: '中转O', type: 'openai', baseUrl: `${up}/v1`, apiKey: RELAY_KEY, defaultModel: 'deepseek-flash', models: ['deepseek-flash', 'qwen-e2e', 'gpt-4o'], responsesApi: false } });
  const A = await req({ kind: 'providers.upsert', provider: { name: '中转A', type: 'anthropic', baseUrl: up, apiKey: RELAY_KEY, defaultModel: 'claude-opus-5-5', models: ['claude-opus-5-5', 'claude-sonnet-4-6'], runtime: 'ccb' } });
  const G = await req({ kind: 'providers.upsert', provider: { name: 'GemG', type: 'gemini', baseUrl: up, apiKey: 'gem-key-e2e', defaultModel: 'gemini-3-pro', models: ['gemini-3-pro'] } });

  // ---- the model list declares the levels ----
  await req({ kind: 'providers.refreshModels', ids: [O.id] });
  const listed = await providerNow(O.id);
  check('the provider keeps each model\'s levels from /v1/models (effort.supported_levels)', listed?.modelEfforts?.['deepseek-flash']?.levels?.join(',') === 'low,high,max' && listed?.modelEfforts?.['qwen-e2e']?.levels?.join(',') === 'low,medium,high', JSON.stringify(listed?.modelEfforts ?? null));

  // ---- Anthropic format: Claude 5 on our engine ----
  const a = await openOn(A.id, 'claude-opus-5-5', { effort: 'max' });
  check('a Claude-format provider\'s conversation runs on claude-web-engine', a.info.runtime === 'ccb', `runtime=${a.info.runtime}`);
  const ar = await turn(a.sessionId, 'ANT-ONE 你好');
  const am = mainOf('anthropic', 'ANT-ONE');
  // (thinking itself is still switched off for Claude 5 on ccb by claude-web's ccbMisthinks detour, until the real-relay check)
  check('claude-opus-5-5 + max → output_config.effort "max"', am.length > 0 && am.every((h) => h.body.output_config?.effort === 'max'), am.map((h) => JSON.stringify({ oc: h.body.output_config, th: h.body.thinking })).join(' | ').slice(0, 200));
  check('… and the answer comes back', /anthropic:ok/.test(ar.result?.result ?? ''), String(ar.result?.result ?? ar.result?.subtype ?? '(no result)').slice(0, 120));
  const s46 = await openOn(A.id, 'claude-sonnet-4-6', { effort: 'high' });
  await turn(s46.sessionId, 'ANT-TWO 你好');
  const sm = mainOf('anthropic', 'ANT-TWO');
  check('claude-sonnet-4-6 + high → adaptive thinking with output_config.effort "high"', sm.length > 0 && sm.every((h) => h.body.output_config?.effort === 'high' && h.body.thinking?.type === 'adaptive'), sm.map((h) => JSON.stringify({ oc: h.body.output_config, th: h.body.thinking })).join(' | ').slice(0, 200));

  // ---- OpenAI format: DeepSeek's own levels, changed mid-conversation, then 深度编排 ----
  const d = await openOn(O.id, 'deepseek-flash', { effort: 'xhigh' });
  const dr = await turn(d.sessionId, 'DS-ONE 你好');
  const d1 = mainOf('openai', 'DS-ONE');
  check('deepseek-flash + 更深 (xhigh) → reasoning_effort "max" (DeepSeek has low / high / max)', d1.length > 0 && d1.every((h) => h.body.reasoning_effort === 'max'), d1.map((h) => h.body.reasoning_effort).join(','));
  check('… and the answer comes back', /relay:deepseek-flash/.test(dr.result?.result ?? ''), String(dr.result?.result ?? '(no result)').slice(0, 120));
  const startsBefore = starts(d.sessionId);
  const spawnsBefore = engineSpawns();
  await req({ kind: 'session.setEffort', sessionId: d.sessionId, effort: 'low' });
  await turn(d.sessionId, 'DS-TWO 再来');
  const d2 = mainOf('openai', 'DS-TWO');
  check('changed to low → the next request says reasoning_effort "low"', d2.length > 0 && d2.every((h) => h.body.reasoning_effort === 'low'), d2.map((h) => h.body.reasoning_effort).join(','));
  check('… without restarting the engine process', spawnsBefore > 0 && engineSpawns() === spawnsBefore && starts(d.sessionId) === startsBefore, `engine spawns ${spawnsBefore} → ${engineSpawns()}, starting states ${startsBefore} → ${starts(d.sessionId)}`);
  await req({ kind: 'session.setUltracode', sessionId: d.sessionId, on: true });
  await turn(d.sessionId, 'DS-THREE 做个小任务');
  const d3 = mainOf('openai', 'DS-THREE');
  check('深度编排 on → the next request carries the ultracode reminder', d3.length > 0 && d3.every((h) => turnText(h).includes('Ultracode is on for this session')), d3.map((h) => turnText(h).slice(0, 80)).join(' | '));
  check('… still without a restart', engineSpawns() === spawnsBefore && starts(d.sessionId) === startsBefore);
  const du = await openOn(O.id, 'deepseek-flash', { effort: 'high', ultracode: true });
  await turn(du.sessionId, 'DS-FOUR 做个小任务');
  const d4 = mainOf('openai', 'DS-FOUR');
  check('深度编排 picked before the conversation starts (welcome page) → its first request carries the reminder', d4.length > 0 && d4.every((h) => turnText(h).includes('Ultracode is on for this session') && h.body.reasoning_effort === 'max'), d4.map((h) => `${h.body.reasoning_effort} ${turnText(h).includes('Ultracode is on')}`).join(' | '));

  // ---- a model without the parameter: the prompt way ----
  const g4 = await openOn(O.id, 'gpt-4o', { effort: 'high' });
  await turn(g4.sessionId, 'GPT-ONE 你好');
  const gm = mainOf('openai', 'GPT-ONE');
  check('gpt-4o + high → no effort field in the body', gm.length > 0 && gm.every((h) => !('reasoning_effort' in h.body) && !('reasoning' in h.body)), gm.map((h) => Object.keys(h.body).join('/')).join(' | ').slice(0, 200));
  check('… and the turn\'s user message carries "Reasoning depth: high."', gm.length > 0 && gm.every((h) => turnText(h).includes('Reasoning depth: high.')));

  // ---- a relay that refuses the parameter ----
  const qw = await openOn(O.id, 'qwen-e2e', { effort: 'high' });
  const qr = await turn(qw.sessionId, 'QW-ONE 你好');
  const q1 = hits.filter((h) => h.fmt === 'openai' && h.body.model === 'qwen-e2e' && h.body.stream === true && turnText(h).includes('QW-ONE'));
  check('a relay refusing reasoning_effort (400 naming it): the turn is answered anyway', /relay:qwen-e2e/.test(qr.result?.result ?? '') && q1.some((h) => h.status === 400) && q1.at(-1)?.status === 200 && !('reasoning_effort' in (q1.at(-1)?.body ?? {})), `${String(qr.result?.result ?? '(no result)').slice(0, 60)} · ${q1.map((h) => `${h.status}${'reasoning_effort' in h.body ? '+effort' : ''}`).join(',')}`);
  const remembered = await until(async () => (await providerNow(O.id))?.promptEffortModels?.includes('qwen-e2e'), 10_000);
  check('… the provider remembers the model as prompt-only', !!remembered, JSON.stringify((await providerNow(O.id))?.promptEffortModels ?? null));
  await turn(qw.sessionId, 'QW-TWO 再来');
  const q2 = mainOf('openai', 'QW-TWO');
  check('… and the next turn goes the prompt way (no parameter, "Reasoning depth: high.")', q2.length > 0 && q2.every((h) => !('reasoning_effort' in h.body) && turnText(h).includes('Reasoning depth: high.')), q2.map((h) => `${h.status}${'reasoning_effort' in h.body ? '+effort' : ''}`).join(','));

  // ---- Gemini format ----
  const gg = await openOn(G.id, 'gemini-3-pro', { effort: 'high' });
  const gr = await turn(gg.sessionId, 'GEM-ONE 你好');
  const gmn = mainOf('gemini', 'GEM-ONE');
  check('gemini-3-pro + high → generationConfig.thinkingConfig.thinkingLevel "high"', gmn.length > 0 && gmn.every((h) => h.body.generationConfig?.thinkingConfig?.thinkingLevel === 'high'), gmn.map((h) => JSON.stringify(h.body.generationConfig?.thinkingConfig ?? null)).join(' | '));
  check('… and the answer comes back', /gemini:ok/.test(gr.result?.result ?? ''), String(gr.result?.result ?? gr.result?.subtype ?? '(no result)').slice(0, 120));

  // ---- 自动判断 on a model that thinks by default ----
  const au = await openOn(O.id, 'deepseek-flash', { effort: 'high', permissionMode: 'auto' });
  const permFrom = events.length;
  const ar2 = await turn(au.sessionId, 'AUTO-BASH 运行一条命令');
  const cls = hits.filter((h) => h.fmt === 'openai' && h.body.tool_choice?.function?.name === 'classify_result');
  check('自动判断 asks the classifier with thinking off and tool_choice naming classify_result', cls.length > 0 && cls.every((h) => h.body.thinking?.type === 'disabled' && h.body.tool_choice?.type === 'function'), cls.map((h) => JSON.stringify({ th: h.body.thinking, tc: h.body.tool_choice })).join(' | ').slice(0, 200));
  const asked = events.slice(permFrom).filter((e) => e.kind === 'permission.request' && e.request?.sessionId === au.sessionId).length;
  check('… the command runs without a permission prompt and the turn finishes', asked === 0 && /auto:done/.test(ar2.result?.result ?? ''), `prompts=${asked} · ${String(ar2.result?.result ?? '(no result)').slice(0, 80)}`);
}

main().catch((e) => { check('phase22 ran to the end', false, e.stack || e.message); }).finally(async () => {
  for (const sid of opened) await req({ kind: 'session.close', sessionId: sid }).catch(() => {});
  try { ws.close(); } catch { /* */ }
  server.kill();
  upstream.closeAllConnections(); upstream.close();
  await new Promise((r) => setTimeout(r, 800));
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows may still hold a handle */ }
  const bad = results.filter(([, ok]) => !ok);
  if (bad.length) {
    const brief = (e) => e.kind === 'session.state' ? `${e.sessionId.slice(0, 8)} state ${e.state}${e.error ? ` (${e.error})` : ''}` : `${e.sessionId.slice(0, 8)} ${e.message.type}${e.message.subtype ? `/${e.message.subtype}` : ''}${e.message.type === 'result' ? ` ${String(e.message.result ?? e.message.errors ?? '').slice(0, 160)}` : ''}`;
    console.log(`\n--- conversation events ---\n${events.filter((e) => e.kind === 'session.state' || (e.kind === 'session.event' && e.message.type !== 'stream_event')).map(brief).join('\n')}`);
    console.log(`\n--- upstream requests ---\n${hits.map((h) => `${h.status} ${h.method} ${h.url} ${h.body.model ?? ''} ${h.body.stream ? 'stream' : ''}`).join('\n')}`);
    console.log(`\n--- server log (tail) ---\n${slog.split('\n').filter((l) => !l.startsWith('[spawn]')).slice(-60).join('\n')}`);
  }
  console.log(`\nphase22: ${results.length - bad.length}/${results.length} passed`);
  process.exit(bad.length ? 1 : 0);
});
