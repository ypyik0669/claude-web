import WebSocket from 'ws';
const ws = new WebSocket('ws://127.0.0.1:3090/ws');
let n = 0;
const pending = new Map();
const req = (r) => new Promise((res, rej) => { const id = String(++n); pending.set(id, { res, rej }); ws.send(JSON.stringify({ type: 'request', request: { id, req: r } })); });
ws.on('message', async (raw) => {
  const d = JSON.parse(String(raw));
  if (d.type === 'reply') { const p = pending.get(d.reply.id); pending.delete(d.reply.id); d.reply.ok ? p.res(d.reply.data) : p.rej(new Error(d.reply.error)); return; }
  const e = d.event;
  if (e.kind === 'session.event') {
    const m = e.message;
    if (m.type === 'stream_event') return;
    if (m.type === 'assistant') console.log('assistant:', JSON.stringify(m.message.content).slice(0, 200));
    else if (m.type === 'result') console.log('result:', m.subtype, m.total_cost_usd, m.num_turns);
    else console.log('event:', m.type, m.subtype ?? '');
  } else if (e.kind === 'permission.request') {
    console.log('PERMISSION', e.request.toolName, JSON.stringify(e.request.input).slice(0, 120));
    await req({ kind: 'permission.respond', requestId: e.request.requestId, response: { behavior: 'allow' } });
  } else console.log('EV', e.kind, e.kind === 'session.state' ? e.state : e.kind === 'session.info' ? `model=${e.info.model} cmds=${e.info.slashCommands?.length} models=${e.info.models?.length}` : '');
});
ws.on('open', async () => {
  const list = await req({ kind: 'sessions.list', limit: 3 });
  console.log('sessions:', list.map((s) => s.title));
  const o = await req({ kind: 'session.open', params: { cwd: 'C:\\Users\\YPY\\claude-web', model: 'haiku', permissionMode: 'default' } });
  console.log('opened', o.sessionId);
  await new Promise((r) => setTimeout(r, 4000));
  await req({ kind: 'session.send', params: { sessionId: o.sessionId, text: 'Run `git status --short | head -3` with the Bash tool, then reply with one line.' } });
  setTimeout(async () => { await req({ kind: 'session.close', sessionId: o.sessionId }); ws.close(); process.exit(0); }, 60000);
});
