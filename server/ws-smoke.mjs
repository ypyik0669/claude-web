// Headless end-to-end check against a running claude-web server:
//   node server/ws-smoke.mjs [port] [providerId|claude] [token]
import WebSocket from 'ws';
const port = process.argv[2] ?? '3090';
const providerId = process.argv[3] ?? 'claude';
const token = process.argv[4];
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${token ? `?token=${token}` : ''}`);
let n = 0;
const pending = new Map();
const req = (r) => new Promise((res, rej) => { const id = String(++n); pending.set(id, { res, rej }); ws.send(JSON.stringify({ type: 'request', request: { id, req: r } })); });
let info = null;
const texts = [];
ws.on('message', async (raw) => {
  const d = JSON.parse(String(raw));
  if (d.type === 'reply') { const p = pending.get(d.reply.id); pending.delete(d.reply.id); d.reply.ok ? p.res(d.reply.data) : p.rej(new Error(d.reply.error)); return; }
  const e = d.event;
  if (e.kind === 'session.info') info = e.info;
  if (e.kind === 'session.state' && e.error) console.log('STATE', e.state, e.error);
  if (e.kind === 'session.event' && e.message.type === 'assistant') for (const b of e.message.message.content ?? []) if (b.type === 'text') texts.push(b.text);
  if (e.kind === 'session.event' && e.message.type === 'result') console.log('result:', e.message.subtype, e.message.total_cost_usd, e.message.is_error ? e.message.result?.slice(0, 200) : '');
  if (e.kind === 'permission.request') { console.log('PERMISSION', e.request.toolName); await req({ kind: 'permission.respond', requestId: e.request.requestId, response: { behavior: 'allow' } }); }
});
ws.on('open', async () => {
  const eng = await req({ kind: 'engine.info' });
  console.log('engine:', eng.runtime, eng.version, eng.source, eng.fallback ? `(fallback ${eng.fallback.runtime} ${eng.fallback.version})` : '');
  const provs = await req({ kind: 'providers.list' });
  console.log('providers:', provs.map((p) => `${p.id}=${p.name}:${p.type}:${p.apiKey}`).join('  ') || '(none)');
  const o = await req({ kind: 'session.open', params: { cwd: 'C:\\Users\\YPY\\claude-web', model: 'haiku', permissionMode: 'default', providerId } });
  console.log('opened', o.sessionId, 'runtime', o.info.runtime, 'provider', o.info.providerId ?? 'claude');
  for (let i = 0; i < 60 && !(info && info.state !== 'starting'); i++) await new Promise((r) => setTimeout(r, 500));
  console.log('info:', 'ver', info?.claudeCodeVersion, 'cmds', info?.slashCommands?.length, 'models', info?.models?.length, 'skills', info?.skills?.length, 'mcp', info?.mcpServers?.length, 'model', info?.model);
  await req({ kind: 'session.send', params: { sessionId: o.sessionId, text: `Reply with exactly: pong via ${providerId}` } });
  setTimeout(async () => { console.log('text:', texts.join(' | ').slice(0, 160)); await req({ kind: 'session.close', sessionId: o.sessionId }); ws.close(); process.exit(0); }, 40000);
});
