import type { MetaStore, Schedule } from '../meta/store.js';
import type { RunnerPool } from '../runtime/pool.js';
import type { PermissionMode, ScheduleRun } from '../protocol.js';
import { nextCron } from './cron.js';

/** Ready-made schedules users can start from (the UI fills cwd). */
export const SCHEDULE_TEMPLATES: { id: string; name: string; cron: string; prompt: string; permissionMode: PermissionMode; freshSession?: boolean }[] = [
  { id: 'ci', name: 'CI 巡检', cron: '*/30 * * * *', prompt: '用 gh 查看这个仓库最近的 CI 运行状态；如果有失败，读取日志找出原因并给出修复建议（不要直接改代码）。只在有失败时详细汇报，否则一句话说明全部通过。', permissionMode: 'acceptEdits' },
  { id: 'daily', name: '每日总结', cron: '0 18 * * 1-5', prompt: '总结今天这个仓库的 git 提交（git log --since=today），按功能 / 修复 / 杂项分组，写成一段可以直接发到群里的中文日报。', permissionMode: 'acceptEdits', freshSession: true },
  { id: 'deps', name: '依赖更新检查', cron: '0 9 * * 1', prompt: '检查项目依赖是否有新版本（npm outdated / pip list --outdated 等，按项目类型选），列出主版本变更和安全相关的更新，并说明升级风险。不要修改 lockfile。', permissionMode: 'default', freshSession: true },
  { id: 'changelog', name: '每周 changelog', cron: '0 10 * * 5', prompt: '根据本周的提交（git log --since="7 days ago"）起草 CHANGELOG 条目，按 Added / Changed / Fixed 分类，写入 CHANGELOG.md 的顶部（如果没有就创建）。', permissionMode: 'acceptEdits', freshSession: true },
  { id: 'todo', name: 'TODO 巡查', cron: '0 11 * * 3', prompt: '搜索代码里的 TODO / FIXME / HACK 注释，按文件归类，估计每条的优先级，输出一份清单。', permissionMode: 'default', freshSession: true },
  { id: 'tests', name: '跑测试', cron: '0 */4 * * *', prompt: '运行项目的测试套件，只汇报失败的用例和可能的原因；全部通过就一句话。', permissionMode: 'acceptEdits' },
];

function computeNext(s: Schedule, from = Date.now()): number {
  if (s.cron) return nextCron(s.cron, new Date(from)).getTime();
  return from + Math.max(1, s.everyMinutes || 60) * 60_000;
}

/**
 * Local scheduler: interval (`everyMinutes`) or cron (`cron`). Each schedule keeps one session so context
 * accumulates like /loop, unless `freshSession` asks for a new one per run. Every run is logged (meta.scheduleRuns).
 */
export class ScheduleService {
  private timer: NodeJS.Timeout;
  private running = new Set<string>();
  constructor(private meta: MetaStore, private pool: RunnerPool) {
    this.timer = setInterval(() => void this.tick(), 30_000);
    this.timer.unref();
    // recompute cron schedules whose next run is stale (e.g. laptop slept)
    for (const s of this.meta.schedules()) if (s.enabled && s.cron && (!s.nextRunAt || s.nextRunAt < Date.now() - 12 * 3600_000)) void this.meta.touchSchedule(s.id, { nextRunAt: computeNext(s) });
  }

  nextRun(s: Schedule) { return computeNext(s); }

  private async tick() {
    const now = Date.now();
    for (const s of this.meta.schedules()) {
      if (!s.enabled || this.running.has(s.id)) continue;
      if ((s.nextRunAt ?? 0) <= now) await this.run(s).catch(() => {});
    }
  }

  async run(s: Schedule, manual = false) {
    this.running.add(s.id);
    const started = Date.now();
    const runId = `${s.id}-${started.toString(36)}`;
    try {
      const runner = this.pool.open({ sessionId: s.freshSession ? undefined : s.sessionId, cwd: s.cwd, model: s.model, permissionMode: (s.permissionMode as PermissionMode) ?? 'acceptEdits' });
      for (let i = 0; i < 60 && runner.state === 'starting'; i++) await new Promise((r) => setTimeout(r, 500));
      if (runner.state === 'running' || runner.state === 'waiting') {
        await this.meta.touchSchedule(s.id, { nextRunAt: Date.now() + 60_000, lastError: '会话正忙，1 分钟后重试' });
        return; // busy — try again in a minute
      }
      runner.send(s.prompt);
      await this.meta.touchSchedule(s.id, { lastRunAt: started, nextRunAt: manual ? s.nextRunAt ?? computeNext(s, started) : computeNext(s, started), sessionId: runner.sessionId, lastError: undefined, runs: (s.runs ?? 0) + 1 });
      runner.once('info', (i) => void this.meta.touchSchedule(s.id, { sessionId: i.sessionId }));
      // wait for the turn to finish (bounded) to log outcome + a short summary
      const outcome = await new Promise<{ ok: boolean; summary?: string; error?: string }>((resolve) => {
        const timeout = setTimeout(() => { off(); resolve({ ok: true, summary: '（仍在运行）' }); }, 30 * 60_000);
        const onMsg = (m: any) => {
          if (m?.type === 'result') { clearTimeout(timeout); off(); resolve({ ok: !m.is_error, summary: typeof m.result === 'string' ? m.result.slice(0, 300) : undefined, error: m.is_error ? m.subtype : undefined }); }
        };
        const off = () => runner.off('message', onMsg);
        runner.on('message', onMsg);
      });
      const run: ScheduleRun = { id: runId, scheduleId: s.id, at: started, sessionId: runner.sessionId, ok: outcome.ok, durationMs: Date.now() - started, summary: outcome.summary, error: outcome.error };
      await this.meta.addScheduleRun(run);
      if (!outcome.ok) await this.meta.touchSchedule(s.id, { lastError: outcome.error });
    } catch (e: any) {
      await this.meta.addScheduleRun({ id: runId, scheduleId: s.id, at: started, ok: false, durationMs: Date.now() - started, error: e.message });
      await this.meta.touchSchedule(s.id, { lastError: e.message, nextRunAt: computeNext(s) });
      throw e;
    } finally {
      this.running.delete(s.id);
    }
  }
}
