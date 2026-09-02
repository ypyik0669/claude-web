// Phase-1 headless checks: uuid anchor in transcript, attachment upload + Read, feedback/drafts round trip, contextUsage.
//   node server/ws-phase1.mjs [port] [token]
import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';
const port = process.argv[2] ?? '3090';
const token = process.argv[3];
const q = token ? `?token=${token}` : '';
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${q}`);
let n = 0;
const pending = new Map();
const req = (r) => new Promise((res, rej) => { const id = String(++n); pending.set(id, { res, rej }); ws.send(JSON.stringify({ type: 'request', request: { id, req: r } })); });
const events = [];
let sid = null;
ws.on('message', async (raw) => {
  const d = JSON.parse(String(raw));
  if (d.type === 'reply') { const p = pending.get(d.reply.id); pending.delete(d.reply.id); d.reply.ok ? p.res(d.reply.data) : p.rej(new Error(d.reply.error)); return; }
  const e = d.event;
  if (e.kind === 'session.event' && e.sessionId === sid) events.push(e.message);
  if (e.kind === 'permission.request') await req({ kind: 'permission.respond', requestId: e.request.requestId, response: { behavior: 'allow' } });
});
const waitResult = async (ms = 120_000) => { const t0 = Date.now(); const start = events.length; while (Date.now() - t0 < ms) { const r = events.slice(start).find((m) => m.type === 'result'); if (r) return r; await new Promise((x) => setTimeout(x, 400)); } throw new Error('no result'); };
const ok = (name, cond, extra = '') => console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);

ws.on('open', async () => {
  const cwd = path.resolve('.');
  const o = await req({ kind: 'session.open', params: { cwd, model: 'haiku', permissionMode: 'bypassPermissions', providerId: 'claude' } });
  sid = o.sessionId;
  console.log('session', sid);
  await new Promise((r) => setTimeout(r, 2500));

  // 1. attachment upload over HTTP, then a message referencing it
  const body = 'alpha\nbravo\ncharlie\n';
  const up = await fetch(`http://127.0.0.1:${port}/api/attachments?sessionId=${sid}&rel=notes/list.txt${token ? `&token=${token}` : ''}`, { method: 'POST', body });
  const upj = await up.json();
  ok('attachment upload', up.status === 200 && fs.existsSync(upj.path), upj.path);
  const bad = await fetch(`http://127.0.0.1:${port}/api/attachments?sessionId=${sid}&rel=../../evil.txt${token ? `&token=${token}` : ''}`, { method: 'POST', body: 'x' });
  ok('attachment traversal rejected', bad.status === 400);

  // 2. send with client uuid + attachment ref; expect a Read of the attached path and the uuid in the transcript
  const uuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  await req({ kind: 'session.send', params: { sessionId: sid, text: 'Read the attached file and reply with its second line only.', uuid, attachments: [{ kind: 'file', name: 'list.txt', path: upj.path, size: body.length }] } });
  const r1 = await waitResult();
  const readTool = events.some((m) => m.type === 'assistant' && (m.message.content ?? []).some((b) => b.type === 'tool_use' && b.name === 'Read' && String(b.input.file_path ?? '').includes('list.txt')));
  ok('model Read the attachment', readTool);
  ok('reply mentions bravo', /bravo/i.test(r1.result ?? ''), (r1.result ?? '').slice(0, 60));
  const tr = await req({ kind: 'transcript.load', sessionId: sid });
  const userRec = tr.find((m) => m.type === 'user' && m.uuid === uuid);
  ok('client uuid is the transcript uuid', !!userRec);
  const userText = !!userRec && (typeof userRec.message.content === 'string' ? userRec.message.content : (userRec.message.content ?? []).map((b) => b.text ?? '').join(''));
  ok('attachment marker in transcript text', !!userText && userText.includes('<attached kind="file"'));

  // 3. context usage
  const cu = await req({ kind: 'session.contextUsage', sessionId: sid, detail: 'summary' }).catch((e) => ({ error: e.message }));
  ok('contextUsage summary', cu && typeof cu.percentage === 'number', JSON.stringify(cu).slice(0, 120));

  // 4. feedback + drafts round trip
  const firstAssistant = events.find((m) => m.type === 'assistant');
  await req({ kind: 'feedback.set', sessionId: sid, messageId: firstAssistant.message.id, rating: 'up' });
  const fb = await req({ kind: 'feedback.list', sessionId: sid });
  ok('feedback round trip', fb[firstAssistant.message.id]?.rating === 'up');
  await req({ kind: 'feedback.set', sessionId: sid, messageId: firstAssistant.message.id, rating: null });
  ok('feedback cleared', Object.keys(await req({ kind: 'feedback.list', sessionId: sid })).length === 0);
  await req({ kind: 'drafts.set', key: sid, text: 'draft text' });
  ok('draft round trip', (await req({ kind: 'drafts.get', key: sid })) === 'draft text');
  await req({ kind: 'drafts.set', key: sid, text: '' });

  // 5. fork at the uuid (edit-and-resend path)
  const f = await req({ kind: 'session.open', params: { cwd, sessionId: sid, resumeAt: uuid } });
  ok('fork at client uuid gives a new session', f.sessionId && f.sessionId !== sid, f.sessionId);
  await req({ kind: 'session.close', sessionId: f.sessionId }).catch(() => {});

  // 6. export save
  const p = await req({ kind: 'export.save', name: 'phase1 test', html: '<html><body>x</body></html>' });
  ok('export.save', fs.existsSync(p), p);
  fs.rmSync(p, { force: true });

  await req({ kind: 'session.close', sessionId: sid });
  ws.close();
  process.exit(0);
});
