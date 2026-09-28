import { useMemo } from 'react';
import { useScopedSession, useStore } from '@/store';
import { walkTools, type ToolUseBlock } from '@/model/conversation';
import { workbenchOn } from '@/model/layout';
import { ws } from '@/ws/client';
import { clsx, fmtMs, toolSummary } from '@/util';
import { SchedulesView } from '@/features/automation/SchedulesView';
import { TodoBody } from '@/features/chat/tools/AgentTool';
import { openSchedules } from '@/features/workbench/right-panel';
import { EmptyState } from '@/ui/EmptyState';
import { EMPTY } from '@/ui/terms';
import { Icon } from '@/ui/icons';
export { SchedulesView as Schedules };

/**
 * 定时任务 moved to the automation page (spec §5.6 / §5.9): in the default look 任务 keeps one line that goes there
 * — with or without a conversation. (With 「显示工作台工具」 the list sits on top of 任务, as before the redesign.)
 */
function SchedulesLink() {
  const n = useStore((s) => s.schedules.length);
  return (
    <div className="tasks-sched">
      <button className="tasks-link" onClick={() => openSchedules()} title="定时任务：按时间自动开一个对话做事（在「自动化」里）">
        <Icon name="tasks" size={13} /> 定时任务{n ? ` · ${n}` : ''}<span className="grow" /><span className="to">在「自动化」里</span><Icon name="chevronRight" size={12} />
      </button>
    </div>
  );
}

/**
 * 任务: what the current conversation has running or planned — background tasks, the sub-agent / background-call
 * tree and its latest TodoWrite plan. The scheduled tasks list sits on top only with 「显示工作台工具」 (as before
 * the redesign); by default a line at the bottom opens them on the automation page.
 */
export function TasksPanel(_: { inDock?: boolean }) {
  const active = useScopedSession();
  const workbench = useStore((s) => workbenchOn(s.settings));
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
  const tasks = [...active.conv.tasks.values()].sort((a, b) => b.startedAt - a.startedAt);
  const inspect = (id: string) => useStore.setState({ inspect: { sessionId: active.sessionId, toolUseId: id } });

  return (
    <div className="list tasks-panel">
      {workbench && <SchedulesView compact />}
      {tasks.length > 0 && (
        <div className="section" style={{ padding: '0 4px' }}>
          <h5>任务</h5>
          {tasks.map((t) => (
            <div key={t.id} className={clsx('row', t.toolUseId && 'clickable')} onClick={() => t.toolUseId && inspect(t.toolUseId)}>
              <span className={clsx('dot', t.status === 'running' ? 'running' : t.status === 'failed' ? 'error' : 'idle')} />
              <div className="grow">
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.description}</div>
                <div className="sub">
                  {t.subagentType ?? t.type ?? ''} {t.lastTool ? `· ${t.lastTool}` : ''} {t.summary ? `· ${t.summary}` : ''} · {fmtMs((t.endedAt ?? Date.now()) - t.startedAt)}
                </div>
              </div>
              {t.status === 'running' && (
                <button className="btn sm danger" onClick={(e) => { e.stopPropagation(); void ws.request({ kind: 'session.stopTask', sessionId: active.sessionId, taskId: t.id }); }}>
                  停止
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {plan && (
        <div className="section tasks-plan" style={{ padding: '0 4px' }}>
          <h5>计划</h5>
          <TodoBody t={plan} />
        </div>
      )}
      <div className="section" style={{ padding: '0 4px' }}>
        <h5>子代理 / 后台调用树</h5>
        {agents.map(({ tool, depth }) => (
          <div key={tool.id} className="row clickable" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => inspect(tool.id)}>
            <span className={clsx('dot', tool.status === 'running' || tool.status === 'pending' ? 'running' : tool.status === 'error' ? 'error' : 'idle')} />
            <div className="grow">
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{toolSummary(tool.name, tool.input)}</div>
              <div className="sub">
                {tool.name} · {tool.children.length} 条消息 {tool.progress?.lastTool ? `· ${tool.progress.lastTool}` : ''}
              </div>
            </div>
          </div>
        ))}
        {!agents.length && !tasks.length && <EmptyState e={EMPTY.tasks} />}
      </div>
      {!workbench && <SchedulesLink />}
    </div>
  );
}
