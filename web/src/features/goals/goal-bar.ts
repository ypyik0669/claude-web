// The thin bar on top of a conversation a goal is driving (redesign phase 5, spec §5.3 / §4.2 「进度：对话顶部一条目标条」):
// 「目标：把 README 翻成英文 · 第 3 轮 · 查看」. The goal list is one small store per window (not per conversation):
// loaded when the first conversation that could show the bar mounts, refreshed on `goals.changed`, dropped with the last.
import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import type { Goal } from '@shared';
import { ws } from '@/ws/client';

export interface GoalBar { id: string; objective: string; round: number; maxTurns: number }

/** The active goal bound to this conversation (the newest, if two), on the round it is working on. */
export function goalBarFor(goals: Goal[], sessionId: string): GoalBar | null {
  if (!sessionId) return null;
  let best: Goal | null = null;
  for (const g of goals) if (g.sessionId === sessionId && g.status === 'active' && (!best || g.updatedAt > best.updatedAt)) best = g;
  // turnsExecuted counts the finished rounds; the goal's own prompt calls the one in flight 「第 N+1 轮」
  return best ? { id: best.id, objective: best.objective, round: best.turnsExecuted + 1, maxTurns: best.maxTurns } : null;
}

const NONE: Goal[] = [];
const useGoalList = create<{ goals: Goal[] }>(() => ({ goals: NONE }));
let users = 0;
let off: (() => void) | null = null;
let seq = 0;
function load() {
  const mine = ++seq;
  ws.request<Goal[]>({ kind: 'goals.list' }).then((g) => { if (mine === seq) useGoalList.setState({ goals: g ?? NONE }); }).catch(() => { /* no goals service / offline: no bar */ });
}

/** The goal driving `sessionId`, if any (see `goalBarFor`). */
export function useSessionGoal(sessionId: string | undefined): GoalBar | null {
  useEffect(() => {
    if (users++ === 0) {
      load();
      off = ws.on((e) => { if (e.kind === 'goals.changed') load(); });
    }
    return () => { if (--users === 0) { off?.(); off = null; } };
  }, []);
  const goals = useGoalList((s) => s.goals);
  return useMemo(() => goalBarFor(goals, sessionId ?? ''), [goals, sessionId]);
}
