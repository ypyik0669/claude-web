import { useEffect, useMemo, useState } from 'react';
import { useStore } from '@/store';
import { ws } from '@/ws/client';
import { ago, basename, clsx } from '@/util';
import type { SessionSummary, Workspace } from '@shared';

function SessionMenu({ s, onClose }: { s: SessionSummary; onClose: () => void }) {
  const st = useStore();
  const open = st.open[s.sessionId];
  const meta = st.sessionMeta[s.sessionId] ?? {};
  useEffect(() => {
    const k = () => onClose();
    window.addEventListener('click', k);
    return () => window.removeEventListener('click', k);
  }, [onClose]);
  const rename = async () => {
    const t = prompt('新标题', s.title);
    if (t && t !== s.title) await ws.request({ kind: 'session.rename', sessionId: s.sessionId, title: t }).catch((e) => st.toast(e.message));
    onClose();
  };
  const del = async () => {
    if (!confirm(`删除会话「${s.title}」？文件会从磁盘移除。`)) return;
    await st.closeSession(s.sessionId);
    await ws.request({ kind: 'session.delete', sessionId: s.sessionId }).catch((e) => st.toast(e.message));
    await st.refreshSessions();
    onClose();
  };
  const act = (fn: () => unknown) => () => { void fn(); onClose(); };
  return (
    <div className="menu" style={{ right: 8, top: 28 }} onClick={(e) => e.stopPropagation()}>
      <button onClick={act(() => st.openSession({ sessionId: s.sessionId, cwd: s.cwd }).catch((e) => st.toast(e.message)))}>▶ 恢复运行</button>
      <button onClick={act(() => st.openSession({ sessionId: s.sessionId, cwd: s.cwd, fork: true }).catch((e) => st.toast(e.message)))}>⑂ 分叉</button>
      <button onClick={act(() => st.setSessionMeta(s.sessionId, { pinned: !meta.pinned }))}>{meta.pinned ? '⊝ 取消置顶' : '📌 置顶'}</button>
      <button onClick={act(() => st.setSessionMeta(s.sessionId, { archived: !meta.archived }))}>{meta.archived ? '↥ 取消归档' : '🗄 归档'}</button>
      <button onClick={rename}>✎ 重命名</button>
      <button onClick={act(() => ws.request({ kind: 'shell.open', path: s.cwd }))}>▤ 在资源管理器打开</button>
      <button onClick={act(() => ws.request({ kind: 'shell.open', path: s.cwd, app: 'code' }))}>⌨ 在 VS Code 打开</button>
      {open && open.state !== 'history' && <button onClick={act(() => st.closeSession(s.sessionId))}>⏻ 结束进程</button>}
      <button onClick={act(() => { navigator.clipboard.writeText(s.sessionId); st.toast('已复制 session id', true); })}>⧉ 复制 ID</button>
      <button className="danger" onClick={del}>🗑 删除</button>
    </div>
  );
}

function SessionRow({ s, menu, setMenu }: { s: SessionSummary; menu: string | null; setMenu: (v: string | null) => void }) {
  const open = useStore((st) => st.open[s.sessionId]);
  const activeId = useStore((st) => st.activeId);
  const meta = useStore((st) => st.sessionMeta[s.sessionId]);
  const loadHistory = useStore((st) => st.loadHistory);
  const setActive = useStore((st) => st.setActive);
  const live = open?.state ?? s.live;
  const isLive = live && live !== 'history' && live !== 'closed';
  return (
    <div className={clsx('sess', activeId === s.sessionId && 'active')} onClick={() => (open ? setActive(s.sessionId) : loadHistory(s.sessionId))} title={s.firstPrompt}>
      {isLive ? <span className={clsx('dot', live)} /> : meta?.pinned ? <span style={{ fontSize: 10, color: 'var(--fg-3)' }}>📌</span> : null}
      <span className="t">{s.title}</span>
      <span className="ago">{ago(s.lastModified)}</span>
      <button className="more" onClick={(e) => { e.stopPropagation(); setMenu(menu === s.sessionId ? null : s.sessionId); }}>⋯</button>
      {menu === s.sessionId && <SessionMenu s={s} onClose={() => setMenu(null)} />}
    </div>
  );
}

