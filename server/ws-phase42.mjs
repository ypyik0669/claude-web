// Phase 42 end-to-end (2026-10-30, 值班 Bot phase 1): a bot's whole life on a real server and our engine (ccb) against
// a fake Anthropic upstream — no tokens. Checks:
//   · bots.templates → 14; bots.create from the 'pr' template (cwd = a throwaway git repo, everyMinutes 60, no
//     precheck) → idle, and bots.list holds the 总管 and it;
//   · bots.runNow → a finished bots.run; bots.runs.list has it with a numeric costUsd; the inbox has a finding;
//   · the model asks for `Bash git push origin main` → the gate refuses it into the inbox as an approval (the model
//     sees the refusal); approving it starts a run with trigger 'resume' on the same conversation, where the very
//     same call passes (audit basis 'user');
//   · bots.unleash on → another run doing the push → no new approval (audit basis 'unleashed');
//   · bots.runNow while the upstream holds the turn, then bots.stop → that run ok false with a stop / timeout error,
//     bots.load running 0;
//   · deleting the 总管 throws; deleting the bot leaves only the 总管.
//   node server/ws-phase42.mjs   (starts its own server; scripts/e2e.mjs' port/token are ignored)
import WebSocket from 'ws';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-phase42-'));
const home = path.join(root, 'home');
const dataDir = path.join(home, '.claude-web');
const repo = path.join(root, 'repo');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(repo, { recursive: true });
// a repo with one commit and no remote: `git push origin main` fails locally, it never reaches a network
const git = (...a) => spawnSync('git', a, { cwd: repo, windowsHide: true, encoding: 'utf8' });
git('init', '-q', '-b', 'main');
fs.writeFileSync(path.join(repo, 'README.md'), '# e2e\n');
git('add', '.');
git('-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', 'commit', '-q', '-m', 'init');

const results = [];
const check = (name, ok, detail = '') => { results.push([name, !!ok]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const until = async (fn, ms, step = 200) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await new Promise((r) => setTimeout(r, step)); } };

