// Stand-in for the `codex` / `gemini` / `qwen` config subcommands (`mcp add|remove|list`, `--version`), shaped
// after the real CLIs' --help (codex-cli 0.155, gemini 0.41, qwen-code 0.24). Which one it plays comes from
// CW_FAKE_AS (or argv[2] = `--as=<kind>`). Every call is appended to CW_FAKE_CLI_LOG as JSON (argv + the home
// variables it saw) so tests can assert the exact command shape. CW_FAKE_FAIL=1 → exit 1 with a message.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'smol-toml';

let argv = process.argv.slice(2);
let as = process.env.CW_FAKE_AS;
if (argv[0]?.startsWith('--as=')) { as = argv[0].slice(5); argv = argv.slice(1); }
if (process.env.CW_FAKE_CLI_LOG) {
  fs.appendFileSync(process.env.CW_FAKE_CLI_LOG, JSON.stringify({ as, argv, CODEX_HOME: process.env.CODEX_HOME, GEMINI_CLI_HOME: process.env.GEMINI_CLI_HOME, QWEN_HOME: process.env.QWEN_HOME, cwd: process.cwd() }) + '\n');
}
const die = (msg) => { process.stderr.write(msg + '\n'); process.exit(1); };
if (argv[0] === '--version') { console.log(`${as}-fake 9.9.9`); process.exit(0); }
if (process.env.CW_FAKE_FAIL) die(`Error: ${as} fake failure`);
if (argv[0] !== 'mcp') die(`unsupported: ${argv.join(' ')}`);
const sub = argv[1];
const rest = argv.slice(2);

if (as === 'codex') {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const file = path.join(home, 'config.toml');
  const read = () => (fs.existsSync(file) ? parse(fs.readFileSync(file, 'utf8')) : {});
  const write = (doc) => { fs.mkdirSync(home, { recursive: true }); fs.writeFileSync(file, stringify(doc) + '\n'); };
  if (sub === 'list') {
    if (!rest.includes('--json')) die('fake: only --json');
    const servers = read().mcp_servers ?? {};
    console.log(JSON.stringify(Object.entries(servers).sort(([a], [b]) => a.localeCompare(b)).map(([name, s]) => ({
      name, enabled: s.enabled !== false, disabled_reason: null,
      transport: s.url ? { type: 'streamable_http', url: s.url, bearer_token_env_var: s.bearer_token_env_var ?? null, http_headers: s.http_headers ?? null, env_http_headers: null } : { type: 'stdio', command: s.command, args: s.args ?? [], env: s.env ?? null, env_vars: [], cwd: null },
    })), null, 2));
  } else if (sub === 'add') {
    const name = rest[0];
    const s = {};
    const env = {};
    let i = 1;
    for (; i < rest.length; i++) {
      const a = rest[i];
      if (a === '--') { s.command = rest[i + 1]; s.args = rest.slice(i + 2); break; }
      if (a === '--env') { const [k, ...v] = rest[++i].split('='); env[k] = v.join('='); } else if (a === '--url') s.url = rest[++i];
      else if (a === '--bearer-token-env-var') s.bearer_token_env_var = rest[++i];
      else die(`error: unexpected argument '${a}'`);
    }
    if (!s.url && !s.command) die('error: the following required arguments were not provided: <COMMAND>');
    if (Object.keys(env).length) s.env = env;
    const doc = read();
    doc.mcp_servers = { ...(doc.mcp_servers ?? {}), [name]: s };
    write(doc);
    console.log(`Added global MCP server '${name}'.`);
  } else if (sub === 'remove') {
    const doc = read();
    if (!doc.mcp_servers?.[rest[0]]) { console.log(`No MCP server named '${rest[0]}' found.`); process.exit(0); }
    delete doc.mcp_servers[rest[0]];
    write(doc);
    console.log(`Removed global MCP server '${rest[0]}'.`);
  } else die(`unsupported: mcp ${sub}`);
} else if (as === 'gemini' || as === 'qwen') {
  const dir = as === 'gemini' ? path.join(process.env.GEMINI_CLI_HOME || os.homedir(), '.gemini') : (process.env.QWEN_HOME || path.join(os.homedir(), '.qwen'));
  const file = path.join(dir, 'settings.json');
  const read = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {});
  const write = (doc) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(doc, null, 2)); };
  const opts = { scope: as === 'qwen' ? 'user' : 'project', transport: 'stdio', env: [], header: [] };
  const pos = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (pos.length < 2 && (a === '-s' || a === '--scope')) opts.scope = rest[++i];
    else if (pos.length < 2 && (a === '-t' || a === '--transport')) opts.transport = rest[++i];
    else if (pos.length < 2 && (a === '-e' || a === '--env')) opts.env.push(rest[++i]);
    else if (pos.length < 2 && (a === '-H' || a === '--header')) opts.header.push(rest[++i]);
    else if (a === '--' && pos.length >= 2) continue;
    else pos.push(a);
  }
  if (opts.scope !== 'user') die('fake: tests must use --scope user');
  const doc = read();
  const servers = doc.mcpServers ?? {};
  if (sub === 'add') {
    const [name, target, ...args] = pos;
    if (!name || !target) die('Not enough non-option arguments');
    const headers = Object.fromEntries(opts.header.map((h) => { const [k, ...v] = h.split(':'); return [k.trim(), v.join(':').trim()]; }));
    const env = Object.fromEntries(opts.env.map((e) => { const [k, ...v] = e.split('='); return [k, v.join('=')]; }));
    const had = !!servers[name];
    if (opts.transport === 'stdio') servers[name] = { command: target, args, ...(opts.env.length ? { env } : {}) };
    else if (opts.transport === 'http') servers[name] = as === 'qwen' ? { httpUrl: target, headers } : { url: target, type: 'http', headers };
    else servers[name] = { url: target, headers };
    doc.mcpServers = servers;
    write(doc);
    console.log(had ? `MCP server "${name}" updated in user settings.` : `MCP server "${name}" added to user settings. (${opts.transport})`);
  } else if (sub === 'remove') {
    const [name] = pos;
    if (!servers[name]) { console.log(`Server "${name}" not found in user settings.`); process.exit(0); }
    delete servers[name];
    doc.mcpServers = servers;
    write(doc);
    console.log(`Server "${name}" removed from user settings.`);
  } else die(`unsupported: mcp ${sub}`);
} else die(`fake-cli: unknown CW_FAKE_AS ${as}`);
