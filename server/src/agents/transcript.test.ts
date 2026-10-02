import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentTranscripts } from './transcript.js';

describe('AgentTranscripts: a mirror parked on the hand-over back to Claude', () => {
  let tmp: string;
  const saved = { web: process.env.CLAUDE_WEB_DIR, cfg: process.env.CLAUDE_CONFIG_DIR };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-agent-tr-'));
    process.env.CLAUDE_WEB_DIR = path.join(tmp, 'web');
    process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
  });
  afterEach(() => {
    if (saved.web === undefined) delete process.env.CLAUDE_WEB_DIR; else process.env.CLAUDE_WEB_DIR = saved.web;
    if (saved.cfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved.cfg;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const head = { agent: 'codex' as const, cwd: 'C:/proj', title: '修一下登录', createdAt: 1, sessionId: 's1', nativeSessionId: 'thr-1' };

  it('stays listed, as Claude, until Claude has a transcript of its own', async () => {
    const t = new AgentTranscripts();
    await t.create(head);
    await t.park('s1');
    expect(await t.head('s1')).toBeNull(); // out of session.open's agent lookup
    const parked = await t.entries();
    expect(parked.map((e) => e.summary)).toEqual([expect.objectContaining({ sessionId: 's1', agent: 'claude', title: '修一下登录', cwd: 'C:/proj' })]);
    expect(parked[0].head).toEqual(expect.objectContaining({ agent: 'claude', nativeSessionId: undefined }));

    // the first Claude turn writes its transcript: from then on the Claude source lists it, not the parked mirror
    const proj = path.join(tmp, 'claude', 'projects', 'C--proj');
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, 's1.jsonl'), '{}\n');
    expect(await t.entries()).toEqual([]);
  });

  it('a mirror unparked for its agent again is listed once, as that agent', async () => {
    const t = new AgentTranscripts();
    await t.create(head);
    await t.park('s1');
    expect(await t.unpark('s1', 'codex')).toBe(true);
    expect((await t.entries()).map((e) => [e.summary.sessionId, e.summary.agent])).toEqual([['s1', 'codex']]);
  });
});
