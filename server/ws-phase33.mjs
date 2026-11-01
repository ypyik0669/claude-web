// Phase 33 end-to-end (2026-10-25, stage C2): a project's extra folders reach Claude Code, over a real server and the
// real engine against a fake Anthropic upstream started here (no model, no token).
//   · workspaces.add main, workspaces.update { folders: [extra] } → workspaces.list has them; a folder that does not
//     exist is refused with 「找不到这个文件夹」;
//   · a conversation opened in the project's main folder: the first request's system text / messages name `extra`
//     (Claude Code writes its additional working directories into the environment section);
//   · a conversation opened in `extra` itself (not a project's main folder) names no other folder;
//   · a conversation opened in a subfolder of the main folder does not get `extra` (fix wave C-S4);
//   · workspaces.update with a `folders` that is not a list is refused and the list kept (C-S2).
//   node server/ws-phase33.mjs   (starts its own server; scripts/e2e.mjs' port/token are ignored)
import WebSocket from 'ws';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-phase33-'));
const home = path.join(root, 'home');
fs.mkdirSync(path.join(home, '.claude'), { recursive: true });

const results = [];
const check = (name, ok, detail = '') => { results.push([name, !!ok]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const until = async (fn, ms, step = 200) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await new Promise((r) => setTimeout(r, step)); } };

// ---- the fake upstream: keeps every streamed request's whole text (system + messages) ----
const hits = [];
let n = 0;
const textOf = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => typeof p === 'string' ? p : p?.text ?? (typeof p?.content === 'string' ? p.content : Array.isArray(p?.content) ? textOf(p.content) : '')).join('\n') : '';
const json = (s, status, o) => s.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(o));
const upstream = http.createServer((q, s) => {
  let raw = '';
  q.on('data', (c) => { raw += c; });
  q.on('end', () => {
    let j = {};
    try { j = JSON.parse(raw || '{}'); } catch { /* keep */ }
    const url = q.url ?? '';
    if (url.includes('/count_tokens')) return json(s, 200, { input_tokens: 10 });
    if (!url.startsWith('/v1/messages')) return json(s, 404, { error: { type: 'not_found_error', message: 'no' } });
    const msg = { id: `msg_${++n}`, type: 'message', role: 'assistant', model: j.model, stop_sequence: null };
    if (!j.stream) return json(s, 200, { ...msg, content: [{ type: 'text', text: 'side:ok' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2 } });
    const all = `${textOf(j.system)}\n${(j.messages ?? []).map((m) => textOf(m.content)).join('\n')}`;
    // the main request carries the tool list; the official binary's title request is streamed with the same line too
    hits.push({ all, main: /DIRS-PLEASE/.test(all) && Array.isArray(j.tools) && j.tools.length > 0 });
    const ev = (type, o) => `event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`;
    let out = ev('message_start', { message: { ...msg, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } });
    out += ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) + ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } });
    out += ev('content_block_stop', { index: 0 }) + ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }) + ev('message_stop', {});
    s.writeHead(200, { 'content-type': 'text/event-stream' });
    s.end(out);
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const up = `http://127.0.0.1:${upstream.address().port}`;

// ---- the server: throwaway HOME, no proxy ----
const token = randomBytes(12).toString('hex');
const env = { ...process.env, HOME: home, USERPROFILE: home, PORT: '0', CLAUDE_WEB_TOKEN: token, CLAUDE_WEB_DIR: path.join(home, '.claude-web'), CW_NO_MODEL_REFRESH: '1', CW_NO_PUBLIC_BROKERS: '1', CLAUDE_WEB_SYSTEM_LANG: 'zh-CN' };
for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_CONFIG_DIR|CLAUDE_WEB_CONTEXT_WINDOWS|CLAUDE_WEB_MODEL_CAPS|OPENAI_|GEMINI_|GROK_|XAI_)/.test(k) || /^(no_proxy|https?_proxy|all_proxy)$/i.test(k)) delete env[k];
const server = spawn(process.execPath, [path.join(here, 'dist', 'index.js')], { cwd: path.dirname(here), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let slog = '';
server.stderr.on('data', (d) => { slog += d; });
const port = await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`server did not start in 60s\n${slog}`)), 60_000);
  server.stdout.on('data', (d) => { slog += d; const m = /listening on http:\/\/[^:]+:(\d+)/.exec(slog); if (m) { clearTimeout(t); res(m[1]); } });
  server.on('exit', (c) => rej(new Error(`server exited (${c})\n${slog}`)));
});

