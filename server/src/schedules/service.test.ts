import { describe, expect, it, vi } from 'vitest';
import { ScheduleService } from './service.js';

function fakeMeta(schedules: any[]) {
  return {
    schedules: () => schedules,
    touchSchedule: vi.fn(async (id: string, patch: any) => { Object.assign(schedules.find((s) => s.id === id), patch); }),
    addScheduleRun: vi.fn(async () => {}),
  };
}

describe('ScheduleService with a cron that never matches', () => {
  it('does not throw at startup and never sends the prompt', async () => {
    const sched = { id: 's1', enabled: true, cron: '0 0 30 2 *', prompt: 'hi', cwd: '.', nextRunAt: 0 };
    const meta = fakeMeta([sched]);
    const pool = { open: vi.fn() };
    let svc!: ScheduleService;
    expect(() => { svc = new ScheduleService(meta as any, pool as any); }).not.toThrow();
    await (svc as any).tick();
    await (svc as any).tick();
    expect(pool.open).not.toHaveBeenCalled();
    expect(sched).toHaveProperty('lastError');
    clearInterval((svc as any).timer);
  });
});
