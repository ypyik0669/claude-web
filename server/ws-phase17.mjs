// Phase 17 end-to-end: the other agents' configuration center (agentConfig.*) over the hub.
// Boots its OWN server (the CLIs are looked up on the server's PATH): throwaway HOME + a temp bin dir at the
// front of PATH holding fake `codex` / `gemini` executables — npm-shaped `.cmd` shims on Windows (so
// resolveSpawn's shim unwrapping is exercised), `#!/bin/sh` wrappers elsewhere — around
// src/agent-config/__mocks__/fake-cli.mjs, which records every argv. Then: detection, Claude MCP listing
// (masked), add, sync to codex + gemini + opencode, duplicate refusal, settings writes with backups,
// restore, remove, instruction-file creation. No model calls, no real ~/.codex / ~/.gemini.
//   node server/ws-phase17.mjs        (scripts/e2e.mjs passes [port] [token]; they're ignored here)
import WebSocket from 'ws';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fake = path.join(here, 'src', 'agent-config', '__mocks__', 'fake-cli.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-phase17-'));
const home = path.join(root, 'home');
const bin = path.join(root, 'bin');
const log = path.join(root, 'calls.jsonl');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(bin, { recursive: true });

for (const as of ['codex', 'gemini']) {
  fs.writeFileSync(path.join(bin, `${as}.mjs`), `process.env.CW_FAKE_AS = ${JSON.stringify(as)};\nawait import(${JSON.stringify(pathToFileURL(fake).href)});\n`);
  if (process.platform === 'win32') {
    // the shape npm's cmd-shim writes (see agents/resolve.test.ts)
    fs.writeFileSync(path.join(bin, `${as}.cmd`), ['@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '', 'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '', `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${as}.mjs" %*`, ''].join('\r\n'));
  } else {
    fs.writeFileSync(path.join(bin, as), `#!/bin/sh\nexec "${process.execPath}" "${path.join(bin, `${as}.mjs`)}" "$@"\n`, { mode: 0o755 });
  }
}

const token = randomBytes(12).toString('hex');
const env = { ...process.env, HOME: home, USERPROFILE: home, PORT: '0', CLAUDE_WEB_TOKEN: token, CLAUDE_WEB_DIR: path.join(home, '.claude-web'), PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, CW_FAKE_CLI_LOG: log };
for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_)/.test(k) || ['CODEX_HOME', 'GEMINI_CLI_HOME', 'QWEN_HOME', 'XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR'].includes(k)) delete env[k];
// Windows env names are case-insensitive but spread copies may carry `Path` as well as `PATH`
for (const k of Object.keys(env)) if (k !== 'PATH' && k.toUpperCase() === 'PATH') delete env[k];

const server = spawn(process.execPath, [path.join(here, 'dist', 'index.js')], { cwd: path.dirname(here), env, stdio: ['ignore', 'pipe', 'pipe'] });
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
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type === 'reply') { const p = pending.get(m.reply.id); pending.delete(m.reply.id); m.reply.ok ? p.res(m.reply.data) : p.rej(new Error(m.reply.error)); }
});
const req = (r) => new Promise((res, rej) => { const id = String(++seq); pending.set(id, { res, rej }); ws.send(JSON.stringify({ type: 'request', request: { id, req: r } })); });
const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const codexToml = path.join(home, '.codex', 'config.toml');
const geminiJson = path.join(home, '.gemini', 'settings.json');
const opencodeJson = path.join(home, '.config', 'opencode', 'opencode.json');

