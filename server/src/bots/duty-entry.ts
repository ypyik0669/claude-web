// The duty service's entry (duty.ts serverEntry): while another live server holds the data dir it exits at once with
// BUSY_EXIT — before loading the whole server, since its loop starts it every 30 s while the app is open. Otherwise it
// loads the server (index.ts runs as the main module under CLAUDE_WEB_STANDALONE=1, and takes the lock itself).
import path from 'node:path';
import { BUSY_EXIT, dutyMayStart, processLockEnv, rotateLog } from './server-lock.js';

const dir = process.env.CLAUDE_WEB_DIR;
if (dir) rotateLog(path.join(dir, 'duty.log')); // launchd appends to it for good (a BUSY line every 30 s while the app is open)
// a ready lock is asked on its port (a dead server's pid reused by another program doesn't block); one that doesn't
// answer is taken only on the second look, 30 s later (an app whose event loop stalled a moment keeps its dir)
const { start, holder } = dir ? await dutyMayStart(dir, processLockEnv()) : { start: true, holder: undefined };
if (!start && holder) {
  console.log(`[duty] ${new Date().toISOString()} another claude-web (pid ${holder.pid}, ${holder.kind}) serves this data dir; trying again later`);
  process.exit(BUSY_EXIT);
}
await import('../index.js');
