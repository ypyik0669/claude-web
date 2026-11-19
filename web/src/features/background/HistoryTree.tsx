import type { CSSProperties } from 'react';
import type { BgAgent, BgTask } from '@shared';
import { clsx } from '@/util';
import { Icon } from '@/ui/icons';
import { agentColor, agentStateText, clock, KIND_LABEL, taskStateText, taskTitle } from './model';
import { HISTORY_GRAPH_MAX } from './history-model';
import { tr } from '@/i18n';

/** An agent's line: its state and how long it ran (so far, while it replays). */
function agentLine(a: BgAgent, at: number): string {
  if (a.state === 'queued' || a.startedAt === undefined) return agentStateText(a);
  return `${agentStateText(a)} ${clock((a.endedAt ?? at) - a.startedAt)}`;
}

/**
 * 跑过的 on a phone: the run's graph standing up — each phase a heading with how many of its agents are done, its
 * agents one per row under it (a sub-agent: itself; a command: its line). A row opens the agent's conversation.
 */
export function HistoryTree({ task, at, onPick }: { task: BgTask; at: number; onPick: (agentKey: string) => void }) {
  if (task.kind === 'shell' || !task.agents.length) {
    return (
      <div className="hx-tree">
        <div className="hx-tag shell" data-state={task.status}>
          <Icon name={task.kind === 'shell' ? 'terminal' : 'workflow'} size={14} />
          <b>{taskTitle(task)}</b>
          <small>{KIND_LABEL[task.kind]} · {taskStateText(task)}</small>
        </div>
      </div>
    );
  }
  const phases = task.phases?.length ? task.phases : [...new Map(task.agents.filter((a) => a.phase != null).map((a) => [a.phase!, { index: a.phase!, title: a.phaseTitle ?? tr('阶段 {index}', { index: a.phase! }) }])).values()];
  const groups = phases.map((p) => ({ key: `p${p.index}`, title: p.title, agents: task.agents.filter((a) => a.phase === p.index) }));
  const loose = task.agents.filter((a) => !phases.some((p) => p.index === a.phase));
  if (loose.length) groups.push({ key: 'rest', title: task.kind === 'agent' ? KIND_LABEL.agent : tr('其它'), agents: loose });
  let left = HISTORY_GRAPH_MAX;
  let more = 0;
  return (
    <div className="hx-tree">
      {groups.map((g) => {
        const shown = g.agents.slice(0, Math.max(0, left));
        left -= shown.length;
        more += g.agents.length - shown.length;
        return (
          <section key={g.key} className="hx-tsec">
            <div className="hx-tph"><b>{g.title}</b><small>{g.agents.filter((a) => a.state === 'done').length} / {g.agents.length}</small></div>
            {shown.map((a) => (
              <button key={a.key} type="button" className={clsx('hx-tag', a.state)} data-agent={a.key} style={{ '--c': agentColor(a.color) } as CSSProperties} onClick={() => onPick(a.key)}>
                <i className="dot" aria-hidden />
                <b>{a.label}</b>
                <small>{agentLine(a, at)}</small>
              </button>
            ))}
          </section>
        );
      })}
      {more > 0 && <div className="hx-tmore">{tr('还有 {more} 个', { more })}</div>}
    </div>
  );
}
