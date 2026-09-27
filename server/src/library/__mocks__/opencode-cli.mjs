#!/usr/bin/env node
// Fake `opencode` CLI for OpenCodeSource tests: understands `serve` (prints the real listening line
// and idles, optionally after a delay so tests can exercise the ensure()/close() race), `session
// --help`, and `session delete <id>` — controlled by env vars so one script covers every case the
// tests need.
import fs from 'node:fs';

const argv = process.argv.slice(2);

if (argv[0] === 'serve') {
  if (process.env.FAKE_PID_FILE) fs.writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
  const delay = Number(process.env.FAKE_SERVE_DELAY_MS ?? '0');
  setTimeout(() => { process.stdout.write('opencode server listening on http://127.0.0.1:65530\n'); }, delay);
  setInterval(() => {}, 1000); // stay alive until the test kills us, like the real server would
} else if (argv[0] === 'session' && argv[1] === '--help') {
  const lines = [
    'opencode session',
    '',
    'manage sessions',
    '',
    'Commands:',
    '  opencode session list                list sessions',
  ];
  if (process.env.FAKE_HAS_DELETE === '1') lines.push('  opencode session delete <sessionID>  delete a session');
  process.stdout.write(lines.join('\n') + '\n');
  process.exit(0);
} else if (argv[0] === 'session' && argv[1] === 'delete') {
  if (process.env.FAKE_ARGV_FILE) fs.writeFileSync(process.env.FAKE_ARGV_FILE, JSON.stringify(argv));
  const code = Number(process.env.FAKE_EXIT_CODE ?? '0');
  if (code !== 0) process.stderr.write('fake delete failure\n');
  process.exit(code);
} else {
  process.stderr.write(`unhandled args: ${argv.join(' ')}\n`);
  process.exit(1);
}
