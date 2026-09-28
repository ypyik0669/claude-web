// End-to-end suite: boots the built server against a throwaway HOME (so ~/.claude-web and ~/.claude are
// never touched) and runs the WebSocket checks that need no model and no network login.
//   npm run build:all && node scripts/e2e.mjs [phase…]
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// phase1 needs a real Claude session (manual); phase7 needs `gh auth login` or GH_TOKEN (CI passes it explicitly)
const phases = process.argv.slice(2).length ? process.argv.slice(2) : ['3', '4', '5', '6', '11', '12', '13', '14', '15', '16', '17'];
const home = mkdtempSync(path.join(os.tmpdir(), 'cw-e2e-'));
const token = randomBytes(12).toString('hex');
const env = { ...process.env, HOME: home, USERPROFILE: home, PORT: '0', CLAUDE_WEB_TOKEN: token, CLAUDE_WEB_DIR: path.join(home, '.claude-web') };
for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_)/.test(k)) delete env[k];

const server = spawn(process.execPath, [path.join(root, 'server', 'dist', 'index.js')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
server.stderr.on('data', (d) => { log += d; });
const port = await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`server did not start in 60s\n${log}`)), 60_000);
  server.stdout.on('data', (d) => {
    log += d;
    const m = /listening on http:\/\/[^:]+:(\d+)/.exec(log);
    if (m) { clearTimeout(t); res(m[1]); }
  });
  server.on('exit', (c) => rej(new Error(`server exited (${c})\n${log}`)));
});
console.log(`server on :${port} (HOME=${home})`);

const PHASE_TIMEOUT_MS = Number(process.env.E2E_PHASE_TIMEOUT_MS ?? 300_000);
let failed = [];
for (const p of phases) {
  console.log(`\n===== phase ${p} =====`);
  const serverLogFrom = log.length;
  const started = Date.now();
  // streamed as before (the concise PASS lines), and kept: a failure / timeout reprints it with the server log
  let out = '';
  const { code, timedOut } = await new Promise((res) => {
    const c = spawn(process.execPath, [path.join(root, 'server', `ws-phase${p}.mjs`), port, token], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    c.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
    c.stderr.on('data', (d) => { out += d; process.stderr.write(d); });
    let timedOut = false;
    const t = setTimeout(() => { timedOut = true; c.kill(); }, PHASE_TIMEOUT_MS);
    c.on('exit', (code) => { clearTimeout(t); res({ code, timedOut }); });
  });
  if (code !== 0) {
    failed.push(p);
    const why = timedOut ? `TIMED OUT after ${Math.round((Date.now() - started) / 1000)}s` : `exit ${code} after ${Math.round((Date.now() - started) / 1000)}s`;
    console.log(`\n----- phase ${p} FAILED (${why}): full output -----\n${out || '(no output)'}`);
    const serverTail = log.slice(serverLogFrom).split('\n').slice(-80).join('\n');
    console.log(`----- server log during phase ${p} (last 80 lines) -----\n${serverTail || '(nothing)'}\n----- end phase ${p} -----`);
  }
}
server.kill();
await new Promise((r) => setTimeout(r, 500));
try { rmSync(home, { recursive: true, force: true }); } catch { /* windows may still hold a handle */ }
console.log(failed.length ? `\nFAILED phases: ${failed.join(', ')}` : `\nall ${phases.length} phases passed`);
process.exit(failed.length ? 1 : 0);
