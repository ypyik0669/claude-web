// Phase 18 end-to-end: prompt caching (2026-09-28) over the real server and a real ccb process, against
// fake upstreams started here — no model, no token. Checks:
//   · an openai-type profile's Claude session goes through the cache shim (gateway switch OFF): the upstream sees
//     prompt_cache_key "cw:<session>" + affinity headers (no x-client-request-id) + the real key; DeepSeek-style
//     top-level hit counts reach ccb (result cache_read > 0) and the ledger; cost unknown (not $0) for a non-Claude model;
//   · a fork (and the fork reopened) keeps the parent's key, its ledger rows are its own;
//   · the same profile with the shim switched off = the old behaviour (no key; ccb counts 0 % hits);
//   · an upstream that 400s naming prompt_cache_key: retried, the profile remembers;
//   · gpt-* → /v1/responses (store:false + key + 24h retention) answered back as chat chunks; the profile probe
//     checks /v1/responses too;
//   · (review probe) parallel tool calls round-trip through /v1/responses, a mid-stream response.failed surfaces as
//     an API error, a 404 model_not_found does not mark the endpoint as having no Responses API;
//   · the model gateway: translated → Anthropic gets 3 cache_control + metadata.user_id; → OpenAI gets the key,
//     affinity headers and no x-anthropic-billing-header block;
//   · the shim refuses a foreign key and the LAN listener.
//   node server/ws-phase18.mjs [port] [token]   (meant for scripts/e2e.mjs: temp HOME + CLAUDE_WEB_DIR)
import WebSocket from 'ws';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const port = args[0] ?? '3090';
const token = args[1];

