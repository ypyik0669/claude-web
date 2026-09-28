import { useStore } from '@/store';
import { Icon } from '@/ui/icons';
import { showPanel } from '@/features/workbench/right-panel';
import { useSessionGoal } from './goal-bar';

/**
 * 「目标：把 README 翻成英文 · 第 3 轮 · 查看」 on top of a conversation while a goal drives it (spec §5.3). 查看 opens
 * the 目标 panel in the right panel; a phone has none (the bar is the progress there).
 */
export function GoalBar({ sessionId }: { sessionId: string }) {
  const g = useSessionGoal(sessionId);
  const mobile = useStore((s) => s.mobile);
  if (!g) return null;
  return (
    <div className="goal-bar" role="status" data-goal={g.id}>
      <Icon name="goals" size={13} className="gb-ic" />
      <span className="gb-t" title={g.objective}>目标：{g.objective}</span>
      <span className="gb-r" title={`最多 ${g.maxTurns} 轮`}>第 {g.round} 轮</span>
      {!mobile && <button className="gb-go" onClick={() => showPanel('goals')} title="在右侧面板查看目标的执行图、规格和证据">查看</button>}
    </div>
  );
}
