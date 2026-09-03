// Phase 5 end-to-end: multi-agent sessions over the hub (custom ACP agent = the mock in src/agents/__mocks__).
//   node server/ws-phase5.mjs [port] [token] [--real]   (--real also drives gemini --acp and codex app-server if installed)
import WebSocket from 'ws';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const real = process.argv.includes('--real');
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
  if (process.env.CW_DEBUG) console.error('<<', String(raw).slice(0, 300));
  if (m.type === 'reply') { const p = pending.get(m.reply.id); pending.delete(m.reply.id); m.reply.ok ? p.res(m.reply.data) : p.rej(new Error(m.reply.error)); return; }
  if (m.type === 'event') { events.push(m.event); for (const w of [...waiters]) if (safe(w.fn, m.event)) { waiters.splice(waiters.indexOf(w), 1); w.res(m.event); } }
});
const safe = (fn, e) => { try { return fn(e); } catch { return false; } };
const req = (r) => new Promise((res, rej) => { const id = String(++seq); pending.set(id, { res, rej }); ws.send(JSON.stringify({ type: 'request', request: { id, req: r } })); });
const waitEvent = (fn, ms = 60000) => new Promise((res, rej) => { const hit = events.find((e) => safe(fn, e)); if (hit) return res(hit); const w = { fn, res }; waiters.push(w); setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error('timeout waiting for event')); }, ms); });
const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const sessionEvents = (sid) => events.filter((e) => e.kind === 'session.event' && e.sessionId === sid).map((e) => e.message);

async function driveSession(label, agent, prompt, { expectPermission = true, permissionMode = 'default' } = {}) {
  const o = await req({ kind: 'session.open', params: { cwd: here, agent, permissionMode } });
  const info = o.info ?? {};
  check(`${label}: session.open`, info.agent === agent && !!o.sessionId, `${info.agentName} ${info.model ?? ''}`);
  const sid = o.sessionId;
  await waitEvent((e) => e.kind === 'session.state' && e.sessionId === sid && (e.state === 'idle' || e.state === 'error'), 90000);
  const st = events.filter((e) => e.kind === 'session.state' && e.sessionId === sid).pop();
  if (st.state === 'error' && /登录|login|api key/i.test(st.error ?? '')) { console.log(`SKIP ${label}: not logged in on this machine — ${(st.error ?? '').split(String.fromCharCode(10))[0]}`); return sid; }
  check(`${label}: reaches idle`, st.state === 'idle', st.error ?? '');
  if (st.state !== 'idle') return sid;
  await req({ kind: 'session.send', params: { sessionId: sid, text: prompt } });
  if (expectPermission) {
    const perm = (await waitEvent((e) => e.kind === 'permission.request' && e.request.sessionId === sid, 90000).catch(() => null))?.request;
    check(`${label}: permission request surfaces`, !!perm, perm ? `${perm.toolName} ${JSON.stringify(perm.input).slice(0, 80)}` : 'none');
    if (perm) await req({ kind: 'permission.respond', requestId: perm.requestId, response: { behavior: 'allow' } });
  }
  const result = await waitEvent((e) => e.kind === 'session.event' && e.sessionId === sid && e.message.type === 'result', 180000).catch(() => null);
  check(`${label}: result arrives`, !!result && !result.message.is_error, result ? `${result.message.duration_ms}ms tokens=${result.message.usage?.input_tokens}/${result.message.usage?.output_tokens}` : 'timeout');
  const msgs = sessionEvents(sid);
  const text = msgs.filter((m) => m.type === 'stream_event' && m.event.type === 'content_block_delta' && m.event.delta.type === 'text_delta').map((m) => m.event.delta.text).join('');
  check(`${label}: streamed text`, text.length > 0, JSON.stringify(text.slice(0, 100)));
  return sid;
}