const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
let seq = 0;
const pending = new Map();
const events = [];
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type === 'reply') { const p = pending.get(m.reply.id); pending.delete(m.reply.id); m.reply.ok ? p.res(m.reply.data) : p.rej(new Error(m.reply.error)); return; }
  if (m.type === 'event') events.push(m.event);
});
const req = (r) => new Promise((res, rej) => { const id = String(++seq); pending.set(id, { res, rej }); ws.send(JSON.stringify({ type: 'request', request: { id, req: r } })); });
const resultOf = (sid, from, ms = 120_000) => until(() => events.slice(from).find((e) => e.kind === 'session.event' && e.sessionId === sid && e.message?.type === 'result')?.message, ms);
// a path as it may appear in the prompt: either slash, any case (Windows)
const named = (text, p) => { const t = text.toLowerCase().replace(/\\\\/g, '\\'); const a = p.toLowerCase(); return t.includes(a) || t.includes(a.replace(/\\/g, '/')); };

/** Opens a conversation in `cwd`, sends one line, returns the text of the main request it made. */
async function turnIn(cwd) {
  const mark = hits.length;
  const from = events.length;
  const o = await req({ kind: 'session.open', params: { cwd, model: 'claude-sonnet-4-6', permissionMode: 'bypassPermissions', features: { env: { ANTHROPIC_BASE_URL: up, ANTHROPIC_AUTH_TOKEN: 'e2e-phase33' } } } });
  await req({ kind: 'session.send', params: { sessionId: o.sessionId, text: 'DIRS-PLEASE' } });
  const r = await resultOf(o.sessionId, from);
  await req({ kind: 'session.close', sessionId: o.sessionId }).catch(() => {});
  return { result: r?.subtype, text: hits.slice(mark).find((h) => h.main)?.all ?? '' };
}

async function main() {
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  await req({ kind: 'settings.set', key: 'network.proxy', value: 'off' });
  const main = path.join(root, 'main');
  const extra = path.join(root, 'extra-folder-c2');
  fs.mkdirSync(main, { recursive: true });
  fs.mkdirSync(extra, { recursive: true });

  const w = await req({ kind: 'workspaces.add', path: main });
  check('workspaces.add: a new project has no extra folders', Array.isArray(w.folders) && w.folders.length === 0, JSON.stringify(w));
  const missing = await req({ kind: 'workspaces.update', id: w.id, folders: [path.join(root, 'not-here')] }).then(() => 'accepted', (e) => e.message);
  check('workspaces.update: a folder that does not exist is refused, by name', /找不到这个文件夹/.test(missing) && missing.includes('not-here'), missing);
  const u = await req({ kind: 'workspaces.update', id: w.id, folders: [extra, main] });
  check('workspaces.update: the extra folder is kept, the main folder dropped from the list', JSON.stringify(u.folders) === JSON.stringify([extra]), JSON.stringify(u.folders));
  const listed = (await req({ kind: 'workspaces.list' })).find((x) => x.id === w.id);
  check('workspaces.list has the extra folder', JSON.stringify(listed?.folders) === JSON.stringify([extra]), JSON.stringify(listed));

  const a = await turnIn(main);
  check('a conversation in the project folder: Claude Code is told about the extra folder', a.result === 'success' && named(a.text, extra), `${a.result}; ${a.text.length} chars; mentions extra: ${named(a.text, extra)}`);
  const b = await turnIn(extra);
  check('a conversation in the extra folder itself (not a project folder): no other folder is added', b.result === 'success' && !named(b.text, main), `${b.result}; mentions main: ${named(b.text, main)}`);
  // C-S4: only the project's main folder itself gets them, not a folder inside it
  const sub = path.join(main, 'sub');
  fs.mkdirSync(sub, { recursive: true });
  const c = await turnIn(sub);
  check('a conversation in a subfolder of the main folder: the extra folder is not added', c.result === 'success' && named(c.text, sub) && !named(c.text, extra), `${c.result}; names sub: ${named(c.text, sub)}; mentions extra: ${named(c.text, extra)}`);
  // C-S2: a folders that is not a list is refused and leaves the list alone
  const bad = await req({ kind: 'workspaces.update', id: w.id, folders: 'x' }).then(() => 'accepted', (e) => e.message);
  const after = (await req({ kind: 'workspaces.list' })).find((x) => x.id === w.id);
  check('workspaces.update: folders that is not a list is refused, the list kept', bad !== 'accepted' && JSON.stringify(after?.folders) === JSON.stringify([extra]), `${bad}; ${JSON.stringify(after?.folders)}`);
}

try {
  await main();
} catch (e) {
  check('ran without throwing', false, e?.stack ?? String(e));
} finally {
  ws.close();
  server.kill();
  upstream.close();
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\nphase33: ${results.length - failed}/${results.length} passed`);
  if (failed) console.log(slog.split('\n').slice(-30).join('\n'));
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows may still hold a handle */ }
  process.exit(failed ? 1 : 0);
}
