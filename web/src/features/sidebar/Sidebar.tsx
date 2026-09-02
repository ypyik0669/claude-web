import { useEffect, useMemo, useState } from 'react';
import { useStore } from '@/store';
import { ws } from '@/ws/client';
import { ago, basename, clsx } from '@/util';
import type { SessionSummary } from '@shared';

function SessionMenu({ s, onClose }: { s: SessionSummary; onClose: () => void }) {
  const openSession = useStore((st) => st.openSession);
  const closeSession = useStore((st) => st.closeSession);
  const refresh = useStore((st) => st.refreshSessions);
  const toast = useStore((st) => st.toast);
  const open = useStore((st) => st.open[s.sessionId]);
  useEffect(() => {
    const k = () => onClose();
    window.addEventListener('click', k);
    return () => window.removeEventListener('click', k);
  }, [onClose]);
  const rename = async () => {
    const t = prompt('新标题', s.title);
    if (t && t !== s.title) await ws.request({ kind: 'session.rename', sessionId: s.sessionId, title: t }).catch((e) => toast(e.message));
    onClose();
  };
  const del = async () => {
    if (!confirm(`删除会话「${s.title}」？文件会从磁盘移除。`)) return;
    await closeSession(s.sessionId);
    await ws.request({ kind: 'session.delete', sessionId: s.sessionId }).catch((e) => toast(e.message));
    await refresh();
    onClose();
  };
  return (
    <div className="menu" style={{ right: 8, top: 28 }} onClick={(e) => e.stopPropagation()}>
      <button onClick={() => { openSession({ sessionId: s.sessionId, cwd: s.cwd }).catch((e) => toast(e.message)); onClose(); }}>▶ 恢复运行</button>
      <button onClick={() => { openSession({ sessionId: s.sessionId, cwd: s.cwd, fork: true }).catch((e) => toast(e.message)); onClose(); }}>⑂ 分叉</button>
      <button onClick={rename}>✎ 重命名</button>
      {open && open.state !== 'history' && <button onClick={() => { closeSession(s.sessionId); onClose(); }}>⏻ 结束进程</button>}
      <button onClick={() => { navigator.clipboard.writeText(s.sessionId); toast('已复制 session id', true); onClose(); }}>⧉ 复制 ID</button>
      <button className="danger" onClick={del}>🗑 删除</button>
    </div>
  );
}

export function Sidebar({ onNew }: { onNew: () => void }) {
  const sessions = useStore((s) => s.sessions);
  const open = useStore((s) => s.open);
  const activeId = useStore((s) => s.activeId);
  const connected = useStore((s) => s.connected);
  const loadHistory = useStore((s) => s.loadHistory);
  const setActive = useStore((s) => s.setActive);
  const togglePanel = useStore((s) => s.togglePanel);
  const panels = useStore((s) => s.panels);
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const [q, setQ] = useState('');
  const [menu, setMenu] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => JSON.parse(localStorage.getItem('cw.collapsed') ?? '{}'));

  const groups = useMemo(() => {
    const m = new Map<string, SessionSummary[]>();
    const ql = q.trim().toLowerCase();
    for (const s of sessions) {
      if (ql && !`${s.title} ${s.firstPrompt ?? ''} ${s.cwd}`.toLowerCase().includes(ql)) continue;
      const k = s.cwd || '(未知目录)';
      (m.get(k) ?? m.set(k, []).get(k)!).push(s);
    }
    return [...m.entries()].sort((a, b) => b[1][0].lastModified - a[1][0].lastModified);
  }, [sessions, q]);

  const running = Object.values(open).filter((o) => o.state === 'running' || o.state === 'waiting');

  const pick = (s: SessionSummary) => {
    if (open[s.sessionId]) setActive(s.sessionId);
    else void loadHistory(s.sessionId);
  };
  const toggleGroup = (k: string) => {
    const next = { ...collapsed, [k]: !collapsed[k] };
    setCollapsed(next);
    localStorage.setItem('cw.collapsed', JSON.stringify(next));
  };

  return (
    <>
      <div className="sb-top">
        <span className="brand"><span className="logo">✱</span>Claude Web</span>
        <button className="icon-btn" title="收起侧栏" onClick={() => useStore.setState({ sidebarOpen: false })}>⇤</button>
      </div>
      <div className="sb-nav">
        <button className={clsx('nav', !activeId && 'active')} onClick={onNew}><span className="ic">＋</span>新会话<span className="k kbd">Ctrl N</span></button>
        <button className={clsx('nav', panels.includes('config') && 'active')} onClick={() => togglePanel('config')}><span className="ic">⚙</span>配置中心</button>
        <button className={clsx('nav', panels.includes('usage') && 'active')} onClick={() => togglePanel('usage')}><span className="ic">▤</span>用量</button>
      </div>
      <div className="sb-search">
        <input placeholder="搜索会话…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="sb-list">
        {running.length > 0 && !q && (
          <div className="proj">
            <div className="proj-head"><span className="name">运行中</span><span className="cnt">{running.length}</span></div>
            {running.map((o) => {
              const s = sessions.find((x) => x.sessionId === o.sessionId);
              return (
                <div key={o.sessionId} className={clsx('sess', activeId === o.sessionId && 'active')} onClick={() => setActive(o.sessionId)}>
                  <span className={clsx('dot', o.state)} />
                  <span className="t">{s?.title ?? o.sessionId.slice(0, 8)}</span>
                  <span className="ago">{basename(o.cwd)}</span>
                </div>
              );
            })}
          </div>
        )}
        {groups.map(([cwd, list]) => (
          <div className="proj" key={cwd}>
            <div className="proj-head" onClick={() => toggleGroup(cwd)} title={cwd}>
              <span className="name">{basename(cwd) || cwd}</span>
              <span className="cnt">{collapsed[cwd] ? `${list.length} ▸` : list.length}</span>
            </div>
            {!collapsed[cwd] &&
              list.slice(0, q ? 200 : 25).map((s) => {
                const live = open[s.sessionId]?.state ?? s.live;
                const isLive = live && live !== 'history' && live !== 'closed';
                return (
                  <div key={s.sessionId} className={clsx('sess', activeId === s.sessionId && 'active')} onClick={() => pick(s)} title={s.firstPrompt}>
                    {isLive ? <span className={clsx('dot', live)} /> : null}
                    <span className="t">{s.title}</span>
                    <span className="ago">{ago(s.lastModified)}</span>
                    <button className="more" onClick={(e) => { e.stopPropagation(); setMenu(menu === s.sessionId ? null : s.sessionId); }}>⋯</button>
                    {menu === s.sessionId && <SessionMenu s={s} onClose={() => setMenu(null)} />}
                  </div>
                );
              })}
            {!collapsed[cwd] && list.length > 25 && !q && <div className="sess" style={{ color: 'var(--fg-3)', fontSize: 11.5 }}>还有 {list.length - 25} 个 · 用搜索查找</div>}
          </div>
        ))}
        {!groups.length && <div className="empty">没有会话</div>}
      </div>
      <div className="sb-foot">
        <span className={clsx('dot', connected ? 'idle' : 'error')} />
        <span>{connected ? '已连接' : '重连中…'}</span>
        <span style={{ flex: 1 }} />
        <button className="icon-btn" title="切换主题" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? '☾' : '☀'}</button>
      </div>
    </>
  );
}
