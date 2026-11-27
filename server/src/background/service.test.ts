import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackgroundService, KEEP_ENDED_MS, KEEP_TASK_MS, handleBackground, isBackgroundRequest, isTaskGone } from './service.js';
import type { BgHistoryPage, BgSession } from './types.js';

const sys = (subtype: string, o: Record<string, unknown>) => ({ type: 'system', subtype, uuid: 'u', session_id: 's', ...o });

function setup() {
  let now = 1_000_000;
  const pool = new EventEmitter();
  const svc = new BackgroundService({ pool: pool as any, now: () => now, flushMs: 1000 });
  const pushes: BgSession[] = [];
  svc.on('changed', (s: BgSession) => pushes.push(s));
  return { pool, svc, pushes, tick: (ms: number) => { now += ms; vi.advanceTimersByTime(ms); } };
}

afterEach(() => { vi.useRealTimers(); });

describe('BackgroundService', () => {
  it('pushes the first change at once and gathers the rest for a second', () => {
    vi.useFakeTimers();
    const { pool, svc, pushes, tick } = setup();
    pool.emit('message', 's1', sys('task_started', { task_id: 'a1', description: 'x', task_type: 'local_agent' }));
    expect(pushes.length).toBe(1);
    for (let i = 1; i <= 5; i++) pool.emit('message', 's1', sys('task_progress', { task_id: 'a1', usage: { total_tokens: i, tool_uses: i, duration_ms: 1 }, summary: `s${i}` }));
    expect(pushes.length).toBe(1);
    tick(1000);
    expect(pushes.length).toBe(2);
    expect(pushes[1].tasks[0].agents[0].lastSummary).toBe('s5');
    // not a task message: nothing
    pool.emit('message', 's1', { type: 'assistant' });
    pool.emit('message', 's1', sys('init', {}));
    tick(2000);
    expect(pushes.length).toBe(2);
    expect(svc.hasRunning('s1')).toBe(true);
    svc.dispose();
  });

  it('an ended task leaves the snapshot after a minute; a conversation with nothing left is pushed empty and dropped', () => {
    vi.useFakeTimers();
    const { pool, svc, pushes, tick } = setup();
    pool.emit('message', 's1', sys('task_started', { task_id: 'a1', description: 'x', task_type: 'local_agent' }));
    pool.emit('message', 's1', sys('task_started', { task_id: 'a2', description: 'y', task_type: 'local_agent' }));
    tick(1000);
    pool.emit('message', 's1', sys('task_notification', { task_id: 'a1', status: 'completed' }));
    tick(1000);
    expect(svc.list()[0].tasks.map((t) => t.id)).toEqual(['a1', 'a2']);
    tick(KEEP_TASK_MS);
    expect(svc.list()[0].tasks.map((t) => t.id)).toEqual(['a2']);
    expect(pushes.at(-1)!.tasks.map((t) => t.id)).toEqual(['a2']);
    pool.emit('message', 's1', sys('task_notification', { task_id: 'a2', status: 'failed' }));
    tick(KEEP_TASK_MS + 5000);
    expect(pushes.at(-1)).toMatchObject({ sessionId: 's1', tasks: [] });
    expect(svc.list()).toEqual([]);
    svc.dispose();
  });

  it('a process that ends takes its background with it', () => {
    vi.useFakeTimers();
    const { pool, svc, pushes, tick } = setup();
    pool.emit('message', 's1', sys('task_started', { task_id: 'wf', description: 'x', task_type: 'local_workflow' }));
    tick(5000);
    pool.emit('state', 's1', 'idle');
    expect(pushes.length).toBe(1);
    pool.emit('state', 's1', 'closed');
    expect(pushes.length).toBe(2);
    expect(pushes[1].tasks[0]).toMatchObject({ status: 'stopped', reason: '进程结束了' });
    expect(svc.hasRunning('s1')).toBe(false);
    // a conversation with nothing in the background: nothing to say
    pool.emit('state', 's2', 'closed');
    expect(pushes.length).toBe(2);
    svc.dispose();
  });

  it('lists conversations with background work; ended ones go after a day', () => {
    vi.useFakeTimers();
    const { pool, svc, tick } = setup();
    pool.emit('message', 's1', sys('task_started', { task_id: 'a1', description: 'x', task_type: 'local_agent' }));
    pool.emit('message', 's2', sys('task_started', { task_id: 'b1', description: 'y', task_type: 'local_bash' }));
    pool.emit('message', 's2', sys('task_notification', { task_id: 'b1', status: 'completed', summary: '', output_file: '' }));
    expect(svc.list().map((s) => s.sessionId).sort()).toEqual(['s1', 's2']);
    tick(KEEP_ENDED_MS + 1000);
    expect(svc.list().map((s) => s.sessionId)).toEqual(['s1']);
    svc.dispose();
  });

  it('跑过的 leaves out what still runs (it is 在跑); once it ended it is there', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'cw-bg-svc-'));
    try {
      const sid = 'dddddddd-0000-4000-8000-00000000000d';
      const proj = path.join(root, 'C--w');
      mkdirSync(proj);
      const at = new Date(1_700_000_000_000).toISOString();
      const base = { sessionId: sid, cwd: 'C:\\w', isSidechain: false, timestamp: at };
      writeFileSync(path.join(proj, `${sid}.jsonl`), [
        { ...base, type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_s', name: 'Bash', input: { command: 'npx serve', description: 'serve it', run_in_background: true } }] } },
        { ...base, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_s', content: 'started' }] }, toolUseResult: { backgroundTaskId: 'bsrv00001' } },
      ].map((l) => JSON.stringify(l)).join('\n') + '\n');
      const pool = new EventEmitter();
      const svc = new BackgroundService({ pool: pool as any, historyRoots: () => [{ dir: root }] });
      expect(isBackgroundRequest({ kind: 'background.historyAll' })).toBe(true);
      pool.emit('message', sid, sys('task_started', { task_id: 'bsrv00001', description: 'serve it', task_type: 'local_bash' }));
      expect(((await handleBackground(svc, { kind: 'background.historyAll' })) as BgHistoryPage).items).toEqual([]);
      pool.emit('message', sid, sys('task_notification', { task_id: 'bsrv00001', status: 'completed' }));
      const page = (await handleBackground(svc, { kind: 'background.historyAll', limit: 5 })) as BgHistoryPage;
      expect(page.items.map((i) => [i.kind, i.title, i.sessionId])).toEqual([['shell', 'serve it', sid]]);
      svc.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('answers its requests', async () => {
    const { svc } = setup();
    expect(isBackgroundRequest({ kind: 'background.list' })).toBe(true);
    expect(isBackgroundRequest({ kind: 'session.open' })).toBe(false);
    expect(await handleBackground(svc, { kind: 'background.list' })).toEqual([]);
    // an unknown conversation has nothing on disk
    expect(await handleBackground(svc, { kind: 'background.history', sessionId: '00000000-0000-0000-0000-000000000000' })).toEqual([]);
    expect(await handleBackground(svc, { kind: 'background.run', sessionId: '00000000-0000-0000-0000-000000000000', runId: 'wf_x' })).toBeNull();
    expect(await handleBackground(svc, { kind: 'background.transcript', sessionId: '00000000-0000-0000-0000-000000000000', agentId: 'abcdef12' })).toEqual([]);
    svc.dispose();
  });
});

describe('BackgroundService: finished sub-agents do not stay 在跑 (issue #19)', () => {
  it('the Agent call before its task (no state yet) is remembered; its result ends the task; nothing listed before a task', () => {
    vi.useFakeTimers();
    const { pool, svc, pushes, tick } = setup();
    pool.emit('message', 's1', { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Agent', input: { prompt: 'p' } }] } });
    expect(svc.list()).toEqual([]);
    expect(pushes.length).toBe(0);
    pool.emit('message', 's1', sys('task_started', { task_id: 'a1', tool_use_id: 'tu1', description: 'x', task_type: 'local_agent' }));
    tick(1000);
    pool.emit('message', 's1', { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] } });
    tick(1000);
    expect(svc.hasRunning('s1')).toBe(false);
    expect(pushes.at(-1)!.tasks[0].status).toBe('completed');
    svc.dispose();
  });
  it('markGone: a running task ends as stopped; an unknown one changes nothing', () => {
    vi.useFakeTimers();
    const { pool, svc, tick } = setup();
    pool.emit('message', 's1', sys('task_started', { task_id: 'a1', description: 'x', task_type: 'local_agent' }));
    tick(1000);
    expect(svc.markGone('s1', 'a1')).toBe(true);
    expect(svc.hasRunning('s1')).toBe(false);
    expect(svc.markGone('s1', 'a1')).toBe(false);
    expect(svc.markGone('s2', 'a1')).toBe(false);
    svc.dispose();
  });
  it("isTaskGone: the CLI's answer, not other failures", () => {
    expect(isTaskGone(new Error('No task found with ID: a7c600f5f6811e6cd'))).toBe(true);
    expect(isTaskGone('no task found with id: x')).toBe(true);
    expect(isTaskGone(new Error('process exited'))).toBe(false);
  });
});
