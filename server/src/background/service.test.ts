import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackgroundService, KEEP_ENDED_MS, KEEP_TASK_MS, handleBackground, isBackgroundRequest } from './service.js';
import type { BgSession } from './types.js';

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
