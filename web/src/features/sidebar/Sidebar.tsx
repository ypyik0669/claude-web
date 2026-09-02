import { useMemo, useState } from 'react';
import { useStore } from '@/store';
import { ago, basename, clsx } from '@/util';
import type { SessionSummary } from '@shared';

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
        <span className="brand">Claude Web</span>
        <span className={clsx('dot', connected ? 'idle' : 'error')} title={connected ? '已连接' : '连接断开'} />
        <button className="icon-btn" title="收起侧栏" onClick={() => useStore.setState({ sidebarOpen: false })}>
          ◧
        </button>
      </div>
      <div style={{ padding: '10px 10px 0' }}>
        <button className="btn primary" style={{ width: '100%', justifyContent: 'center' }} onClick={onNew}>
          ＋ 新会话
        </button>
      </div>
      <div className="sb-search">
        <input placeholder="搜索会话…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="sb-list">
        {groups.map(([cwd, list]) => (
          <div className="proj" key={cwd}>
            <div className="proj-head" onClick={() => toggleGroup(cwd)} title={cwd}>
              <span>{collapsed[cwd] ? '▸' : '▾'}</span>
              <span className="name">{basename(cwd) || cwd}</span>
              <span className="ago">{list.length}</span>
            </div>
            {!collapsed[cwd] &&
              list.slice(0, q ? 200 : 30).map((s) => {
                const live = open[s.sessionId]?.state ?? s.live;
                return (
                  <div key={s.sessionId} className={clsx('sess', activeId === s.sessionId && 'active')} onClick={() => pick(s)} title={s.firstPrompt}>
                    {live && live !== 'history' && live !== 'closed' ? <span className={clsx('dot', live)} /> : null}
                    <span className="t">{s.title}</span>
                    <span className="ago">{ago(s.lastModified)}</span>
                  </div>
                );
              })}
            {!collapsed[cwd] && list.length > 30 && !q && <div className="sess" style={{ color: 'var(--fg-2)', fontSize: 11 }}>还有 {list.length - 30} 个，用搜索查找</div>}
          </div>
        ))}
        {!groups.length && <div className="empty">没有会话</div>}
      </div>
      <div className="sb-foot">
        <button className={clsx('icon-btn', panels.includes('config') && 'active')} title="配置中心" onClick={() => togglePanel('config')}>
          ⚙
        </button>
        <button className={clsx('icon-btn', panels.includes('usage') && 'active')} title="用量" onClick={() => togglePanel('usage')}>
          ▤
        </button>
        <button className={clsx('icon-btn', panels.includes('terminal') && 'active')} title="终端" onClick={() => togglePanel('terminal')}>
          ▣
        </button>
        <span style={{ flex: 1 }} />
        <button className="icon-btn" title="切换主题" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
          {theme === 'dark' ? '☾' : '☀'}
        </button>
      </div>
    </>
  );
}