const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${token ? `?token=${token}` : ''}`);
let seq = 0;
const pending = new Map();
const events = [];
const waiters = [];
const safe = (fn, e) => { try { return fn(e); } catch { return false; } };
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (process.env.CW_DEBUG) console.error('<<', String(raw).slice(0, 300));
  if (m.type === 'reply') { const p = pending.get(m.reply.id); pending.delete(m.reply.id); m.reply.ok ? p.res(m.reply.data) : p.rej(new Error(m.reply.error)); return; }
  if (m.type === 'event') { events.push(m.event); for (const w of [...waiters]) if (safe(w.fn, m.event)) { waiters.splice(waiters.indexOf(w), 1); w.res(m.event); } }
});
const req = (r) => new Promise((res, rej) => { const id = String(++seq); pending.set(id, { res, rej }); ws.send(JSON.stringify({ type: 'request', request: { id, req: r } })); });
const waitEvent = (fn, ms = 60000) => new Promise((res, rej) => { const hit = events.find((e) => safe(fn, e)); if (hit) return res(hit); const w = { fn, res }; waiters.push(w); setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); rej(new Error('timeout waiting for event')); }, ms); });
const results = [];
const check = (name, ok, detail = '') => { results.push([name, !!ok]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

// ---- fake upstreams ----
function upstream(handle) {
  const hits = [];
  const srv = http.createServer((q, s) => {
    let body = '';
    q.on('data', (c) => { body += c; });
    q.on('end', () => { const h = { method: q.method, url: q.url, headers: q.headers, body }; hits.push(h); handle(q, s, body, h); });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, hits, url: `http://127.0.0.1:${srv.address().port}` })));
}
const state = { rejectKeyFor: '' }; // api key whose requests 400 when they carry prompt_cache_key
// OpenAI-compatible relay: chat/completions answers like DeepSeek (hit count only at the top level), /v1/responses like OpenAI
const O = await upstream((q, s, body, h) => {
  if (q.method === 'GET') { s.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-e2e', object: 'model' }, { id: 'gpt-e2e-5', object: 'model' }] })); return; }
  let j = {};
  try { j = JSON.parse(body || '{}'); } catch { /* keep */ }
  if (state.rejectKeyFor && q.headers.authorization === `Bearer ${state.rejectKeyFor}` && j.prompt_cache_key) {
    h.rejected = true;
    s.writeHead(400, { 'content-type': 'application/json' }).end('{"error":{"message":"Unrecognized request argument supplied: prompt_cache_key","type":"invalid_request_error"}}');
    return;
  }
  if (q.url.endsWith('/responses') && !j.stream) { // the profile probe's one-shot check
    s.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'resp_probe', object: 'response', status: 'completed', model: j.model, output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] }));
    return;
  }
  if (q.url.endsWith('/responses')) {
    const ev = (o) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
    s.writeHead(200, { 'content-type': 'text/event-stream' });
    s.end([
      ev({ type: 'response.created', response: { id: 'resp_e2e', model: j.model, status: 'in_progress' } }),
      ev({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm1', role: 'assistant', content: [] } }),
      ev({ type: 'response.output_text.delta', item_id: 'm1', output_index: 0, content_index: 0, delta: 'done via responses' }),
      ev({ type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'm1', content: [{ type: 'output_text', text: 'done via responses' }] } }),
      ev({ type: 'response.completed', response: { id: 'resp_e2e', status: 'completed', usage: { input_tokens: 30000, input_tokens_details: { cached_tokens: 27000 }, output_tokens: 7 } } }),
    ].join(''));
    return;
  }
  const c = (o) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: j.model, ...o })}\n\n`;
  if (!j.stream) { // ccb always streams; the profile probe does not
    s.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'c1', object: 'chat.completion', model: j.model, choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20000, completion_tokens: 5, prompt_cache_hit_tokens: 15000, prompt_cache_miss_tokens: 5000 } }));
    return;
  }
  s.writeHead(200, { 'content-type': 'text/event-stream' });
  s.end(c({ choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
    + c({ choices: [{ index: 0, delta: { content: 'done' }, finish_reason: null }] })
    + c({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
    + c({ choices: [], usage: { prompt_tokens: 20000, completion_tokens: 5, total_tokens: 20005, prompt_cache_hit_tokens: 15000, prompt_cache_miss_tokens: 5000 } })
    + 'data: [DONE]\n\n');
});
// A Responses-only relay for the tool round trip (review probe): parallel function calls, a mid-stream
// response.failed, a 404 model_not_found; chat/completions is not there at all
const rt = { mode: 'tools' };
const R = await upstream((q, s, body) => {
  let j = {};
  try { j = JSON.parse(body || '{}'); } catch { /* keep */ }
  if (q.method === 'GET') { s.writeHead(200, { 'content-type': 'application/json' }).end('{"object":"list","data":[{"id":"gpt-rt-5"}]}'); return; }
  if (!q.url.endsWith('/responses')) { s.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"message":"Invalid URL (POST /v1/chat/completions)"}}'); return; }
  if (rt.mode === '404') { s.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"message":"The model `gpt-typo` does not exist or you do not have access to it.","type":"invalid_request_error","code":"model_not_found"}}'); return; }
  const ev = (o) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
  const u = { input_tokens: 1000, input_tokens_details: { cached_tokens: 800 }, output_tokens: 5 };
  s.writeHead(200, { 'content-type': 'text/event-stream' });
  if (rt.mode === 'fail') {
    s.end(ev({ type: 'response.created', response: { id: 'r' } }) + ev({ type: 'response.output_text.delta', item_id: 'm', delta: 'partial ' }) + ev({ type: 'response.failed', response: { status: 'failed', error: { code: 'server_error', message: 'boom upstream' } } }));
    return;
  }
  const outputs = (j.input ?? []).filter((i) => i.type === 'function_call_output');
  if (!j.tools?.length || outputs.length) {
    const text = outputs.length ? `got ${outputs.length} outputs` : 'title';
    s.end([ev({ type: 'response.created', response: { id: 'r2' } }), ev({ type: 'response.output_item.added', item: { type: 'message', id: 'm2', role: 'assistant', content: [] } }), ev({ type: 'response.output_text.delta', item_id: 'm2', delta: text }), ev({ type: 'response.output_item.done', item: { type: 'message', id: 'm2', content: [{ type: 'output_text', text }] } }), ev({ type: 'response.completed', response: { status: 'completed', usage: u } })].join(''));
    return;
  }
  s.end([
    ev({ type: 'response.created', response: { id: 'r1' } }),
    ev({ type: 'response.output_item.added', item: { type: 'reasoning', id: 'rs' } }),
    ev({ type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs', summary: [] } }),
    ev({ type: 'response.output_item.added', item: { type: 'message', id: 'm1', role: 'assistant', content: [] } }),
    ev({ type: 'response.output_text.delta', item_id: 'm1', delta: 'Looking.' }),
    ev({ type: 'response.output_item.done', item: { type: 'message', id: 'm1', content: [{ type: 'output_text', text: 'Looking.' }] } }),
    ev({ type: 'response.output_item.added', item: { type: 'function_call', id: 'fa', call_id: 'call_a', name: 'Glob', arguments: '' } }),
    ev({ type: 'response.function_call_arguments.delta', item_id: 'fa', delta: '{"pattern":' }),
    ev({ type: 'response.function_call_arguments.delta', item_id: 'fa', delta: '"*.txt"}' }),
    ev({ type: 'response.output_item.done', item: { type: 'function_call', id: 'fa', call_id: 'call_a', name: 'Glob', arguments: '{"pattern":"*.txt"}' } }),
    ev({ type: 'response.output_item.added', item: { type: 'function_call', id: 'fb', call_id: 'call_b', name: 'Glob', arguments: '' } }),
    ev({ type: 'response.function_call_arguments.delta', item_id: 'fb', delta: '{"pattern":"*.md"}' }),
    ev({ type: 'response.output_item.done', item: { type: 'function_call', id: 'fb', call_id: 'call_b', name: 'Glob', arguments: '{"pattern":"*.md"}' } }),
    ev({ type: 'response.completed', response: { status: 'completed', usage: u } }),
  ].join(''));
});
// Anthropic member for the gateway checks
const A = await upstream((q, s) => {
  s.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'msg_a', type: 'message', role: 'assistant', model: 'claude-e2e', content: [{ type: 'text', text: 'A' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 90 } }));
});

const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-e2e18-'));
fs.writeFileSync(path.join(cwd, 'a.txt'), 'x');
const chats = (key) => O.hits.filter((h) => h.method === 'POST' && h.headers.authorization === `Bearer ${key}`);

/** One Claude (ccb) turn on a profile (or `open` params of an existing session / a fork); returns { sid, result, text, tools }. */
async function turn(providerId, model, prompt = 'say done', open = {}) {
  const o = await req({ kind: 'session.open', params: { cwd, ...(providerId ? { providerId } : {}), model, permissionMode: 'bypassPermissions', ...open } });
  const sid = o.sessionId;
  await waitEvent((e) => e.kind === 'session.state' && e.sessionId === sid && (e.state === 'idle' || e.state === 'error'), 120000).catch(() => null);
  const from = events.length;
  await req({ kind: 'session.send', params: { sessionId: sid, text: prompt } });
  const r = await waitEvent((e) => e.kind === 'session.event' && e.sessionId === sid && e.message.type === 'result' && events.indexOf(e) >= from, 180000).catch(() => null);
  const mine = events.slice(from).filter((e) => e.kind === 'session.event' && e.sessionId === sid);
  const text = mine.filter((e) => e.message.type === 'stream_event' && e.message.event?.type === 'content_block_delta' && e.message.event.delta?.type === 'text_delta').map((e) => e.message.event.delta.text).join('');
  const tools = mine.filter((e) => e.message.type === 'assistant').flatMap((e) => e.message.message.content.filter((c) => c.type === 'tool_use'));
  await req({ kind: 'session.close', sessionId: sid }).catch(() => {});
  return { sid, result: r?.message, text, tools };
}
const pct = (u) => { const all = (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0); return all ? Math.round(((u.cache_read_input_tokens ?? 0) / all) * 100) : 0; };

ws.on('open', async () => {
  const created = [];
  const groups = [];
  let remotePort = 0;
  try {
    const st = await req({ kind: 'gateway.status' });
    check('the model gateway is off (the shim must not depend on it)', !st.enabled);
    const ds = await req({ kind: 'providers.upsert', provider: { name: 'e2e-ds', type: 'openai', baseUrl: `${O.url}/v1`, apiKey: 'sk-e2e-ds', defaultModel: 'deepseek-e2e' } });
    const direct = await req({ kind: 'providers.upsert', provider: { name: 'e2e-direct', type: 'openai', baseUrl: `${O.url}/v1`, apiKey: 'sk-e2e-direct', defaultModel: 'deepseek-e2e', cacheShim: false } });
    const strict = await req({ kind: 'providers.upsert', provider: { name: 'e2e-strict', type: 'openai', baseUrl: `${O.url}/v1`, apiKey: 'sk-e2e-strict', defaultModel: 'deepseek-e2e' } });
    const gpt = await req({ kind: 'providers.upsert', provider: { name: 'e2e-gpt', type: 'openai', baseUrl: `${O.url}/v1`, apiKey: 'sk-e2e-gpt', defaultModel: 'gpt-e2e-5' } });
    created.push(ds.id, direct.id, strict.id, gpt.id);

    // 1) through the shim
    const t1 = await turn(ds.id, 'deepseek-e2e');
    const h1 = chats('sk-e2e-ds');
    check('shim: ccb session answered through it', !!t1.result && !t1.result.is_error && t1.text.includes('done'), t1.result ? `text=${JSON.stringify(t1.text.slice(0, 40))}` : 'no result');
    check('shim: every chat request carries prompt_cache_key "cw:<session>" as its first field', h1.length > 0 && h1.every((h) => h.body.startsWith(`{"prompt_cache_key":"cw:${t1.sid}",`)), `${h1.length} requests`);
    // x-client-request-id is a per-request id upstream (OpenAI SDK): never reused as a session key
    check('shim: affinity headers (session_id / x-session-affinity, no x-client-request-id) + the real key upstream', h1.length > 0 && h1.every((h) => h.headers.session_id === `cw:${t1.sid}` && h.headers['x-session-affinity'] === `cw:${t1.sid}` && h.headers['x-client-request-id'] !== `cw:${t1.sid}` && h.headers.authorization === 'Bearer sk-e2e-ds'), JSON.stringify(h1[0]?.headers ?? {}).slice(0, 160));
    const u1 = t1.result?.usage;
    check('shim: DeepSeek top-level hit reaches ccb (result cache_read > 0)', (u1?.cache_read_input_tokens ?? 0) >= 15000 && u1.input_tokens === 5000 * h1.length, `input=${u1?.input_tokens} cache_read=${u1?.cache_read_input_tokens} hit=${pct(u1)}%`);
    check('non-Claude model: ccb\'s Claude-priced cost is dropped (cost_unknown, not $0)', t1.result?.total_cost_usd === 0 && t1.result?.cost_unknown === true, `cost=${t1.result?.total_cost_usd} unknown=${t1.result?.cost_unknown}`);

    // 1b) a fork keeps routing under its parent's key (same prefix); its ledger rows are its own — also after a reopen
    const beforeFork = chats('sk-e2e-ds').length;
    const tf = await turn(undefined, 'deepseek-e2e', 'say done', { sessionId: t1.sid, fork: true });
    const hf = chats('sk-e2e-ds').slice(beforeFork);
    check('fork: a new session id, prompt_cache_key / affinity still the parent\'s', tf.sid !== t1.sid && !!tf.result && !tf.result.is_error && hf.length > 0 && hf.every((h) => JSON.parse(h.body).prompt_cache_key === `cw:${t1.sid}` && h.headers.session_id === `cw:${t1.sid}`), `fork=${tf.sid?.slice(0, 8)} ${hf.length} requests key=${hf[0] ? JSON.parse(hf[0].body).prompt_cache_key : '-'}`);
    const beforeReopen = chats('sk-e2e-ds').length;
    const tr = await turn(undefined, 'deepseek-e2e', 'say done', { sessionId: tf.sid });
    const hr = chats('sk-e2e-ds').slice(beforeReopen);
    check('fork reopened later: still the parent\'s key', tr.sid === tf.sid && hr.length > 0 && hr.every((h) => JSON.parse(h.body).prompt_cache_key === `cw:${t1.sid}`), `${hr.length} requests`);

    // 2) the same thing with the shim switched off = what it was before
    const t2 = await turn(direct.id, 'deepseek-e2e');
    const h2 = chats('sk-e2e-direct');
    check('shim off: straight to the endpoint, no prompt_cache_key / affinity headers', h2.length > 0 && h2.every((h) => !JSON.parse(h.body).prompt_cache_key && !h.headers.session_id), `${h2.length} requests`);
    check('shim off: ccb reads 0 % from the same upstream (the statistics bug the shim fixes)', !!t2.result && (t2.result.usage?.cache_read_input_tokens ?? 0) === 0, `input=${t2.result?.usage?.input_tokens} cache_read=${t2.result?.usage?.cache_read_input_tokens}`);

    // 3) an upstream that rejects the key
    state.rejectKeyFor = 'sk-e2e-strict';
    const t3 = await turn(strict.id, 'deepseek-e2e');
    const h3 = chats('sk-e2e-strict');
    check('400 on prompt_cache_key: retried without it and the turn succeeds', !!t3.result && !t3.result.is_error && h3.some((h) => h.rejected) && h3.some((h) => !JSON.parse(h.body).prompt_cache_key), `${h3.length} requests, ${h3.filter((h) => h.rejected).length} rejected`);
    const pl = await req({ kind: 'providers.list' });
    check('… and the profile remembers (noPromptCacheKey: the error named the field)', pl.find((p) => p.id === strict.id)?.noPromptCacheKey === true);
    state.rejectKeyFor = '';

    // 4) gpt-* via /v1/responses
    const t4 = await turn(gpt.id, 'gpt-e2e-5');
    const h4 = chats('sk-e2e-gpt');
    const rb = h4.find((h) => h.url.endsWith('/responses'));
    const rj = rb ? JSON.parse(rb.body) : {};
    check('gpt-*: sent to /v1/responses with store:false + prompt_cache_key + 24h retention', !!rb && rj.store === false && rj.prompt_cache_key === `cw:${t4.sid}` && rj.prompt_cache_retention === '24h' && Array.isArray(rj.input) && typeof rj.instructions === 'string' && h4.every((h) => h.url.endsWith('/responses')), `${h4.map((h) => h.url).join(',')}`);
    check('gpt-*: the answer comes back to ccb as chat chunks, with the hit counted', !!t4.result && !t4.result.is_error && t4.text.includes('done via responses') && (t4.result.usage?.cache_read_input_tokens ?? 0) >= 27000, `text=${JSON.stringify(t4.text.slice(0, 40))} cache_read=${t4.result?.usage?.cache_read_input_tokens} hit=${pct(t4.result?.usage)}%`);
    const pr = await req({ kind: 'providers.probe', id: gpt.id });
    check('probe of a gpt-* profile: /v1/responses checked next to chat', pr.ok && pr.chat?.ok && pr.responses?.ok === true && O.hits.some((h) => h.url.endsWith('/responses') && !h.body.includes('"stream":true')), `chat=${JSON.stringify(pr.chat ?? null).slice(0, 100)} responses=${JSON.stringify(pr.responses ?? null).slice(0, 100)}`);

    // 4b) review probe: parallel tool calls through /v1/responses, a mid-stream failure, a 404 model_not_found
    const rtp = await req({ kind: 'providers.upsert', provider: { name: 'e2e-rt', type: 'openai', baseUrl: `${R.url}/v1`, apiKey: 'sk-e2e-rt', defaultModel: 'gpt-rt-5' } });
    created.push(rtp.id);
    const tt = await turn(rtp.id, 'gpt-rt-5', 'find files');
    const second = R.hits.map((h) => { try { return JSON.parse(h.body); } catch { return {}; } }).find((j) => (j.input ?? []).some((i) => i.type === 'function_call_output'));
    const outs = second ? second.input.filter((i) => i.type === 'function_call_output').map((i) => i.call_id) : [];
    const calls = second ? second.input.filter((i) => i.type === 'function_call').map((i) => `${i.call_id}:${i.name}`) : [];
    check('Responses tool round trip: ccb runs both parallel calls, the next request carries both calls + outputs', !!tt.result && !tt.result.is_error && tt.tools.filter((t) => t.name === 'Glob').length === 2 && outs.includes('call_a') && outs.includes('call_b') && calls.includes('call_a:Glob') && calls.includes('call_b:Glob') && tt.text.includes('got 2 outputs'), `tools=${tt.tools.map((t) => t.name).join(',')} outputs=${outs.join(',')} text=${JSON.stringify(tt.text.slice(-30))}`);
    rt.mode = 'fail';
    const tfl = await turn(rtp.id, 'gpt-rt-5', 'find files');
    check('response.failed mid-stream → an API error in ccb, not a silent empty answer', !!tfl.result && (tfl.result.is_error || String(tfl.result.result ?? '').includes('boom upstream')) && String(tfl.result.result ?? '').includes('boom upstream'), tfl.result ? String(tfl.result.result).slice(0, 100) : 'no result');
    rt.mode = '404';
    const t404 = await turn(rtp.id, 'gpt-rt-5', 'find files');
    const pl404 = await req({ kind: 'providers.list' });
    check('404 model_not_found on /v1/responses: ccb shows the model error (not the fallback\'s), noResponsesApi NOT remembered', !!t404.result && String(t404.result.result ?? '').includes('gpt-typo') && pl404.find((p) => p.id === rtp.id)?.noResponsesApi !== true, `noResponsesApi=${pl404.find((p) => p.id === rtp.id)?.noResponsesApi} result=${String(t404.result?.result ?? '').slice(0, 80)}`);
    rt.mode = 'tools';

    // 5) ledger: session rows (cost 0 for non-Claude models) + one shim row per call
    const rows = await req({ kind: 'ledger.list', days: 1 });
    const s1 = rows.find((r) => r.sessionId === t1.sid && r.kind !== 'gateway');
    const shimRows = rows.filter((r) => r.kind === 'gateway' && r.gateway?.via === 'shim');
    check('ledger: the session row has the hit and an unknown (not $0) cost', !!s1 && s1.cacheRead >= 15000 && s1.costUsd === 0 && s1.costUnknown === true, s1 ? `cacheRead=${s1.cacheRead} cost=${s1.costUsd} unknown=${s1.costUnknown}` : 'missing');
    check('ledger: one shim row per upstream call, with usage', shimRows.filter((r) => r.sessionId === t1.sid).length === h1.length && shimRows.filter((r) => r.ok && r.providerId !== rtp.id).every((r) => r.cacheRead > 0) && shimRows.some((r) => r.gateway.outbound === 'responses'), `${shimRows.length} shim rows`);
    check('ledger: the fork\'s shim rows are under the fork, not the parent', shimRows.filter((r) => r.sessionId === tf.sid).length === hf.length + hr.length, `${shimRows.filter((r) => r.sessionId === tf.sid).length} rows for ${hf.length + hr.length} calls`);
    check('ledger: no shim rows for the direct profile', !rows.some((r) => r.kind === 'gateway' && r.providerId === direct.id));

    // 6) shim access control
    const bad = await fetch(`http://127.0.0.1:${port}/gateway/~p/${ds.id}/k/x/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer sk-e2e-ds', 'content-type': 'application/json' }, body: '{"model":"x","messages":[]}' });
    check('shim: any key but the internal one → 401 (the real key does not work either)', bad.status === 401, `status ${bad.status}`);

    // 7) the model gateway: breakpoints / metadata on → Anthropic, key / headers / no billing block on → OpenAI
    await req({ kind: 'gateway.set', enabled: true });
    const key = await req({ kind: 'gateway.revealKey' });
    const pa = await req({ kind: 'providers.upsert', provider: { name: 'e2e-ant', type: 'anthropic', baseUrl: A.url, apiKey: 'sk-e2e-ant' } });
    created.push(pa.id);
    const ga = await req({ kind: 'gateway.groups.upsert', group: { name: 'e2e-cache-a', members: [{ providerId: pa.id }] } });
    const go = await req({ kind: 'gateway.groups.upsert', group: { name: 'e2e-cache-o', members: [{ providerId: ds.id }] } });
    groups.push(ga.id, go.id);
    const base = `http://127.0.0.1:${port}/gateway`;
    await fetch(`${base}/${ga.id}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-e2e', prompt_cache_key: 'codex-e2e', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }], tools: [{ type: 'function', function: { name: 't', parameters: { type: 'object' } } }] }) });
    const ab = A.hits.at(-1)?.body ?? '';
    const aj = ab ? JSON.parse(ab) : {};
    check('gateway → Anthropic: 3 cache_control breakpoints + metadata.user_id', (ab.match(/"cache_control"/g)?.length ?? 0) === 3 && aj.metadata?.user_id === 'codex-e2e', ab.slice(0, 120));
    const before = O.hits.length;
    await fetch(`${base}/${go.id}/v1/messages`, { method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'x-claude-code-session-id': 'cc-e2e', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-e2e', max_tokens: 16, system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.300.e2e; cc_entrypoint=cli;' }, { type: 'text', text: 'You are Claude Code.' }], messages: [{ role: 'user', content: 'hi' }] }) });
    const oh = O.hits.slice(before).find((h) => h.method === 'POST');
    const oj = oh ? JSON.parse(oh.body) : {};
    check('gateway → OpenAI: prompt_cache_key + affinity headers from the Claude Code session, billing block dropped', oj.prompt_cache_key === 'cc-e2e' && oh.headers.session_id === 'cc-e2e' && oj.messages?.[0]?.content === 'You are Claude Code.' && !oh.body.includes('billing'), oh ? oh.body.slice(0, 120) : 'no request');

    // 8) the LAN listener never serves the shim
    remotePort = await freePort();
    const rs = await req({ kind: 'remote.set', enabled: true, port: remotePort });
    if (rs.running) {
      const rr = await fetch(`http://127.0.0.1:${remotePort}/gateway/~p/${ds.id}/k/x/v1/models`);
      check('remote listener → 404 for the shim', rr.status === 404, `status ${rr.status}`);
    } else check('remote listener → 404 for the shim', false, rs.error ?? 'remote listener did not start');
  } catch (e) {
    check('script error', false, e.stack ?? String(e));
  }
  if (remotePort) await req({ kind: 'remote.set', enabled: false }).catch(() => {});
  for (const g of groups) await req({ kind: 'gateway.groups.remove', id: g }).catch(() => {});
  for (const id of created) await req({ kind: 'providers.remove', id }).catch(() => {});
  await req({ kind: 'gateway.set', enabled: false }).catch(() => {});
  O.srv.closeAllConnections?.(); A.srv.closeAllConnections?.();
  O.srv.close(); A.srv.close();
  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* windows may still hold it */ }
  const pass = results.filter((r) => r[1]).length;
  console.log(`\n${pass}/${results.length} checks passed`);
  ws.close();
  process.exit(pass === results.length ? 0 : 1);
});