// ---- the fake upstream ----
const PUSH = { command: 'git push origin main', description: 'push the fix' };
/** 'plain' = a report; 'push' = the model pushes; 'hold' = the turn never answers (for the hard stop) */
let mode = 'plain';
const mains = [];
const held = [];
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
const REPORT = '查了什么：打开的 PR 和 CI / 没能查到什么：无 / 建议的下一步：无';
// ---- a bot's own conversation (chat-first A): told apart by its system prompt, which explains <cw-bot-events> ----
const QUESTION = '你最想让我帮什么？';
const ANSWER = 'A 每天早上给我一份简报';
const ROUTINE = { name: '早间简报', prompt: '每个工作日早上 8 点看一眼仓库，写一份简报。', cron: '0 8 * * 1-5', until: 'forever' };
/** every request of the thread: { text (this turn's user text), toolResult?, kind } */
const threadReqs = [];
const isThreadReq = (j) => /cw-bot-events/.test(textOf(j.system));
/** the bot-self server is named per install (`cw-bot-<hex>`, kept in <data dir>/bots/self-server.json) */
const selfTool = (name) => `mcp__${JSON.parse(fs.readFileSync(path.join(dataDir, 'bots', 'self-server.json'), 'utf8')).name}__${name}`;
/** the tool_use the last tool_result answers */
const answeredTool = (j, tr) => {
  for (const m of [...(j.messages ?? [])].reverse()) {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    const u = m.content.find((b) => b?.type === 'tool_use' && b.id === tr.tool_use_id);
    if (u) return u;
  }
  return null;
};
function threadTurn(s, j, h) {
  const tr = lastToolResult(j);
  const text = turnText(j);
  // the engine's next-message suggestion is a side request on the same prompt: not a turn of the thread
  if (/\[SUGGESTION MODE:/.test(text)) return sse(s, j, [{ type: 'text', text: '' }], 'end_turn');
  const r = { text, at: Date.now() };
  threadReqs.push(r);
  if (tr) {
    const u = answeredTool(j, tr);
    r.toolResult = { name: u?.name, error: !!tr.is_error, text: textOf(tr.content) };
    // the bot makes the routine the user picked: by its own name when the request lists it (alwaysLoad), else the way
    // a model on our engine reaches a deferred tool — SearchExtraTools first, then ExecuteExtraTool (ccb runs a deferred
    // tool only after a search found it; without one it answers `result: null` and nothing runs)
    const RC = selfTool('routine_create');
    const direct = (j.tools ?? []).some((t) => t?.name === RC);
    const make = () => (direct
      ? { type: 'tool_use', id: `toolu_rc_${++n}`, name: RC, input: ROUTINE }
      : { type: 'tool_use', id: `toolu_rc_${++n}`, name: 'ExecuteExtraTool', input: { tool_name: RC, params: ROUTINE } });
    if (u?.name === 'AskUserQuestion') {
      r.kind = 'answered';
      r.direct = direct;
      r.tools = (j.tools ?? []).map((t) => t?.name);
      if (direct) return sse(s, j, [make()], 'tool_use');
      return sse(s, j, [{ type: 'tool_use', id: `toolu_search_${++n}`, name: 'SearchExtraTools', input: { query: `select:${RC}`, max_results: 3 } }], 'tool_use');
    }
    if (u?.name === 'SearchExtraTools') { r.kind = 'searched'; return sse(s, j, [make()], 'tool_use'); }
    r.kind = 'after-tool';
    return sse(s, j, [{ type: 'text', text: '好的，弄好了。' }], 'end_turn');
  }
  if (/cw-bot-kickoff/.test(text)) {
    r.kind = 'kickoff';
    return sse(s, j, [
      { type: 'text', text: '嗨，我是 晨报。我能每天替你盯着仓库。' },
      { type: 'tool_use', id: `toolu_ask_${++n}`, name: 'AskUserQuestion', input: { questions: [{ question: QUESTION, header: '帮什么', multiSelect: false, options: [
        { label: ANSWER, description: '工作日早上 8 点' },
        { label: 'B 盯着 CI', description: '红了叫你' },
        { label: 'C 看新的 PR', description: '有人提就说' },
        { label: 'D 整理 issue', description: '每周一次' },
      ] }] } },
    ], 'tool_use');
  }
  // asked to push, and again once told it was approved: the very same call (the thread gate lets it through once)
  if (/给我推一下|已批准「/.test(text)) { r.kind = /已批准「/.test(text) ? 'continue' : 'push'; return sse(s, j, [{ type: 'tool_use', id: `toolu_tpush_${++n}`, name: 'Bash', input: PUSH }], 'tool_use'); }
  r.kind = 'plain';
  return sse(s, j, [{ type: 'text', text: '在呢。' }], 'end_turn');
}
function anthropic(s, j, h) {
  if (h.url.includes('/count_tokens')) return json(s, 200, { input_tokens: 10 });
  if (!j.stream) return json(s, 200, { id: `msg_${++n}`, type: 'message', role: 'assistant', model: j.model, content: [{ type: 'text', text: 'side:ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 2 } });
  if (isThreadReq(j)) return threadTurn(s, j, h);
  const tr = lastToolResult(j);
  const text = turnText(j);
  h.mode = mode;
  mains.push(h);
  if (tr) { h.toolResult = { error: !!tr.is_error, text: textOf(tr.content) }; return sse(s, j, [{ type: 'text', text: REPORT }], 'end_turn'); }
  if (mode === 'hold') { held.push(s); return; } // answered never: the hard stop has to cut it
  // the run that asks, and the resumed one after the approval, make the very same call
  if (mode === 'push' || /已经批准/.test(text)) { h.sent = true; return sse(s, j, [{ type: 'tool_use', id: `toolu_push_${++n}`, name: 'Bash', input: PUSH }], 'tool_use'); }
  return sse(s, j, [{ type: 'text', text: REPORT }], 'end_turn');
}
const upstream = http.createServer((q, s) => {
  let raw = '';
  q.on('data', (c) => { raw += c; });
  q.on('end', () => {
    let j = {};
    try { j = JSON.parse(raw || '{}'); } catch { /* keep */ }
    const h = { url: q.url ?? '', model: j.model };
    if (h.url.startsWith('/v1/messages')) return anthropic(s, j, h);
    if (h.url.includes('/models')) return json(s, 200, { data: [{ id: 'claude-sonnet-4-6', type: 'model' }] });
    json(s, 404, { error: { message: 'no' } });
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const up = `http://127.0.0.1:${upstream.address().port}`;

// ---- the server: throwaway HOME ----
const token = randomBytes(16).toString('hex');
const env = { ...process.env, HOME: home, USERPROFILE: home, PORT: '0', CLAUDE_WEB_TOKEN: token, CLAUDE_WEB_DIR: dataDir, CW_NO_MODEL_REFRESH: '1', CW_NO_PUBLIC_BROKERS: '1', CLAUDE_WEB_SYSTEM_LANG: 'zh-CN' };
for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_CONFIG_DIR|OPENAI_)/.test(k) || /^(no_proxy|https?_proxy|all_proxy)$/i.test(k)) delete env[k];
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
const req = (r) => new Promise((res, rej) => { const id = String(++seq); pending.set(id, { res, rej }); ws.send(JSON.stringify({ type: 'request', request: { id, req: r } })); });
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type === 'reply') { const p = pending.get(m.reply.id); pending.delete(m.reply.id); m.reply.ok ? p.res(m.reply.data) : p.rej(new Error(m.reply.error)); return; }
  if (m.type === 'event') events.push(m.event);
});
/** the next finished run of `botId` after event index `from` */
const nextRun = (botId, from, ms = 180_000) => until(() => events.slice(from).find((e) => e.kind === 'bots.run' && e.run.botId === botId && e.run.endedAt)?.run, ms, 200);
const approvals = async (botId) => (await req({ kind: 'bots.inbox.list', botId })).filter((i) => i.kind === 'approval');

async function main() {
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  await req({ kind: 'settings.set', key: 'network.proxy', value: 'off' });
  const P = await req({ kind: 'providers.upsert', provider: { name: '中转e2e', type: 'anthropic', baseUrl: up, apiKey: 'sk-e2e', defaultModel: 'claude-sonnet-4-6', models: ['claude-sonnet-4-6'] } });
  // bots run on an API source, not the subscription
  await req({ kind: 'settings.set', key: 'bots.defaultProvider', value: P.id });

  // 1. templates
  const templates = await req({ kind: 'bots.templates' });
  check('bots.templates → 14', templates.length === 14, String(templates.length));

  // 2. create from 'pr'
  const t = templates.find((x) => x.id === 'pr');
  const draft = { ...JSON.parse(JSON.stringify(t.bot)), cwd: repo };
  draft.routines = draft.routines.map((r) => { const { precheck: _p, cron: _c, ...rest } = r; return { ...rest, everyMinutes: 60 }; });
  const bot = await req({ kind: 'bots.create', bot: draft });
  const rid = bot.routines[0]?.id;
  check('bots.create → idle, one routine every 60 minutes, no precheck', bot.state === 'idle' && bot.routines.length === 1 && bot.routines[0].everyMinutes === 60 && !bot.routines[0].precheck && !!rid, JSON.stringify({ state: bot.state, routines: bot.routines.map((r) => ({ id: r.id, everyMinutes: r.everyMinutes, precheck: r.precheck })) }));
  const list = await req({ kind: 'bots.list' });
  check('bots.list holds the 总管 and the new bot', list.length === 2 && list.some((b) => b.manager && b.id === 'manager') && list.some((b) => b.id === bot.id), JSON.stringify(list.map((b) => ({ id: b.id, manager: b.manager }))));

  // 3. a plain run
  mode = 'plain';
  let from = events.length;
  await req({ kind: 'bots.runNow', id: bot.id, routineId: rid });
  const r1 = await nextRun(bot.id, from);
  check('bots.runNow → a finished bots.run, ok', !!r1 && r1.ok === true && r1.trigger === 'manual' && !!r1.sessionId, JSON.stringify(r1 && { ok: r1.ok, trigger: r1.trigger, error: r1.error, said: r1.said?.slice(0, 80) }));
  const runs1 = await req({ kind: 'bots.runs.list', botId: bot.id });
  check('bots.runs.list → one run with a numeric costUsd', runs1.length === 1 && typeof runs1[0].costUsd === 'number', JSON.stringify(runs1.map((r) => ({ id: r.id, costUsd: r.costUsd }))));
  const inbox1 = await req({ kind: 'bots.inbox.list', botId: bot.id });
  check('the inbox has a finding (the report)', inbox1.some((i) => i.kind === 'finding' && i.runId === r1?.id && /查了什么/.test(i.body ?? '')), JSON.stringify(inbox1.map((i) => ({ kind: i.kind, title: i.title }))));

  // 4. a push asks; approving resumes the run that asked
  mode = 'push';
  from = events.length;
  let mark = mains.length;
  await req({ kind: 'bots.runNow', id: bot.id, routineId: rid });
  const r2 = await nextRun(bot.id, from);
  const ap = await approvals(bot.id);
  const asked = ap.find((i) => i.runId === r2?.id);
  check('a `git push` lands in the inbox as an approval', ap.length === 1 && !!asked && asked.toolName === 'Bash' && asked.input?.command === PUSH.command && asked.cls === 'send' && asked.sessionId === r2?.sessionId, JSON.stringify(ap.map((i) => ({ title: i.title, toolName: i.toolName, cls: i.cls, runId: i.runId }))));
  const refused = mains.slice(mark).find((h) => h.toolResult)?.toolResult;
  check('… the model got a refusal (the push did not run)', !!refused && /收件箱/.test(refused.text), JSON.stringify(refused));
  const audit2 = r2 ? await req({ kind: 'bots.runs.audit', botId: bot.id, runId: r2.id }) : [];
  check('… on record as queued', audit2.some((a) => a.toolName === 'Bash' && a.result === 'queued' && a.level === 'ask'), JSON.stringify(audit2.map((a) => ({ toolName: a.toolName, result: a.result, level: a.level }))));
  check('the bot needs attention', (await req({ kind: 'bots.get', id: bot.id })).state === 'attention');

  mode = 'plain'; // the resumed run makes the push again because it was told it was approved, not because of the mode
  from = events.length;
  mark = mains.length;
  await req({ kind: 'bots.inbox.answer', answer: { id: asked.id, answer: 'approve' } });
  const r3 = await nextRun(bot.id, from);
  check('approve → a new bots.run with trigger resume, on the same conversation', !!r3 && r3.trigger === 'resume' && r3.id !== r2?.id && r3.sessionId === r2?.sessionId, JSON.stringify(r3 && { trigger: r3.trigger, ok: r3.ok, error: r3.error, sessionId: r3.sessionId, asked: r2?.sessionId }));
  const audit3 = r3 ? await req({ kind: 'bots.runs.audit', botId: bot.id, runId: r3.id }) : [];
  check('… where the approved push passes (basis user)', audit3.some((a) => a.toolName === 'Bash' && a.result === 'allowed' && a.basis === 'user'), JSON.stringify(audit3.map((a) => ({ toolName: a.toolName, result: a.result, basis: a.basis }))));
  const ran = mains.slice(mark).find((h) => h.toolResult)?.toolResult;
  check('… and ran (no gate refusal reached the model)', !!ran && !/收件箱|策略/.test(ran.text), JSON.stringify(ran));
  check('… and no approval is left pending', (await approvals(bot.id)).length === 0);

  // 5. unleashed: the push runs without asking
  const u = await req({ kind: 'bots.unleash', id: bot.id, on: true });
  check('bots.unleash on', u.policy?.unleashed === true);
  mode = 'push';
  from = events.length;
  await req({ kind: 'bots.runNow', id: bot.id, routineId: rid });
  const r4 = await nextRun(bot.id, from);
  const ap4 = await approvals(bot.id);
  const audit4 = r4 ? await req({ kind: 'bots.runs.audit', botId: bot.id, runId: r4.id }) : [];
  check('unleashed → the push runs, no new approval', !!r4 && ap4.length === 0 && audit4.some((a) => a.toolName === 'Bash' && a.result === 'allowed' && a.basis === 'unleashed'), JSON.stringify({ approvals: ap4.length, audit: audit4.map((a) => ({ toolName: a.toolName, result: a.result, basis: a.basis })) }));
  await req({ kind: 'bots.unleash', id: bot.id, on: false });

  // 6. the hard stop, mid-turn
  mode = 'hold';
  from = events.length;
  mark = mains.length;
  await req({ kind: 'bots.runNow', id: bot.id, routineId: rid });
  const reached = await until(() => mains.slice(mark).some((h) => h.mode === 'hold'), 120_000);
  check('the held run reached the model', !!reached);
  const busy = await req({ kind: 'bots.load' });
  check('… bots.load counts it running', busy.running === 1, JSON.stringify(busy));
  await req({ kind: 'bots.stop', id: bot.id });
  const r5 = await nextRun(bot.id, from, 60_000);
  check('bots.stop → that run ok false, error says it was stopped', !!r5 && r5.ok === false && /超时|中断|停/.test(r5.error ?? ''), JSON.stringify(r5 && { ok: r5.ok, error: r5.error }));
  const load = await req({ kind: 'bots.load' });
  check('… bots.load.running 0', load.running === 0, JSON.stringify(load));
  mode = 'plain';

  // 7. delete
  let threw = '';
  try { await req({ kind: 'bots.delete', id: 'manager' }); } catch (e) { threw = e.message; }
  // the refusal itself (in either language), not any error: an unknown id would throw too
  check('deleting the 总管 is refused', /总管不能删除|manager can't be deleted/.test(threw), threw);
  await req({ kind: 'bots.delete', id: bot.id });
  const left = await req({ kind: 'bots.list' });
  check('deleting the bot leaves only the 总管', left.length === 1 && left[0].manager === true, JSON.stringify(left.map((b) => b.id)));

  await chatFirst();
}

/** chat-first A: a bot is a conversation — kickoff question, a routine it made itself, a thread approval, events told once */
async function chatFirst() {
  // 8. bots.start → its own conversation, kept out of the list
  let from = events.length;
  const b = await req({ kind: 'bots.start', name: '晨报', cwd: repo });
  const tid = b.threadId;
  check('bots.start → a bot with its own conversation (threadId)', !!tid && b.name === '晨报', JSON.stringify({ id: b.id, threadId: tid }));
  const listed = await req({ kind: 'sessions.list' });
  check('… which sessions.list does not show', !listed.some((x) => x.sessionId === tid), String(listed.length));
  // a fork / rewind of it would run as an ordinary, ungated copy: refused before the copy is made
  const copies = [];
  for (const r of [{ kind: 'session.open', params: { sessionId: tid, cwd: repo, fork: true } }, { kind: 'session.open', params: { sessionId: tid, cwd: repo, resumeAt: tid } }, { kind: 'library.fork', sessionId: tid }, { kind: 'session.open', params: { sessionId: tid.toUpperCase(), cwd: repo, fork: true } }, { kind: 'library.fork', sessionId: tid.toUpperCase() }]) {
    copies.push(await req(r).then((x) => `opened ${JSON.stringify(x?.sessionId ?? x)}`, (e) => /分叉|fork/i.test(String(e?.message ?? e)) ? 'refused' : `error ${e?.message ?? e}`));
  }
  check('… and can\'t be forked or rewound (session.open fork / resumeAt, library.fork; the id in upper case too)', copies.every((x) => x === 'refused'), JSON.stringify(copies));

  // 9. the kickoff spoke first: the AskUserQuestion card reaches the window (not the inbox)
  const ask = await until(() => events.slice(from).find((e) => e.kind === 'permission.request' && e.request.sessionId === tid && e.request.toolName === 'AskUserQuestion')?.request, 120_000);
  check('the kickoff asks with AskUserQuestion on the thread', !!ask && ask.input?.questions?.[0]?.question === QUESTION, JSON.stringify({ ask: !!ask, reqs: threadReqs.map((r) => r.kind) }));
  check('… and the kickoff text reached the model hidden in <cw-bot-kickoff>', threadReqs.some((r) => r.kind === 'kickoff'));
  check('… not as an inbox approval', (await approvals(b.id)).length === 0);
  if (!ask) return;
  await req({ kind: 'permission.respond', requestId: ask.requestId, response: { behavior: 'allow', updatedInput: { ...ask.input, answers: { [QUESTION]: ANSWER } } } });

  // 10. the bot makes the routine itself
  const made = await until(async () => (await req({ kind: 'bots.get', id: b.id })).routines.find((r) => r.name === ROUTINE.name), 120_000);
  const via = threadReqs.find((r) => r.kind === 'answered');
  const back = threadReqs.find((r) => r.kind === 'after-tool' && /routine_create|ExecuteExtraTool/.test(r.toolResult?.name ?? ''))?.toolResult;
  const found = threadReqs.find((r) => r.kind === 'searched')?.toolResult;
  check('the answer → the bot made 早间简报 itself (selfMade)', !!made && made.selfMade === true && made.cron === ROUTINE.cron, JSON.stringify({ made, direct: via?.direct, search: found?.text.slice(0, 300), tool: back }));
  // plan risk 11: the cw-bot tools are alwaysLoad, so the model sees them without searching (on ccb as on the binary)
  check('… the cw-bot tools were in the model\'s own tool list (alwaysLoad, not deferred)', via?.direct === true, `tools: ${via?.tools?.filter((x) => /^mcp__|ExtraTool/.test(x)).join(',')}`);
  check('… with an end (until)', !!made?.until, JSON.stringify(made && { until: made.until }));
  const rules = await until(async () => (await req({ kind: 'bots.inbox.list', botId: b.id })).find((i) => i.kind === 'proposal' && i.proposal?.type === 'rules'), 10_000);
  check('… and its first routine files the 规矩 card (a rules proposal)', !!rules);
  const tl = await req({ kind: 'bots.timeline.list', id: b.id });
  check('… bots.timeline.list has a system line 已创建例行', tl.some((e) => e.kind === 'system' && /已创建例行/.test(e.text ?? '')), JSON.stringify(tl.map((e) => ({ kind: e.kind, text: e.text }))));
  const day = (() => { const d = new Date(); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`; })();
  const auditOf = () => req({ kind: 'bots.runs.audit', botId: b.id, runId: `thread-${day}` });
  const a1 = await auditOf();
  check('… audited: mcp__cw-bot-<hex>__routine_create, basis rule', a1.some((a) => a.toolName === selfTool('routine_create') &&a.basis === 'rule' && a.result === 'allowed'), JSON.stringify(a1.map((a) => ({ toolName: a.toolName, basis: a.basis, result: a.result }))));
  await until(async () => !/running|waiting/.test((await req({ kind: 'bots.get', id: b.id })).activity ?? '') && threadReqs.at(-1)?.kind === 'after-tool', 30_000);

  // 11. the user asks for a push in the thread → a thread approval, on a card in the timeline
  const opened = await req({ kind: 'session.open', params: { sessionId: tid, cwd: repo } });
  check('session.open on the thread answers the thread', opened.sessionId === tid, JSON.stringify({ sessionId: opened.sessionId }));
  from = events.length;
  let mark = threadReqs.length;
  await req({ kind: 'session.send', params: { sessionId: tid, text: '给我推一下', uuid: crypto.randomUUID() } });
  const ap = await until(async () => (await approvals(b.id)).find((i) => i.toolName === 'Bash'), 120_000);
  check('「给我推一下」 → an approval with thread: true on the thread', !!ap && ap.thread === true && ap.sessionId === tid && ap.input?.command === PUSH.command, JSON.stringify(ap && { thread: ap.thread, sessionId: ap.sessionId, routineId: ap.routineId }));
  const pushReq = threadReqs.slice(mark).find((r) => r.kind === 'push');
  // the only thing new since the user last spoke is the 规矩 card routine_create filed (a proposal: told once, here);
  // the bot's own system line 已创建例行 stays out, and nothing about the push exists yet
  const ev = /^<cw-bot-events>\n([\s\S]*?)\n<\/cw-bot-events>/.exec(pushReq?.text.trimStart() ?? '')?.[1].split('\n') ?? [];
  check('… that turn told only the 规矩 card (no own system line, nothing about the push yet)', !!pushReq && ev.length === 1 && /提议等你看：规矩/.test(ev[0]) && pushReq.text.trimEnd().endsWith('给我推一下'), JSON.stringify(pushReq?.text.slice(0, 200)));
  const tl2 = await until(async () => (await req({ kind: 'bots.timeline.list', id: b.id })).find((e) => e.kind === 'approval' && e.itemId === ap?.id), 10_000);
  check('… and a timeline entry of kind approval holds it', !!tl2);
  const refused = await until(() => threadReqs.slice(mark).find((r) => r.toolResult?.name === 'Bash')?.toolResult, 30_000);
  check('… the model was told it waits for the user', !!refused && refused.error, JSON.stringify(refused));
  await until(() => threadReqs.at(-1)?.kind === 'after-tool', 30_000);

  // 12. approving it on the card: the thread is told 已批准 and the push passes this once (basis user)
  if (!ap) return;
  mark = threadReqs.length;
  await req({ kind: 'bots.inbox.answer', answer: { id: ap.id, answer: 'approve' } });
  const cont = await until(() => threadReqs.slice(mark).find((r) => r.kind === 'continue'), 60_000);
  check('approve → the thread\'s next request says 已批准', !!cont && /已批准/.test(cont.text), JSON.stringify(threadReqs.slice(mark).map((r) => r.kind)));
  const ran = await until(() => threadReqs.slice(mark).find((r) => r.toolResult?.name === 'Bash')?.toolResult, 60_000);
  check('… where the push ran (no gate refusal)', !!ran && !/收件箱|策略/.test(ran.text), JSON.stringify(ran));
  const a2 = await auditOf();
  check('… audited with basis user', a2.some((a) => a.toolName === 'Bash' && a.result === 'allowed' && a.basis === 'user'), JSON.stringify(a2.map((a) => ({ toolName: a.toolName, basis: a.basis, result: a.result }))));
  await until(() => threadReqs.at(-1)?.kind === 'after-tool', 30_000);
  await until(async () => (await req({ kind: 'session.info', sessionId: tid })).info?.state === 'idle', 30_000);

  // 13. the next thing the user says carries what happened since, once — the transcript keeps it, the UI strips it (T7)
  mark = threadReqs.length;
  const said = '今天怎么样';
  await req({ kind: 'session.send', params: { sessionId: tid, text: said, uuid: crypto.randomUUID() } });
  const next = await until(() => threadReqs.slice(mark).find((r) => r.kind === 'plain'), 60_000);
  check('a later message → the model gets <cw-bot-events> first, with 你批准了', !!next && next.text.trimStart().startsWith('<cw-bot-events>') && /你批准了/.test(next.text) && next.text.includes(said), JSON.stringify(next?.text.slice(0, 300)));
  await until(async () => (await req({ kind: 'session.info', sessionId: tid })).info?.state === 'idle', 30_000);
  const tx = await req({ kind: 'transcript.load', sessionId: tid });
  check('… and the transcript holds it', JSON.stringify(tx).includes('cw-bot-events'));

  // 14. deleting the bot removes its timeline with its folder
  const dir = path.join(dataDir, 'bots', b.id);
  const had = fs.existsSync(path.join(dir, 'timeline.jsonl'));
  await req({ kind: 'bots.delete', id: b.id });
  check('deleting the bot removes its folder and timeline.jsonl', had && !fs.existsSync(dir), JSON.stringify({ had }));
}

try {
  await main();
} catch (e) {
  check('ran without throwing', false, e?.stack ?? String(e));
} finally {
  ws.close();
  for (const s of held) { try { s.destroy(); } catch { /* gone */ } }
  const gone = new Promise((r) => server.once('exit', r));
  server.kill();
  upstream.close();
  upstream.closeAllConnections?.();
  await Promise.race([gone, new Promise((r) => setTimeout(r, 10_000))]);
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch (e) { console.log(`(could not remove ${root}: ${e.message})`); }
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\nphase42: ${results.length - failed}/${results.length} passed`);
  if (failed) console.log(slog.split('\n').slice(-40).join('\n'));
  process.exit(failed ? 1 : 0);
}
