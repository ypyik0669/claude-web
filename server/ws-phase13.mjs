// Phase 13 end-to-end: the unified session library over the hub, with mock agents (no model calls).
// Codex is pointed at src/agents/__mocks__/codex-server.mjs and a custom ACP agent at acp-agent.mjs
// (MOCK_ACP_LIST=1 → session/list), then: opt-in joining, folded sub-threads, paged reads, search,
// rename, delete-with-backup, resume of an imported thread, and source status.
//   node server/ws-phase13.mjs [port] [token]   (meant for scripts/e2e.mjs: temp HOME + CLAUDE_WEB_DIR)
import WebSocket from 'ws';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const port = args[0] ?? '3090';
const token = args[1];
const here = path.dirname(fileURLToPath(import.meta.url));
const mocks = path.join(here, 'src', 'agents', '__mocks__');
const webDir = process.env.CLAUDE_WEB_DIR || path.join(os.homedir(), '.claude-web');
const rpcLog = path.join(os.tmpdir(), `cw-phase13-codex-${process.pid}.jsonl`);
const ACP = 'acp:e2e-lib';

// the library also detects Codex by its data dir; under the e2e temp HOME there is none yet
if (process.env.CLAUDE_WEB_DIR) fs.mkdirSync(path.join(os.homedir(), '.codex', 'sessions'), { recursive: true });

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
const waitEvent = (fn, ms = 60000) => new Promise((res, rej) => { const hit = events.find((e) => safe(fn, e)); if (hit) return res(hit); const w = { fn, res }; waiters.push(w); setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); rej(new Error('timeout waiting for event')); }, ms); });
const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const ids = (list) => list.map((s) => s.sessionId);

