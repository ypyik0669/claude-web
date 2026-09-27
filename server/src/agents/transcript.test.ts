import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentTranscripts } from './transcript.js';

let dir: string;
let prevEnv: string | undefined;
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cw-transcript-'));
  prevEnv = process.env.CLAUDE_WEB_DIR;
  process.env.CLAUDE_WEB_DIR = dir;
});
afterAll(async () => {
  if (prevEnv === undefined) delete process.env.CLAUDE_WEB_DIR; else process.env.CLAUDE_WEB_DIR = prevEnv;
  await fs.rm(dir, { recursive: true, force: true });
});

describe('AgentTranscripts', () => {
  it('patchHead does not drop lines appended concurrently', async () => {
    const t = new AgentTranscripts();
    const sid = 'aaaaaaaa-0000-0000-0000-000000000001';
    await t.create({ agent: 'gemini' as any, cwd: dir, title: '', createdAt: 1, sessionId: sid });
    for (let i = 0; i < 20; i++) {
      t.append(sid, { type: 'assistant', n: i });
      if (i % 5 === 0) void t.patchHead(sid, { model: `m${i}` });
    }
    await t.patchHead(sid, { nativeSessionId: 'native' });
    const msgs = await t.load(sid);
    expect(msgs.map((m) => m.n)).toEqual([...Array(20).keys()]);
    expect(await t.head(sid)).toMatchObject({ model: 'm15', nativeSessionId: 'native' });
  });
});
