import { useMemo } from 'react';
import { useScopedSession, useStore } from '@/store';
import { walkTools, type ToolUseBlock } from '@/model/conversation';
import { workbenchOn } from '@/model/layout';
import { clsx, toolSummary } from '@/util';
import { SchedulesView } from '@/features/automation/SchedulesView';
import { TodoBody, planItems, planProgress } from '@/features/chat/tools/AgentTool';
import { openSchedules } from '@/features/workbench/right-panel';
import { CommandGraph } from '@/features/background/CommandGraph';
import { CharacterIcon } from '@/features/background/Character';
import { agentColor, agentStateText, KIND_LABEL, orderedTasks, taskStateText, taskTitle } from '@/features/background/model';
import { openAgent, openBackground, stopTask, useBgSession } from '@/features/background/state';
import { EmptyState } from '@/ui/EmptyState';
import { EMPTY } from '@/ui/terms';
import { Icon } from '@/ui/icons';
import { tr } from '@/i18n';
export { SchedulesView as Schedules };

/**
 * 定时任务 moved to the automation page (spec §5.6 / §5.9): in the default look 任务 keeps one line that goes there
 * — with or without a conversation. (With 「显示工作台工具」 the list sits on top of 任务, as before the redesign.)
 */
function SchedulesLink() {
  const n = useStore((s) => s.schedules.length);
  return (
    <div className="tasks-sched">
      <button className="tasks-link" onClick={() => openSchedules()} title={tr('定时任务：按时间自动开一个对话做事（在「自动化」里）')}>
        <Icon name="tasks" size={13} /> {tr('定时任务{v}', { v: n ? ` · ${n}` : '' })}<span className="grow" /><span className="to">{tr('在「自动化」里')}</span><Icon name="chevronRight" size={12} />
      </button>
    </div>
  );
}

/**
 * The conversation's background, small (后台, spec 2026-10-12 §3): the command graph and every task with its agents,
 * a Stop each; an agent opens its own conversation on the 后台 page.
 */
function Background({ sessionId }: { sessionId: string }) {
  const s = useBgSession(sessionId);
  if (!s || !s.tasks.length) return null;
  const pick = (agentKey: string, taskId: string) => { openBackground(sessionId, taskId); openAgent({ sessionId, taskId, agentKey }); };
  return (
    <div className="section bg-tasks" style={{ padding: '0 4px' }}>
      <h5>{tr('后台')}<button className="tasks-open" onClick={() => openBackground(sessionId)} title={tr('在 自动化 › 运行中 里看')}><Icon name="office" size={13} />{tr('打开')}</button></h5>
      <div className="bg-tasks-graph"><CommandGraph session={s} compact onPick={pick} /></div>
      {orderedTasks(s).map((t) => (
        <div key={t.id} className={clsx('bg-ttask', t.status === 'running' && 'live')} data-task={t.id}>
          <div className="row">
            <Icon name={t.kind === 'workflow' ? 'workflow' : t.kind === 'shell' ? 'terminal' : 'agent'} size={14} />
            <div className="grow">
              <div className="n">{taskTitle(t)}</div>
              <div className="sub">{KIND_LABEL[t.kind]} · {taskStateText(t)}</div>
            </div>
            {t.status === 'running' && <button className="btn sm danger" onClick={() => stopTask(sessionId, t.id)}>{tr('停止')}</button>}
          </div>
          {t.kind === 'workflow' && t.agents.map((a) => (
            <button key={a.key} className="bg-tagent" style={{ '--c': agentColor(a.color) } as React.CSSProperties} onClick={() => pick(a.key, t.id)} title={a.lastSummary ?? a.label}>
              <CharacterIcon color={a.color} type={a.agentType} state={a.state} size={16} still />
              <span className="l">{a.label}</span>
              <span className={clsx('st', a.state)}>{agentStateText(a)}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * 任务: what the current conversation has running or planned — its background (后台: workflows and their agents,
 * sub-agents, background commands) and its latest TodoWrite plan. Other agents (no 后台 there) keep the sub-agent /
 * background-call tree from the conversation. The scheduled tasks list sits on top only with 「显示工作台工具」 (as
 * before the redesign); by default a line at the bottom opens them on the automation page.
 */
export function TasksPanel(_: { inDock?: boolean }) {
  const active = useScopedSession();
  const workbench = useStore((s) => workbenchOn(s.settings));
  const bg = useBgSession(active?.sessionId);
  const { agents, plan } = useMemo(() => {
    const agents: { tool: ToolUseBlock; depth: number }[] = [];
    let plan: ToolUseBlock | null = null;
    if (!active) return { agents, plan };
    for (const { tool, depth } of walkTools(active.conv.items)) {
      if (tool.name === 'Agent' || tool.name === 'Task' || tool.name === 'Workflow' || (tool.name === 'Bash' && (tool.input as any).run_in_background)) agents.push({ tool, depth });
      if (tool.name === 'TodoWrite' && depth === 0) plan = tool;
    }
    return { agents, plan };
  }, [active?.version]);
  if (!active) {
    return (
      <div className="list tasks-panel">
        {workbench && <SchedulesView compact />}
        <EmptyState e={EMPTY.tasksNoChat} />
        {!workbench && <SchedulesLink />}
      </div>
    );
  }
  const hasBg = !!bg?.tasks.length;
  const prog = plan ? planProgress(planItems(plan)) : null;
  const inspect = (id: string) => useStore.setState({ inspect: { sessionId: active.sessionId, toolUseId: id } });

  return (
    <div className="list tasks-panel">
      {workbench && <SchedulesView compact />}
      <Background sessionId={active.sessionId} />
      {plan && (
        <div className="section tasks-plan" style={{ padding: '0 4px' }} data-done={prog?.done} data-total={prog?.total}>
          {/* GitHub issue #2: 「3/7 完成」 alone did not show at a glance how far a long plan is — a bar like a goal's */}
          <h5 className="plan-head" {...(prog?.attrs as any)}>
            {tr('计划')}
            {prog && prog.total > 0 && <span className="plan-count">{prog.done}/{prog.total}</span>}
            {prog && prog.total > 0 && <span className="plan-prog" role="progressbar" aria-label={tr('计划进度')} aria-valuemin={0} aria-valuemax={prog.total} aria-valuenow={prog.done}><i style={{ width: `${prog.pct}%` }} /></span>}
          </h5>
          <TodoBody t={plan} count={false} />
        </div>
      )}
      {!hasBg && agents.length > 0 && (
        <div className="section" style={{ padding: '0 4px' }}>
          <h5>{tr('子代理 / 后台调用')}</h5>
          {agents.map(({ tool, depth }) => (
            <div key={tool.id} className="row clickable" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => inspect(tool.id)}>
              <span className={clsx('dot', tool.status === 'running' || tool.status === 'pending' ? 'running' : tool.status === 'error' ? 'error' : 'idle')} />
              <div className="grow">
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{toolSummary(tool.name, tool.input)}</div>
                <div className="sub">
                  {tr('{name} · {childrenCount} 条消息 {v}', { name: tool.name, childrenCount: tool.children.length, v: tool.progress?.lastTool ? `· ${tool.progress.lastTool}` : '' })}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {!hasBg && !agents.length && !plan && <EmptyState e={EMPTY.tasks} />}
      {!workbench && <SchedulesLink />}
    </div>
  );
}
