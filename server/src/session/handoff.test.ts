import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CanonicalLog, type CanonicalEvent } from './canonical.js';
import { renderBriefing, toClaudeEntries } from './handoff.js';

const sdk = {
  user: (text: string) => ({ type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'text', text }] } }),
  assistantText: (text: string) => ({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text }] } }),
  // a real turn interleaves thinking, which must never reach the timeline
  assistantThinking: (t: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: t, signature: 'sig-abc' }] } }),
  toolUse: (id: string, name: string, input: unknown) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }),
  toolResult: (id: string, text: string, isError = false) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: [{ type: 'text', text }] }] } }),
  result: (extra: Record<string, unknown> = {}) => ({ type: 'result', duration_ms: 1200, usage: { input_tokens: 10, output_tokens: 20 }, ...extra }),
};

describe('CanonicalLog', () => {
  let dir: string;
  let prev: string | undefined;
  let log: CanonicalLog;

  beforeEach(async () => {
    prev = process.env.CLAUDE_WEB_DIR;
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cw-canon-'));
    process.env.CLAUDE_WEB_DIR = dir;
    log = new CanonicalLog();
    await log.ensure('s1', '/repo');
  });
  afterEach(async () => {
    if (prev === undefined) delete process.env.CLAUDE_WEB_DIR;
    else process.env.CLAUDE_WEB_DIR = prev;
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
  });

  const settle = () => new Promise((r) => setTimeout(r, 60));

  it('pairs a tool call with its result and drops thinking', async () => {
    log.observe('s1', sdk.user('修一下登录'));
    log.observe('s1', sdk.assistantThinking('这里有一堆带签名的推理'));
    log.observe('s1', sdk.toolUse('t1', 'Edit', { file_path: '/repo/src/auth.ts' }));
    log.observe('s1', sdk.toolResult('t1', 'ok'));
    log.observe('s1', sdk.assistantText('改好了'));
    log.observe('s1', sdk.result());
    await settle();

    const events = await log.load('s1');
    expect(events.map((e) => e.kind)).toEqual(['user', 'tool', 'assistant', 'result']);
    const tool = events.find((e) => e.kind === 'tool') as Extract<CanonicalEvent, { kind: 'tool' }>;
    expect(tool.name).toBe('Edit');
    expect(tool.ok).toBe(true);
    // the signature-bearing thinking block must not be anywhere in the file
    expect(JSON.stringify(events)).not.toContain('sig-abc');
  });

  it('records a tool that never returned rather than silently dropping it', async () => {
    log.observe('s1', sdk.toolUse('t9', 'Bash', { command: 'npm test' }));
    log.observe('s1', sdk.result({ is_error: true, result: 'interrupted' }));
    await settle();

    const events = await log.load('s1');
    const tool = events.find((e) => e.kind === 'tool') as Extract<CanonicalEvent, { kind: 'tool' }>;
    expect(tool.ok).toBe(false);
    expect(events.find((e) => e.kind === 'result')).toMatchObject({ error: 'interrupted' });
  });

  it('never writes for a session that was never opened', async () => {
    log.observe('ghost', sdk.user('hi'));
    await settle();
    expect(await log.exists('ghost')).toBe(false);
  });
});

describe('renderBriefing', () => {
  const events: CanonicalEvent[] = [
    { t: 1, kind: 'user', text: '把登录改成 OAuth' },
    { t: 2, kind: 'tool', id: 'a', name: 'Edit', input: { file_path: '/repo/src/auth.ts' }, ok: true },
    { t: 3, kind: 'tool', id: 'b', name: 'Edit', input: { file_path: '/repo/src/auth.ts' }, ok: true },
    { t: 4, kind: 'tool', id: 'c', name: 'Bash', input: { command: 'npm test' }, ok: false, result: '2 failing' },
    { t: 5, kind: 'tool', id: 'd', name: 'Read', input: { file_path: '/repo/README.md' }, ok: true },
    { t: 6, kind: 'assistant', text: '测试还有两个没过' },
    { t: 7, kind: 'result', ms: 900 },
  ];

  it('reports disk state, failures and the last reply — not a transcript dump', () => {
    const b = renderBriefing(events, { fromAgent: 'codex', toAgent: 'claude', cwd: '/repo' });
    expect(b.filesTouched).toEqual(['/repo/src/auth.ts']);
    expect(b.text).toContain('把登录改成 OAuth');
    expect(b.text).toContain('/repo/src/auth.ts');
    expect(b.text).toContain('改了 2 次');
    expect(b.text).toContain('npm test');
    expect(b.text).toContain('2 failing');
    expect(b.text).toContain('测试还有两个没过');
    // it must tell the receiving agent that reasoning did not come along
    expect(b.text).toMatch(/推理|签名/);
  });

  it('synthesizes resumable Claude entries with an unbroken parent chain', () => {
    const rows = toClaudeEntries(events, { cwd: '/repo', sessionId: 's1' });
    expect(rows.length).toBeGreaterThan(1);
    expect(rows[0].parentUuid).toBeNull();
    for (let i = 1; i < rows.length; i++) expect(rows[i].parentUuid).toBe(rows[i - 1].uuid);
    expect(rows.every((r) => r.sessionId === 's1' && r.cwd === '/repo')).toBe(true);
    expect(rows.map((r) => r.type)).toContain('user');
    expect(rows.map((r) => r.type)).toContain('assistant');
  });

  it('uses the briefing form when one is supplied', () => {
    const rows = toClaudeEntries(events, { cwd: '/repo', sessionId: 's1', briefing: '# 会话交接\n状态如下' });
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows[0])).toContain('会话交接');
  });
});
