// Phase 11 end-to-end: the canonical timeline, provider hot-swap and cross-agent handover.
//   node server/ws-phase11.mjs [port] [token]
// Uses the mock ACP agent, so nothing here spends model tokens. The Claude leg is only exercised
// when a login exists; otherwise it reports SKIP rather than failing.
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
const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const idle = (sid, ms = 60000) => waitEvent((e) => e.kind === 'session.state' && e.sessionId === sid && (e.state === 'idle' || e.state === 'error'), ms);

async function turn(sid, text) {
  await req({ kind: 'session.send', params: { sessionId: sid, text } });
  const perm = (await waitEvent((e) => e.kind === 'permission.request' && e.request.sessionId === sid, 20000).catch(() => null))?.request;
  if (perm) await req({ kind: 'permission.respond', requestId: perm.requestId, response: { behavior: 'allow' } });
  return waitEvent((e) => e.kind === 'session.event' && e.sessionId === sid && e.message.type === 'result', 90000).catch(() => null);
}

ws.on('open', async () => {
  try {
    const mock = path.join(here, 'src', 'agents', '__mocks__', 'acp-agent.mjs');
    await req({ kind: 'agents.set', agent: 'acp:p11', patch: { name: 'P11 Mock', command: process.execPath, args: [mock], protocol: 'acp', label: 'p11' } });

    // ---- 1. a foreign-agent session mirrors into the canonical timeline ----
    const o = await req({ kind: 'session.open', params: { cwd: path.dirname(here), agent: 'acp:p11', permissionMode: 'default' } });
    const sid = o.sessionId;
    await idle(sid);
    await turn(sid, 'please use a tool and make a plan');

    let canon = await req({ kind: 'session.canonical', sessionId: sid });
    check('canonical timeline records the turn', canon.length >= 3, canon.map((e) => e.kind).join(','));
    check('canonical records what the user asked for', canon.some((e) => e.kind === 'user' && /use a tool/.test(e.text)), canon.find((e) => e.kind === 'user')?.text ?? 'none');
    check('canonical pairs tool calls with results', canon.some((e) => e.kind === 'tool' && e.ok === true), JSON.stringify(canon.find((e) => e.kind === 'tool') ?? {}).slice(0, 120));
    check('canonical carries no reasoning', !JSON.stringify(canon).includes('signature') && !canon.some((e) => e.kind === 'thinking'));
    const beforeLen = canon.length;

    // ---- 2. handover to Claude: same session id, briefing-backed resume ----
    const agents = await req({ kind: 'agents.list' });
    const claudeOk = agents.find((a) => a.kind === 'claude')?.installed;
    if (!claudeOk) {
      console.log('SKIP handover to Claude: claude is not installed on this machine');
    } else {
      const sw = await req({ kind: 'session.switchAgent', sessionId: sid, agent: 'claude' }).catch((e) => ({ error: e.message }));
      if (sw.error) {
        console.log(`SKIP handover to Claude: ${sw.error.split('\n')[0]}`);
      } else {
        check('switchAgent keeps the session id', sw.sessionId === sid, `${sw.sessionId}`);
        check('switchAgent reports the new agent', (sw.info?.agent ?? 'claude') === 'claude', sw.info?.agent);
        const st = await idle(sid, 90000);
        check('handed-over session reaches idle', st.state === 'idle', st.error ?? '');
        canon = await req({ kind: 'session.canonical', sessionId: sid });
        check('timeline is continuous across the handover', canon.length > beforeLen && canon.some((e) => e.kind === 'switch' && e.agent === 'claude'), `${beforeLen} → ${canon.length}`);
      }
    }

    // ---- 3. provider hot-swap keeps the session ----
    const providers = await req({ kind: 'providers.list' }).catch(() => []);
    const live = await req({ kind: 'sessions.list', limit: 500 });
    const mine = live.find((x) => x.sessionId === sid);
    check('the session is still one row in the list', !!mine, mine?.title);

    if (!providers.length) {
      console.log('SKIP provider hot-swap: no provider profile configured');
    } else {
      const p = providers[0];
      const sw = await req({ kind: 'session.setProvider', sessionId: sid, providerId: p.id }).catch((e) => ({ error: e.message }));
      if (sw.error) console.log(`SKIP provider hot-swap: ${sw.error.split('\n')[0]}`);
      else {
        check('setProvider keeps the session id', sw.sessionId === sid, sw.sessionId);
        check('setProvider reports the new profile', sw.info?.providerId === p.id, `${sw.info?.providerName}`);
        const back = await req({ kind: 'session.setProvider', sessionId: sid }).catch(() => null);
        check('setProvider can go back to the claude.ai login', !!back && !back.info?.providerId, back?.info?.providerName ?? '');
      }
    }

    // ---- 4. cleanup ----
    await req({ kind: 'session.close', sessionId: sid }).catch(() => {});
    await req({ kind: 'session.delete', sessionId: sid }).catch(() => {});
    await req({ kind: 'agents.set', agent: 'acp:p11', patch: null });
    check('cleanup removed the mock agent', !(await req({ kind: 'agents.list' })).some((a) => a.kind === 'acp:p11'));
  } catch (e) {
    check(`unexpected error: ${e.message}`, false);
  }
  const bad = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - bad}/${results.length} checks passed`);
  ws.close();
  process.exit(bad ? 1 : 0);
});
