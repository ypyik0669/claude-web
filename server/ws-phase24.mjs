// Phase 24 end-to-end: 操控电脑 — the whole desktop as the MCP server `computer`, for a Claude conversation that was
// started with it (server/src/computer). Over a real server, the real engine (started, never asked anything: no model,
// no token) and the real MCP entry (server/dist/computer/mcp.js, driven with raw JSON-RPC over stdio). The one thing
// this is about: which applications may be controlled is the user's answer to a card of this app — whatever the
// conversation's own permission mode lets through. Checks:
//   · engine.info says whether this machine can do it (Windows, for now); the per-start secret is in a file under the
//     data folder and in no reply;
//   · a Claude conversation opened with the capability is handed the server (Windows; nowhere else), one opened
//     without it is not;
//   · POST /api/computer/ask: no secret / a wrong one 401, a body without applications 400, a conversation that is not
//     open is refused without a card; for an open one the card goes to every window as a permission request of that
//     conversation and is in what a window gets when it opens the conversation; 允许 → granted, 不允许 with words →
//     refused with the words, the caller going away withdraws the card, the conversation closing answers it;
//   · the endpoint does not exist on the remote-access listener;
//   · (Windows) the MCP server handshakes and lists its 23 tools; request_access raises the card with the applications
//     and the reason, and grants only after the yes; a no grants nothing; Claude Web itself is refused without a card;
//     with a grant that nothing in front matches, a screenshot comes back and input is refused (the wheel is asked
//     to turn by no notches, so a broken gate would do nothing either).
//   node server/ws-phase24.mjs   (starts its own server; scripts/e2e.mjs' port/token are ignored)
import WebSocket from 'ws';
import net from 'node:net';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-phase24-'));
const home = path.join(root, 'home');
const proj = path.join(root, 'proj');
const dataDir = path.join(home, '.claude-web');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(proj, { recursive: true });
const WIN = process.platform === 'win32';

const results = [];
const check = (name, ok, detail = '') => { results.push([name, !!ok]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const skip = (name, why) => console.log(`SKIP ${name} — ${why}`);
const until = async (fn, ms, step = 50) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await new Promise((r) => setTimeout(r, step)); } };
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

// ---- the server: throwaway HOME ----
const token = randomBytes(12).toString('hex');
const env = { ...process.env, HOME: home, USERPROFILE: home, PORT: '0', CLAUDE_WEB_TOKEN: token, CLAUDE_WEB_DIR: dataDir, CODEX_HOME: path.join(home, '.codex'), CW_NO_MODEL_REFRESH: '1', CW_NO_PUBLIC_BROKERS: '1' };
for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_|OPENAI_)/.test(k) || /^CW_(COMPUTER|WEB)_/.test(k)) delete env[k];
const server = spawn(process.execPath, [path.join(here, 'dist', 'index.js')], { cwd: path.dirname(here), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let slog = '';
server.stderr.on('data', (d) => { slog += d; });
const port = await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`server did not start in 60s\n${slog}`)), 60_000);
  server.stdout.on('data', (d) => { slog += d; const m = /listening on http:\/\/[^:]+:(\d+)/.exec(slog); if (m) { clearTimeout(t); res(m[1]); } });
  server.on('exit', (c) => rej(new Error(`server exited (${c})\n${slog}`)));
});

/** A window on the server's WebSocket: requests, and every event it is sent. */
function client(url) {
  const ws = new WebSocket(url);
  let seq = 0;
  const pending = new Map();
  const events = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.type === 'reply') { const p = pending.get(m.reply.id); pending.delete(m.reply.id); m.reply.ok ? p.res(m.reply.data) : p.rej(new Error(m.reply.error)); return; }
    if (m.type === 'event') events.push(m.event);
  });
  return {
    ws,
    events,
    open: new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); }),
    req: (r) => new Promise((res, rej) => { const id = String(++seq); pending.set(id, { res, rej }); ws.send(JSON.stringify({ type: 'request', request: { id, req: r } })); }),
    /** The access cards this window was sent, oldest first. */
    cards: () => events.filter((e) => e.kind === 'permission.request').map((e) => e.request),
    resolved: () => events.filter((e) => e.kind === 'permission.resolved').map((e) => e.requestId),
  };
}

