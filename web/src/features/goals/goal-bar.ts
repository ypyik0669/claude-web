// The thin bar on top of a conversation a goal is driving (redesign phase 5, spec §5.3 / §4.2 「进度：对话顶部一条目标条」):
// 「目标：把 README 翻成英文 · 第 3 轮 · 查看」. Pure; the goal list and the bar are GoalBar.tsx.
import type { Goal } from '@shared';

export interface GoalBar { id: string; objective: string; round: number; maxTurns: number }

/** The active goal bound to this conversation (the newest created, if two), on the round it is working on. */
export function goalBarFor(goals: Goal[], sessionId: string): GoalBar | null {
  if (!sessionId) return null;
  let best: Goal | null = null;
  for (const g of goals) if (g.sessionId === sessionId && g.status === 'active' && (!best || g.createdAt > best.createdAt)) best = g;
  // turnsExecuted counts the finished rounds; the goal's own prompt calls the one in flight 「第 N+1 轮」
  return best ? { id: best.id, objective: best.objective, round: best.turnsExecuted + 1, maxTurns: best.maxTurns } : null;
}

/** What of the goal list a bar can show: a refetch that changed none of it (new evidence, tokens) changes nothing on screen. */
export function goalListSig(goals: Goal[]): string {
  return goals.map((g) => [g.id, g.status, g.turnsExecuted, g.maxTurns, g.sessionId ?? '', g.createdAt, g.objective].join('\u0001')).join('\u0000');
}
