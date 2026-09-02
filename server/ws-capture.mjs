// Capture a real SDK message stream into a JSONL fixture for reducer tests:
//   node server/ws-capture.mjs [port] [out=web/src/model/__fixtures__/tools.jsonl] [token]
// Runs one turn in this repo with bypassPermissions that exercises Read/Glob/Grep/Bash/WebFetch(+image Read).
import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';
const port = process.argv[2] ?? '3090';
const out = process.argv[3] ?? path.resolve('web/src/model/__fixtures__/tools.jsonl');
const token = process.argv[4];
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${token ? `?token=${token}` : ''}`);
let n = 0;
const pending = new Map();
const req = (r) => new Promise((res, rej) => { const id = String(++n); pending.set(id, { res, rej }); ws.send(JSON.stringify({ type: 'request', request: { id, req: r } })); });
const lines = [];
let sid = null;
let done = false;
ws.on('message', async (raw) => {
  const d = JSON.parse(String(raw));
  if (d.type === 'reply') { const p = pending.get(d.reply.id); pending.delete(d.reply.id); d.reply.ok ? p.res(d.reply.data) : p.rej(new Error(d.reply.error)); return; }
  const e = d.event;
  if (e.kind === 'session.event' && e.sessionId === sid) {
    lines.push(JSON.stringify(e.message));
    if (e.message.type === 'result') { done = true; }
  }
  if (e.kind === 'permission.request') await req({ kind: 'permission.respond', requestId: e.request.requestId, response: { behavior: 'allow' } });
});
ws.on('open', async () => {
  const cwd = path.resolve('.');
  const o = await req({ kind: 'session.open', params: { cwd, model: 'haiku', permissionMode: 'bypassPermissions', providerId: 'claude' } });
  sid = o.sessionId;
  console.log('session', sid);
  await new Promise((r) => setTimeout(r, 3000));
  const prompt = [
    'Do exactly these steps with tools, one after another, then reply with the single word DONE:',
    '1. Read package.json (the whole file).',
    '2. Glob web/src/**/*.tsx',
    '3. Grep for "applyMessage" in web/src with output_mode content.',
    '4. Run the shell command: git log -1 --oneline',
    '5. Read desktop/build/icon.png',
    '6. WebFetch https://example.com with prompt "what is the title?"',
    '7. Use TodoWrite to create two todos and mark the first completed.',
  ].join('\n');
  await req({ kind: 'session.send', params: { sessionId: sid, text: prompt, uuid: '11111111-2222-4333-8444-555555555555' } });
  const t0 = Date.now();
  while (!done && Date.now() - t0 < 240_000) await new Promise((r) => setTimeout(r, 500));
  await new Promise((r) => setTimeout(r, 1500));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, lines.join('\n') + '\n');
  const types = {};
  for (const l of lines) { const m = JSON.parse(l); const k = m.type + (m.subtype ? '/' + m.subtype : ''); types[k] = (types[k] ?? 0) + 1; }
  console.log('wrote', lines.length, 'messages to', out, JSON.stringify(types));
  await req({ kind: 'session.close', sessionId: sid });
  ws.close();
  process.exit(0);
});
