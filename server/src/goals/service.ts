import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import type { MetaStore } from '../meta/store.js';
import type { RunnerPool } from '../runtime/pool.js';
import type { Goal, GoalEvidence, GoalStep } from '../protocol.js';

const CONTINUE_DELAY_MS = 1500;
const TEST_CMD = /\b(vitest|jest|pytest|mocha|go test|cargo test|npm test|pnpm test|yarn test|dotnet test|mvn test|gradle test|phpunit|rspec|ctest|make test)\b/i;
const NO_PROGRESS_LIMIT = 3;

export const GOAL_PROTOCOL = `你在执行一个「目标」。规则：
- 持续推进，直到目标完整达成。每轮结束时我会让你继续。
- 目标**完全达成并验证**后，最后一行写：GOAL_STATUS: complete
- 如果没有人类输入就无法继续（缺权限、缺信息、需要决策），最后一行写：GOAL_STATUS: blocked — <原因>
- 其它情况最后一行写：GOAL_STATUS: continue，并简述下一步。
- 每次改动都要留下证据：跑测试 / 构建 / 命令验证，把结果说清楚。`;

/**
 * Web-level goals: an objective + living spec bound to a session, auto-continued until the model reports
 * `GOAL_STATUS: complete` (or blocks / runs out of budget). Evidence (files, commands, tests, commits) and
 * steps (TodoWrite) are harvested from the session stream. Works with any agent driver.
 */
export class GoalService extends EventEmitter {
  private timers = new Map<string, NodeJS.Timeout>();
  private lastTexts = new Map<string, string[]>();
  private turnTools = new Map<string, number>();
  constructor(private meta: MetaStore, private pool: RunnerPool) {
    super();
    pool.on('message', (sid: string, m: any) => this.onMessage(sid, m));
    pool.on('state', (sid: string, state: string, err?: string) => this.onState(sid, state, err));
  }

  list(): Goal[] { return this.meta.goals(); }
  get(id: string) { return this.meta.goals().find((g) => g.id === id); }
  private goalOfSession(sid: string) { return this.meta.goals().find((g) => g.sessionId === sid && g.status === 'active'); }

  private async save(g: Goal) { g.updatedAt = Date.now(); await this.meta.setGoal(g); this.emit('changed'); }

  async create(p: { objective: string; spec?: string; cwd: string; maxTurns?: number; tokenBudget?: number | null; agent?: string; permissionMode?: string; model?: string; sessionId?: string }): Promise<Goal> {
    const g: Goal = { id: randomBytes(5).toString('hex'), objective: p.objective.trim(), spec: p.spec ?? '', cwd: p.cwd, status: 'draft', turnsExecuted: 0, maxTurns: p.maxTurns ?? 50, tokensUsed: 0, tokenBudget: p.tokenBudget ?? null, createdAt: Date.now(), updatedAt: Date.now(), steps: [], evidence: [], agent: p.agent || undefined, permissionMode: p.permissionMode, model: p.model, sessionId: p.sessionId };
    await this.save(g);
    return g;
  }

  async update(id: string, patch: Partial<Pick<Goal, 'objective' | 'spec' | 'maxTurns' | 'tokenBudget' | 'cwd' | 'agent' | 'permissionMode' | 'model'>>) {
    const g = this.get(id);
    if (!g) throw new Error('目标不存在');
    Object.assign(g, patch);
    await this.save(g);
    return g;
  }

  async remove(id: string) {
    this.clearTimer(id);
    await this.meta.removeGoal(id);
    this.emit('changed');
  }

  async note(id: string, text: string) { const g = this.get(id); if (!g) throw new Error('目标不存在'); this.addEvidence(g, { kind: 'note', summary: text }); await this.save(g); }

  /** Start (or resume) the goal: open its session if needed and send the objective. */
  async start(id: string): Promise<Goal> {
    const g = this.get(id);
    if (!g) throw new Error('目标不存在');
    let r = g.sessionId ? this.pool.get(g.sessionId) : undefined;
    if (!r) {
      r = this.pool.open({ sessionId: g.sessionId, cwd: g.cwd, agent: (g.agent as any) || undefined, permissionMode: (g.permissionMode as any) ?? 'default', model: g.model || undefined });
      g.sessionId = r.sessionId;
    }
    const fresh = g.status === 'draft' || g.turnsExecuted === 0;
    g.status = 'active';
    g.startedAt = g.startedAt ?? Date.now();
    if (g.status === 'active' && (g as any)._wasMax) delete (g as any)._wasMax;
    this.lastTexts.set(g.id, []);
    const prompt = fresh ? `${GOAL_PROTOCOL}\n\n# 目标\n${g.objective}${g.spec ? `\n\n# 规格 / 验收标准\n${g.spec}` : ''}` : this.continuePrompt(g);
    this.addEvidence(g, { kind: 'note', summary: fresh ? '目标已启动' : '继续推进' });
    await this.save(g);
    this.sendWhenReady(r, prompt, g.id);
    return g;
  }

  async pause(id: string) { const g = this.get(id); if (!g) throw new Error('目标不存在'); this.clearTimer(id); if (g.status === 'active') { g.status = 'paused'; this.addEvidence(g, { kind: 'note', summary: '已暂停' }); await this.save(g); } return g; }
  async resume(id: string) { const g = this.get(id); if (!g) throw new Error('目标不存在'); if (g.status === 'max_turns') g.turnsExecuted = 0; return this.start(id); }
  async complete(id: string) { const g = this.get(id); if (!g) throw new Error('目标不存在'); this.clearTimer(id); g.status = 'complete'; g.completedAt = Date.now(); this.addEvidence(g, { kind: 'note', summary: '手动标记完成' }); await this.save(g); return g; }