/** The `computer` MCP server as the engine starts it: a process, JSON-RPC lines over stdio. */
function startMcp(entry, mcpEnv) {
  const p = spawn(process.execPath, [entry], { cwd: proj, env: { ...env, ...mcpEnv }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const replies = new Map();
  let buf = '';
  let stderr = '';
  let seq = 0;
  p.stderr.on('data', (d) => { stderr += String(d); });
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try { const m = JSON.parse(line); replies.set(m.id, m); } catch { /* not ours */ }
    }
  });
  const send = (method, params = {}) => { const id = ++seq; p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); return id; };
  const wait = async (id, ms = 60_000) => (await until(() => replies.get(id), ms)) ?? { error: { message: `no answer in ${ms} ms. stderr: ${stderr.slice(-300)}` } };
  const resultOf = (r) => r.result ?? { isError: true, content: [{ type: 'text', text: `rpc error: ${r.error?.message}` }] };
  return {
    rpc: (method, params) => wait(send(method, params)),
    /** Start a call and go on: `await pending.done` once the card was answered. */
    begin: (name, args = {}) => { const id = send('tools/call', { name, arguments: args }); return { done: wait(id).then(resultOf) }; },
    call: async (name, args = {}) => resultOf(await wait(send('tools/call', { name, arguments: args }))),
    stop: () => new Promise((r) => { p.once('exit', r); p.stdin.end(); setTimeout(() => p.kill(), 5000).unref?.(); }),
  };
}
const textOf = (r) => (r?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const jsonOf = (r) => { try { return JSON.parse(textOf(r)); } catch { return null; } };

/** `POST /api/computer/ask`, the way a `computer` MCP process asks. `signal` to go away before the answer. */
async function ask(toPort, body, bearer, signal) {
  const res = await fetch(`http://127.0.0.1:${toPort}/api/computer/ask`, { method: 'POST', headers: { 'content-type': 'application/json', ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }) }, body: JSON.stringify(body), signal });
  let json = null;
  try { json = await res.json(); } catch { /* no body (404) */ }
  return { status: res.status, json };
}

const a = client(`ws://127.0.0.1:${port}/ws?token=${token}`);
const b = client(`ws://127.0.0.1:${port}/ws?token=${token}`);
let mcp = null;
const opened = [];

/** Open a Claude conversation (the real engine; nothing is sent to it) and wait for what it was handed. */
async function openClaude(features) {
  const from = a.events.length;
  const o = await a.req({ kind: 'session.open', params: { cwd: proj, permissionMode: 'default', ...(features ? { features } : {}) } });
  opened.push(o.sessionId);
  const info = await until(() => a.events.slice(from).filter((e) => e.kind === 'session.info' && e.info.sessionId === o.sessionId && Array.isArray(e.info.mcpServers)).pop()?.info, 120_000, 200);
  const failed = a.events.slice(from).find((e) => e.kind === 'session.state' && e.sessionId === o.sessionId && e.state === 'error');
  return { sessionId: o.sessionId, servers: info?.mcpServers ?? null, error: failed?.error };
}

