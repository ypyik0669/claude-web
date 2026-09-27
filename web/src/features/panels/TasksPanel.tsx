import { useMemo, useState } from 'react';
import { useScopedSession, useStore } from '@/store';
import { walkTools, type ToolUseBlock } from '@/model/conversation';
import { ws } from '@/ws/client';
import { clsx, fmtMs, toolSummary } from '@/util';
import { dlg } from '@/ui/dialog';
import { SchedulesView } from '@/features/automation/SchedulesView';
export { SchedulesView as Schedules };

export function TasksPanel() {
  const active = useScopedSession();
  const agents = useMemo(() => {
    if (!active) return [];
    const out: { tool: ToolUseBlock; depth: number }[] = [];
    for (const { tool, depth } of walkTools(active.conv.items)) if (tool.name === 'Agent' || tool.name === 'Task' || tool.name === 'Workflow' || (tool.name === 'Bash' && (tool.input as any).run_in_background)) out.push({ tool, depth });
    return out;
  }, [active?.version]);
  if (!active) return <div className="list"><SchedulesView compact /><div className="empty">打开一个会话后这里显示它的子代理和后台任务</div></div>;
  const tasks = [...active.conv.tasks.values()].sort((a, b) => b.startedAt - a.startedAt);
  const inspect = (id: string) => useStore.setState({ inspect: { sessionId: active.sessionId, toolUseId: id } });

  return (
    <div className="list">
      <SchedulesView compact />
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
        {!agents.length && !tasks.length && <div className="empty">本会话还没有子代理或后台任务</div>}
      </div>
    </div>
  );
}