  private continuePrompt(g: Goal) {
    return `目标继续（第 ${g.turnsExecuted + 1}/${g.maxTurns} 轮）：继续推进「${g.objective.slice(0, 200)}」。检查还缺什么、验证已做的部分，然后干活。完成时最后一行写 GOAL_STATUS: complete；卡住写 GOAL_STATUS: blocked — 原因；否则 GOAL_STATUS: continue。`;
  }

  private sendWhenReady(r: any, text: string, goalId: string) {
    const tryOnce = (n: number) => {
      if (r.state === 'closed' || r.state === 'error') return;
      if (r.state === 'starting' && n < 200) { setTimeout(() => tryOnce(n + 1), 250); return; }
      r.send(text);
      this.turnTools.set(goalId, 0);
    };
    tryOnce(0);
  }

  private clearTimer(id: string) { const t = this.timers.get(id); if (t) clearTimeout(t); this.timers.delete(id); }

  private addEvidence(g: Goal, e: Omit<GoalEvidence, 'at'>) {
    g.evidence.push({ at: Date.now(), ...e });
    if (g.evidence.length > 400) g.evidence.splice(0, g.evidence.length - 400);
  }

  // ---- harvest the session stream ----
  private onMessage(sid: string, m: any) {
    const g = this.goalOfSession(sid);
    if (!g) return;
    let dirty = false;
    if (m.type === 'assistant') {
      for (const c of m.message?.content ?? []) {
        if (c.type !== 'tool_use') continue;
        this.turnTools.set(g.id, (this.turnTools.get(g.id) ?? 0) + 1);
        const inp: any = c.input ?? {};
        if (c.name === 'TodoWrite' && Array.isArray(inp.todos)) { g.steps = inp.todos.map((t: any, i: number): GoalStep => ({ id: `s${i}`, text: t.content, status: t.status })); dirty = true; }
        else if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(c.name) && inp.file_path) { this.addEvidence(g, { kind: 'file', summary: `${c.name} ${inp.file_path}`, ref: inp.file_path }); dirty = true; }
        else if (c.name === 'Bash' && inp.command) {
          const cmd = String(inp.command);
          const kind = /git\s+commit/.test(cmd) ? 'commit' : TEST_CMD.test(cmd) ? 'test' : 'command';
          this.addEvidence(g, { kind, summary: cmd.slice(0, 200), ref: c.id });
          dirty = true;
        }
      }
    } else if (m.type === 'user') {
      for (const c of m.message?.content ?? []) {
        if (c.type !== 'tool_result') continue;
        const ev = g.evidence.find((e) => e.ref === c.tool_use_id && (e.kind === 'test' || e.kind === 'command' || e.kind === 'commit'));
        if (ev) { ev.ok = !c.is_error; dirty = true; }
      }
    } else if (m.type === 'result') {
      g.turnsExecuted++;
      g.tokensUsed += (m.usage?.input_tokens ?? 0) + (m.usage?.output_tokens ?? 0) + (m.usage?.cache_read_input_tokens ?? 0);
      g.costUsd = (g.costUsd ?? 0) + (m.total_cost_usd ?? 0);
      const text = String(m.result ?? '');
      g.lastResult = text.slice(-2000);
      const st = /GOAL_STATUS:\s*(complete|blocked|continue)\s*(?:[—-]+\s*(.*))?/i.exec(text);
      const status = st?.[1]?.toLowerCase();
      if (m.is_error) { g.status = 'blocked'; this.addEvidence(g, { kind: 'error', summary: text.slice(0, 300) }); }
      else if (status === 'complete') { g.status = 'complete'; g.completedAt = Date.now(); this.addEvidence(g, { kind: 'note', summary: '模型报告：目标完成', ok: true }); }
      else if (status === 'blocked') { g.status = 'blocked'; this.addEvidence(g, { kind: 'blocked', summary: st?.[2]?.trim() || '模型报告：需要人工介入' }); }
      else {
        // progress guard: identical replies with no tool use → stuck
        const arr = this.lastTexts.get(g.id) ?? [];
        const tools = this.turnTools.get(g.id) ?? 0;
        arr.push(tools === 0 ? text.trim().slice(0, 400) : '');
        if (arr.length > NO_PROGRESS_LIMIT) arr.shift();
        this.lastTexts.set(g.id, arr);
        const stuck = arr.length >= NO_PROGRESS_LIMIT && arr.every((t) => t && t === arr[0]);
        if (stuck) { g.status = 'blocked'; this.addEvidence(g, { kind: 'blocked', summary: '连续几轮没有工具调用且回复相同，判定卡住' }); }
        else if (g.turnsExecuted >= g.maxTurns) { g.status = 'max_turns'; this.addEvidence(g, { kind: 'note', summary: `达到最大轮数 ${g.maxTurns}` }); }
        else if (g.tokenBudget && g.tokensUsed >= g.tokenBudget) { g.status = 'max_turns'; this.addEvidence(g, { kind: 'note', summary: `达到 token 预算 ${g.tokenBudget}` }); }
        else {
          this.clearTimer(g.id);
          this.timers.set(g.id, setTimeout(() => { const cur = this.get(g.id); const r = cur?.sessionId ? this.pool.get(cur.sessionId) : undefined; if (cur?.status === 'active' && r && r.state === 'idle') { this.sendWhenReady(r, this.continuePrompt(cur), cur.id); } }, CONTINUE_DELAY_MS));
        }
      }
      dirty = true;
    }
    if (dirty) void this.save(g);
  }

  private onState(sid: string, state: string, err?: string) {
    const g = this.goalOfSession(sid);
    if (!g) return;
    if (state === 'error') { g.status = 'blocked'; this.addEvidence(g, { kind: 'error', summary: (err ?? '会话出错').split('\n')[0] }); void this.save(g); }
  }
}
