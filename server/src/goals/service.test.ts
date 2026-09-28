import { describe, expect, it, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { GoalService, GOAL_PROTOCOL } from './service.js';

class FakeRunner extends EventEmitter { state = 'idle'; sent: string[] = []; constructor(public sessionId: string) { super(); } send(t: string) { this.sent.push(t); } }
class FakePool extends EventEmitter {
  runners = new Map<string, FakeRunner>(); opened: any[] = [];
  get(id: string) { return this.runners.get(id); }
  open(p: any) { const r = new FakeRunner(p.sessionId ?? `s${this.runners.size + 1}`); this.runners.set(r.sessionId, r); this.opened.push(p); return r; }
}
class FakeMeta { list: any[] = []; goals() { return this.list; } async setGoal(g: any) { const i = this.list.findIndex((x) => x.id === g.id); if (i >= 0) this.list[i] = g; else this.list.push(g); } async removeGoal(id: string) { this.list = this.list.filter((g) => g.id !== id); } }
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const result = (text: string, extra: any = {}) => ({ type: 'result', is_error: false, result: text, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0 }, total_cost_usd: 0.01, ...extra });

describe('GoalService', () => {
  let pool: FakePool, meta: FakeMeta, svc: GoalService;
  beforeEach(() => { pool = new FakePool(); meta = new FakeMeta(); svc = new GoalService(meta as any, pool as any); });

  it('create → start opens a session and sends protocol + objective + spec', async () => {
    const g = await svc.create({ objective: 'ship it', spec: '- tests green', cwd: 'C:/p', permissionMode: 'acceptEdits' });
    expect(g.status).toBe('draft');
    await svc.start(g.id);
    await tick();
    const r = pool.runners.get('s1')!;
    expect(pool.opened[0]).toMatchObject({ cwd: 'C:/p', permissionMode: 'acceptEdits' });
    expect(r.sent[0]).toContain(GOAL_PROTOCOL);
    expect(r.sent[0]).toContain('# 目标\nship it');
    expect(r.sent[0]).toContain('# 规格 / 验收标准\n- tests green');
    expect(svc.get(g.id)!.status).toBe('active');
    expect(svc.get(g.id)!.sessionId).toBe('s1');
  });

  it('a prompt waiting for a starting session is dropped if the goal stopped being active meanwhile (N4)', async () => {
    vi.useFakeTimers();
    try {
      const g = await svc.create({ objective: 'x', cwd: 'C:/p' });
      await svc.start(g.id);
      const r = pool.runners.get('s1')!;
      r.state = 'starting';
      await vi.advanceTimersByTimeAsync(10);
      r.sent = [];
      await svc.start(g.id); // queues another send while still starting
      await svc.pause(g.id);
      r.state = 'idle';
      await vi.advanceTimersByTimeAsync(1000);
      expect(r.sent).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it('create can adopt an already-open session', async () => {
    const pre = pool.open({ cwd: 'C:/p' });
    const g = await svc.create({ objective: 'x', cwd: 'C:/p', sessionId: pre.sessionId });
    await svc.start(g.id);
    await tick();
    expect(pool.opened).toHaveLength(1);
    expect(pre.sent[0]).toContain(GOAL_PROTOCOL);
  });

  it('harvests steps and evidence, auto-continues on GOAL_STATUS: continue, completes on complete', async () => {
    vi.useFakeTimers();
    try {
      const g = await svc.create({ objective: 'x', cwd: 'C:/p' });
      await svc.start(g.id);
      await vi.advanceTimersByTimeAsync(10);
      const r = pool.runners.get('s1')!;
      pool.emit('message', 's1', { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }] } }, { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: 'src/a.ts' } }, { type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'npm test' } }] } });
      pool.emit('message', 's1', { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't3', is_error: true }] } });
      pool.emit('message', 's1', result('did a thing\nGOAL_STATUS: continue — next b'));
      await vi.advanceTimersByTimeAsync(10);
      let cur = svc.get(g.id)!;
      expect(cur.steps.map((s) => s.status)).toEqual(['completed', 'in_progress']);
      expect(cur.evidence.some((e) => e.kind === 'file' && e.ref === 'src/a.ts')).toBe(true);
      expect(cur.evidence.find((e) => e.kind === 'test')!.ok).toBe(false);
      expect(cur.turnsExecuted).toBe(1);
      expect(cur.tokensUsed).toBe(120);
      expect(cur.status).toBe('active');
      expect(r.sent.length).toBe(1);
      await vi.advanceTimersByTimeAsync(2000);
      expect(r.sent.length).toBe(2);
      expect(r.sent[1]).toContain('第 2/50 轮');
      pool.emit('message', 's1', { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't4', name: 'Bash', input: { command: 'git commit -m done' } }] } });
      pool.emit('message', 's1', result('all good\nGOAL_STATUS: complete'));
      await vi.advanceTimersByTimeAsync(3000);
      cur = svc.get(g.id)!;
      expect(cur.status).toBe('complete');
      expect(cur.evidence.some((e) => e.kind === 'commit')).toBe(true);
      expect(r.sent.length).toBe(2); // no further continue
    } finally { vi.useRealTimers(); }
  });

  it('blocked status, max turns, stuck detection and pause stop the loop', async () => {
    vi.useFakeTimers();
    try {
      const g = await svc.create({ objective: 'y', cwd: 'C:/p', maxTurns: 2 });
      await svc.start(g.id);
      await vi.advanceTimersByTimeAsync(10);
      const r = pool.runners.get('s1')!;
      pool.emit('message', 's1', result('GOAL_STATUS: blocked — need API key'));
      await vi.advanceTimersByTimeAsync(10);
      expect(svc.get(g.id)!.status).toBe('blocked');
      expect(svc.get(g.id)!.evidence.at(-1)!.summary).toBe('need API key');
      await svc.resume(g.id);
      await vi.advanceTimersByTimeAsync(10);
      expect(r.sent.length).toBe(2);
      pool.emit('message', 's1', result('more\nGOAL_STATUS: continue'));
      await vi.advanceTimersByTimeAsync(10);
      expect(svc.get(g.id)!.status).toBe('max_turns'); // turnsExecuted 2 >= maxTurns 2
      await vi.advanceTimersByTimeAsync(3000);
      expect(r.sent.length).toBe(2);
      // resume from max_turns resets the counter; three identical no-tool replies → stuck
      await svc.resume(g.id);
      await vi.advanceTimersByTimeAsync(10);
      expect(svc.get(g.id)!.turnsExecuted).toBe(0);
      await svc.update(g.id, { maxTurns: 10 });
      for (let i = 0; i < 3; i++) { pool.emit('message', 's1', result('same reply')); await vi.advanceTimersByTimeAsync(2000); }
      expect(svc.get(g.id)!.status).toBe('blocked');
      expect(svc.get(g.id)!.evidence.at(-1)!.summary).toContain('卡住');
      // pause prevents continue
      await svc.resume(g.id);
      await svc.pause(g.id);
      const before = r.sent.length;
      pool.emit('message', 's1', result('GOAL_STATUS: continue'));
      await vi.advanceTimersByTimeAsync(3000);
      expect(svc.get(g.id)!.status).toBe('paused');
      expect(r.sent.length).toBe(before);
    } finally { vi.useRealTimers(); }
  });

  it('session error blocks the goal; errors in result too', async () => {
    const g = await svc.create({ objective: 'z', cwd: 'C:/p' });
    await svc.start(g.id);
    await tick();
    pool.emit('state', 's1', 'error', 'boom\nstack');
    await tick();
    expect(svc.get(g.id)!.status).toBe('blocked');
    expect(svc.get(g.id)!.evidence.at(-1)).toMatchObject({ kind: 'error', summary: 'boom' });
  });
});
