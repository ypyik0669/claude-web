import fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { CanonicalLog } from './canonical.js';

describe('CanonicalLog.ensure', () => {
  it('a second ensure does not truncate events already appended', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cw-canon-'));
    const prev = process.env.CLAUDE_WEB_DIR;
    process.env.CLAUDE_WEB_DIR = dir; // read at construction; keep the test out of the real ~/.claude-web
    const log = new CanonicalLog();
    if (prev === undefined) delete process.env.CLAUDE_WEB_DIR;
    else process.env.CLAUDE_WEB_DIR = prev;
    const sid = `test-${randomUUID()}`;
    try {
      await log.ensure(sid, '/x');
      log.observe(sid, { type: 'user', message: { content: 'hello' } });
      // let the queued append land, then race a re-open of the same session
      await log.settled(sid);
      // simulate the race window: another ensure already passed its exists() check before the file appeared
      const exists = log.exists.bind(log);
      log.exists = async () => false;
      await log.ensure(sid, '/x');
      log.exists = exists;
      const events = await log.load(sid);
      expect(events.map((e) => e.kind)).toEqual(['user']);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
