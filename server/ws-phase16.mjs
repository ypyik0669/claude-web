// Phase 16 end-to-end: the model gateway over the real server, against two fake upstreams started here
// (an Anthropic-shaped one that answers 529 to its first request, and an OpenAI-shaped one). No real
// provider is contacted. Checks failover, passthrough fidelity, translation (stream and non-stream,
// Anthropic and OpenAI entry points), ledger rows, member state, auth and the LAN-listener 404.
//   node server/ws-phase16.mjs [port] [token]   (meant for scripts/e2e.mjs: temp HOME + CLAUDE_WEB_DIR)
import WebSocket from 'ws';
import http from 'node:http';
import net from 'node:net';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const port = args[0] ?? '3090';
const token = args[1];

const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${token ? `?token=${token}` : ''}`);
let seq = 0;
const pending = new Map();
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type === 'reply') { const p = pending.get(m.reply.id); pending.delete(m.reply.id); m.reply.ok ? p.res(m.reply.data) : p.rej(new Error(m.reply.error)); }
});
const req = (r) => new Promise((res, rej) => { const id = String(++seq); pending.set(id, { res, rej }); ws.send(JSON.stringify({ type: 'request', request: { id, req: r } })); });
const results = [];
const check = (name, ok, detail = '') => { results.push([name, !!ok]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

// ---- fake upstreams ----
function upstream(handle) {
  const hits = [];
  const srv = http.createServer((q, s) => {
    let body = '';
    q.on('data', (c) => { body += c; });
    q.on('end', () => { hits.push({ url: q.url, headers: q.headers, body }); handle(q, s, body, hits.length); });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, hits, url: `http://127.0.0.1:${srv.address().port}` })));
}
const sseEv = (o) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
const A = await upstream((q, s, body, n) => {
  if (n === 1) { s.writeHead(529, { 'content-type': 'application/json' }).end('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'); return; }
  const j = JSON.parse(body || '{}');
  if (j.stream) {
    s.writeHead(200, { 'content-type': 'text/event-stream' });
    s.end([
      sseEv({ type: 'message_start', message: { id: 'msg_a', type: 'message', role: 'assistant', model: j.model, content: [], usage: { input_tokens: 9, output_tokens: 1 } } }),
      sseEv({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      sseEv({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'A-stream' } }),
      sseEv({ type: 'content_block_stop', index: 0 }),
      sseEv({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }),
      sseEv({ type: 'message_stop' }),
    ].join(''));
    return;
  }
  s.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'msg_a', type: 'message', role: 'assistant', model: j.model, content: [{ type: 'text', text: 'A-json' }], stop_reason: 'end_turn', usage: { input_tokens: 9, output_tokens: 2 } }));
});
const O = await upstream((q, s, body) => {
  const j = JSON.parse(body || '{}');
  if (j.stream) {
    s.writeHead(200, { 'content-type': 'text/event-stream' });
    const c = (o) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: j.model, ...o })}\n\n`;
    s.end(c({ choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] }) + c({ choices: [{ index: 0, delta: { content: 'O-' } }] }) + c({ choices: [{ index: 0, delta: { content: 'stream' }, finish_reason: 'stop' }] }) + c({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }) + 'data: [DONE]\n\n');
    return;
  }
  s.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'c1', object: 'chat.completion', model: j.model, choices: [{ index: 0, message: { role: 'assistant', content: 'O-json' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }));
});

const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

ws.on('open', async () => {
  const created = [];
  const groups = [];
  let remotePort = 0;
  try {
    const pa = await req({ kind: 'providers.upsert', provider: { name: 'e2e-anthropic', type: 'anthropic', baseUrl: A.url, apiKey: 'sk-e2e-anthropic' } });
    const po = await req({ kind: 'providers.upsert', provider: { name: 'e2e-openai', type: 'openai', baseUrl: `${O.url}/v1`, apiKey: 'sk-e2e-openai' } });
    created.push(pa.id, po.id);

    const st0 = await req({ kind: 'gateway.set', enabled: true });
    check('gateway.set enables and the wire key is masked', st0.enabled && st0.keyMasked.includes('…') && !st0.keyMasked.includes('sk-'), st0.keyMasked);
    const key = await req({ kind: 'gateway.revealKey' });
    check('gateway.revealKey returns a cwg- key', /^cwg-[0-9a-f]{48}$/.test(key));
    const base = `${st0.baseUrl}`;
    check('base URL points at this server', base === `http://127.0.0.1:${port}/gateway`, base);

    const main = await req({ kind: 'gateway.groups.upsert', group: { name: 'e2e-main', strategy: 'failover', members: [{ providerId: pa.id }, { providerId: po.id, model: 'gpt-4.1' }] } });
    const onlyA = await req({ kind: 'gateway.groups.upsert', group: { name: 'e2e-a', members: [{ providerId: pa.id }] } });
    const onlyO = await req({ kind: 'gateway.groups.upsert', group: { name: 'e2e-o', members: [{ providerId: po.id }] } });
    groups.push(main.id, onlyA.id, onlyO.id);

    const post = async (group, path, body, headers = {}) => {
      const r = await fetch(`${base}/${group}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
      return { status: r.status, member: decodeURIComponent(r.headers.get('x-cw-gateway-member') ?? ''), switches: r.headers.get('x-cw-gateway-switches'), ct: r.headers.get('content-type') ?? '', text: await r.text() };
    };
    const anth = { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
    const msg = { model: 'claude-sonnet-4-5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] };

    // auth
    const bad = await post(main.id, '/v1/messages', msg, { 'x-api-key': 'wrong', 'anthropic-version': '2023-06-01' });
    check('wrong key → 401 in Anthropic error shape', bad.status === 401 && JSON.parse(bad.text).type === 'error', bad.text.slice(0, 80));

    // 1) Anthropic in, non-stream: A answers 529 → switch to the OpenAI member (translated)
    const r1 = await post(main.id, '/v1/messages', msg, anth);
    const j1 = JSON.parse(r1.text);
    check('529 from the first member → switched to the second', r1.status === 200 && r1.member === 'e2e-openai' && r1.switches === '1', `${r1.status} member=${r1.member} switches=${r1.switches}`);
    check('anthropic → openai translation (non-stream)', j1.type === 'message' && j1.content?.[0]?.text === 'O-json' && j1.model === 'claude-sonnet-4-5', r1.text.slice(0, 120));
    const oBody = JSON.parse(O.hits[0].body);
    check('member pin applied upstream (gpt-4.1) with the member key', oBody.model === 'gpt-4.1' && O.hits[0].headers.authorization === 'Bearer sk-e2e-openai' && O.hits[0].url === '/v1/chat/completions');

    const st1 = await req({ kind: 'gateway.status' });
    const aState = st1.states[main.id][0];
    check('the 529 member is cooling with its last status', aState.health === 'cooling' && aState.lastStatus === 529, JSON.stringify(aState).slice(0, 120));

    // 2) Anthropic in, stream: A still cooling in main → OpenAI member, SSE translated
    const r2 = await post(main.id, '/v1/messages', { ...msg, stream: true }, anth);
    check('anthropic → openai translation (stream)', r2.ct.includes('event-stream') && r2.text.includes('event: message_start') && r2.text.includes('"text":"O-"') && r2.text.includes('event: message_stop'), r2.text.slice(0, 80));
    check('cooling member skipped (A not hit again via main)', A.hits.length === 1, `A hits=${A.hits.length}`);

    // 3) passthrough (group with only A): body bytes + fingerprint headers unchanged
    const raw = '{"model":"claude-sonnet-4-5","max_tokens":16,"messages":[{"role":"user","content":"hi"}],"system":[{"type":"text","text":"You are Claude Code, Anthropic\'s official CLI for Claude."}]}';
    const r3 = await post(onlyA.id, '/v1/messages?beta=true', raw, { 'anthropic-version': '2023-06-01', authorization: `Bearer ${key}`, 'user-agent': 'claude-cli/2.1.300 (external, cli)', 'anthropic-beta': 'claude-code-20250219' });
    const h3 = A.hits.at(-1);
    check('passthrough non-stream', r3.status === 200 && JSON.parse(r3.text).content[0].text === 'A-json', r3.text.slice(0, 80));
    check('passthrough keeps body bytes, UA, anthropic-beta, query; swaps only the credential', h3.body === raw && h3.headers['user-agent'] === 'claude-cli/2.1.300 (external, cli)' && h3.headers['anthropic-beta'] === 'claude-code-20250219' && h3.url === '/v1/messages?beta=true' && h3.headers.authorization === 'Bearer sk-e2e-anthropic' && !JSON.stringify(h3.headers).includes(key));
    const r4 = await post(onlyA.id, '/v1/messages', { ...msg, stream: true }, anth);
    check('passthrough stream', r4.text.includes('A-stream') && r4.text.includes('event: message_stop'));

    // 4) OpenAI in: passthrough to the OpenAI member, and translation to the Anthropic member
    const oa = { authorization: `Bearer ${key}` };
    const chat = { model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'hi' }] };
    const r5 = await post(onlyO.id, '/v1/chat/completions', chat, oa);
    check('openai passthrough (non-stream)', r5.status === 200 && JSON.parse(r5.text).choices[0].message.content === 'O-json');
    const r6 = await post(onlyO.id, '/v1/chat/completions', { ...chat, stream: true }, oa);
    check('openai passthrough (stream)', r6.text.includes('"content":"stream"') && r6.text.trim().endsWith('data: [DONE]'));
    const r7 = await post(onlyA.id, '/v1/chat/completions', chat, oa);
    const j7 = JSON.parse(r7.text);
    check('openai → anthropic translation (non-stream)', j7.object === 'chat.completion' && j7.choices[0].message.content === 'A-json' && j7.usage.prompt_tokens === 9, r7.text.slice(0, 100));
    const r8 = await post(onlyA.id, '/v1/chat/completions', { ...chat, stream: true, stream_options: { include_usage: true } }, oa);
    check('openai → anthropic translation (stream)', r8.text.includes('"content":"A-stream"') && r8.text.includes('"usage"') && r8.text.trim().endsWith('data: [DONE]'), r8.text.slice(0, 80));
    const aUp = JSON.parse(A.hits.at(-1).body);
    check('translated request reached the Anthropic member in Messages shape', aUp.messages?.[0]?.role === 'user' && aUp.max_tokens > 0 && aUp.stream === true);

    // 5) ledger rows
    const rows = (await req({ kind: 'ledger.list', days: 1 })).filter((r) => r.kind === 'gateway');
    const sw = rows.find((r) => r.gateway?.switches === 1);
    check('ledger has gateway rows (group / inbound / member / switches / tokens)', rows.length >= 8 && sw?.gateway.group === 'e2e-main' && sw?.gateway.inbound === 'anthropic' && sw?.gateway.member === 'e2e-openai' && sw?.input + sw?.output > 0, `${rows.length} rows`);
    check('passthrough stream usage sniffed into the ledger', rows.some((r) => r.gateway.member === 'e2e-anthropic' && r.gateway.stream && r.output === 3 && r.input === 9));

    // 6) gateway.test through our own endpoint
    const t = await req({ kind: 'gateway.test', groupId: onlyO.id, protocol: 'openai' });
    check('gateway.test reports the member it went through', t.ok && t.member === 'e2e-openai' && t.text === 'O-json', JSON.stringify(t).slice(0, 120));

    // 7) the LAN listener never serves the gateway
    remotePort = await freePort();
    const rs = await req({ kind: 'remote.set', enabled: true, port: remotePort });
    if (rs.running) {
      const rr = await fetch(`http://127.0.0.1:${remotePort}/gateway/${main.id}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', ...anth }, body: JSON.stringify(msg) });
      check('remote listener → 404 for /gateway', rr.status === 404, `status ${rr.status}`);
    } else check('remote listener → 404 for /gateway', false, rs.error ?? 'remote listener did not start');
  } catch (e) {
    check('script error', false, e.stack ?? String(e));
  }
  if (remotePort) await req({ kind: 'remote.set', enabled: false }).catch(() => {});
  for (const g of groups) await req({ kind: 'gateway.groups.remove', id: g }).catch(() => {});
  for (const id of created) await req({ kind: 'providers.remove', id }).catch(() => {});
  await req({ kind: 'gateway.set', enabled: false }).catch(() => {});
  A.srv.close(); O.srv.close();
  A.srv.closeAllConnections?.(); O.srv.closeAllConnections?.();
  const pass = results.filter((r) => r[1]).length;
  console.log(`\n${pass}/${results.length} checks passed`);
  ws.close();
  process.exit(pass === results.length ? 0 : 1);
});
