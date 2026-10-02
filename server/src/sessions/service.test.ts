// Fix round 1 (task-5): SessionsService.list() used to hardcode `listSessions({limit:2000})`
// regardless of the caller's own limit, so ClaudeSource asking for "everything" (100_000) could
// never see past 2000 sessions. This spies on the SDK's `listSessions` (via vi.mock + importOriginal
// — ESM named exports aren't directly vi.spyOn-able, "Module namespace is not configurable") to
// assert the limit actually passed downstream, and the caching behavior around it.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const calls: { limit?: number }[] = [];
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    listSessions: async (opts: any) => { calls.push(opts); return actual.listSessions(opts); },
  };
});

let SessionService: typeof import('./service.js').SessionService;
let tmpHome: string;

beforeAll(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cw-sessions-service-'));
  process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, '.claude');
  const projectDir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'demo');
  await fs.mkdir(projectDir, { recursive: true });
  const sid = '11111111-1111-1111-1111-111111111111';
  const line = { type: 'user', cwd: '/work/demo', session_id: sid, uuid: sid, parentUuid: null, parent_tool_use_id: null, parent_agent_id: null, timestamp: new Date(0).toISOString(), message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } };
  await fs.writeFile(path.join(projectDir, `${sid}.jsonl`), JSON.stringify(line) + '\n', 'utf8');
  ({ SessionService } = await import('./service.js'));
});

afterEach(() => { calls.length = 0; });

afterAll(async () => {
  await fs.rm(tmpHome, { recursive: true, force: true });
});

describe('SessionService.list() fetch limit', () => {
  it('asks the SDK for at least 2000 even when the caller wants fewer (default 500)', async () => {
    const svc = new SessionService();
    await svc.list();
    expect(calls).toHaveLength(1);
    expect(calls[0].limit).toBe(2000);
  });

  it('asks the SDK for the caller-requested limit when it exceeds 2000 (ClaudeSource wants "everything")', async () => {
    const svc = new SessionService();
    await svc.list(100_000);
    expect(calls).toHaveLength(1);
    expect(calls[0].limit).toBe(100_000);
  });

  it('reuses the cache for a second call within the cached limit — no second SDK call', async () => {
    const svc = new SessionService();
    await svc.list(10);
    await svc.list(10);
    expect(calls).toHaveLength(1); // second call served from cache
  });

  it('re-scans when a later call asks for more than the cached limit', async () => {
    const svc = new SessionService();
    await svc.list(5); // fetchLimit = max(2000, 5) = 2000
    expect(calls).toHaveLength(1);
    expect(calls[0].limit).toBe(2000);
    await svc.list(5_000); // exceeds the cached 2000 -> must re-scan
    expect(calls).toHaveLength(2);
    expect(calls[1].limit).toBe(5_000);
  });
});

describe('which conversation a write under ~/.claude/projects belongs to', () => {
  it('a transcript names its conversation; project dirs, sub-agent logs and memory do not', async () => {
    const { transcriptIdOf } = await import('./service.js');
    expect(transcriptIdOf('C--work-demo/11111111-1111-1111-1111-111111111111.jsonl')).toBe('11111111-1111-1111-1111-111111111111');
    expect(transcriptIdOf('C--work-demo\\11111111-1111-1111-1111-111111111111.jsonl')).toBe('11111111-1111-1111-1111-111111111111');
    expect(transcriptIdOf('C--work-demo')).toBeNull();
    expect(transcriptIdOf('C--work-demo/1111/subagents/agent-x.jsonl')).toBeNull();
    expect(transcriptIdOf('C--work-demo/memory/notes.md')).toBeNull();
  });

  it('a CLI writing a transcript: one "transcripts" event names it (an open view re-reads it)', async () => {
    const svc = new SessionService();
    try {
      const got = new Promise<string[]>((res) => svc.once('transcripts', res));
      await new Promise((r) => setTimeout(r, 300)); // the recursive watch is up
      const sid = '22222222-2222-2222-2222-222222222222';
      await fs.appendFile(path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', 'demo', `${sid}.jsonl`), '{"type":"user"}\n', 'utf8');
      const ids = await Promise.race([got, new Promise<string[]>((_, rej) => setTimeout(() => rej(new Error('no transcripts event')), 5000))]);
      expect(ids).toContain(sid);
    } finally {
      svc.close?.();
    }
  });
});

describe('forkTitle', () => {
  it('one (分叉) mark, however deep', async () => {
    const { forkTitle } = await import('./service.js');
    expect(forkTitle('修 bug')).toBe('修 bug (分叉)');
    expect(forkTitle('修 bug (分叉)')).toBe('修 bug (分叉)');
    expect(forkTitle('修 bug (分叉) (分叉)')).toBe('修 bug (分叉)');
    expect(forkTitle('')).toBe('(分叉)');
  });
});

describe('listTitle', () => {
  it('a hand-over briefing is never a conversation title', async () => {
    const { listTitle } = await import('./service.js');
    const brief = '# 会话交接 这个会话之前由 **Codex** 在跑，现在交给你（Claude Code）继续。';
    expect(listTitle({ sessionId: 's1', summary: brief, firstPrompt: '修一下登录页' })).toBe('修一下登录页');
    expect(listTitle({ sessionId: 's1', summary: brief, firstPrompt: brief })).toBe('交接的对话');
    expect(listTitle({ sessionId: 's1', customTitle: '我起的名字', summary: brief })).toBe('我起的名字');
    expect(listTitle({ sessionId: 's1', summary: '最后一句', firstPrompt: '第一句' })).toBe('最后一句');
    expect(listTitle({ sessionId: '24f2b165-07d7' })).toBe('24f2b165');
  });
});
