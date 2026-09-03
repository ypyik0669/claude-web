// Dev helper: create one mock-ACP session with tool calls + a plan, so the conversation UI can be
// screenshotted without spending real model tokens. Leaves the session (and the agent) in place.
//   node server/ws-demo-session.mjs [port] [token]
import WebSocket from 'ws';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const port = args[0] ?? '3090';
const token = args[1];
const here = path.dirname(fileURLToPath(import.meta.url));
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${token ? `?token=${token}` : ''}`);
let seq = 0;
const pending = new Map();
const events = [];
const waiters = [];
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type === 'reply') { const p = pending.get(m.reply.id); pending.delete(m.reply.id); m.reply.ok ? p.res(m.reply.data) : p.rej(new Error(m.reply.error)); return; }
  if (m.type === 'event') { events.push(m.event); for (const w of [...waiters]) { let hit = false; try { hit = w.fn(m.event); } catch { /* ignore */ } if (hit) { waiters.splice(waiters.indexOf(w), 1); w.res(m.event); } } }
});
const req = (r) => new Promise((res, rej) => { const id = String(++seq); pending.set(id, { res, rej }); ws.send(JSON.stringify({ type: 'request', request: { id, req: r } })); });
const waitEvent = (fn, ms = 60000) => new Promise((res, rej) => { const hit = events.find((e) => { try { return fn(e); } catch { return false; } }); if (hit) return res(hit); const w = { fn, res }; waiters.push(w); setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error('timeout')); }, ms); });

ws.on('open', async () => {
  try {
    const mock = path.join(here, 'src', 'agents', '__mocks__', 'acp-agent.mjs');
    await req({ kind: 'agents.set', agent: 'acp:demo', patch: { name: 'Demo Agent', command: process.execPath, args: [mock], protocol: 'acp', label: 'demo' } });
    const o = await req({ kind: 'session.open', params: { cwd: path.dirname(here), agent: 'acp:demo', permissionMode: 'default' } });
    const sid = o.sessionId;
    await waitEvent((e) => e.kind === 'session.state' && e.sessionId === sid && (e.state === 'idle' || e.state === 'error'), 60000);
    await req({ kind: 'session.send', params: { sessionId: sid, text: 'please use a tool and make a plan' } });
    const perm = (await waitEvent((e) => e.kind === 'permission.request' && e.request.sessionId === sid, 60000).catch(() => null))?.request;
    if (perm) await req({ kind: 'permission.respond', requestId: perm.requestId, response: { behavior: 'allow' } });
    await waitEvent((e) => e.kind === 'session.event' && e.sessionId === sid && e.message.type === 'result', 90000).catch(() => null);
    console.log(sid);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
  ws.close();
});
