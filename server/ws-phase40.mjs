// Phase 40 end-to-end (2026-10-26): ego lite as the browser Claude acts in first — a real server and the real Claude
// Code against a fake Anthropic upstream, with a fake `ego-browser` on PATH:
//   · web.status finds ego lite (and its version); a conversation's tools include ego_browser, and the built-in
//     browser's tools say to prefer it;
//   · the model calls ego_browser with a script in Chinese, quotes and backticks: the permission card carries the script,
//     ego-browser gets `nodejs -e "await import('file:///…/round-01.mjs')"` and that file holds the script byte for byte
//     after the CW_SPACE / CW_OUT lines; the output and the screenshot the script saved reach the model;
//   · 「内置浏览器」 in settings: a new conversation has no ego tools.
// The permission rule (spec 14.1 / 14.4): default mode → exactly one card for ego_browser, the server's;
// 完全放开 (bypassPermissions) → no card at all, the script runs and its output reaches the model. The built-in
// browser's browser_eval (this script's WebSocket hosts the browser and answers it): default → one server card for the
// script, 完全放开 → none. Last, 允许的网站 (spec 14.4, last bullet): a click on a new site in 完全放开 raises no card
// and puts the site on the list, marked as added by 完全放开; a click there in the default mode then raises no card,
// while another new site still asks.
// 允许的网站 is the only say for the built-in browser (the user's decision, 2026-10-27): default mode — opening a new
// site → exactly one card (the site card, op open; 总是允许), a scroll / click there → none, opening another new site →
// one, a script → one; 完全放开 → none (siteRule below).
//   node server/ws-phase40.mjs   (starts its own server; scripts/e2e.mjs' port/token are ignored)
import WebSocket from 'ws';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-phase40-'));
const home = path.join(root, 'home');
const dataDir = path.join(home, '.claude-web');
fs.mkdirSync(home, { recursive: true });

const results = [];
const checkRaw = (name, ok, detail = '') => { results.push([name, !!ok]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const until = async (fn, ms, step = 200) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await new Promise((r) => setTimeout(r, step)); } };

// ---- a fake ego-browser on PATH ----
const bin = path.join(root, 'bin');
fs.mkdirSync(bin);
const egoLog = path.join(root, 'ego-calls.log');
const FAKE = `#!/usr/bin/env node
const fs = require('fs');
const [cmd, flag, code] = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(egoLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
if (cmd === 'skill') { process.stdout.write('[ego-browser:skill] ego-browser v9.8.7\\n# Fake guide\\nconst task = await taskSpace(name)\\n'); process.exit(0); }
if (cmd !== 'nodejs' || flag !== '-e') { process.stderr.write('usage'); process.exit(2); }
globalThis.taskSpace = async (n) => ({ name: n, page: () => ({ goto: async () => {} }) });
(async () => { await eval('(async () => {' + code + '})()'); })().catch((e) => { process.stderr.write(String(e && e.stack || e)); process.exit(1); });
`;
fs.writeFileSync(path.join(bin, 'ego-browser.js'), FAKE);
if (process.platform === 'win32') fs.writeFileSync(path.join(bin, 'ego-browser.cmd'), '@ECHO off\r\nnode "%~dp0\\ego-browser.js" %*\r\n');
else { fs.writeFileSync(path.join(bin, 'ego-browser'), FAKE); fs.chmodSync(path.join(bin, 'ego-browser'), 0o755); }

const EVAL_SCRIPT = 'return document.title + " EVAL-RAN"';
const SCRIPT = 'const t = await taskSpace(CW_SPACE);\nawait t.page("p1").goto("https://example.com/登录");\nconsole.log(`中文-OK:${t.name} "引号" \'单引号\' $HOME %PATH%`);\nconst fs = await import("node:fs");\nconst path = await import("node:path");\nfs.writeFileSync(path.join(CW_OUT, "shot.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));';

