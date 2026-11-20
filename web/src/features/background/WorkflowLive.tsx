import { useScopedSessionId } from '@/store';
import { clsx } from '@/util';
import { Icon } from '@/ui/icons';
import { CharacterIcon } from './Character';
import { agentColor, agentStateText, taskStateText } from './model';
import { openBackground, useBackground } from './state';
import { tr } from '@/i18n';

/**
 * In a conversation's Workflow card: the workflow's agents as it runs — a chip each, in its colour, by phase — and
 * 打开 to the 后台 page on it. Nothing while 后台 has not heard of this workflow (an old transcript, an older server).
 * `onlyRunning`: under a folded turn (the card itself is in the fold) — only while the workflow still runs.
 */
export function WorkflowLive({ toolUseId, onlyRunning }: { toolUseId: string; onlyRunning?: boolean }) {
  const sessionId = useScopedSessionId();
  const task = useBackground((s) => (sessionId ? s.sessions[sessionId]?.tasks.find((t) => t.toolUseId === toolUseId) : undefined));
  if (!sessionId || !task || (onlyRunning && task.status !== 'running')) return null;
  const running = task.agents.filter((a) => a.state === 'running').length;
  const done = task.agents.filter((a) => a.state === 'done').length;
  const phases = task.phases?.length ? task.phases : [{ index: 0, title: '' }];
  return (
    <div className={clsx('bg-wf', task.status === 'running' && 'live')} data-task={task.id}>
      <div className="bg-wf-head">
        <span className="t">{task.status === 'running' ? tr('{running} 个在跑 · {done}/{agentsCount} 完成', { running, done, agentsCount: task.agents.length }) : tr('{taskStateText} · {done}/{agentsCount} 完成', { taskStateText: taskStateText(task), done, agentsCount: task.agents.length })}</span>
        <span className="grow" />
        <button className="btn sm" onClick={() => openBackground(sessionId, task.id)} title={tr('自动化 › 运行中')}><Icon name="office" size={13} />{tr('在运行中里看')}</button>
      </div>
      {phases.map((p) => {
        const agents = task.agents.filter((a) => (p.index ? a.phase === p.index : true));
        if (!agents.length) return null;
        return (
          <div key={p.index} className="bg-wf-phase">
            {p.title && <div className="bg-wf-ph">{p.title}</div>}
            <div className="bg-wf-chips">
              {agents.map((a) => (
                <span key={a.key} className={clsx('bg-wf-chip', a.state)} style={{ '--c': agentColor(a.color) } as React.CSSProperties} title={`${a.label} · ${agentStateText(a)}${a.lastSummary ? ` · ${a.lastSummary}` : ''}`}>
                  <CharacterIcon color={a.color} type={a.agentType} state={a.state} size={16} still />
                  <span className="l">{a.label}</span>
                </span>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
