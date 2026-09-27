import WebSocket from 'ws';
const [cwd] = process.argv.slice(2);
const ws = new WebSocket('ws://127.0.0.1:3095/ws'); let n = 0; const P = new Map(); const events = [];
const req = (r) => new Promise((res, rej) => { const id = String(++n); P.set(id, { res, rej }); ws.send(JSON.stringify({ type: 'request', request: { id, req: r } })); });
ws.on('message', (raw) => { const d = JSON.parse(String(raw)); if (d.type === 'reply') { const p = P.get(d.reply.id); P.delete(d.reply.id); d.reply.ok ? p.res(d.reply.data) : p.rej(new Error(d.reply.error)); } else if (d.type === 'event') events.push(d.event); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function turn(sid, text) {
  const before = events.length;
  await req({ kind: 'session.send', params: { sessionId: sid, text } });
  for (let t = 0; t < 600; t++) { const r = events.slice(before).find((e) => e?.sessionId === sid && e.message?.type === 'result'); if (r) return r.message; await sleep(500); }
  throw new Error('turn timeout');
}
ws.on('open', async () => {
  try {
    await req({ kind: 'workspaces.add', path: cwd });
    const o = await req({ kind: 'session.open', params: { cwd, permissionMode: 'bypassPermissions', model: 'sonnet' } });
    const r1 = await turn(o.sessionId, '看一下这个项目。completeTodo 在 id 不存在时会崩，修掉它（找不到时抛出清晰的错误），给它补两个测试，然后跑 npm test 确认通过。最后用两三句话总结改了什么。');
    console.log('turn1', r1.subtype, r1.num_turns, r1.total_cost_usd);
    const o2 = await req({ kind: 'session.open', params: { cwd, permissionMode: 'default', model: 'sonnet' } });
    const r2 = await turn(o2.sessionId, '这个仓库的 README 太简单了。先列一个计划（用 TodoWrite），不要改文件，告诉我你打算怎么写。');
    console.log('turn2', r2.subtype, r2.total_cost_usd);
    console.log('SIDS', o.sessionId, o2.sessionId);
  } catch (e) { console.log('ERR', e.message); }
  process.exit(0);
});
