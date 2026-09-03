// Drive one agent session and dump every non-stream event — for debugging real agents.
//   node server/ws-agent-probe.mjs <agent> "<prompt>" [port] [permissionMode]
import WebSocket from 'ws';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [agent, prompt, port = '3090', permissionMode = 'default'] = process.argv.slice(2);
const here = path.dirname(fileURLToPath(import.meta.url));
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
let seq = 0;
const pending = new Map();
let sid = null;
const req = (r) => new Promise((res, rej) => { const id = String(++seq); pending.set(id, { res, rej }); ws.send(JSON.stringify({ type: 'request', request: { id, req: r } })); });
const short = (o) => JSON.stringify(o).slice(0, 400);
ws.on('message', async (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type === 'reply') { const p = pending.get(m.reply.id); pending.delete(m.reply.id); m.reply.ok ? p.res(m.reply.data) : p.rej(new Error(m.reply.error)); return; }
  const e = m.event;
  if (e.kind === 'session.event' && e.sessionId === sid) {
    const msg = e.message;
    if (msg.type === 'stream_event') { if (msg.event.type === 'content_block_delta') process.stdout.write(msg.event.delta.text ?? msg.event.delta.thinking ?? ''); return; }
    console.log('\n[msg]', short(msg));
    if (msg.type === 'result') { await req({ kind: 'session.close', sessionId: sid }).catch(() => {}); setTimeout(() => process.exit(0), 500); }
  } else if (e.kind === 'permission.request' && e.request.sessionId === sid) {
    console.log('\n[perm]', short(e.request));
    await req({ kind: 'permission.respond', requestId: e.request.requestId, response: { behavior: 'allow' } });
  } else if (e.kind === 'session.state' && e.sessionId === sid) {
    console.log('\n[state]', e.state, e.error ?? '');
    if (e.state === 'idle' && !ws.sent) { ws.sent = true; await req({ kind: 'session.send', params: { sessionId: sid, text: prompt } }); }
    if (e.state === 'error') { setTimeout(() => process.exit(1), 500); }
  } else if (e.kind === 'session.info' && e.info.sessionId === sid) {
    console.log('\n[info]', e.info.state, e.info.model, e.info.error ?? '', (e.info.models ?? []).length, 'models');
  }
});
ws.on('open', async () => {
  const o = await req({ kind: 'session.open', params: { cwd: here, agent, permissionMode } });
  sid = o.sessionId;
  console.log('[open]', sid, o.info.agentName);
});
setTimeout(() => { console.log('\n[timeout]'); process.exit(2); }, 180000);