async function main() {
  await Promise.all([a.open, b.open]);

  // ---- what this machine can do, and where the secret lives ----
  const engine = await a.req({ kind: 'engine.info' });
  check(`engine.info: 操控电脑 ${WIN ? 'can' : 'cannot'} run on this machine (${process.platform})`, engine.computerUse === WIN, JSON.stringify({ computerUse: engine.computerUse, runtime: engine.runtime }));
  const tokenFile = path.join(dataDir, 'runtime', 'computer-mcp', `${server.pid}.token`);
  const secret = await until(() => { try { return fs.readFileSync(tokenFile, 'utf8').trim(); } catch { return null; } }, 5000);
  check('the per-start secret is in a file under the data folder (the MCP processes are pointed at it)', /^[0-9a-f]{64}$/.test(secret ?? ''), tokenFile);
  check('… and in no reply a window can ask for', !!secret && !JSON.stringify(engine).includes(secret) && !JSON.stringify(await a.req({ kind: 'settings.get' })).includes(secret));

  // ---- the endpoint, before any conversation ----
  const body = { sessionId: 'no-such-conversation', apps: ['Notepad'], reason: 'phase 24' };
  check('no secret → 401', (await ask(port, body)).status === 401);
  check('a wrong secret → 401', (await ask(port, body, 'f'.repeat(64))).status === 401);
  check('a body without applications → 400', (await ask(port, { sessionId: 'x', apps: [], reason: 'r' }, secret)).status === 400);
  const stranger = await ask(port, body, secret);
  check('a conversation that is not open: refused, and no window is shown a card', stranger.status === 200 && stranger.json?.granted === false && /not open/.test(stranger.json?.message ?? '') && a.cards().length === 0 && b.cards().length === 0, JSON.stringify(stranger.json));

  // ---- what a Claude conversation is handed ----
  const plain = await openClaude();
  if (!plain.servers) { check('a Claude conversation starts in the throwaway HOME (the engine is there, nothing is sent to it)', false, plain.error ?? 'no session.info with its MCP servers in 120 s'); return; }
  const names = (s) => s.map((m) => m.name).sort().join(',');
  check('a conversation opened without the capability is not handed the computer server', !plain.servers.some((m) => m.name === 'computer') && plain.servers.some((m) => m.name === 'web'), names(plain.servers));
  const withIt = await openClaude({ computerUse: true });
  const computer = withIt.servers?.find((m) => m.name === 'computer');
  if (WIN) {
    check('one opened with it is handed `computer` next to the web and the shared memory', !!computer && withIt.servers.some((m) => m.name === 'web') && withIt.servers.some((m) => m.name === 'memory'), withIt.servers ? names(withIt.servers) : withIt.error);
    // the engine reports its servers as soon as it is up: a server still connecting is "pending" there
    const settled = computer?.status === 'connected';
    check('… the engine started it (connected: its 23 tools; or still connecting)', !!computer && (settled ? computer.tools?.length === 23 : computer.status === 'pending'), JSON.stringify({ status: computer?.status, tools: computer?.tools?.length, error: computer?.error }));
  } else {
    check('off Windows the capability starts nothing: no computer server even when asked for', !!withIt.servers && !computer, withIt.servers ? names(withIt.servers) : withIt.error);
  }
  const sid = withIt.sessionId;

  // ---- the card ----
  const cardsBefore = a.cards().length;
  const first = ask(port, { sessionId: sid, apps: ['Notepad', '  画图  ', 7, ''], reason: '  把这段话\n写进记事本  ', clipboardWrite: true, somethingElse: 'x' }, secret);
  const card = await until(() => a.cards()[cardsBefore], 10_000);
  check('an open conversation: the card goes out as a permission request of that conversation', card?.sessionId === sid && card?.toolName === 'mcp__computer__request_access', JSON.stringify(card));
  check('… with the applications, the reason on one line, and only what was really asked for', JSON.stringify(card?.input) === JSON.stringify({ apps: ['Notepad', '画图'], reason: '把这段话 写进记事本', clipboardWrite: true }), JSON.stringify(card?.input));
  check('… to every window', !!(await until(() => b.cards().some((c) => c.requestId === card?.requestId), 5000)));
  const reopened = await b.req({ kind: 'session.open', params: { sessionId: sid, cwd: proj } });
  check('… and in what a window gets when it opens the conversation', (reopened.pending ?? []).some((p) => p.requestId === card?.requestId), JSON.stringify((reopened.pending ?? []).map((p) => p.toolName)));
  await b.req({ kind: 'permission.respond', requestId: card.requestId, response: { behavior: 'allow' } });
  const yes = await first;
  check('允许 (from another window than the one that opened it) → granted', yes.status === 200 && yes.json?.granted === true, JSON.stringify(yes.json));
  check('… and the card is taken away everywhere', !!(await until(() => a.resolved().includes(card.requestId) && b.resolved().includes(card.requestId), 5000)));
  check('… answering it a second time finds nothing', await a.req({ kind: 'permission.respond', requestId: card.requestId, response: { behavior: 'allow' } }).then(() => false, () => true));

  const n2 = a.cards().length;
  const second = ask(port, { sessionId: sid, apps: ['Notepad'], reason: 'again' }, secret);
  const card2 = await until(() => a.cards()[n2], 10_000);
  await a.req({ kind: 'permission.respond', requestId: card2.requestId, response: { behavior: 'deny', message: '只许用画图' } });
  const no = await second;
  check('不允许 with words → refused, and the words reach the agent', no.json?.granted === false && no.json.message.includes('只许用画图') && /Nothing was granted/.test(no.json.message), JSON.stringify(no.json));

  const n3 = a.cards().length;
  const gone = new AbortController();
  const third = ask(port, { sessionId: sid, apps: ['Notepad'], reason: 'then leaves' }, secret, gone.signal).catch(() => null);
  const card3 = await until(() => a.cards()[n3], 10_000);
  gone.abort();
  await third;
  check('the asking process going away withdraws its card', !!card3 && !!(await until(() => a.resolved().includes(card3.requestId), 5000)));

  // ---- the remote-access listener ----
  const rst = await a.req({ kind: 'remote.set', enabled: true, port: await freePort(), anywhere: false });
  check('remote access is on (the phone\'s listener)', rst.running === true, rst.error);
  const viaRemote = await ask(rst.port, { sessionId: sid, apps: ['Notepad'], reason: 'from outside' }, secret);
  check('the endpoint does not exist there, even with the secret — and no card', viaRemote.status === 404 && a.cards().length === n3 + 1, String(viaRemote.status));
  await a.req({ kind: 'remote.set', enabled: false });

  // ---- the MCP server itself (Windows) ----
  if (WIN) {
    const entry = path.join(here, 'dist', 'computer', 'mcp.js');
    if (!fs.existsSync(entry)) { check('server/dist/computer/mcp.js exists (npm run build -w server)', false, entry); return; }
    mcp = startMcp(entry, { CW_COMPUTER_ASK_URL: `http://127.0.0.1:${port}`, CW_COMPUTER_TOKEN_FILE: tokenFile, CW_SESSION_ID: sid });
    const init = await mcp.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'phase24', version: '0' } });
    check('mcp initialize handshakes', init.result?.serverInfo?.name === 'claude-web-computer' && !!init.result?.capabilities?.tools, JSON.stringify(init.result?.serverInfo ?? init.error));
    const tools = (await mcp.rpc('tools/list')).result?.tools ?? [];
    check('mcp lists its 23 tools, request_access among them', tools.length === 23 && tools.some((t) => t.name === 'request_access') && tools.some((t) => t.name === 'computer_batch'), tools.map((t) => t.name).join(','));
    const before = jsonOf(await mcp.call('list_granted_applications'));
    check('nothing is granted to begin with', Array.isArray(before?.granted) && before.granted.length === 0, textOf(await mcp.call('list_granted_applications')).slice(0, 200));
    const early = await mcp.call('screenshot');
    check('… and nothing can be looked at before a grant', early.isError === true && !(early.content ?? []).some((c) => c.type === 'image'), textOf(early).slice(0, 160));

    // an application name nothing on this machine answers to: granted, and never in front
    const APP = 'cw-phase24-no-such-app';
    const n4 = a.cards().length;
    const refused = mcp.begin('request_access', { apps: [APP], reason: 'phase 24: the first answer is a no' });
    const card4 = await until(() => a.cards()[n4], 60_000);
    check('request_access raises the card with its applications and reason', card4?.sessionId === sid && JSON.stringify(card4?.input) === JSON.stringify({ apps: [APP], reason: 'phase 24: the first answer is a no' }), JSON.stringify(card4));
    await a.req({ kind: 'permission.respond', requestId: card4.requestId, response: { behavior: 'deny', message: '' } });
    const r4 = await refused.done;
    check('a no grants nothing', r4.isError === true && jsonOf(r4)?.granted?.length === 0 && jsonOf(r4)?.allGranted?.length === 0 && jsonOf(await mcp.call('list_granted_applications'))?.granted?.length === 0, textOf(r4).slice(0, 240));

    const n5 = a.cards().length;
    const self = await mcp.call('request_access', { apps: ['Claude Web'], reason: 'phase 24: itself' });
    check('Claude Web itself is refused without the user being asked', self.isError === true && /never be controlled/.test(textOf(self)) && a.cards().length === n5, textOf(self).slice(0, 200));

    const granting = mcp.begin('request_access', { apps: [APP], reason: 'phase 24: now a yes' });
    const card6 = await until(() => a.cards()[n5], 60_000);
    await a.req({ kind: 'permission.respond', requestId: card6.requestId, response: { behavior: 'allow' } });
    const r6 = await granting.done;
    check('a yes grants it', !r6.isError && jsonOf(r6)?.granted?.[0]?.app === APP && jsonOf(await mcp.call('list_granted_applications'))?.granted?.includes(APP), textOf(r6).slice(0, 240));

    const where = await mcp.call('cursor_position');
    check('the pointer can be asked for (it reads, it sends nothing)', !where.isError && /The pointer is/.test(textOf(where)), textOf(where).slice(0, 160));
    const shot = await mcp.call('screenshot');
    const image = (shot.content ?? []).find((c) => c.type === 'image');
    if (image) {
      check('with a grant the screen can be looked at: a picture comes back', typeof image.data === 'string' && image.data.length > 1000 && /^image\//.test(image.mimeType ?? ''), `${image.mimeType} ${image.data.length} chars`);
      // the gate, with an action that would do nothing were it broken: the wheel turned by no notches
      const turn = await mcp.call('scroll', { coordinate: [40, 40], scroll_direction: 'down', scroll_amount: 0 });
      check('input is refused while what is in front is not a granted application', turn.isError === true && /not granted|refused|No window is in front|Nothing was sent/i.test(textOf(turn)), textOf(turn).slice(0, 260));
    } else {
      skip('with a grant the screen can be looked at / input is refused for what is not granted', `no picture (a locked or sleeping display?): ${textOf(shot).slice(0, 200)}`);
    }
  } else {
    skip('the MCP server itself', `操控电脑 is Windows-only for now (this is ${process.platform})`);
  }

  // ---- the conversation closing answers what is still asked ----
  const n7 = a.cards().length;
  const last = ask(port, { sessionId: sid, apps: ['Notepad'], reason: 'and then it closes' }, secret);
  const card7 = await until(() => a.cards()[n7], 10_000);
  await a.req({ kind: 'session.close', sessionId: sid });
  const closed = await last;
  check('the conversation closing answers a card that is still up with a no, and takes it away', !!card7 && closed.json?.granted === false && /closed/.test(closed.json?.message ?? '') && !!(await until(() => a.resolved().includes(card7.requestId), 5000)), JSON.stringify(closed.json));
  const after = await ask(port, { sessionId: sid, apps: ['Notepad'], reason: 'after' }, secret);
  check('… and once it is closed nothing can be asked in its name', after.json?.granted === false && a.cards().length === n7 + 1, JSON.stringify(after.json));
}

main().catch((e) => { check('phase24 ran to the end', false, e.stack || e.message); }).finally(async () => {
  try { await mcp?.stop(); } catch { /* */ }
  for (const id of opened) { try { await a.req({ kind: 'session.close', sessionId: id }); } catch { /* closed already */ } }
  for (const c of [a, b]) { try { c.ws.terminate(); } catch { /* */ } }
  server.kill();
  await new Promise((r) => setTimeout(r, 800));
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows may still hold a handle */ }
  const bad = results.filter(([, ok]) => !ok);
  if (bad.length) console.log(`\n--- server log (tail) ---\n${slog.split('\n').slice(-60).join('\n')}`);
  console.log(`\nphase24: ${results.length - bad.length}/${results.length} passed`);
  process.exit(bad.length ? 1 : 0);
});
