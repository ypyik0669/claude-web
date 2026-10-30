// The duty service's entry (duty.ts serverEntry): while another live server holds the data dir it exits at once with
// BUSY_EXIT — before loading the whole server, since its loop starts it every 30 s while the app is open. Otherwise it
// loads the server (index.ts runs as the main module under CLAUDE_WEB_STANDALONE=1, and takes the lock itself).
import path from 'node:path';
import { BUSY_EXIT, liveHolder, processLockEnv, rotateLog } from './server-lock.js';

const dir = process.env.CLAUDE_WEB_DIR;
if (dir) rotateLog(path.join(dir, 'duty.log')); // launchd appends to it for good (a BUSY line every 30 s while the app is open)
const holder = dir ? await liveHolder(dir, processLockEnv()) : null; // a ready lock is asked on its port: a dead server's pid reused by another program doesn't block
if (holder) {
  console.log(`[duty] ${new Date().toISOString()} another claude-web (pid ${holder.pid}, ${holder.kind}) serves this data dir; trying again later`);
  process.exit(BUSY_EXIT);
}
await import('../index.js');