// ---- the fake upstream ----
const hits = [];
let n = 0;
const textOf = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => typeof p === 'string' ? p : p?.text ?? (typeof p?.content === 'string' ? p.content : Array.isArray(p?.content) ? textOf(p.content) : '')).join('\n') : '';
const lastToolResult = (j) => {
  const last = (j.messages ?? []).at(-1);
  if (last?.role !== 'user' || !Array.isArray(last.content)) return null;
  return last.content.find((b) => b?.type === 'tool_result') ?? null;
};
const turnText = (j) => {
  const msgs = j.messages ?? [];
  let i = msgs.length;
  while (i > 0 && msgs[i - 1].role !== 'assistant') i--;
  return msgs.slice(i).filter((m) => m.role === 'user').map((m) => textOf(m.content)).join('\n');
};
const json = (s, status, o) => s.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(o));
function sse(s, j, blocks, stop) {
  const msg = { id: `msg_${++n}`, type: 'message', role: 'assistant', model: j.model, stop_sequence: null };
  const ev = (type, o) => `event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`;
  let out = ev('message_start', { message: { ...msg, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  blocks.forEach((b, i) => {
    if (b.type === 'text') out += ev('content_block_start', { index: i, content_block: { type: 'text', text: '' } }) + ev('content_block_delta', { index: i, delta: { type: 'text_delta', text: b.text } });
    else out += ev('content_block_start', { index: i, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } }) + ev('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    out += ev('content_block_stop', { index: i });
  });
  out += ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 3 } }) + ev('message_stop', {});
  s.writeHead(200, { 'content-type': 'text/event-stream' });
  s.end(out);
}

