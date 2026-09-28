import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import type { Goal } from '@shared';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { Icon } from '@/ui/icons';
import { showGoals } from '@/features/workbench/right-panel';
import { coalesce } from '@/features/workbench/git-refresh';
import { goalBarFor, goalListSig, type GoalBar as GoalBarInfo } from './goal-bar';

// The goal list is one small store per window (not per conversation): loaded when the first conversation that could
// show the bar mounts, refreshed on `goals.changed` — coalesced, and only stored when something a bar shows changed:
// the service sends it for every piece of evidence, i.e. every tool call of a goal's conversation (review M6) — and
// after a reconnect (a goal may have ended while the socket was down), dropped with the last.
const NONE: Goal[] = [];
const useGoalList = create<{ goals: Goal[]; sig: string }>(() => ({ goals: NONE, sig: '' }));
let users = 0;
let offs: (() => void)[] = [];
let seq = 0;
function load() {
  const mine = ++seq;
  ws.request<Goal[]>({ kind: 'goals.list' }).then((g) => {
    if (mine !== seq) return;
    const goals = g ?? NONE;
    const sig = goalListSig(goals);
    if (sig !== useGoalList.getState().sig) useGoalList.setState({ goals, sig });
  }).catch(() => { /* no goals service / offline: no bar */ });
}
const soon = coalesce(load, 800, 3000);

/** The goal driving `sessionId`, if any (see `goalBarFor`). */
function useSessionGoal(sessionId: string | undefined): GoalBarInfo | null {
  useEffect(() => {
    if (users++ === 0) {
      load();
      offs = [
        ws.on((e) => { if (e.kind === 'goals.changed') soon.trigger(); }),
        useStore.subscribe((s, prev) => { if (s.connected && !prev.connected) load(); }),
      ];
    }
    return () => { if (--users === 0) { for (const off of offs) off(); offs = []; soon.cancel(); } };
  }, []);
  const goals = useGoalList((s) => s.goals);
  return useMemo(() => goalBarFor(goals, sessionId ?? ''), [goals, sessionId]);
}

/**
 * 「目标：把 README 翻成英文 · 第 3 轮 · 查看」 on top of a conversation while a goal drives it (spec §5.3). 查看 is
 * `showGoals()`, the one rule for where goals are: the right panel's 目标 on a desktop, the automation page's 目标 tab
 * on a phone (review 7 M11 — the drawer is too small for the execution graph and the live spec).
 */
export function GoalBar({ sessionId }: { sessionId: string }) {
  const g = useSessionGoal(sessionId);
  if (!g) return null;
  return (
    <div className="goal-bar" role="status" data-goal={g.id}>
      <Icon name="goals" size={13} className="gb-ic" />
      <span className="gb-t" title={g.objective}>目标：{g.objective}</span>
      <span className="gb-r" title={`最多 ${g.maxTurns} 轮`}>第 {g.round} 轮</span>
      <button className="gb-go" onClick={() => showGoals()} title="查看目标的执行图、规格和证据">查看</button>
    </div>
  );
}
