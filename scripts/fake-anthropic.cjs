// A fake Anthropic Messages API on one 127.0.0.1 port, for ui-smoke: a provider (type `anthropic`) whose baseUrl is
// this server makes the real Claude Code run a conversation without a key or tokens. It stands in for the mock
// agent the smoke used before the app became Claude-only (2026-11-01). What it answers depends on the conversation:
//
//   - the last user message carries tool results: an error → 「denied」; the slow command's result → the echo of the
//     prompt (a goal's first round ends 「GOAL_STATUS: continue」, later rounds 「GOAL_STATUS: complete」); else 「read ok」
//   - a main-agent request (it offers the Read tool) whose last prompt says 「slow」 → a Bash `sleep <SLOW_S>` call,
//     「tool」 → a Read of `readPath` (outside the project, so the CLI asks for permission first)
//   - anything else (the main agent's plain prompts, the CLI's side requests: titles, suggestions …) → 「Echo: <prompt>」
const http = require('node:http');

const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n') : '');
const stripReminders = (t) => t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();

function decide(body, opts) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray(body.tools) ? body.tools.map((t) => t && t.name) : [];
  const main = tools.includes('Read') && tools.includes('Bash');
  const userTexts = msgs.filter((m) => m.role === 'user').map((m) => stripReminders(textOf(m.content))).filter(Boolean);
  const prompt = userTexts[userTexts.length - 1] ?? '';
  // what came after the last assistant message (the CLI may put a reminder in a message of its own after the results)
  let lastA = -1;
  msgs.forEach((m, i) => { if (m.role === 'assistant') lastA = i; });
  const results = msgs.slice(lastA + 1).flatMap((m) => (Array.isArray(m.content) ? m.content.filter((b) => b && b.type === 'tool_result') : []));
  if (results.length) {
    if (results.some((r) => r.is_error)) return { text: 'denied' };
    if (results.some((r) => String(r.tool_use_id).startsWith('toolu_fake_slow'))) {
      const goalRounds = userTexts.filter((t) => /GOAL_STATUS/.test(t)).length;
      if (!goalRounds) return { text: `Echo: ${prompt}` };
      return { text: `Echo: ${prompt.replace(/GOAL_STATUS/g, 'GOAL-STATUS').slice(0, 200)}\nGOAL_STATUS: ${goalRounds <= 1 ? 'continue' : 'complete'}` };
    }
    return { text: 'read ok' };
  }
  if (main && /slow/.test(prompt)) return { tool: { id: `toolu_fake_slow_${++opts.seq}`, name: 'Bash', input: { command: `sleep ${opts.slowSeconds}`, description: 'smoke: a slow command' } } };
  if (main && /\btool\b/.test(prompt)) return { tool: { id: `toolu_fake_read_${++opts.seq}`, name: 'Read', input: { file_path: opts.readPath } } };
  return { text: `Echo: ${prompt.slice(0, 400) || 'ok'}` };
}

function startFakeAnthropic({ readPath, slowSeconds = 6 } = {}) {
  const opts = { readPath, slowSeconds, seq: 0 };
  const calls = [];
  let n = 0;
  const server = http.createServer((q, s) => {
    let raw = '';
    q.on('data', (c) => { raw += c; });
    q.on('end', () => {
      const url = new URL(q.url, 'http://x');
      calls.push(`${q.method} ${url.pathname}`);
      const json = (code, o) => { s.writeHead(code, { 'content-type': 'application/json' }); s.end(JSON.stringify(o)); };
      if (q.method === 'GET' && url.pathname === '/v1/models') return json(200, { data: [{ type: 'model', id: 'smoke-fake', display_name: 'smoke-fake', created_at: '2026-01-01T00:00:00Z' }], has_more: false, first_id: 'smoke-fake', last_id: 'smoke-fake' });
      if (q.method !== 'POST') return json(404, { type: 'error', error: { type: 'not_found_error', message: 'not here' } });
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* an empty body */ }
      if (url.pathname === '/v1/messages/count_tokens') return json(200, { input_tokens: 10 });
      if (url.pathname !== '/v1/messages') return json(404, { type: 'error', error: { type: 'not_found_error', message: 'not here' } });
      const d = decide(body, opts);
      const id = `msg_fake_${++n}`;
      const model = body.model || 'smoke-fake';
      const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
      const block = d.tool ? { type: 'tool_use', id: d.tool.id, name: d.tool.name, input: d.tool.input } : { type: 'text', text: d.text };
      const stop = d.tool ? 'tool_use' : 'end_turn';
      if (!body.stream) return json(200, { id, type: 'message', role: 'assistant', model, content: [block], stop_reason: stop, stop_sequence: null, usage });
      s.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const ev = (type, data) => s.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      ev('message_start', { message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } });
      if (d.tool) {
        ev('content_block_start', { index: 0, content_block: { type: 'tool_use', id: d.tool.id, name: d.tool.name, input: {} } });
        ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(d.tool.input) } });
      } else {
        ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: d.text } });
      }
      ev('content_block_stop', { index: 0 });
      ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
      ev('message_stop', {});
      s.end();
    });
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ url: `http://127.0.0.1:${server.address().port}`, calls, close: () => server.close() })));
}

module.exports = { startFakeAnthropic };
