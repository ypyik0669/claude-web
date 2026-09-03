// Dev helper: park a mock-ACP session mid-turn (a tool left running) so the composer's run card and
// the in-flight timeline can be screenshotted. Prints the session id and holds the turn open.
//   node server/ws-demo-running.mjs [port] [token]
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
  const mock = path.join(here, 'src', 'agents', '__mocks__', 'acp-agent.mjs');
  await req({ kind: 'agents.set', agent: 'acp:slow', patch: { name: 'Slow Demo', command: process.execPath, args: [mock], env: { MOCK_SLOW_MS: process.env.MOCK_SLOW_MS ?? '60000' }, protocol: 'acp', label: 'slow' } });
  const o = await req({ kind: 'session.open', params: { cwd: path.dirname(here), agent: 'acp:slow', permissionMode: 'bypassPermissions' } });
  const sid = o.sessionId;
  await waitEvent((e) => e.kind === 'session.state' && e.sessionId === sid && (e.state === 'idle' || e.state === 'error'), 60000);
  await req({ kind: 'session.send', params: { sessionId: sid, text: '跑一下测试（slow）' } });
  console.log(sid);
  // hold the socket open; the turn ends on its own after MOCK_SLOW_MS
  setTimeout(() => { ws.close(); process.exit(0); }, Number(process.env.HOLD_MS ?? 70000));
});
