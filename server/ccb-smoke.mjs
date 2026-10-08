import { query } from '@anthropic-ai/claude-agent-sdk';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const exe = process.argv[2] ?? fileURLToPath(new URL('../node_modules/claude-web-engine/dist/cli-node.js', import.meta.url));
const t0 = Date.now();
const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(1) + 's', ...a);
const q = query({
  prompt: 'Reply with exactly: pong from ccb',
  options: {
    cwd: 'C:\\Users\\YPY\\claude-web',
    model: 'haiku',
    maxTurns: 1,
    persistSession: false,
    settingSources: ['user', 'project', 'local'],
    pathToClaudeCodeExecutable: exe,
    stderr: (s) => log('[stderr]', s.trim().slice(0, 300)),
    spawnClaudeCodeProcess: (o) => { log('spawn', o.command, o.args.slice(0, 3).join(' ')); const c = spawn(o.command, o.args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, signal: o.signal }); c.on('exit', (code) => log('EXIT', code)); return c; },
  },
});
setTimeout(() => { log('timeout'); process.exit(2); }, 120000);
q.initializationResult().then((r) => log('initResult keys', Object.keys(r).join(','), 'commands', r.commands?.length, 'models', r.models?.length)).catch((e) => log('initErr', e.message));
for await (const m of q) {
  if (m.type === 'system' && m.subtype === 'init') log('init', m.model, 'cmds', m.slash_commands?.length, 'skills', m.skills?.length, 'mcp', m.mcp_servers?.length, 'ver', m.claude_code_version);
  else if (m.type === 'result') log('result', m.subtype, m.result, m.total_cost_usd);
  else if (m.type !== 'stream_event') log('msg', m.type, m.subtype ?? '');
}
log('done');
process.exit(0);