function WorkspaceMenu({ w, onClose }: { w: Workspace; onClose: () => void }) {
  const st = useStore();
  useEffect(() => {
    const k = () => onClose();
    window.addEventListener('click', k);
    return () => window.removeEventListener('click', k);
  }, [onClose]);
  const act = (fn: () => unknown) => () => { void fn(); onClose(); };
  return (
    <div className="menu" style={{ right: 8, top: 26 }} onClick={(e) => e.stopPropagation()}>
      <button onClick={act(() => st.openSession({ cwd: w.path }))}>＋ 在这里新建会话</button>
      <button onClick={act(async () => { const n = prompt('worktree 名称', 'feature'); if (n) await st.openSession({ cwd: w.path, worktree: n }).catch((e) => st.toast(e.message)); })}>⑂ 新建 worktree 会话</button>
      <button onClick={act(async () => { const n = prompt('工作区名称', w.name); if (n) await ws.request({ kind: 'workspaces.rename', id: w.id, name: n }); })}>✎ 重命名</button>
      <button onClick={act(() => ws.request({ kind: 'shell.open', path: w.path }))}>▤ 在资源管理器打开</button>
      <button onClick={act(() => ws.request({ kind: 'shell.open', path: w.path, app: 'code' }))}>⌨ 在 VS Code 打开</button>
      <button className="danger" onClick={act(() => ws.request({ kind: 'workspaces.remove', id: w.id }))}>✕ 移除工作区（不删文件）</button>
    </div>
  );
}

