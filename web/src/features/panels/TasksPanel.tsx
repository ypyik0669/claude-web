import { useMemo, useState } from 'react';
import { useActive, useStore } from '@/store';
import { walkTools, type ToolUseBlock } from '@/model/conversation';
import { ws } from '@/ws/client';
import { clsx, fmtMs, toolSummary } from '@/util';

function Schedules() {
  const schedules = useStore((s) => s.schedules);
  const active = useActive();
  const toast = useStore((s) => s.toast);
  const loadHistory = useStore((s) => s.loadHistory);
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ name: '', prompt: '', everyMinutes: 60, cwd: '' });
  const submit = async () => {
    if (!f.prompt.trim() || !(f.cwd || active?.cwd)) return toast('需要提示词和工作目录');
    await ws.request({ kind: 'schedules.upsert', schedule: { name: f.name || f.prompt.slice(0, 30), prompt: f.prompt, everyMinutes: Number(f.everyMinutes) || 60, cwd: f.cwd || active!.cwd, enabled: true, permissionMode: 'acceptEdits' } }).catch((e) => toast(e.message));
    setAdding(false);
    setF({ name: '', prompt: '', everyMinutes: 60, cwd: '' });
  };
  return (
    <div className="section" style={{ padding: '0 4px' }}>
      <h5 style={{ display: 'flex', alignItems: 'center' }}>定时任务 <span style={{ flex: 1 }} /><button className="icon-btn" style={{ padding: '0 4px' }} onClick={() => setAdding(!adding)}>＋</button></h5>
      {adding && (
        <div style={{ padding: '4px 8px 8px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <input className="field" placeholder="名称（可选）" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <textarea className="code" style={{ minHeight: 60, fontFamily: 'var(--font)' }} placeholder="每次运行发送给 Claude 的提示词，例如：检查 CI 状态并总结" value={f.prompt} onChange={(e) => setF({ ...f, prompt: e.target.value })} />
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
            每 <input className="field" type="number" min={1} style={{ width: 70 }} value={f.everyMinutes} onChange={(e) => setF({ ...f, everyMinutes: Number(e.target.value) })} /> 分钟
            <input className="field" style={{ flex: 1 }} placeholder={active?.cwd ? `目录：${active.cwd}` : '工作目录'} value={f.cwd} onChange={(e) => setF({ ...f, cwd: e.target.value })} />
          </div>
          <div style={{ display: 'flex', gap: 6 }}><button className="btn sm primary" onClick={submit}>保存</button><button className="btn sm" onClick={() => setAdding(false)}>取消</button></div>
        </div>
      )}
      {schedules.map((sc) => (
        <div key={sc.id} className="row">
          <button className={clsx('toggle', sc.enabled && 'on')} onClick={() => ws.request({ kind: 'schedules.upsert', schedule: { id: sc.id, enabled: !sc.enabled, nextRunAt: !sc.enabled ? Date.now() + sc.everyMinutes * 60000 : undefined } })} />
          <div className="grow" style={{ cursor: sc.sessionId ? 'pointer' : undefined }} onClick={() => sc.sessionId && loadHistory(sc.sessionId)}>
            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{sc.name}</div>
            <div className="sub">每 {sc.everyMinutes} 分钟 · {sc.lastRunAt ? `上次 ${fmtMs(Date.now() - sc.lastRunAt)} 前` : '未运行'} {sc.enabled && sc.nextRunAt ? `· 下次 ${fmtMs(Math.max(0, sc.nextRunAt - Date.now()))} 后` : ''}</div>
          </div>
          <button className="btn sm ghost" title="立即运行" onClick={() => ws.request({ kind: 'schedules.runNow', id: sc.id }).catch((e) => toast(e.message))}>▶</button>
          <button className="btn sm ghost danger" title="删除" onClick={() => confirm('删除这个定时任务？') && ws.request({ kind: 'schedules.remove', id: sc.id })}>✕</button>
        </div>
      ))}
      {!schedules.length && !adding && <div style={{ padding: '2px 10px 8px', fontSize: 12, color: 'var(--fg-3)' }}>按固定间隔往一个会话里发提示词，比如定时巡检、定时汇总。</div>}
    </div>
  );
}

export function TasksPanel() {
  const active = useActive();
  const agents = useMemo(() => {
    if (!active) return [];
    const out: { tool: ToolUseBlock; depth: number }[] = [];
    for (const { tool, depth } of walkTools(active.conv.items)) if (tool.name === 'Agent' || tool.name === 'Task' || tool.name === 'Workflow' || (tool.name === 'Bash' && (tool.input as any).run_in_background)) out.push({ tool, depth });
    return out;
  }, [active?.version]);
  if (!active) return <div className="list"><Schedules /><div className="empty">打开一个会话后这里显示它的子代理和后台任务</div></div>;
  const tasks = [...active.conv.tasks.values()].sort((a, b) => b.startedAt - a.startedAt);
  const inspect = (id: string) => useStore.setState({ inspect: { sessionId: active.sessionId, toolUseId: id } });

  return (
    <div className="list">
      <Schedules />
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