async function main() {
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });

  // warm the registry's install probe first: a cold one can take longer than the 3 s agentConfig waits for
  await req({ kind: 'agents.list', refresh: true });
  const list = await req({ kind: 'agentConfig.list', cwd: root });
  const cx = list.find((s) => s.kind === 'codex');
  const gm = list.find((s) => s.kind === 'gemini');
  check('list: fake codex / gemini detected through the PATH shims', cx?.installed && gm?.installed && /fake/.test(cx.version), `${cx?.version} / ${gm?.version}`);
  check('list: file paths follow the temp HOME', cx?.configPath === codexToml && gm?.configPath === geminiJson && list.find((s) => s.kind === 'opencode')?.configPath === opencodeJson, cx?.configPath);
  check('list: project instruction files for the cwd', cx?.files.some((f) => f.path === path.join(root, 'AGENTS.md') && !f.exists) && gm?.files.some((f) => f.path === path.join(root, 'GEMINI.md')));
  check('list: codex settings table', ['model', 'model_reasoning_effort', 'approval_policy', 'sandbox_mode'].every((k) => cx?.settings.some((f) => f.key === k)));

  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { gh: { type: 'http', url: 'https://gh.example/mcp', headers: { Authorization: 'Bearer ghp_secret' } }, fs: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\My Docs'], env: { ROOT_TOKEN: 'tok_secret' } } } }));
  const claude = await req({ kind: 'agentConfig.claudeMcp' });
  const gh = claude.find((e) => e.spec.name === 'gh');
  check('claudeMcp: lists Claude servers with secrets masked', gh?.spec.headers?.Authorization === '••••••' && !JSON.stringify(claude).includes('secret'), JSON.stringify(gh?.spec));

  await req({ kind: 'agentConfig.mcp.add', agent: 'codex', spec: { name: 'files', transport: 'stdio', command: 'npx', args: ['-y', 'pkg', 'C:\\a b'], env: { K: 'v' } } });
  const add = calls().filter((c) => c.as === 'codex' && c.argv[1] === 'add').at(-1);
  check('mcp.add codex: `codex mcp add <name> --env K=V -- <cmd> <args>`', JSON.stringify(add?.argv) === JSON.stringify(['mcp', 'add', 'files', '--env', 'K=v', '--', 'npx', '-y', 'pkg', 'C:\\a b']), JSON.stringify(add?.argv));

  const sync = await req({ kind: 'agentConfig.mcp.sync', source: { claude: 'gh' }, targets: ['codex', 'gemini', 'opencode'] });
  check('mcp.sync: Claude gh → codex + gemini + opencode all ok', sync.length === 3 && sync.every((r) => r.ok), sync.map((r) => `${r.agent}:${r.ok}`).join(' '));
  const toml = fs.readFileSync(codexToml, 'utf8');
  check('sync codex: header written as http_headers table', /\[mcp_servers\.gh\.http_headers\]/.test(toml) && toml.includes('Bearer ghp_secret'));
  const gAdd = calls().find((c) => c.as === 'gemini' && c.argv[1] === 'add');
  check('sync gemini: `gemini mcp add -s user -t http -H … gh <url>` with the real header value', JSON.stringify(gAdd?.argv) === JSON.stringify(['mcp', 'add', '-s', 'user', '-t', 'http', '-H', 'Authorization: Bearer ghp_secret', 'gh', 'https://gh.example/mcp']), JSON.stringify(gAdd?.argv));
  const oc = JSON.parse(fs.readFileSync(opencodeJson, 'utf8'));
  check('sync opencode: structured mcp entry', oc.mcp?.gh?.type === 'remote' && oc.mcp.gh.url === 'https://gh.example/mcp');

  const again = await req({ kind: 'agentConfig.mcp.sync', source: { claude: 'gh' }, targets: ['codex', 'gemini'] });
  check('mcp.sync again: refused per target without overwrite', again.every((r) => !r.ok && /已存在/.test(r.message)), again.map((r) => r.message).join(' | '));
  const over = await req({ kind: 'agentConfig.mcp.sync', source: { claude: 'fs' }, targets: ['gemini', 'codex'], overwrite: true });
  check('mcp.sync stdio with env (overwrite)', over.every((r) => r.ok), over.map((r) => r.message).join(' | '));

  const cx2 = await req({ kind: 'agentConfig.get', agent: 'codex' });
  check('get codex: list via `codex mcp list --json`, masked', ['files', 'gh', 'fs'].every((n) => cx2.mcp.some((m) => m.name === n)) && cx2.mcp.find((m) => m.name === 'gh').headers?.Authorization === '••••••', cx2.mcp.map((m) => m.name).join(','));

  const before = fs.readFileSync(codexToml, 'utf8');
  const b1 = await req({ kind: 'agentConfig.set', agent: 'codex', key: 'model', value: 'gpt-5-codex' });
  const after = fs.readFileSync(codexToml, 'utf8');
  check('set codex model: only one line added, backup taken', after.includes('model = "gpt-5-codex"') && after.replace('model = "gpt-5-codex"\n', '').replace(/^\n/, '') === before.replace(/^\n/, '') && !!b1?.id, b1?.id);
  await req({ kind: 'agentConfig.set', agent: 'gemini', key: 'model.name', value: 'gemini-2.5-flash' });
  check('set gemini model.name', JSON.parse(fs.readFileSync(geminiJson, 'utf8')).model?.name === 'gemini-2.5-flash');
  const bad = await req({ kind: 'agentConfig.set', agent: 'codex', key: 'approval_policy', value: 'sometimes' }).then(() => 'accepted', (e) => e.message);
  check('set: enum values validated', /只能是/.test(bad), bad);

  const backups = await req({ kind: 'agentConfig.backups' });
  // files that did not exist yet (opencode.json before the first sync) have nothing to back up
  check('backups: every write to an existing file backed up', backups.length >= 5 && backups.some((b) => b.agent === 'gemini') && backups.some((b) => b.agent === 'codex') && backups.every((b) => b.agent !== 'opencode'), `${backups.length} backups`);
  await req({ kind: 'agentConfig.restore', id: b1.id });
  check('restore: codex config back to before the model write', fs.readFileSync(codexToml, 'utf8') === before);

  await req({ kind: 'agentConfig.mcp.remove', agent: 'gemini', name: 'gh' });
  const gm2 = await req({ kind: 'agentConfig.get', agent: 'gemini' });
  check('mcp.remove gemini: `gemini mcp remove -s user gh`', !gm2.mcp.some((m) => m.name === 'gh') && JSON.stringify(calls().at(-1).argv) === JSON.stringify(['mcp', 'remove', '-s', 'user', 'gh']));
  const rmMissing = await req({ kind: 'agentConfig.mcp.remove', agent: 'codex', name: 'nope' }).then(() => 'removed', (e) => e.message);
  check('mcp.remove of a missing name is an error', /没有名为 nope/.test(rmMissing), rmMissing);

  const created = await req({ kind: 'agentConfig.createFile', agent: 'codex', path: path.join(root, 'AGENTS.md'), cwd: root });
  check('createFile: project AGENTS.md', fs.existsSync(created) && created === path.join(root, 'AGENTS.md'));
  const evil = await req({ kind: 'agentConfig.createFile', agent: 'codex', path: path.join(root, 'x.txt'), cwd: root }).then(() => 'created', (e) => e.message);
  check('createFile: refuses paths the adapter does not list', /不是/.test(evil), evil);

  check('fake CLIs only ever saw the temp HOME', calls().every((c) => !c.CODEX_HOME && !c.GEMINI_CLI_HOME), `${calls().length} calls`);
}

let code = 0;
try { await main(); } catch (e) { console.error('ERROR', e); code = 1; }
ws.close();
server.kill();
await new Promise((r) => setTimeout(r, 500));
try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows may still hold a handle */ }
const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(code || failed.length ? 1 : 0);