ws.on('open', async () => {
  try {
    const list = await req({ kind: 'agents.list' });
    check('agents.list has builtins', ['claude', 'codex', 'gemini', 'qwen', 'kimi'].every((k) => list.some((a) => a.kind === k)), list.map((a) => `${a.kind}${a.installed ? '✓' : '✗'}`).join(' '));
    // custom ACP agent → the mock
    const mock = path.join(here, 'src', 'agents', '__mocks__', 'acp-agent.mjs');
    await req({ kind: 'agents.set', agent: 'acp:e2e-mock', patch: { name: 'E2E Mock', command: process.execPath, args: [mock], protocol: 'acp', label: 'mock' } });
    const list2 = await req({ kind: 'agents.list' });
    const mockInfo = list2.find((a) => a.kind === 'acp:e2e-mock');
    check('agents.set adds a custom ACP agent', !!mockInfo && mockInfo.installed && mockInfo.label === 'mock', mockInfo?.version);
    const sid = await driveSession('mock acp', 'acp:e2e-mock', 'please use a tool and make a plan');
    const msgs = sessionEvents(sid);
    check('mock acp: init + TodoWrite + tool cards', msgs.some((m) => m.type === 'system' && m.subtype === 'init') && msgs.some((m) => m.type === 'assistant' && m.message.content[0]?.name === 'TodoWrite') && msgs.some((m) => m.type === 'assistant' && m.message.content[0]?.name === 'Read'));
    const sessions = await req({ kind: 'sessions.list' });
    const mine = sessions.find((s) => s.sessionId === sid);
    check('sessions.list merges agent transcripts', !!mine && mine.agent === 'acp:e2e-mock' && (mine.firstPrompt ?? '').includes('please use a tool'), mine?.title);
    const tr = await req({ kind: 'transcript.load', sessionId: sid });
    check('transcript.load (agent) has user + result', tr.some((m) => m.type === 'user') && tr.some((m) => m.type === 'result'), `${tr.length} msgs`);
    await req({ kind: 'session.rename', sessionId: sid, title: 'renamed-e2e' });
    const s3 = (await req({ kind: 'sessions.list' })).find((s) => s.sessionId === sid);
    check('session.rename (agent)', s3?.title === 'renamed-e2e');
    const info = await req({ kind: 'session.info', sessionId: sid });
    check('session.info carries agent', info.info?.agent === 'acp:e2e-mock' && info.info?.agentName === 'E2E Mock' && info.history.length > 3, `history=${info.history?.length}`);
    // close and resume (mock agent cannot load; we expect a fresh native session but same web session id + history replay)
    await req({ kind: 'session.close', sessionId: sid });
    const re = await req({ kind: 'session.open', params: { sessionId: sid, cwd: here } });
    check('session.open resume infers agent from transcript head', re.info?.agent === 'acp:e2e-mock' && re.sessionId === sid && (await req({ kind: 'transcript.load', sessionId: sid })).length >= 8);
    await waitEvent((e) => e.kind === 'session.state' && e.sessionId === sid && e.state === 'idle', 30000);
    await req({ kind: 'session.close', sessionId: sid });
    await req({ kind: 'session.delete', sessionId: sid });
    const s4 = (await req({ kind: 'sessions.list' })).find((s) => s.sessionId === sid);
    check('session.delete (agent)', !s4);
    await req({ kind: 'agents.set', agent: 'acp:e2e-mock', patch: null });
    check('agents.set null removes the custom agent', !(await req({ kind: 'agents.list' })).some((a) => a.kind === 'acp:e2e-mock'));

    if (real) {
      const gem = list.find((a) => a.kind === 'gemini');
      if (gem?.installed) {
        const gs = await driveSession('gemini --acp', 'gemini', 'Read the file package.json in this directory and tell me its "name" field in one short sentence.', { expectPermission: false });
        await req({ kind: 'session.close', sessionId: gs }).catch(() => {});
      } else console.log('skip gemini (not installed)');
      const cx = list.find((a) => a.kind === 'codex');
      if (cx?.installed) {
        const cs = await driveSession('codex app-server', 'codex', 'Run this exact shell command and report its output in one short sentence: node -e "console.log(String.fromCharCode(99,119,45,111,107))"', { expectPermission: true, permissionMode: 'default' });
        await req({ kind: 'session.close', sessionId: cs }).catch(() => {});
      } else console.log('skip codex (not installed)');
    }
  } catch (e) {
    check('script error', false, e.stack ?? String(e));
  }
  const pass = results.filter((r) => r[1]).length;
  console.log(`\n${pass}/${results.length} checks passed`);
  ws.close();
  process.exit(pass === results.length ? 0 : 1);
});