let call = 0;
function anthropic(s, j, h, raw) {
  if (h.url.includes('/count_tokens')) return json(s, 200, { input_tokens: 10 });
  if (!j.stream) return json(s, 200, { id: `msg_${++n}`, type: 'message', role: 'assistant', model: j.model, content: [{ type: 'text', text: 'side:ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 2 } });
  h.main = true;
  h.tools = (j.tools ?? []).map((t) => t.name);
  h.mentionsEgo = raw.includes('mcp__web__ego_browser');
  h.openDesc = (j.tools ?? []).find((t) => t.name === 'mcp__web__browser_open')?.description ?? '';
  const tr = lastToolResult(j);
  const WANT = { ego: { name: 'mcp__web__ego_browser', input: { script: SCRIPT } }, eval: { name: 'mcp__web__browser_eval', input: { script: EVAL_SCRIPT } } };
  const use = (w, id) => {
    // 'direct' when the tool is in the conversation's own tool list, 'missing' when the model is calling one it was not given
    const { name, input } = w;
    h.called = h.tools.includes(name) ? 'direct' : 'missing';
    return sse(s, j, [{ type: 'tool_use', id, name, input }], 'tool_use');
  };
  if (tr) { h.toolResult = tr; return sse(s, j, [{ type: 'text', text: 'main: done' }], 'end_turn'); }
  // 'TOOL-GO <web tool> <json args>': any tool of the web server with those arguments (允许的网站 below)
  const t = turnText(j);
  const go = /TOOL-GO (\w+) (\{.*\})/.exec(t);
  const w = /EGO-GO/.test(t) ? WANT.ego : /EVAL-GO/.test(t) ? WANT.eval : go ? { name: `mcp__web__${go[1]}`, input: JSON.parse(go[2]) } : null;
  if (w) return use(w, `toolu_use_${++call}`);
  return sse(s, j, [{ type: 'text', text: 'main:ok' }], 'end_turn');
}
const upstream = http.createServer((q, s) => {
  let raw = '';
  q.on('data', (c) => { raw += c; });
  q.on('end', () => {
    let j = {};
    try { j = JSON.parse(raw || '{}'); } catch { /* keep */ }
    const h = { url: q.url ?? '', model: j.model };
    hits.push(h);
    if (h.url.startsWith('/v1/messages')) return anthropic(s, j, h, raw);
    if (h.url.includes('/models')) return json(s, 200, { data: [{ id: 'claude-sonnet-4-6', type: 'model' }] });
    json(s, 404, { error: { message: 'no' } });
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const up = `http://127.0.0.1:${upstream.address().port}`;

// ---- the server: throwaway HOME, the fake ego-browser first on PATH ----
const token = randomBytes(12).toString('hex');
const env = { ...process.env, HOME: home, USERPROFILE: home, PORT: '0', CLAUDE_WEB_TOKEN: token, CLAUDE_WEB_DIR: dataDir, CW_NO_MODEL_REFRESH: '1', CW_NO_PUBLIC_BROKERS: '1', PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` };
for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_CONFIG_DIR|OPENAI_)/.test(k) || /^(no_proxy|https?_proxy|all_proxy)$/i.test(k)) delete env[k];
if (process.platform === 'win32') delete env.Path;
const server = spawn(process.execPath, [path.join(here, 'dist', 'index.js')], { cwd: path.dirname(here), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let slog = '';
server.stderr.on('data', (d) => { slog += d; });
const port = await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`server did not start in 60s\n${slog}`)), 60_000);
  server.stdout.on('data', (d) => { slog += d; const m = /listening on http:\/\/[^:]+:(\d+)/.exec(slog); if (m) { clearTimeout(t); res(m[1]); } });
  server.on('exit', (c) => rej(new Error(`server exited (${c})\n${slog}`)));
});

/** Where this window's browser tab is: every answer says this page. */
let pageUrl = 'https://app.example/';
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
let seq = 0;
const pending = new Map();
const events = [];
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type === 'reply') { const p = pending.get(m.reply.id); pending.delete(m.reply.id); m.reply.ok ? p.res(m.reply.data) : p.rej(new Error(m.reply.error)); return; }
  if (m.type !== 'event') return;
  events.push(m.event);
  // this window hosts the built-in browser: a script is answered with its result, anything else with a plain page
  const c = m.event.kind === 'browser.command' ? m.event.command : null;
  if (!c) return;
  // opening a page (browser_open, a new tab with an address): the tab is there from now on
  if ((c.op === 'open' || (c.op === 'tabs' && c.args?.action === 'new')) && c.args?.url) pageUrl = c.args.url;
  const page = { url: pageUrl, title: 'App', text: '' };
  req({ kind: 'browser.result', id: c.id, ok: true, answer: c.op === 'eval' ? { result: JSON.stringify('App EVAL-RAN'), page } : { page } }).catch(() => {});
});
const req = (r) => new Promise((res, rej) => { const id = String(++seq); pending.set(id, { res, rej }); ws.send(JSON.stringify({ type: 'request', request: { id, req: r } })); });
const msgsOf = (sid, from) => events.slice(from).filter((e) => e.kind === 'session.event' && e.sessionId === sid).map((e) => e.message);
const resultOf = (sid, from, ms = 180_000) => until(() => msgsOf(sid, from).find((m) => m.type === 'result'), ms);

async function main() {
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  await req({ kind: 'settings.set', key: 'network.proxy', value: 'off' });
  const st = await until(async () => { const s = await req({ kind: 'web.status' }); return s.ego?.found ? s : null; }, 30_000, 500);
  checkRaw('web.status finds ego lite on PATH, with the version its guide states; the choice is 自动', st?.ego?.version === '9.8.7' && st.agentBrowser === 'auto', JSON.stringify(st && { ego: st.ego, agentBrowser: st.agentBrowser }));
  const hosted = await req({ kind: 'browser.host', on: true });
  checkRaw('this window hosts the built-in browser', hosted?.host === true, JSON.stringify({ host: hosted?.host }));
  await suite('claude');
  if (process.env.PHASE40_ALLOWLIST !== '0') await allowListSuite();
}

const cardsOf = (sid, from) => events.slice(from).filter((e) => e.kind === 'permission.request' && e.request.sessionId === sid).map((e) => e.request);
const egoCalls = () => fs.readFileSync(egoLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((a) => a[0] === 'nodejs');
const OUTPUT = (sid) => `中文-OK:claude-web ${sid.slice(0, 8)} "引号" '单引号' $HOME %PATH%`;
/** Wait for the turn's result, answering every card on the way with allow (each once); the cards are returned. */
async function runTurn(sid, from) {
  const answered = new Set();
  const r = await until(() => {
    for (const rq of cardsOf(sid, from)) {
      if (answered.has(rq.requestId)) continue;
      answered.add(rq.requestId);
      void req({ kind: 'permission.respond', requestId: rq.requestId, response: { behavior: 'allow' } }).catch(() => {});
    }
    return msgsOf(sid, from).find((m) => m.type === 'result');
  }, 180_000, 300);
  return { r, cards: cardsOf(sid, from) };
}
const cardBrief = (cards) => JSON.stringify(cards.map((c) => ({ toolName: c.toolName, tool: c.input?.tool, op: c.input?.op, host: c.input?.host })));
/** what a conversation's tab was sent since `from` */
const cmdsOf = (sid, from) => events.slice(from).filter((e) => e.kind === 'browser.command' && e.command.sessionId === sid).map((e) => e.command);
/** Answer a card: a site card with `site` ('always' | 'once' | 'deny'), anything else on the way (a lookup) allowed. */
const answerCard = (rq, site) => {
  const isSite = rq.toolName === 'browser.site';
  const response = isSite && site === 'deny' ? { behavior: 'deny', message: 'no' }
    : isSite && site === 'always' && rq.input?.op !== 'eval' ? { behavior: 'allow', updatedInput: { allow: 'always' } }
    : { behavior: 'allow' };
  return req({ kind: 'permission.respond', requestId: rq.requestId, response }).catch(() => {});
};

/**
 * 允许的网站 is the only say for the built-in browser (the user's decision, 2026-10-27, spec 14.4). Default mode:
 * opening a site not on the list → exactly one card, the server's site card (op open; answered 总是允许), a scroll and
 * a click there → none, opening another new site → one, a script → one. 完全放开: none for any of them.
 * `doCall(tool, args, siteAnswer)` makes the call the agent's way: { cards, cmds, ok }. `hosts`: three new sites.
 */
async function siteRule(check, mode, hosts, doCall) {
  if (mode === 'default') {
    const [s1, s2] = hosts;
    const r1 = await doCall('browser_open', { url: `https://${s1}/` }, 'always');
    check('default: opening a site not on the list raises exactly one card, the server\'s site card (op open), and the page opens', r1.cards.length === 1 && r1.cards[0].toolName === 'browser.site' && r1.cards[0].input?.op === 'open' && r1.cards[0].input?.host === s1 && r1.cmds.filter((c) => c.op === 'open').length === 1 && r1.ok, cardBrief(r1.cards) + JSON.stringify(r1.cmds.map((c) => c.op)));
    const list = (await req({ kind: 'settings.get' }))['web.browser.allowedSites'] ?? [];
    check('… 总是允许这个网站 put it on the list', list.includes(s1), JSON.stringify(list));
    for (const [tool, args, op] of [['browser_scroll', { direction: 'down' }, 'scroll'], ['browser_click', { ref: '1' }, 'click']]) {
      const r = await doCall(tool, args, 'deny');
      check(`default: ${tool} on that site raises no card at all, and reaches the page`, r.cards.length === 0 && r.cmds.some((c) => c.op === op && c.args?.site === s1) && r.ok, cardBrief(r.cards) + JSON.stringify(r.cmds.map((c) => [c.op, c.args?.site])));
    }
    const r3 = await doCall('browser_open', { url: `https://${s2}/a` }, 'once');
    check('default: opening another new site raises exactly one card again (op open)', r3.cards.length === 1 && r3.cards[0].toolName === 'browser.site' && r3.cards[0].input?.op === 'open' && r3.cards[0].input?.host === s2 && r3.ok, cardBrief(r3.cards));
    const r4 = await doCall('browser_eval', { script: EVAL_SCRIPT }, 'once');
    check('default: a script raises exactly one card (the server\'s; every time)', r4.cards.length === 1 && r4.cards[0].toolName === 'browser.site' && r4.cards[0].input?.op === 'eval' && r4.ok, cardBrief(r4.cards));
  } else {
    let all = [];
    const failed = [];
    for (const [tool, args] of [['browser_open', { url: `https://${hosts[2]}/` }], ['browser_scroll', { direction: 'down' }], ['browser_click', { ref: '1' }], ['browser_eval', { script: EVAL_SCRIPT }]]) {
      const r = await doCall(tool, args, 'deny');
      all = all.concat(r.cards);
      if (!r.ok) failed.push(tool);
    }
    check('完全放开: opening a new site, a scroll, a click and a script raise no card at all, and all of them run', all.length === 0 && failed.length === 0, cardBrief(all) + JSON.stringify(failed));
  }
}

/** A call made by Claude: a turn whose model calls `tool`. */
const claudeCall = (sid) => async (tool, args, site) => {
  const from = events.length;
  const mark = hits.length;
  await req({ kind: 'session.send', params: { sessionId: sid, text: `TOOL-GO ${tool} ${JSON.stringify(args)}` } });
  const answered = new Set();
  const r = await until(() => {
    for (const rq of cardsOf(sid, from)) { if (!answered.has(rq.requestId)) { answered.add(rq.requestId); void answerCard(rq, site); } }
    return msgsOf(sid, from).find((m) => m.type === 'result');
  }, 180_000, 300);
  const tr = hits.slice(mark).find((h) => h.main && h.toolResult)?.toolResult;
  return { cards: cardsOf(sid, from), cmds: cmdsOf(sid, from), ok: r?.subtype === 'success' && !!tr && !tr.is_error };
};

async function suite(runtime) {
  const check = (name, ok, detail) => checkRaw(name, ok, detail);
  const proj = path.join(root, `proj-${runtime}`);
  fs.mkdirSync(proj, { recursive: true });
  await req({ kind: 'settings.set', key: 'web.browser.agent', value: null });
  const A = await req({ kind: 'providers.upsert', provider: { name: `中转${runtime}`, type: 'anthropic', baseUrl: up, apiKey: 'relay-key-e2e', defaultModel: 'claude-sonnet-4-6', models: ['claude-sonnet-4-6'] } });

  // ---- ego lite found: its tools are there and Claude can run a script ----
  const o = await req({ kind: 'session.open', params: { cwd: proj, providerId: A.id, model: 'claude-sonnet-4-6', permissionMode: 'default' } });
  const sid = o.sessionId;
  const mark = hits.length;
  const from = events.length;
  fs.writeFileSync(egoLog, '');
  await req({ kind: 'session.send', params: { sessionId: sid, text: 'EGO-GO open the page' } });
  // allow anything else that asks on the way (looking the tool up); keep the ego_browser card — the server's
  // (browser.site, tool ego_browser: spec 14.1), never Claude's own (the tool is in its allowed tools)
  const isEgo = (rq) => /ego_browser/.test(String(rq.toolName) + String(rq.input?.tool ?? ''));
  const asked = await until(() => {
    for (const e of events.slice(from)) {
      if (e.kind !== 'permission.request' || e.request.sessionId !== sid) continue;
      if (isEgo(e.request)) return e.request;
      if (!e.request.__allowed) { e.request.__allowed = true; void req({ kind: 'permission.respond', requestId: e.request.requestId, response: { behavior: 'allow' } }).catch(() => {}); }
    }
    return null;
  }, 120_000, 300);
  const askedScript = asked?.input?.script;
  check('ego_browser is asked about on the server\'s card, and the card carries the whole script', !!asked && asked.toolName === 'browser.site' && asked.input?.tool === 'ego_browser' && askedScript === SCRIPT, JSON.stringify(asked && { toolName: asked.toolName, input: asked.input }).slice(0, 400));
  if (asked) await req({ kind: 'permission.respond', requestId: asked.requestId, response: { behavior: 'allow' } });
  const r = await resultOf(sid, from);
  // every card of the turn, not only the ones naming ego_browser: a stray one (a lookup, Claude's own prompt) fails too
  const allCards = cardsOf(sid, from);
  check('… and only that one card in the whole turn: Claude asks about nothing itself', allCards.length === 1 && allCards[0].requestId === asked?.requestId, cardBrief(allCards));
  const mine = hits.slice(mark).filter((h) => h.main);
  const first = mine[0];
  check('the conversation has ego_browser in its tool list itself (alwaysLoad: not deferred behind a tool search)', !!first?.tools?.includes('mcp__web__ego_browser') && mine.find((h) => h.called)?.called === 'direct', JSON.stringify({ called: mine.find((h) => h.called)?.called, tools: first?.tools?.filter((t) => /web__/.test(t)) }));
  if (first?.openDesc) check('… and the built-in browser\'s tools say to prefer it', /use it instead for web tasks/.test(first.openDesc), first.openDesc.slice(-200));
  const calls = fs.readFileSync(egoLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((a) => a[0] === 'nodejs');
  check('ego-browser is run once with nodejs -e "await import(file:///…round-01.mjs)" — no script on the command line', calls.length === 1 && calls[0][1] === '-e' && /^await import\("file:\/\/\/.*round-01\.mjs"\)$/.test(calls[0][2] ?? ''), JSON.stringify(calls));
  const round = path.join(dataDir, 'runtime', 'ego', sid.replace(/[^\w-]/g, '').slice(0, 8), 'round-01.mjs');
  const written = fs.existsSync(round) ? fs.readFileSync(round, 'utf8') : '';
  check('… the round file holds the script byte for byte after the CW_SPACE / CW_OUT lines', written.endsWith(`\n${SCRIPT}`) && written.startsWith(`globalThis.CW_SPACE = "claude-web ${sid.slice(0, 8)}";`), written.slice(0, 160));
  const tr = mine.find((h) => h.toolResult)?.toolResult;
  const trText = textOf(tr?.content);
  check('the output reaches the model: Chinese, quotes and $ / % untouched, in this conversation\'s Space', trText.includes(`中文-OK:claude-web ${sid.slice(0, 8)} "引号" '单引号' $HOME %PATH%`) && !tr?.is_error, trText.slice(0, 400));
  check('… with the screenshot the script saved', Array.isArray(tr?.content) && tr.content.some((b) => b?.type === 'image'), JSON.stringify((tr?.content ?? []).map?.((b) => b?.type)));
  check('… and the turn ends normally', r?.subtype === 'success', r?.subtype);
  await req({ kind: 'session.close', sessionId: sid }).catch(() => {});

  // ---- 完全放开: ego_browser asks nothing, the script runs and its output comes back ----
  {
    const o3 = await req({ kind: 'session.open', params: { cwd: proj, providerId: A.id, model: 'claude-sonnet-4-6', permissionMode: 'bypassPermissions' } });
    const mark3 = hits.length;
    const from3 = events.length;
    const before = egoCalls().length;
    await req({ kind: 'session.send', params: { sessionId: o3.sessionId, text: 'EGO-GO open the page' } });
    const { r: r3, cards } = await runTurn(o3.sessionId, from3);
    check('完全放开: ego_browser raises no card at all (neither the server\'s nor Claude\'s)', cards.length === 0, cardBrief(cards));
    check('… the script runs in ego lite', egoCalls().length === before + 1, String(egoCalls().length - before));
    const tr3 = hits.slice(mark3).find((h) => h.main && h.toolResult)?.toolResult;
    check('… and its output reaches the model', textOf(tr3?.content).includes(OUTPUT(o3.sessionId)) && !tr3?.is_error && r3?.subtype === 'success', textOf(tr3?.content).slice(0, 300));
    await req({ kind: 'session.close', sessionId: o3.sessionId }).catch(() => {});
  }

  // ---- the built-in browser's browser_eval: one server card in default mode, none in 完全放开 ----
  for (const permissionMode of ['default', 'bypassPermissions']) {
    const o4 = await req({ kind: 'session.open', params: { cwd: proj, providerId: A.id, model: 'claude-sonnet-4-6', permissionMode } });
    const mark4 = hits.length;
    const from4 = events.length;
    await req({ kind: 'session.send', params: { sessionId: o4.sessionId, text: 'EVAL-GO run it' } });
    const { r: r4, cards } = await runTurn(o4.sessionId, from4);
    const server = cards.filter((c) => c.toolName === 'browser.site');
    const evals = events.slice(from4).filter((e) => e.kind === 'browser.command' && e.command.op === 'eval' && e.command.sessionId === o4.sessionId);
    const tr4 = hits.slice(mark4).find((h) => h.main && h.toolResult)?.toolResult;
    if (permissionMode === 'default') {
      // one card in the whole turn, the server's, for the script: Claude has browser_eval in its allowed tools (the
      // server asks), and nothing else on the way (a lookup) asks
      check('default: browser_eval raises exactly one card in the whole turn, the server\'s, for the script', cards.length === 1 && server.length === 1 && server[0].input?.op === 'eval' && server[0].input?.tool === 'browser_eval' && server[0].input?.script === EVAL_SCRIPT, cardBrief(cards));
    } else {
      check('完全放开: browser_eval raises no card at all', cards.length === 0, cardBrief(cards));
    }
    check(`… ${permissionMode}: the script reaches the window once and its result reaches the model`, evals.length === 1 && evals[0].command.args?.script === EVAL_SCRIPT && textOf(tr4?.content).includes('App EVAL-RAN') && !tr4?.is_error && r4?.subtype === 'success', JSON.stringify({ evals: evals.length, args: evals[0]?.command?.args, tr: textOf(tr4?.content).slice(0, 200) }));
    await req({ kind: 'session.close', sessionId: o4.sessionId }).catch(() => {});
  }

  // ---- 允许的网站 is the only say: Claude raises no card of its own for any browser tool ----
  for (const permissionMode of ['default', 'bypassPermissions']) {
    const o5 = await req({ kind: 'session.open', params: { cwd: proj, providerId: A.id, model: 'claude-sonnet-4-6', permissionMode } });
    await siteRule(check, permissionMode, [`open1-${runtime}.example`, `open2-${runtime}.example`, `open3-${runtime}.example`], claudeCall(o5.sessionId));
    await req({ kind: 'session.close', sessionId: o5.sessionId }).catch(() => {});
  }
  pageUrl = 'https://app.example/';

  // ---- 内置浏览器 picked: a new conversation has no ego tools ----
  await req({ kind: 'settings.set', key: 'web.browser.agent', value: 'builtin' });
  check('web.status says 内置浏览器', (await req({ kind: 'web.status' })).agentBrowser === 'builtin', '');
  const o2 = await req({ kind: 'session.open', params: { cwd: proj, providerId: A.id, model: 'claude-sonnet-4-6', permissionMode: 'default' } });
  const mark2 = hits.length;
  const from2 = events.length;
  await req({ kind: 'session.send', params: { sessionId: o2.sessionId, text: 'hello' } });
  await resultOf(o2.sessionId, from2);
  const h2 = hits.slice(mark2).find((h) => h.main);
  check('… then a new conversation has no ego tools (the built-in browser\'s are still there)', !!h2 && !h2.mentionsEgo && h2.tools.includes('mcp__web__browser_open'), JSON.stringify(h2?.tools?.filter((t) => /web__/.test(t))));
  await req({ kind: 'session.close', sessionId: o2.sessionId }).catch(() => {});
  await req({ kind: 'settings.set', key: 'web.browser.agent', value: null });
}

/** The `web` MCP server as an agent starts it for a conversation: a process, JSON-RPC lines over stdio. */
const mcps = [];
function startMcp(sid) {
  const entry = path.join(here, 'dist', 'web', 'mcp.js');
  const tokenFile = path.join(dataDir, 'runtime', 'web-mcp', `${server.pid}.token`);
  const p = spawn(process.execPath, [entry], { cwd: root, env: { ...env, CW_WEB_URL: `http://127.0.0.1:${port}`, CW_WEB_TOKEN_FILE: tokenFile, CW_SESSION_ID: sid, CW_WEB_BROWSER: 'ego' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  mcps.push(p);
  const replies = new Map();
  let buf = '';
  let id = 0;
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) { try { const m = JSON.parse(line); replies.set(m.id, m); } catch { /* not ours */ } }
    }
  });
  p.stderr.on('data', () => {});
  const send = (method, params = {}) => { const n = ++id; p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`); return n; };
  return { send, reply: (n) => replies.get(n), stop: () => { p.stdin.end(); setTimeout(() => p.kill(), 3000).unref?.(); } };
}

/**
 * 完全放开 puts the sites the built-in browser works on onto 允许的网站 (spec 14.4, last bullet): a click on a new site
 * in 完全放开 raises no card and the site lands on the list, marked as added by 完全放开; then a click on that site in
 * the default mode raises no card either — while a click on another new site there still does (the gate is live).
 * The clicks go through the real web MCP entry with each conversation's id, the way an agent's MCP process makes them.
 */
async function allowListSuite() {
  const check = (name, ok, detail) => checkRaw(`[允许的网站] ${name}`, ok, detail);
  const proj = path.join(root, 'proj-allow');
  fs.mkdirSync(proj, { recursive: true });
  const A = await req({ kind: 'providers.upsert', provider: { name: '中转allow', type: 'anthropic', baseUrl: up, apiKey: 'relay-key-e2e', defaultModel: 'claude-sonnet-4-6', models: ['claude-sonnet-4-6'] } });
  const SITE = 'shop-p40.example';
  const OTHER = 'other-p40.example';
  /** a conversation in `permissionMode` that has had a turn (so this server runs it and knows its mode) */
  const open = async (permissionMode) => {
    const o = await req({ kind: 'session.open', params: { cwd: proj, providerId: A.id, model: 'claude-sonnet-4-6', permissionMode } });
    const from = events.length;
    await req({ kind: 'session.send', params: { sessionId: o.sessionId, text: 'hello' } });
    await runTurn(o.sessionId, from);
    return o.sessionId;
  };
  /** `tool` through the web MCP entry; every card on the way is answered with `answer` */
  const call = async (sid, tool, args, answer = 'deny') => {
    const mcp = startMcp(sid);
    const from = events.length;
    const init = mcp.send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'phase40', version: '0' } });
    await until(() => mcp.reply(init), 30_000);
    const n = mcp.send('tools/call', { name: tool, arguments: args });
    const answered = new Set();
    const res = await until(() => {
      for (const rq of cardsOf(sid, from)) {
        if (answered.has(rq.requestId)) continue;
        answered.add(rq.requestId);
        void req({ kind: 'permission.respond', requestId: rq.requestId, response: answer === 'deny' ? { behavior: 'deny', message: 'no' } : { behavior: 'allow' } }).catch(() => {});
      }
      return mcp.reply(n);
    }, 120_000, 300);
    mcp.stop();
    const clicks = events.slice(from).filter((e) => e.kind === 'browser.command' && e.command.op === 'click' && e.command.sessionId === sid);
    return { res, cards: cardsOf(sid, from), clicks };
  };
  const sitesNow = async () => { const s = await req({ kind: 'settings.get' }); return { list: s['web.browser.allowedSites'] ?? [], auto: s['web.browser.allowedSitesAuto'] ?? [] }; };

  const before = await sitesNow();
  check('the site is not on the list to begin with', !before.list.includes(SITE) && !before.auto.includes(SITE), JSON.stringify(before));
  pageUrl = `https://${SITE}/cart`;
  const full = await open('bypassPermissions');
  const r1 = await call(full, 'browser_click', { ref: '1' });
  check('完全放开: a click on a new site raises no card at all, and reaches the page', r1.cards.length === 0 && r1.clicks.length === 1 && !r1.res?.result?.isError, JSON.stringify({ cards: cardBrief(r1.cards), clicks: r1.clicks.length, err: r1.res?.result?.isError ?? r1.res?.error }));
  const after = await until(async () => { const s = await sitesNow(); return s.list.includes(SITE) && s.auto.includes(SITE) ? s : null; }, 10_000, 200);
  check('… and the site is on 允许的网站, marked as added by 完全放开', !!after, JSON.stringify(after ?? await sitesNow()));
  await req({ kind: 'session.close', sessionId: full }).catch(() => {});

  const def = await open('default');
  const r2 = await call(def, 'browser_click', { ref: '2' });
  check('default mode: a click on that site raises no site card, and reaches the page', r2.cards.filter((c) => c.toolName === 'browser.site').length === 0 && r2.clicks.length === 1 && !r2.res?.result?.isError, JSON.stringify({ cards: cardBrief(r2.cards), clicks: r2.clicks.length }));
  pageUrl = `https://${OTHER}/`;
  await call(def, 'browser_read', {});
  const r3 = await call(def, 'browser_click', { ref: '3' }, 'deny');
  check('… while a click on another new site still raises the site card (declined: it does not reach the page)', r3.cards.filter((c) => c.toolName === 'browser.site' && c.input?.host === OTHER).length === 1 && r3.clicks.length === 0, JSON.stringify({ cards: cardBrief(r3.cards), clicks: r3.clicks.length }));
  const last = await sitesNow();
  check('… and default mode added nothing by itself', !last.list.includes(OTHER) && !last.auto.includes(OTHER), JSON.stringify(last));
  const gone = await req({ kind: 'web.allowedSites.remove', host: SITE });
  const now = await sitesNow();
  check('the 允许的网站 page removes it on the server: off the list and its mark', !gone.sites.includes(SITE) && !gone.auto.includes(SITE) && !now.list.includes(SITE) && !now.auto.includes(SITE), JSON.stringify({ gone, now }));
  await req({ kind: 'session.close', sessionId: def }).catch(() => {});
  pageUrl = 'https://app.example/';
}

try {
  await main();
} catch (e) {
  checkRaw('ran without throwing', false, e?.stack ?? String(e));
} finally {
  ws.close();
  for (const p of mcps) p.kill();
  const gone = new Promise((r) => server.once('exit', r));
  server.kill();
  upstream.close();
  await Promise.race([gone, new Promise((r) => setTimeout(r, 10_000))]);
  // the throwaway HOME, the fake ego-browser, the round files (Windows may hold a file a moment longer: retried)
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch (e) { console.log(`(could not remove ${root}: ${e.message})`); }
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\nphase40: ${results.length - failed}/${results.length} passed`);
  if (failed) console.log(slog.split('\n').slice(-30).join('\n'));
  process.exit(failed ? 1 : 0);
}
