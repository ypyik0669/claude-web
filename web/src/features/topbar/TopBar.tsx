import { useState } from 'react';
import { useActive, useStore, type PanelId } from '@/store';
import { ws } from '@/ws/client';
import { clsx, shortModel } from '@/util';
import type { EffortLevel, PermissionMode } from '@shared';

const MODE_LABEL: Record<PermissionMode, string> = { default: '默认权限', acceptEdits: '自动接受编辑', plan: '计划模式', auto: '自动模式', bypassPermissions: '完全权限', dontAsk: '不询问' };
const PANELS: { id: PanelId; l: string }[] = [
  { id: 'tasks', l: '任务' },
  { id: 'files', l: '文件' },
  { id: 'usage', l: '用量' },
  { id: 'config', l: '配置' },
  { id: 'terminal', l: '终端' },
];

export function TopBar({ onNew }: { onNew: () => void }) {
  const active = useActive();
  const sessions = useStore((s) => s.sessions);
  const tab = useStore((s) => s.tab);
  const setTab = useStore((s) => s.setTab);
  const panels = useStore((s) => s.panels);
  const togglePanel = useStore((s) => s.togglePanel);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const openSession = useStore((s) => s.openSession);
  const closeSession = useStore((s) => s.closeSession);
  const [editing, setEditing] = useState<string | null>(null);

  const meta = active ? sessions.find((s) => s.sessionId === active.sessionId) : undefined;
  const title = meta?.title ?? active?.sessionId.slice(0, 8) ?? '';
  const info = active?.info;
  const live = active && active.state !== 'history' && active.state !== 'closed' && active.state !== 'error';
  const runningTasks = active ? [...active.conv.tasks.values()].filter((t) => t.status === 'running').length : 0;

  const rename = async () => {
    if (editing !== null && active && editing.trim() && editing !== title) await ws.request({ kind: 'session.rename', sessionId: active.sessionId, title: editing.trim() });
    setEditing(null);
  };

  const setMode = (mode: PermissionMode) => active && ws.request({ kind: 'session.setPermissionMode', sessionId: active.sessionId, mode });
  const setModel = (model: string) => active && ws.request({ kind: 'session.setModel', sessionId: active.sessionId, model });
  const setEffort = (effort: EffortLevel) => active && ws.request({ kind: 'session.setEffort', sessionId: active.sessionId, effort });

  return (
    <>
      <div className="topbar">
        {!sidebarOpen && (
          <button className="icon-btn" onClick={() => useStore.setState({ sidebarOpen: true })} title="展开侧栏">
            ◨
          </button>
        )}
        {active ? (
          <div className="title" onDoubleClick={() => setEditing(title)} title="双击重命名">
            {editing !== null ? <input autoFocus value={editing} onChange={(e) => setEditing(e.target.value)} onBlur={rename} onKeyDown={(e) => (e.key === 'Enter' ? rename() : e.key === 'Escape' ? setEditing(null) : null)} /> : title}
          </div>
        ) : (
          <div className="title">Claude Web</div>
        )}
        {active && (
          <>
            {live && info ? (
              <>
                <label className="chip" title="模型">
                  <select value={info.model ?? ''} onChange={(e) => setModel(e.target.value)}>
                    {info.models?.length ? info.models.map((m) => <option key={m.value} value={m.value}>{m.displayName}</option>) : <option value={info.model ?? ''}>{shortModel(info.model)}</option>}
                    {info.model && !info.models?.some((m) => m.value === info.model) && <option value={info.model}>{shortModel(info.model)}</option>}
                  </select>
                </label>
                <label className="chip" title="Effort">
                  <select value={info.effort ?? ''} onChange={(e) => setEffort(e.target.value as EffortLevel)}>
                    <option value="" disabled>effort</option>
                    {['low', 'medium', 'high', 'xhigh', 'max'].map((l) => <option key={l} value={l}>{l}</option>)}
                  </select>
                </label>
                <label className={clsx('chip', info.permissionMode === 'bypassPermissions' && 'warn')} title="权限模式">
                  <select value={info.permissionMode ?? 'default'} onChange={(e) => setMode(e.target.value as PermissionMode)}>
                    {(Object.keys(MODE_LABEL) as PermissionMode[]).map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
                  </select>
                </label>
              </>
            ) : (
              <button className="chip" onClick={() => openSession({ sessionId: active.sessionId, cwd: active.cwd })} title="启动进程并继续这个会话">
                ▶ 继续会话
              </button>
            )}
            {runningTasks > 0 && (
              <button className="chip" onClick={() => !panels.includes('tasks') && togglePanel('tasks')}>
                {runningTasks} 个后台任务
              </button>
            )}
            <button className="chip" title="从当前会话分叉出新会话" onClick={() => openSession({ sessionId: active.sessionId, cwd: active.cwd, fork: true })}>
              ⑂
            </button>
            {live && (
              <button className="chip" title="结束进程（会话仍可 resume）" onClick={() => closeSession(active.sessionId)}>
                ■
              </button>
            )}
          </>
        )}
        <span className="grow" />
        {PANELS.map((p) => (
          <button key={p.id} className={clsx('icon-btn', panels.includes(p.id) && 'active')} onClick={() => togglePanel(p.id)} style={{ fontSize: 12, padding: '3px 7px' }}>
            {p.l}
          </button>
        ))}
        <button className="btn sm" onClick={onNew}>
          ＋
        </button>
      </div>
      {active && (
        <div className="tabs">
          <button className={clsx('tab', tab === 'chat' && 'active')} onClick={() => setTab('chat')}>
            对话
          </button>
          <button className={clsx('tab', tab === 'trajectory' && 'active')} onClick={() => setTab('trajectory')}>
            轨迹
          </button>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 11.5, color: 'var(--fg-2)', alignSelf: 'center' }} title={active.cwd}>
            {active.cwd} {meta?.gitBranch ? `· ${meta.gitBranch}` : ''} {info?.claudeCodeVersion ? `· v${info.claudeCodeVersion}` : ''}
          </span>
        </div>
      )}
    </>
  );
}