export function Sidebar({ onNew }: { onNew: () => void }) {
  const sessions = useStore((s) => s.sessions);
  const open = useStore((s) => s.open);
  const activeId = useStore((s) => s.activeId);
  const connected = useStore((s) => s.connected);
  const workspaces = useStore((s) => s.workspaces);
  const sessionMeta = useStore((s) => s.sessionMeta);
  const showArchived = useStore((s) => s.showArchived);
  const addWorkspace = useStore((s) => s.addWorkspace);
  const setActive = useStore((s) => s.setActive);
  const togglePanel = useStore((s) => s.togglePanel);
  const panels = useStore((s) => s.panels);
  const toast = useStore((s) => s.toast);
  const [q, setQ] = useState('');
  const [menu, setMenu] = useState<string | null>(null);
  const [wsMenu, setWsMenu] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => JSON.parse(localStorage.getItem('cw.collapsed') ?? '{}'));

  const ql = q.trim().toLowerCase();
  const visible = useMemo(() => sessions.filter((s) => (showArchived ? true : !sessionMeta[s.sessionId]?.archived) && (!ql || `${s.title} ${s.firstPrompt ?? ''} ${s.cwd}`.toLowerCase().includes(ql))), [sessions, sessionMeta, showArchived, ql]);
  const pinned = visible.filter((s) => sessionMeta[s.sessionId]?.pinned);
  const running = Object.values(open).filter((o) => o.state === 'running' || o.state === 'waiting');

  // group by workspace (longest matching path wins), remainder by cwd
  const grouped = useMemo(() => {
    const byWs = new Map<string, SessionSummary[]>();
    const other = new Map<string, SessionSummary[]>();
    const sorted = [...workspaces].sort((a, b) => b.path.length - a.path.length);
    for (const s of visible) {
      if (sessionMeta[s.sessionId]?.pinned) continue;
      const w = sorted.find((x) => s.cwd.toLowerCase().startsWith(x.path.toLowerCase()));
      const m = w ? byWs : other;
      const k = w ? w.id : s.cwd || '(未知目录)';
      (m.get(k) ?? m.set(k, []).get(k)!).push(s);
    }
    return { byWs, other: [...other.entries()].sort((a, b) => b[1][0].lastModified - a[1][0].lastModified) };
  }, [visible, workspaces, sessionMeta]);

  const toggleGroup = (k: string) => {
    const next = { ...collapsed, [k]: !collapsed[k] };
    setCollapsed(next);
    localStorage.setItem('cw.collapsed', JSON.stringify(next));
  };
  const pickWorkspace = async () => {
    const p = await ws.request<string | null>({ kind: 'fs.pickDir' });
    if (p) await addWorkspace(p).catch((e) => toast(e.message));
  };
  const list = (arr: SessionSummary[], k: string) => (
    <>
      {arr.slice(0, ql ? 200 : 25).map((s) => <SessionRow key={s.sessionId} s={s} menu={menu} setMenu={setMenu} />)}
      {arr.length > 25 && !ql && <div className="sess" style={{ color: 'var(--fg-3)', fontSize: 11.5 }} onClick={() => useStore.setState({ paletteOpen: true })}>还有 {arr.length - 25} 个 · Ctrl+K 搜索</div>}
      {!arr.length && k && <div className="sess" style={{ color: 'var(--fg-3)', fontSize: 12 }}>还没有会话</div>}
    </>
  );

  return (
    <>
      <div className="sb-top">
        <span className="brand"><span className="logo">✱</span>Claude Web</span>
        <button className="icon-btn" title="收起侧栏 (Ctrl+B)" onClick={() => useStore.setState({ sidebarOpen: false })}>⇤</button>
      </div>
      <div className="sb-nav">
        <button className={clsx('nav', !activeId && 'active')} onClick={onNew}><span className="ic">＋</span>新会话<span className="k kbd">Alt N</span></button>
        <button className="nav" onClick={() => useStore.setState({ paletteOpen: true })}><span className="ic">⌘</span>命令 / 搜索<span className="k kbd">Ctrl K</span></button>
        <button className={clsx('nav', panels.includes('config') && 'active')} onClick={() => togglePanel('config')}><span className="ic">⚙</span>配置中心</button>
        <button className={clsx('nav', panels.includes('usage') && 'active')} onClick={() => togglePanel('usage')}><span className="ic">▤</span>用量</button>
      </div>
      <div className="sb-search">
        <input placeholder="筛选会话…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="sb-list">
        {running.length > 0 && !ql && (
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
        {pinned.length > 0 && (
          <div className="proj">
            <div className="proj-head"><span className="name">置顶</span><span className="cnt">{pinned.length}</span></div>
            {list(pinned, '')}
          </div>
        )}
        <div className="proj">
          <div className="proj-head" style={{ cursor: 'default' }}>
            <span className="name">工作区</span>
            <button className="icon-btn" title="添加工作区（文件夹）" onClick={pickWorkspace} style={{ padding: '0 4px' }}>＋</button>
          </div>
          {!workspaces.length && (
            <div className="ws-empty">
              还没有工作区。工作区就是一个文件夹，会话在里面运行。
              <div><button className="btn sm" onClick={pickWorkspace}>＋ 添加工作区</button></div>
            </div>
          )}
          {workspaces.map((w) => {
            const arr = grouped.byWs.get(w.id) ?? [];
            return (
              <div key={w.id} style={{ marginBottom: 6, position: 'relative' }}>
                <div className="ws-head" onClick={() => toggleGroup(w.id)} title={w.path}>
                  <span className="ic">{collapsed[w.id] ? '▸' : '▾'}</span>
                  <span className="name">{w.name}</span>
                  <span className="cnt">{arr.length}</span>
                  <button className="more" onClick={(e) => { e.stopPropagation(); setWsMenu(wsMenu === w.id ? null : w.id); }}>⋯</button>
                  {wsMenu === w.id && <WorkspaceMenu w={w} onClose={() => setWsMenu(null)} />}
                </div>
                {!collapsed[w.id] && list(arr, w.id)}
              </div>
            );
          })}
        </div>
        {grouped.other.length > 0 && (
          <div className="proj">
            <div className="proj-head" style={{ cursor: 'default' }}><span className="name">其它目录</span></div>
            {grouped.other.map(([cwd, arr]) => (
              <div key={cwd} style={{ marginBottom: 6 }}>
                <div className="ws-head" onClick={() => toggleGroup(cwd)} title={cwd}>
                  <span className="ic">{collapsed[cwd] ? '▸' : '▾'}</span>
                  <span className="name">{basename(cwd) || cwd}</span>
                  <span className="cnt">{arr.length}</span>
                  <button className="more" title="设为工作区" onClick={(e) => { e.stopPropagation(); void addWorkspace(cwd); }}>＋</button>
                </div>
                {!collapsed[cwd] && list(arr, '')}
              </div>
            ))}
          </div>
        )}
        {!visible.length && <div className="empty">没有会话</div>}
      </div>
      <div className="sb-foot">
        <span className={clsx('dot', connected ? 'idle' : 'error')} />
        <span>{connected ? '已连接' : '重连中…'}</span>
        <span style={{ flex: 1 }} />
        <button className={clsx('icon-btn', showArchived && 'active')} title="显示已归档" onClick={() => useStore.setState({ showArchived: !showArchived })}>🗄</button>
        <button className="icon-btn" title="主题 / 设置 (Ctrl+K)" onClick={() => useStore.setState({ paletteOpen: true })}>☾</button>
      </div>
    </>
  );
}
