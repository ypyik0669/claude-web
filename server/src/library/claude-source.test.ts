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
let prevWebDir: string | undefined;

beforeAll(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cw-claude-source-'));
  process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, '.claude');
  prevWebDir = process.env.CLAUDE_WEB_DIR;
  process.env.CLAUDE_WEB_DIR = path.join(tmpHome, 'claude-web'); // never the real ~/.claude-web
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
  if (prevWebDir === undefined) delete process.env.CLAUDE_WEB_DIR; else process.env.CLAUDE_WEB_DIR = prevWebDir;
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

  it('LibraryService.remove backs up the raw jsonl AND the <id>/ dir (subagents) before deleting', async () => {
    const { LibraryService } = await import('./service.js');
    const { LibraryIndex } = await import('./index-db.js');
    const { AgentTranscripts } = await import('../agents/transcript.js');
    const { MetaStore } = await import('../meta/store.js');
    const service = new SessionService();
    const src = new ClaudeSource(service);
    const doomed = await src.fork!(sessionId);
    const file = await service.locate(doomed);
    expect(file).toBeTruthy();
    const sideDir = path.join(path.dirname(file!), doomed);
    await fs.mkdir(path.join(sideDir, 'subagents'), { recursive: true });
    await fs.writeFile(path.join(sideDir, 'subagents', 'agent-abc.jsonl'), '{"type":"user","sidechain":true}\n', 'utf8');
    const raw = await fs.readFile(file!, 'utf8');

    const webDir = path.join(tmpHome, 'claude-web');
    const trash = path.join(webDir, 'library-trash');
    const index = new LibraryIndex(path.join(webDir, 'library.db'));
    const meta = new MetaStore(path.join(webDir, 'meta.json'));
    await meta.load();
    const lib = new LibraryService([src], index, new AgentTranscripts(), meta, { dataDirs: {}, trashDir: trash });
    try {
      const r = await lib.remove([doomed]);
      expect(r.failed).toEqual([]);
      expect(r.removed).toEqual([doomed]);
      const proj = path.basename(path.dirname(file!));
      expect(await fs.readFile(path.join(trash, doomed, proj, `${doomed}.jsonl`), 'utf8')).toBe(raw);
      expect(await fs.readFile(path.join(trash, doomed, proj, doomed, 'subagents', 'agent-abc.jsonl'), 'utf8')).toContain('sidechain');
      await expect(fs.access(file!)).rejects.toThrow();
      await expect(fs.access(sideDir)).rejects.toThrow();
    } finally {
      lib.dispose();
      index.close();
    }
  });

  it('a Claude session whose raw backup cannot be made is not deleted', async () => {
    const { LibraryService } = await import('./service.js');
    const { LibraryIndex } = await import('./index-db.js');
    const { AgentTranscripts } = await import('../agents/transcript.js');
    const { MetaStore } = await import('../meta/store.js');
    const service = new SessionService();
    const src = new ClaudeSource(service);
    const keep = await src.fork!(sessionId);
    const webDir = path.join(tmpHome, 'claude-web-2');
    await fs.mkdir(webDir, { recursive: true });
    const trash = path.join(webDir, 'library-trash');
    await fs.writeFile(trash, 'not a directory', 'utf8'); // makes every backup write fail
    const index = new LibraryIndex(path.join(webDir, 'library.db'));
    const meta = new MetaStore(path.join(webDir, 'meta.json'));
    await meta.load();
    const lib = new LibraryService([src], index, new AgentTranscripts(), meta, { dataDirs: {}, trashDir: trash });
    try {
      const r = await lib.remove([keep]);
      expect(r.removed).toEqual([]);
      expect(r.failed.map((f) => f.id)).toEqual([keep]);
      expect(await service.locate(keep)).toBeTruthy();
    } finally {
      lib.dispose();
      index.close();
    }
  });
});
