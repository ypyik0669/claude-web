// Real-machine check of 自动压缩 (2026-11-19 user reports: 「窗口显示 100%，但是他还在跑」, GPT on a relay): spends a
// few real tokens. Like real-subagent-split.mjs: its own server on a copy of the user's meta.json (keys are DPAPI-
// encrypted for this Windows user, so the copy decrypts) in a temp CLAUDE_WEB_DIR, real HOME, a temp project that is
// removed afterwards with its ~/.claude/projects entry. Never writes to ~/.claude-web.
// The copy gives <model> a small window, so one Read of a big file takes the conversation over the engine's
// autocompact threshold; the script reports what the engine and the server said: each answer's usage, every
// compact_boundary, the result's modelUsage window and the info the composer's ring divides by.
//   node scripts/real-autocompact.mjs <providerId> <model> [window=80000]
import WebSocket from 'ws';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const [providerId, model, windowArg] = process.argv.slice(2);
if (!providerId || !model) { console.error('usage: <providerId> <model> [window]'); process.exit(2); }
const win = Number(windowArg || 80000);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-real-compact-'));
const dataDir = path.join(tmp, 'data');
const proj = path.join(tmp, 'proj');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(proj, { recursive: true });
// ~1500 lines of varied words: one Read puts tens of thousands of tokens into the context
const words = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu'.split(' ');
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; };
const lines = [];
for (let i = 1; i <= 1500; i++) lines.push(`${String(i).padStart(4, '0')} ` + Array.from({ length: 12 }, () => words[rnd() % words.length] + (rnd() % 97)).join(' '));
fs.writeFileSync(path.join(proj, 'big.txt'), lines.join('\n') + '\n');

const meta = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude-web', 'meta.json'), 'utf8'));
// AGENT=codex: a Codex conversation on the same profile (Codex gets the profile's default model's window, so the model
// becomes the default too)
const agent = process.env.AGENT || 'claude';
const providers = (meta.providers ?? []).map((p) => (p.id === providerId ? { ...p, contextWindows: { ...(p.contextWindows ?? {}), [model]: win }, compactAt: undefined, ...(agent === 'codex' ? { defaultModel: model } : {}) } : p));
if (!providers.some((p) => p.id === providerId)) { console.error('no provider', providerId); process.exit(2); }
fs.writeFileSync(path.join(dataDir, 'meta.json'), JSON.stringify({ version: meta.version, providers, settings: { 'network.proxy': meta.settings?.['network.proxy'] ?? 'system', 'ui.disabledModels': meta.settings?.['ui.disabledModels'] } }));

const token = randomBytes(12).toString('hex');
const keep = new Set(['CLAUDE_WEB_TOKEN', 'CLAUDE_WEB_DIR']);
const env = { ...process.env, PORT: '0', CLAUDE_WEB_TOKEN: token, CLAUDE_WEB_DIR: dataDir, CW_NO_MODEL_REFRESH: '1', CW_NO_PUBLIC_BROKERS: '1' };
for (const k of Object.keys(env)) if ((/^(CLAUDE|ANTHROPIC)/.test(k) && !keep.has(k)) || k === 'ELECTRON_RUN_AS_NODE') delete env[k];
// CLEAN_CODEX=1: Codex with an empty CODEX_HOME — no config.toml of the user's (their own compaction limit, MCP servers,
// skills) — as most people run it; its rollout then lands in the temp folder and is read back below
const codexHome = process.env.CLEAN_CODEX ? path.join(tmp, 'codex-home') : null;
if (codexHome) { fs.mkdirSync(codexHome, { recursive: true }); env.CODEX_HOME = codexHome; }
// AUTOCOMPACT=<tokens>: a config folder of its own whose settings.json holds only the official CLI's /autocompact point
// (autoCompactWindow) — not the user's settings.json, whose CLAUDE_CODE_AUTO_COMPACT_WINDOW would rank above it
if (process.env.AUTOCOMPACT) {
  const cfg = path.join(tmp, 'cfg');
  fs.mkdirSync(cfg, { recursive: true });
  fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify({ autoCompactWindow: Number(process.env.AUTOCOMPACT) }));
  env.CLAUDE_CONFIG_DIR = cfg;
}
const server = spawn(process.execPath, [path.join(root, 'server', 'dist', 'index.js')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let slog = '';
server.stderr.on('data', (d) => { slog += d; });
const port = await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`server did not start\n${slog}`)), 60_000);
  server.stdout.on('data', (d) => { slog += d; const m = /listening on http:\/\/[^:]+:(\d+)/.exec(slog); if (m) { clearTimeout(t); res(m[1]); } });
});
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
let seq = 0;
const pending = new Map();
const events = [];
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type === 'reply') { const p = pending.get(m.reply.id); pending.delete(m.reply.id); m.reply.ok ? p.res(m.reply.data) : p.rej(new Error(m.reply.error)); return; }
  if (m.type === 'event') events.push({ at: Date.now(), ...m.event });
});
const req = (r) => new Promise((res, rej) => { const id = String(++seq); pending.set(id, { res, rej }); ws.send(JSON.stringify({ type: 'request', request: { id, req: r } })); });
const until = async (fn, ms, step = 500) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await new Promise((r) => setTimeout(r, step)); } };
const tot = (u) => (u ? (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0) : 0);

