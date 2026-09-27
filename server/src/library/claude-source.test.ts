// ClaudeSource wraps SessionService against a real (temporary) ~/.claude/projects tree — no mocking
// of the SDK itself, since CLAUDE_CONFIG_DIR is all that's needed to point it at a scratch directory.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let ClaudeSource: typeof import('./claude-source.js').ClaudeSource;
let SessionService: typeof import('../sessions/service.js').SessionService;
let tmpHome: string;
let sessionId: string;

beforeAll(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cw-claude-source-'));
  process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, '.claude');
  // The SDK's dir-scoped ops (rename/fork/delete/read-with-dir) resolve the project folder by
  // slugifying `cwd` the same way real Claude Code does — the folder name must match that slug,
  // not just contain the session file (listSessions()/getSessionInfo() scan every folder and don't
  // care, but the SessionsService mutation methods do).
  const cwd = '/work/demo';
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const projectDir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', slug);
  await fs.mkdir(projectDir, { recursive: true });

  sessionId = randomUUID();
  const userUuid = randomUUID();
  const assistantUuid = randomUUID();
  const lines = [
    {
      type: 'user', cwd, session_id: sessionId, uuid: userUuid, parentUuid: null,
      parent_tool_use_id: null, parent_agent_id: null, timestamp: new Date(0).toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: 'hello there' }] },
    },
    {
      type: 'assistant', cwd, session_id: sessionId, uuid: assistantUuid, parentUuid: userUuid,
      parent_tool_use_id: null, parent_agent_id: null, timestamp: new Date(1000).toISOString(),
      message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'hi!' }] },
    },
  ];
  await fs.writeFile(path.join(projectDir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');

  // Importing after CLAUDE_CONFIG_DIR is set: both modules compute their directory paths at
  // module-load time, so they must not be imported (even transitively) before this point.
  ({ ClaudeSource } = await import('./claude-source.js'));
  ({ SessionService } = await import('../sessions/service.js'));
});

afterAll(async () => {
  await fs.rm(tmpHome, { recursive: true, force: true });
});

describe('ClaudeSource (real SessionService over a scratch ~/.claude/projects)', () => {
  it('reports installed/joined/enabled — Claude is not part of the opt-in join flow', async () => {
    const src = new ClaudeSource(new SessionService());
    const status = await src.status();
    expect(status).toMatchObject({ kind: 'claude', installed: true, detected: true, joined: true, dismissed: false, enabled: true });
  });

  it('list() sees the session with its native UUID (no id transformation) and full caps', async () => {
    const src = new ClaudeSource(new SessionService());
    const { items, next } = await src.list({ limit: 10 });
    expect(next).toBeUndefined();
    const item = items.find((i) => i.sessionId === sessionId);
    expect(item).toBeTruthy();
    expect(item!.sessionId).toBe(sessionId); // plain UUID, not `claude-<uuid>` or anything else
    expect(item!.cwd).toBe('/work/demo');
    expect(item!.agent).toBe('claude');
    expect(item!.caps).toEqual({ resume: true, rename: true, archive: false, delete: true, fork: true });
  });

  it('read() returns the whole transcript in one page (no cursor/next)', async () => {
    const src = new ClaudeSource(new SessionService());
    const { messages, next } = await src.read(sessionId, { limit: 20 });
    expect(next).toBeUndefined();
    expect(messages.map((m: any) => m.type)).toEqual(['user', 'assistant']);
    expect(JSON.stringify(messages)).toContain('hello there');
    expect(JSON.stringify(messages)).toContain('hi!');
  });

  it('rename() renames via SessionService and is visible in a subsequent list()', async () => {
    const service = new SessionService();
    const src = new ClaudeSource(service);
    await src.rename!(sessionId, 'renamed title');
    const { items } = await src.list({ limit: 10 });
    const item = items.find((i) => i.sessionId === sessionId);
    expect(item?.title).toBe('renamed title');
  });

  it('fork() creates a new session with its own native UUID', async () => {
    const service = new SessionService();
    const src = new ClaudeSource(service);
    const newId = await src.fork!(sessionId);
    expect(newId).toBeTruthy();
    expect(newId).not.toBe(sessionId);
    const { items } = await src.list({ limit: 10 });
    expect(items.some((i) => i.sessionId === newId)).toBe(true);
  });

  it('remove() deletes the session so it no longer appears in list()', async () => {
    const service = new SessionService();
    const src = new ClaudeSource(service);
    const doomed = await src.fork!(sessionId);
    await src.remove!(doomed);
    const { items } = await src.list({ limit: 10 });
    expect(items.some((i) => i.sessionId === doomed)).toBe(false);
  });
});
