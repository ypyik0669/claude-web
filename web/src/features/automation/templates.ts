// How a schedule template is shown on the automation page (structure round 2, spec §4): its own icon and colour and
// one line a person would say — the prompt itself is an instruction to the model, not a description. Pure.
import type { IconName } from '@/ui/icons';

export type Tint = 'accent' | 'ok' | 'info' | 'warn' | 'ink';
export interface TemplateLook { icon: IconName; tint: Tint; desc: string }

/** By the server's template id (`SCHEDULE_TEMPLATES`, server/src/schedules/service.ts). */
const LOOK: Record<string, TemplateLook> = {
  ci: { icon: 'checkCircle', tint: 'ok', desc: '隔一会儿看一眼 CI，失败了就读日志、给出修复建议' },
  daily: { icon: 'read', tint: 'info', desc: '把今天的提交整理成一段可以直接发到群里的日报' },
  deps: { icon: 'refresh', tint: 'warn', desc: '检查依赖有没有新版本，列出大版本变更和安全更新' },
  changelog: { icon: 'edit', tint: 'accent', desc: '根据这一周的提交起草 CHANGELOG 条目' },
  todo: { icon: 'todo', tint: 'ink', desc: '把代码里的 TODO / FIXME 归类，估一估先做哪条' },
  tests: { icon: 'play', tint: 'ok', desc: '跑一遍测试，只告诉你失败的用例和可能的原因' },
};

/** A template the server added that this table does not know yet still gets a card: the start of its prompt. */
export function templateLook(t: { id: string; prompt: string }): TemplateLook {
  const known = LOOK[t.id];
  if (known) return known;
  const first = t.prompt.split(/[。；;\n]/)[0].trim();
  return { icon: 'tasks', tint: 'ink', desc: first.length > 48 ? `${first.slice(0, 47)}…` : first };
}

/** The 定时任务 page with nothing on it yet: what this is, in the heading face (ui/heading-text.ts lists the title). */
export const SCHEDULES_HERO = { title: '到点自己开工', text: '定好时间和要做的事，到点它自己开一个对话去做，把结果留给你。' } as const;