let sid = '';
const turn = async (label, text) => {
  const from = events.length;
  await req({ kind: 'session.send', params: { sessionId: sid, text } });
  const result = await until(() => events.slice(from).find((e) => e.kind === 'session.event' && e.sessionId === sid && e.message?.type === 'result')?.message, 600_000);
  console.log(`\n== ${label}: result ${result?.subtype ?? 'none (timeout)'}${result?.is_error ? ' ERROR' : ''}`);
  for (const e of events.slice(from)) {
    if ((e.sessionId ?? e.info?.sessionId) !== sid) continue;
    const m = e.message;
    if (e.kind === 'session.event' && m?.type === 'assistant' && !m.parent_tool_use_id) {
      const u = m.message?.usage;
      const kinds = (m.message?.content ?? []).map((b) => b.type === 'tool_use' ? `tool_use:${b.name}` : b.type).join(',');
      console.log(`  assistant ${m.message?.model} [${kinds}] usage total=${tot(u)} (in ${u?.input_tokens} cr ${u?.cache_read_input_tokens} cw ${u?.cache_creation_input_tokens} out ${u?.output_tokens})`);
    } else if (e.kind === 'session.event' && m?.type === 'system' && m.subtype === 'compact_boundary') {
      console.log(`  COMPACT_BOUNDARY ${JSON.stringify(m.compact_metadata ?? m)}`);
    } else if (e.kind === 'session.event' && m?.type === 'system' && m.subtype === 'status') {
      console.log(`  status ${JSON.stringify(m.status ?? m)}`);
    } else if (e.kind === 'session.event' && m?.type === 'system' && m.subtype !== 'init') {
      console.log(`  system/${m.subtype} ${JSON.stringify(m).slice(0, 200)}`);
    } else if (e.kind === 'session.info' || e.kind === 'info') {
      const i = e.info ?? e;
      console.log(`  info contextWindow=${i.contextWindow} compactWindow=${i.compactWindow} model=${i.model}`);
    }
  }
  if (result?.modelUsage) for (const [k, v] of Object.entries(result.modelUsage)) console.log(`  modelUsage[${k}] contextWindow=${v.contextWindow} maxOutputTokens=${v.maxOutputTokens}`);
  console.log(`  result.result: ${String(result?.result ?? '').slice(0, 160).replace(/\n/g, ' ')} | num_turns ${result?.num_turns}`);
  const users = events.slice(from).filter((e) => e.kind === 'session.event' && e.sessionId === sid && e.message?.type === 'user' && !e.message.parent_tool_use_id);
  for (const u of users) { const c = u.message.message?.content; const t = typeof c === 'string' ? c : (c ?? []).map((b) => b.type === 'text' ? b.text : b.type).join(' '); if (u.message.isCompactSummary || /summary|continued from a previous/i.test(t)) console.log(`  user (compact summary=${!!u.message.isCompactSummary}): ${t.slice(0, 120).replace(/\n/g, ' ')}`); }
  const texts = events.slice(from).filter((e) => e.kind === 'session.event' && e.sessionId === sid && e.message?.type === 'assistant' && !e.message.parent_tool_use_id).flatMap((e) => (e.message.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text)).join(' ').slice(0, 200);
  console.log(`  text: ${texts}`);
  return result;
};

