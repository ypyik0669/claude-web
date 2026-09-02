import type { MetaStore, Schedule } from '../meta/store.js';
import type { RunnerPool } from '../runtime/pool.js';
import type { PermissionMode } from '../protocol.js';

/**
 * Minimal local scheduler: every `everyMinutes` send `prompt` into a session in `cwd`.
 * Each schedule keeps one session (created on first run) so context accumulates like /loop.
 */
export class ScheduleService {
  private timer: NodeJS.Timeout;
  constructor(private meta: MetaStore, private pool: RunnerPool) {
    this.timer = setInterval(() => void this.tick(), 30_000);
    this.timer.unref();
  }

  private async tick() {
    const now = Date.now();
    for (const s of this.meta.schedules()) {
      if (!s.enabled) continue;
      if ((s.nextRunAt ?? 0) <= now) await this.run(s).catch(() => {});
    }
  }

  async run(s: Schedule) {
    const runner = this.pool.open({ sessionId: s.sessionId, cwd: s.cwd, model: s.model, permissionMode: (s.permissionMode as PermissionMode) ?? 'acceptEdits' });
    // wait until the runner is ready (bounded)
    for (let i = 0; i < 60 && runner.state === 'starting'; i++) await new Promise((r) => setTimeout(r, 500));
    if (runner.state === 'running' || runner.state === 'waiting') {
      await this.meta.touchSchedule(s.id, { nextRunAt: Date.now() + 60_000 });
      return; // busy — try again in a minute
    }
    runner.send(s.prompt);
    await this.meta.touchSchedule(s.id, { lastRunAt: Date.now(), nextRunAt: Date.now() + s.everyMinutes * 60_000, sessionId: runner.sessionId });
    // the session id is only final after init; patch it once known
    runner.once('info', (i) => void this.meta.touchSchedule(s.id, { sessionId: i.sessionId }));
  }
}
