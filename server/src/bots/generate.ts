// 值班 Bot: one sentence → a bot draft. A chat-only conversation (no tools) is asked for one ```json block; the
// answer is read leniently (defaults filled, a bad cron becomes daily) so the user always gets a form to edit.
import { randomBytes } from 'node:crypto';
import type { AgentDriver } from '../agents/types.js';
import type { BotDraft, OpenSessionParams, Routine } from '../protocol.js';
import { nextCron } from '../schedules/cron.js';
import { tr } from '../i18n/index.js';

export interface GenerateDeps { open(params: OpenSessionParams): AgentDriver; defaultProvider(): string | undefined }

/** model-facing, not shown to the user */
export const GENERATE_PROMPT = (text: string) => [
  '把下面这句话变成一个「值班 Bot」的设置。只输出一个 ```json 代码块，不要别的话。字段：',
  '{ "name": "短名字", "charter": { "role": "一句话职责", "audience": "服务对象", "sources": ["只用这些来源"], "report": "报告格式", "done": "完成条件" },',
  '  "routines": [ { "name": "例行名", "prompt": "每次运行的指令，写清要查什么、输出什么、不做什么", "cron": "5 字段 cron 或省略", "everyMinutes": 60, "precheck": "一段 shell：输出会变化的东西（列表、哈希），没变化就不唤醒；没有合适的就省略", "acceptance": { "kind": "none" } } ],',
  '  "tier": "cheap|balanced|best", "budget": { "dailyUsd": 2 } }',
  '规则：默认只读、只起草、不对外发送；要发的东西让它写进 <draft>…</draft>；节奏能慢就慢（每天一次优先于每小时）。',
  'role 写成「你是我的……。你的活：……」，结尾写明不做什么；report 结尾固定是「查了什么 / 没能查到什么 / 建议的下一步」。名字和文字用这句话的语言。',
  '例子：「每天早上看看仓库有什么新 issue」→',
  '```json',
  '{ "name": "晨报", "charter": { "role": "你是我的仓库值班员。你的活：每天早上汇总新 issue 和 PR。不评论、不关 issue。", "sources": ["gh issue", "gh pr"], "report": "分紧急 / 等我 / 仅供了解；结尾写查了什么 / 没能查到什么 / 建议的下一步" },',
  '  "routines": [ { "name": "晨报", "prompt": "列出最近 24 小时新开或有新回复的 issue 和 PR，每条一句话加链接。", "cron": "30 8 * * 1-5", "precheck": "gh issue list --json number,updatedAt -L 50", "acceptance": { "kind": "none" } } ],',
  '  "tier": "cheap", "budget": { "dailyUsd": 1 } }',
  '```',
  '', '这句话：', text,
].join('\n');

/** Reads the first ```json block of the answer; `text` (the user's sentence) names a bot the model left unnamed. */
export function parseDraft(answer: string, cwd: string, text = ''): BotDraft['bot'] {
  const m = /```json\s*([\s\S]*?)```/.exec(answer);
  let j: any; try { j = JSON.parse(m?.[1] ?? ''); } catch { throw new Error(tr('没能从回答里读出 Bot 设置')); }
  if (!j || typeof j !== 'object') throw new Error(tr('没能从回答里读出 Bot 设置'));
  const routines: Routine[] = (Array.isArray(j.routines) && j.routines.length ? j.routines : [{ name: tr('每天一次'), prompt: String(j.charter?.role ?? ''), everyMinutes: 1440 }]).map((r: any) => {
    let cron = typeof r.cron === 'string' && r.cron.trim() ? r.cron.trim() : undefined;
    if (cron) { try { nextCron(cron); } catch { cron = undefined; } }
    return { id: `r_${randomBytes(3).toString('hex')}`, name: String(r.name ?? tr('例行')), prompt: String(r.prompt ?? ''), enabled: true, onFail: 'inbox' as const, acceptance: r.acceptance?.kind === 'script' && typeof r.acceptance.script === 'string' ? { kind: 'script' as const, script: r.acceptance.script } : { kind: 'none' as const }, ...(cron ? { cron } : { everyMinutes: Number(r.everyMinutes) > 0 ? Number(r.everyMinutes) : 1440 }), ...(typeof r.precheck === 'string' && r.precheck.trim() ? { precheck: r.precheck.trim() } : {}) };
  });
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);
  return {
    name: String(j.name ?? '').trim() || [...text.trim()].slice(0, 12).join('') || tr('新 Bot'), cwd,
    charter: { role: String(j.charter?.role ?? ''), audience: str(j.charter?.audience), sources: Array.isArray(j.charter?.sources) ? j.charter.sources.map(String) : [], report: str(j.charter?.report), done: str(j.charter?.done) },
    tier: ['cheap', 'balanced', 'best'].includes(j.tier) ? j.tier : 'balanced', policy: { rules: [], signOff: true }, budget: { dailyUsd: Number(j.budget?.dailyUsd) > 0 ? Number(j.budget.dailyUsd) : 2 },
    routines, outputs: [{ kind: 'inbox' }],
  };
}

export async function generateBot(d: GenerateDeps, text: string, cwd: string): Promise<BotDraft['bot']> {
  const r = d.open({ cwd, features: { chatOnly: true }, permissionMode: 'dontAsk', providerId: d.defaultProvider(), drivenBy: 'schedule' });
  try {
    for (let i = 0; i < 60 && r.state === 'starting'; i++) await new Promise((res) => setTimeout(res, 500));
    const answer = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => { off(); reject(new Error(tr('生成超时'))); }, 120_000);
      const onMsg = (m: any) => { if (m?.type === 'result') { clearTimeout(t); off(); m.is_error ? reject(new Error(String(m.result ?? m.subtype))) : resolve(typeof m.result === 'string' ? m.result : ''); } };
      const off = () => r.off('message', onMsg);
      r.on('message', onMsg);
      r.send(GENERATE_PROMPT(text));
    });
    return parseDraft(answer, cwd, text);
  } finally { await r.close().catch(() => {}); }
}