try {
  const o = await req({ kind: 'session.open', params: { cwd: proj, providerId, model, permissionMode: 'bypassPermissions', ...(agent === 'codex' ? { agent: 'codex' } : {}) } });
  sid = o.sessionId;
  console.log('opened', sid, 'runtime', o.info?.runtime, 'model', o.info?.model, 'window set', win, 'info.contextWindow', o.info?.contextWindow, 'compactWindow', o.info?.compactWindow);
  // a big tool result is folded by the engine (a 500-line Read added ~900 tokens): the text goes in the user's own
  // message instead, which is kept as it is — PASTE lines of it (default 700, ~30K tokens)
  // MODE=midturn: a little pasted data, then one turn that writes it out three times — each Write's content is the
  // answer's own output, which stays in the context, so the threshold is crossed in the middle of a running turn
  if (process.env.MODE === 'midturn') {
    const paste = lines.slice(0, Number(process.env.PASTE || 150)).join('\n');
    await turn('turn 1 (a short paste)', `Here is some data. Do not use any tool; just reply with exactly: OK1\n\n${paste}`);
    await turn('turn 2 (three Writes in one turn)', 'Use the Write tool three times, one after another, with no text in between: copy1.txt, then copy2.txt, then copy3.txt, each containing every line of the data I sent, exactly as sent. After the third Write, reply with exactly: DONE');
    await turn('turn 3', 'Reply with exactly: OK3');
  } else if (agent === 'codex') {
    // Codex: past its window it compacts at the next turn; then the user's /compact (thread/compact/start)
    const paste = lines.slice(0, Number(process.env.PASTE || 900)).join('\n');
    await turn('turn 1 (a long pasted message)', `Here is some data. Do not use any tool; just reply with exactly: OK1\n\n${paste}`);
    await turn('turn 2', 'Reply with exactly: OK2');
    await turn('turn 3 (/compact)', '/compact');
    await turn('turn 4', 'Without using any tool: what is the first word on line 0001 of the data I sent? One short line.');
  } else {
    const paste = lines.slice(0, Number(process.env.PASTE || 700)).join('\n');
    await turn('turn 1 (a long pasted message)', `Here is some data. Do not use any tool; just reply with exactly: OK1\n\n${paste}`);
    await turn('turn 2', 'Reply with exactly: OK2');
    await turn('turn 3', 'Without using any tool: what is the first word on line 0001 of the data I sent? One short line.');
    await turn('turn 4', 'Reply with exactly: DONE');
  }
} catch (e) {
  console.log('error', e.message);
} finally {
  console.log('\n-- server log (tail) --');
  console.log(slog.split('\n').filter((l) => /compact|window|error|warn/i.test(l)).slice(-25).join('\n').replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***'));
  // what Codex itself recorded: each call's context (last), its window, and every compaction
  if (codexHome) {
    const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : []);
    for (const f of walk(path.join(codexHome, 'sessions')).filter((f) => f.endsWith('.jsonl'))) {
      console.log(`\n-- codex rollout ${path.basename(f)} --`);
      for (const l of fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
        let j; try { j = JSON.parse(l); } catch { continue; }
        if (j.type === 'compacted') console.log('  COMPACTED');
        if (j.payload?.type === 'token_count' && j.payload.info) console.log(`  token_count last ${j.payload.info.last_token_usage?.total_tokens} window ${j.payload.info.model_context_window}`);
      }
    }
  }
  if (sid) await req({ kind: 'session.close', sessionId: sid }).catch(() => {});
  ws.close();
  server.kill();
  // Codex can hold the project folder for a moment after it is told to close
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try { fs.rmSync(tmp, { recursive: true, force: true }); break; } catch (e) { if (i === 9) console.log('could not remove', tmp, e.code); }
  }
  const projects = path.join(os.homedir(), '.claude', 'projects');
  for (const d of fs.existsSync(projects) ? fs.readdirSync(projects) : []) if (d.includes('cw-real-compact-')) fs.rmSync(path.join(projects, d), { recursive: true, force: true });
}
