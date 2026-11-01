// The fake upstream's recording scripts (scripts/record-themes.cjs): run with `node --test scripts/lib/demo.test.cjs`.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const demo = require('./demo.cjs');

const post = (url, body) => new Promise((res, rej) => {
  const q = http.request(`${url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' } }, (r) => { let s = ''; r.on('data', (c) => { s += c; }); r.on('end', () => res(s)); });
  q.on('error', rej);
  q.end(JSON.stringify(body));
});
const events = (sse) => sse.split('\n\n').filter((b) => b.includes('data: ')).map((b) => JSON.parse(b.split('\n').find((l) => l.startsWith('data: ')).slice(6)));
const toolOf = (sse) => {
  const ev = events(sse);
  const start = ev.find((e) => e.type === 'content_block_start' && e.content_block.type === 'tool_use');
  if (!start) return null;
  const json = ev.filter((e) => e.type === 'content_block_delta' && e.index === start.index).map((e) => e.delta.partial_json).join('');
  return { name: start.content_block.name, input: JSON.parse(json) };
};
const textOf = (sse) => events(sse).filter((e) => e.type === 'content_block_delta' && e.delta.type === 'text_delta').map((e) => e.delta.text).join('');
const stopOf = (sse) => events(sse).find((e) => e.type === 'message_delta').delta.stop_reason;
const used = (id, name) => ({ role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] });
const result = (id) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }, { type: 'text', text: '<system-reminder>x</system-reminder>' }] });
const shop = path.join('C:', 'work', 'acme-shop');

test('the recorded turn: Read → Edit → npm test, then done', async () => {
  const up = await demo.startUpstream('en', { shop, pace: 0 });
  try {
    const T = demo.TEXT.en;
    const tools = [{ name: 'Read' }, { name: 'Edit' }, { name: 'Bash' }];
    const ask = { role: 'user', content: [{ type: 'text', text: '<system-reminder>x</system-reminder>' }, { type: 'text', text: T.rec }] };
    let messages = [ask];
    const r1 = toolOf(await post(up.url, { model: 'm', stream: true, tools, messages }));
    assert.equal(r1.name, 'Read');
    assert.equal(r1.input.file_path, path.join(shop, 'src', 'cart.ts'));
    messages = [...messages, used('a', 'Read'), result('a')];
    const r2 = toolOf(await post(up.url, { model: 'm', stream: true, tools, messages }));
    assert.equal(r2.name, 'Edit');
    assert.equal(r2.input.old_string, '  return total - total * (percent / 100);');
    messages = [...messages, used('b', 'Edit'), result('b')];
    const s3 = await post(up.url, { model: 'm', stream: true, tools, messages });
    assert.deepEqual(toolOf(s3), { name: 'Bash', input: { command: 'npm test', description: T.recTestDesc } });
    assert.equal(stopOf(s3), 'tool_use');
    messages = [...messages, used('c', 'Bash'), result('c')];
    const s4 = await post(up.url, { model: 'm', stream: true, tools, messages });
    assert.equal(toolOf(s4), null);
    assert.equal(stopOf(s4), 'end_turn');
    // a side request (a title: no tools) with the same words is not the turn
    assert.equal(toolOf(await post(up.url, { model: 'm', stream: true, messages: [ask] })), null);
  } finally { up.server.close(); }
});

test('the intro answers in words', async () => {
  const up = await demo.startUpstream('zh', { shop, pace: 0 });
  try {
    const s = await post(up.url, { model: 'm', stream: true, tools: [{ name: 'Read' }], messages: [{ role: 'user', content: demo.TEXT.zh.recIntro }] });
    assert.equal(textOf(s), demo.TEXT.zh.recIntroSay);
    assert.equal(stopOf(s), 'end_turn');
  } finally { up.server.close(); }
});

test('the described theme: draft (the metro fixture) → save → apply', async () => {
  const up = await demo.startUpstream('en', { shop, pace: 0 });
  try {
    const ask = { role: 'user', content: demo.TEXT.en.themeAsk };
    const direct = [{ name: 'mcp__web__theme_draft' }, { name: 'mcp__web__theme_save' }, { name: 'mcp__web__theme_apply' }];
    const d1 = toolOf(await post(up.url, { model: 'm', stream: true, tools: direct, messages: [ask] }));
    assert.equal(d1.name, 'mcp__web__theme_draft');
    assert.equal(d1.input.json.id, 'metro');
    assert.equal(typeof d1.input.backdrop, 'string');
    assert.equal(typeof d1.input.css, 'string');
    const d2 = toolOf(await post(up.url, { model: 'm', stream: true, tools: direct, messages: [ask, used('a', 'x'), result('a')] }));
    assert.deepEqual(d2, { name: 'mcp__web__theme_save', input: { id: 'metro' } });
    const d3 = toolOf(await post(up.url, { model: 'm', stream: true, tools: direct, messages: [ask, used('a', 'x'), result('a'), used('b', 'x'), result('b')] }));
    assert.deepEqual(d3, { name: 'mcp__web__theme_apply', input: { id: 'metro' } });
  } finally { up.server.close(); }
});

test('the old demo is unchanged: the .gitignore conversation still asks to Write', async () => {
  const up = await demo.startUpstream('en');
  try {
    const s = await post(up.url, { model: 'm', stream: true, messages: [{ role: 'user', content: demo.TEXT.en.gitignore }] });
    assert.equal(toolOf(s).name, 'Write');
  } finally { up.server.close(); }
});