ws.on('open', async () => {
  let sid;
  try {
    await req({ kind: 'agents.set', agent: 'codex', patch: { command: process.execPath, args: [path.join(mocks, 'codex-server.mjs')], env: { CW_MOCK_RPC_LOG: rpcLog } } });
    await req({ kind: 'agents.set', agent: ACP, patch: { name: 'E2E Library', command: process.execPath, args: [path.join(mocks, 'acp-agent.mjs')], env: { MOCK_ACP_LIST: '1' }, protocol: 'acp' } });
    // a refresh re-probes installs and re-announces what's detected but not joined
    await req({ kind: 'agents.list', refresh: true });
    const disc = await waitEvent((e) => e.kind === 'library.discovered' && e.kinds.includes('codex'), 30000).catch(() => null);
    check('library.discovered offers codex', !!disc, disc ? disc.kinds.join(',') : 'no event');

    const before = await req({ kind: 'sessions.list' });
    check('before joining: no codex-/acp_ items', !before.some((s) => /^(codex-|acp_)/.test(s.sessionId)), `${before.length} items`);
    const src0 = await req({ kind: 'library.sources' });
    const cx0 = src0.find((s) => s.kind === 'codex');
    check('library.sources: codex detected, not joined', !!cx0 && cx0.detected && !cx0.joined && !cx0.enabled);

    await req({ kind: 'library.join', kind_: 'codex', joined: true });
    await req({ kind: 'library.join', kind_: ACP, joined: true });
    const list = await req({ kind: 'sessions.list' });
    const codex = list.filter((s) => s.sessionId.startsWith('codex-'));
    const acp = list.filter((s) => s.sessionId.startsWith('acp_e2e~lib-'));
    check('after joining: codex- items listed', ['codex-thr-a', 'codex-thr-b', 'codex-thr-d'].every((id) => ids(codex).includes(id)), ids(codex).join(' '));
    check('after joining: acp_ items listed', ids(acp).includes('acp_e2e~lib-s1') && ids(acp).includes('acp_e2e~lib-s2'), ids(acp).join(' '));
    const a = codex.find((s) => s.sessionId === 'codex-thr-a');
    check('sub-agent thread folded under its parent', !ids(list).includes('codex-thr-c') && a?.childCount === 1, `childCount=${a?.childCount}`);
    check('codex items carry agent + caps', a?.agent === 'codex' && a?.caps?.rename === true && a?.caps?.delete === true);

    const p1 = await req({ kind: 'library.read', sessionId: 'codex-thr-b', limit: 20 });
    const p2 = p1.next ? await req({ kind: 'library.read', sessionId: 'codex-thr-b', limit: 20, cursor: p1.next }) : null;
    check('library.read pages (next cursor)', !!p1.next && p1.messages.length > 0 && !!p2 && p2.messages.length > 0, `page1=${p1.messages.length} page2=${p2?.messages.length}`);

    await req({ kind: 'library.reindex' });
    const hits = await req({ kind: 'sessions.search', query: 'reply' });
    check('sessions.search finds text inside a mock thread', hits.some((h) => h.session.sessionId.startsWith('codex-')), hits.slice(0, 4).map((h) => h.session.sessionId).join(' '));

    await req({ kind: 'library.rename', sessionId: 'codex-thr-a', title: 'renamed-by-e2e' });
    const afterRename = (await req({ kind: 'sessions.list' })).find((s) => s.sessionId === 'codex-thr-a');
    check('library.rename goes through thread/name/set', afterRename?.title === 'renamed-by-e2e', afterRename?.title);

    const del = await req({ kind: 'library.delete', sessionIds: ['codex-thr-d'] });
    const backup = path.join(webDir, 'library-trash', 'codex-thr-d.json');
    const saved = fs.existsSync(backup) ? JSON.parse(fs.readFileSync(backup, 'utf8')) : null;
    check('library.delete writes a trash backup first', del.removed?.includes('codex-thr-d') && saved?.nativeId === 'thr-d' && Array.isArray(saved?.native) && saved.native.length > 0, backup);
    check('deleted thread gone from the list', !ids(await req({ kind: 'sessions.list' })).includes('codex-thr-d'));

    // resume an imported thread: the Codex driver must continue the native thread, not start a new one
    const o = await req({ kind: 'session.open', params: { sessionId: 'codex-thr-a', cwd: here } });
    sid = o.sessionId;
    check('session.open on a codex- id', sid === 'codex-thr-a' && o.info?.agent === 'codex', o.info?.agentName);
    await waitEvent((e) => e.kind === 'session.state' && e.sessionId === sid && (e.state === 'idle' || e.state === 'error'), 60000);
    await req({ kind: 'session.send', params: { sessionId: sid, text: 'hello from phase 13' } });
    const result = await waitEvent((e) => e.kind === 'session.event' && e.sessionId === sid && e.message.type === 'result', 60000).catch(() => null);
    check('turn on the resumed thread completes', !!result && !result.message.is_error);
    const rpc = fs.existsSync(rpcLog) ? fs.readFileSync(rpcLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    const resume = rpc.find((r) => r.method === 'thread/resume');
    check('thread/resume carries the native thread id', resume?.params?.threadId === 'thr-a' && !rpc.some((r) => r.method === 'thread/start'), JSON.stringify(resume?.params ?? null).slice(0, 80));

    const srcs = await req({ kind: 'library.sources' });
    const sc = srcs.find((s) => s.kind === 'codex');
    const sa = srcs.find((s) => s.kind === ACP);
    check('library.sources: codex + acp joined and enabled', sc?.joined && sc?.enabled && sa?.joined && sa?.enabled, `codex count=${sc?.count} acp count=${sa?.count} ${sa?.disabledReason ?? ''}`);
    const cl = srcs.find((s) => s.kind === 'claude');
    check('library.sources: claude indexedAt set after a pass', typeof cl?.indexedAt === 'number' && typeof cl?.count === 'number', `count=${cl?.count}`);

    // leaving removes the source's sessions again (agent data untouched)
    await req({ kind: 'session.close', sessionId: sid }).catch(() => {});
    await req({ kind: 'library.join', kind_: 'codex', joined: false });
    await req({ kind: 'library.join', kind_: ACP, joined: false });
    const left = await req({ kind: 'sessions.list' });
    check('leaving hides codex-/acp_ items', !left.some((s) => /^(codex-|acp_)/.test(s.sessionId)), `${left.length} items`);
  } catch (e) {
    check('script error', false, e.stack ?? String(e));
  }
  await req({ kind: 'agents.set', agent: ACP, patch: null }).catch(() => {});
  await req({ kind: 'agents.set', agent: 'codex', patch: null }).catch(() => {});
  try { fs.rmSync(rpcLog, { force: true }); } catch { /* ignore */ }
  const pass = results.filter((r) => r[1]).length;
  console.log(`\n${pass}/${results.length} checks passed`);
  ws.close();
  process.exit(pass === results.length ? 0 : 1);
});
