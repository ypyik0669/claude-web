import { useState } from 'react';
import { useActive, useStore, type PanelId } from '@/store';
import { ws } from '@/ws/client';
import { basename, clsx } from '@/util';

const PANELS: { id: PanelId; l: string; ic: string }[] = [
  { id: 'tasks', l: '任务', ic: '◔' },
  { id: 'files', l: '文件', ic: '≡' },
  { id: 'usage', l: '用量', ic: '▤' },
  { id: 'config', l: '配置', ic: '⚙' },
  { id: 'terminal', l: '终端', ic: '▣' },
];

export function TopBar() {
  const active = useActive();
  const sessions = useStore((s) => s.sessions);
  const tab = useStore((s) => s.tab);
  const setTab = useStore((s) => s.setTab);
  const panels = useStore((s) => s.panels);
  const togglePanel = useStore((s) => s.togglePanel);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const openSession = useStore((s) => s.openSession);
  const closeSession = useStore((s) => s.closeSession);
  const toast = useStore((s) => s.toast);
  const [editing, setEditing] = useState<string | null>(null);

  const meta = active ? sessions.find((s) => s.sessionId === active.sessionId) : undefined;
  const title = meta?.title ?? active?.sessionId.slice(0, 8) ?? '';
  const live = active && active.state !== 'history' && active.state !== 'closed' && active.state !== 'error';

  const rename = async () => {
    if (editing !== null && active && editing.trim() && editing !== title) await ws.request({ kind: 'session.rename', sessionId: active.sessionId, title: editing.trim() }).catch((e) => toast(e.message));
    setEditing(null);
  };

  return (
    <div className="topbar">
      {!sidebarOpen && (
        <button className="icon-btn" onClick={() => useStore.setState({ sidebarOpen: true })} title="展开侧栏">☰</button>
      )}
      {active ? (
        <div className="title" onDoubleClick={() => setEditing(title)} title="双击重命名">
          {live && <span className={clsx('dot', active.state)} />}
          {editing !== null ? (
            <input autoFocus value={editing} onChange={(e) => setEditing(e.target.value)} onBlur={rename} onKeyDown={(e) => (e.key === 'Enter' ? rename() : e.key === 'Escape' ? setEditing(null) : null)} />
          ) : (
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</span>
          )}
          <span className="sub" title={active.cwd}>
            {basename(active.cwd)}{meta?.gitBranch ? ` · ${meta.gitBranch}` : ''}
          </span>
        </div>
      ) : (
        <div className="title" />
      )}
      <span className="grow" />
      {active && (
        <>
          <div className="seg">
            <button className={clsx(tab === 'chat' && 'active')} onClick={() => setTab('chat')}>对话</button>
            <button className={clsx(tab === 'trajectory' && 'active')} onClick={() => setTab('trajectory')}>轨迹</button>
          </div>
          <button className="icon-btn" title="从当前会话分叉" onClick={() => openSession({ sessionId: active.sessionId, cwd: active.cwd, fork: true }).catch((e) => toast(e.message))}>⑂</button>
          {live ? (
            <button className="icon-btn" title="结束进程（可随时恢复）" onClick={() => closeSession(active.sessionId)}>⏻</button>
          ) : (
            <button className="btn sm ghost" onClick={() => openSession({ sessionId: active.sessionId, cwd: active.cwd }).catch((e) => toast(e.message))}>▶ 恢复</button>
          )}
          <span style={{ width: 1, height: 18, background: 'var(--line)', margin: '0 4px' }} />
        </>
      )}
      {PANELS.map((p) => (
        <button key={p.id} className={clsx('icon-btn', panels.includes(p.id) && 'active')} onClick={() => togglePanel(p.id)} title={p.l} style={{ fontSize: 12.5, gap: 5, padding: '4px 8px' }}>
          <span style={{ fontSize: 13 }}>{p.ic}</span> {p.l}
        </button>
      ))}
    </div>
  );
}
