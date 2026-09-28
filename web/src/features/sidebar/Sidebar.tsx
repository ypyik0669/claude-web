import { modKey } from '@/features/workbench/shortcuts';
import { useEffect, useMemo, useState } from 'react';
import { useStore } from '@/store';
import { ws } from '@/ws/client';
import { desktop } from '@/desktop';
import { ago, basename, clsx } from '@/util';
import type { AgentKind, SessionSummary, SourceStatus, Workspace } from '@shared';
import { Icon, AGENT_ICONS } from '@/ui/icons';
import { MIME_SESSION } from '@/features/workbench/dnd';
import { dlg } from '@/ui/dialog';
import { isWithin } from '@/features/paths';
import { filterSessions, isArchived, machineCounts, renderedRows, sourceCounts } from './filter';
import { SessionMenu, capsIntersection, deleteSessions, effectiveCaps, setArchived } from './session-actions';
import { UsageRing } from './UsageRing';

const PAGE_FIRST = 25;
const PAGE_MORE = 50;

function AgentDot({ kind }: { kind: AgentKind }) {
  const a = useStore((s) => s.agents.find((x) => x.kind === kind));
  return <span className="agent-dot" title={a?.name ?? kind}><Icon name={AGENT_ICONS[kind] ?? 'agent'} size={12} /></span>;
}

/** Sidebar-only entries of the session menu (where to open it, pin, folder); the rest is the shared SessionMenu. */
function SidebarMenuExtra({ s, onClose }: { s: SessionSummary; onClose: () => void }) {
  const st = useStore();
  const open = st.open[s.sessionId];
  const meta = st.sessionMeta[s.sessionId] ?? {};
  const act = (fn: () => unknown) => () => { onClose(); void fn(); };
  const openIn = (mode: 'tab' | 'replace') => act(() => (open ? st.openInPane(s.sessionId, mode) : st.loadHistory(s.sessionId, { mode })));
  return (
    <>
      <button onClick={openIn('tab')}><Icon name="board" size={14} /> 在新标签打开</button>
      <button onClick={act(() => { const g = st.layout; const before = g; st.dispatchLayout({ t: 'pane.split', paneId: (g.groups.find((x) => x.id === g.activeGroupId) ?? g.groups[0]).focusedPaneId, dir: 'row' }); if (useStore.getState().layout === before) return st.toast('最多 6 个窗格'); open ? st.openInPane(s.sessionId, 'replace') : void st.loadHistory(s.sessionId); })}><Icon name="splitRight" size={14} /> 在右侧分屏打开</button>
      {effectiveCaps(s).resume && <button onClick={act(() => st.openSession({ sessionId: s.sessionId, cwd: s.cwd }).catch((e) => st.toast(e.message)))}><Icon name="play" size={14} /> 恢复运行</button>}
      <button onClick={act(() => st.setSessionMeta(s.sessionId, { pinned: !meta.pinned }))}><Icon name="pin" size={14} /> {meta.pinned ? '取消置顶' : '置顶'}</button>
      {!s.peer && <button onClick={act(() => ws.request({ kind: 'shell.open', path: s.cwd }))}><Icon name="folder" size={14} /> 在资源管理器打开</button>}
      {!s.peer && <button onClick={act(() => ws.request({ kind: 'shell.open', path: s.cwd, app: 'code' }))}><Icon name="keyboard" size={14} /> 在 VS Code 打开</button>}
      {open && open.state !== 'history' && <button onClick={act(() => st.closeSession(s.sessionId))}><Icon name="stop" size={14} /> 结束进程</button>}
      <div className="menu-sep" />
    </>
  );
}

/** Click → focused pane (replace); Ctrl / middle click → new tab; drag → any pane / group tab. */
function useOpenRow(sessionId: string) {
  const open = useStore((st) => st.open[sessionId]);
  const loadHistory = useStore((st) => st.loadHistory);
  const openInPane = useStore((st) => st.openInPane);
  return {
    onClick: (e: React.MouseEvent) => {
      const mode = e.ctrlKey || e.metaKey ? 'tab' : 'replace';
      open ? openInPane(sessionId, mode) : void loadHistory(sessionId, { mode });
    },
    onAuxClick: (e: React.MouseEvent) => {
      if (e.button !== 1) return;
      e.preventDefault();
      open ? openInPane(sessionId, 'tab') : void loadHistory(sessionId, { mode: 'tab' });
    },
    draggable: true,
    onDragStart: (e: React.DragEvent) => { e.dataTransfer.setData(MIME_SESSION, sessionId); e.dataTransfer.effectAllowed = 'copyMove'; },
  };
}

interface Selection { on: boolean; ids: Set<string>; toggle(id: string): void }

function SessionRow({ s, menu, setMenu, sel }: { s: SessionSummary; menu: string | null; setMenu: (v: string | null) => void; sel: Selection }) {
  const open = useStore((st) => st.open[s.sessionId]);
  const activeId = useStore((st) => st.activeId);
  const meta = useStore((st) => st.sessionMeta[s.sessionId]);
  const row = useOpenRow(s.sessionId);
  const live = open?.state ?? s.live;
  const isLive = live && live !== 'history' && live !== 'closed';
  const checked = sel.on && sel.ids.has(s.sessionId);
  const archived = isArchived(s, meta ? { [s.sessionId]: meta } : {});
  const handlers = sel.on ? { onClick: () => sel.toggle(s.sessionId) } : row;
  return (
    <div
      className={clsx('sess', activeId === s.sessionId && !sel.on && 'active', checked && 'checked', archived && 'archived', s.peer?.offline && 'offline')}
      {...handlers}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu(s.sessionId); }}
      onClickCapture={() => { if (!sel.on && useStore.getState().mobile) setTimeout(() => useStore.setState({ sidebarOpen: false }), 50); }}
      title={sel.on ? s.title : `${s.firstPrompt ?? s.title}${s.peer ? `\n在机器「${s.peer.name}」上${s.peer.offline ? '（离线，只读）' : ''}` : ''}\n点击打开 · Ctrl/中键新标签 · 右键菜单 · 可拖到窗格`}
    >
      {sel.on ? (
        <input type="checkbox" className="sel-box" checked={checked} readOnly tabIndex={-1} aria-label="选择" />
      ) : isLive ? <span className={clsx('dot', live)} /> : meta?.pinned ? <span className="pin-mark" title="已置顶"><Icon name="pin" size={11} /></span> : <span className="dot ph" />}
      <span className="t">{s.title}</span>
      {!!s.childCount && <span className="kids" title={`${s.childCount} 个子任务会话（分叉 / 子代理），打开父会话查看`}>+{s.childCount} 子任务</span>}
      {s.agent && s.agent !== 'claude' && <AgentDot kind={s.agent} />}
      {s.peer && <span className={clsx('peer-badge', s.peer.offline && 'off')} title={`在机器「${s.peer.name}」上${s.peer.offline ? '（离线）' : ''}`}><Icon name="machine" size={11} />{s.peer.name}</span>}
      <span className="ago">{ago(s.lastModified)}</span>
      {!sel.on && <button className="more" title="更多" onClick={(e) => { e.stopPropagation(); setMenu(menu === s.sessionId ? null : s.sessionId); }}><Icon name="more" size={14} /></button>}
      {menu === s.sessionId && <SessionMenu s={s} onClose={() => setMenu(null)} extra={<SidebarMenuExtra s={s} onClose={() => setMenu(null)} />} />}
    </div>
  );
}

function RunningRow({ sessionId, cwd, state, title }: { sessionId: string; cwd: string; state: string; title: string }) {
  const activeId = useStore((st) => st.activeId);
  const row = useOpenRow(sessionId);
  return (
    <div className={clsx('sess', activeId === sessionId && 'active')} {...row}>
      <span className={clsx('dot', state)} />
      <span className="t">{title}</span>
      <span className="ago">{basename(cwd)}</span>
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
      <button onClick={act(() => st.openSession({ cwd: w.path }))}><Icon name="plus" size={14} /> 在这里新建会话</button>
      <button onClick={act(async () => { const n = await dlg.prompt('worktree 名称', 'feature'); if (n) await st.openSession({ cwd: w.path, worktree: n }).catch((e) => st.toast(e.message)); })}><Icon name="branch" size={14} /> 新建 worktree 会话</button>
      <button onClick={act(() => st.openTile({ id: `t${Date.now()}`, kind: 'term', cwd: w.path }, 'tab'))}><Icon name="terminal" size={14} /> 在这里开终端</button>
      <button onClick={act(async () => { const n = await dlg.prompt('工作区名称', w.name); if (n) await ws.request({ kind: 'workspaces.rename', id: w.id, name: n }); })}><Icon name="edit" size={14} /> 重命名</button>
      <button onClick={act(() => ws.request({ kind: 'shell.open', path: w.path }))}><Icon name="folder" size={14} /> 在资源管理器打开</button>
      <button onClick={act(() => ws.request({ kind: 'shell.open', path: w.path, app: 'code' }))}><Icon name="keyboard" size={14} /> 在 VS Code 打开</button>
      <button className="danger" onClick={act(() => ws.request({ kind: 'workspaces.remove', id: w.id }))}><Icon name="close" size={14} /> 移除工作区（不删文件）</button>
    </div>
  );
}

/** "Codex / OpenCode sessions were found on this machine — add them?" Joining is opt-in; ignoring it changes nothing. */
function DiscoveryBanner({ pending }: { pending: SourceStatus[] }) {
  const toast = useStore((s) => s.toast);
  const [busy, setBusy] = useState<string | null>(null);
  const apply = (r: SourceStatus[] | null) => { if (Array.isArray(r)) useStore.setState({ librarySources: r }); };
  const join = async (k: AgentKind) => {
    setBusy(k);
    try { apply(await ws.request<SourceStatus[]>({ kind: 'library.join', kind_: k, joined: true })); } catch (e: any) { toast(e.message); } finally { setBusy(null); }
  };
  const later = async () => {
    setBusy('later');
    try { for (const p of pending) apply(await ws.request<SourceStatus[]>({ kind: 'library.dismiss', kind_: p.kind })); } catch (e: any) { toast(e.message); } finally { setBusy(null); }
  };
  return (
    <div className="lib-banner" role="status">
      <div className="msg">检测到本机有 {pending.map((p) => p.name).join('、')} 的会话，要加入会话库吗？</div>
      <div className="acts">
        {pending.map((p) => (
          <button key={p.kind} className="btn sm" disabled={!!busy} onClick={() => join(p.kind)}>
            {busy === p.kind ? <span className="spinner" /> : <Icon name={AGENT_ICONS[p.kind] ?? 'agent'} size={12} />} 加入 {p.name}
          </button>
        ))}
        <button className="btn sm ghost" disabled={!!busy} onClick={later}>以后再说</button>
      </div>
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
  const togglePanel = useStore((s) => s.togglePanel);
  const dock = useStore((s) => s.layout.dock);
  const collapsed = useStore((s) => s.layout.sidebar.sections);
  const dispatch = useStore((s) => s.dispatchLayout);
  const toast = useStore((s) => s.toast);
  const sources = useStore((s) => s.librarySources);
  const sourceFilter = useStore((s) => s.sourceFilter);
  const setSourceFilter = useStore((s) => s.setSourceFilter);
  const [q, setQ] = useState('');
  const [menu, setMenu] = useState<string | null>(null);
  const [wsMenu, setWsMenu] = useState<string | null>(null);
  const [shown, setShown] = useState<Record<string, number>>({});
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [machine, setMachine] = useState<string>('all');

  const ql = q.trim().toLowerCase();
  const visible = useMemo(() => filterSessions(sessions, { source: sourceFilter, query: q, showArchived, meta: sessionMeta, machine }), [sessions, sessionMeta, showArchived, q, sourceFilter, machine]);
  // counts follow the archive toggle but not the source filter itself
  const counts = useMemo(() => sourceCounts(filterSessions(sessions, { source: 'all', query: '', showArchived, meta: sessionMeta, machine })), [sessions, sessionMeta, showArchived, machine]);
  // machines (federation): 本机 + every other machine with sessions; follows the source filter, not itself
  const machines = useMemo(() => machineCounts(filterSessions(sessions, { source: sourceFilter, query: '', showArchived, meta: sessionMeta })), [sessions, sessionMeta, showArchived, sourceFilter]);
  const showMachines = machines.length > 1 || machine !== 'all';
  const agents = useStore((s) => s.agents);
  // a source still on its first read has no sessions yet: it gets a chip with a spinner instead of a count
  const chips: Pick<SourceStatus, 'kind' | 'name' | 'error' | 'loading'>[] = sources.filter((x) => x.enabled && ((counts[x.kind] ?? 0) > 0 || x.loading));
  // the active filter keeps its chip even while the sources are (re)loading, so it can always be seen and cleared
  if (sourceFilter !== 'all' && !chips.some((x) => x.kind === sourceFilter)) chips.push({ kind: sourceFilter, name: agents.find((a) => a.kind === sourceFilter)?.name ?? sourceFilter });
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const showChips = chips.length > 1 || sourceFilter !== 'all';
  const pending = sources.filter((x) => x.kind !== 'claude' && x.detected && !x.joined && !x.dismissed);
  const pinned = visible.filter((s) => sessionMeta[s.sessionId]?.pinned);
  const running = Object.values(open).filter((o) => o.state === 'running' || o.state === 'waiting');

  // group by workspace (longest matching path wins), remainder by cwd
  const grouped = useMemo(() => {
    const byWs = new Map<string, SessionSummary[]>();
    const other = new Map<string, SessionSummary[]>();
    const byPeer = new Map<string, SessionSummary[]>(); // other machines: their paths mean nothing here
    const sorted = [...workspaces].sort((a, b) => b.path.length - a.path.length);
    for (const s of visible) {
      if (sessionMeta[s.sessionId]?.pinned) continue;
      if (s.peer) { (byPeer.get(s.peer.id) ?? byPeer.set(s.peer.id, []).get(s.peer.id)!).push(s); continue; }
      // orchestration worktrees live outside the repo: group them with the run's own directory
      const cwd = sessionMeta[s.sessionId]?.groupCwd ?? s.cwd ?? '';
      const w = sorted.find((x) => isWithin(cwd, x.path)); // segment-bounded: /proj/app must not swallow /proj/app2
      const m = w ? byWs : other;
      const k = w ? w.id : cwd || '(未知目录)';
      (m.get(k) ?? m.set(k, []).get(k)!).push(s);
    }
    return { byWs, other: [...other.entries()].sort((a, b) => b[1][0].lastModified - a[1][0].lastModified), peers: [...byPeer.entries()] };
  }, [visible, workspaces, sessionMeta]);

  // selection (and 全选) only ever covers rows that are on screen: expanded groups, within their page limit
  const rendered = useMemo(() => renderedRows([
    { key: '__pinned', items: pinned, collapsed: !!collapsed.__pinned },
    ...workspaces.map((w) => ({ key: w.id, items: grouped.byWs.get(w.id) ?? [], collapsed: !!collapsed[w.id] })),
    ...grouped.other.map(([cwd, arr]) => ({ key: cwd, items: arr, collapsed: !!collapsed[cwd] })),
    ...grouped.peers.map(([id, arr]) => ({ key: `peer:${id}`, items: arr, collapsed: !!collapsed[`peer:${id}`] })),
  ], shown, PAGE_FIRST), [pinned, workspaces, grouped, collapsed, shown]);
  const selected = useMemo(() => rendered.filter((s) => picked.has(s.sessionId)), [rendered, picked]);
  const allOn = rendered.length > 0 && selected.length === rendered.length;
  const sel: Selection = {
    on: selecting,
    ids: picked,
    toggle: (id) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; }),
  };
  const endSelect = () => { setSelecting(false); setPicked(new Set()); };
  const selCaps = capsIntersection(selected);
  const allArchived = selected.length > 0 && selected.every((s) => isArchived(s, sessionMeta));

  const toggleGroup = (k: string) => dispatch({ t: 'sidebar.set', patch: { sections: { ...collapsed, [k]: !collapsed[k] } } });
  const pickWorkspace = async () => {
    const p = desktop ? await desktop.pickDir() : await ws.request<string | null>({ kind: 'fs.pickDir' });
    if (p) await addWorkspace(p).catch((e) => toast(e.message));
  };
  const list = (arr: SessionSummary[], k: string, emptyHint = true) => {
    const limit = shown[k] ?? PAGE_FIRST;
    const rest = arr.length - limit;
    return (
      <>
        {arr.slice(0, limit).map((s) => <SessionRow key={s.sessionId} s={s} menu={menu} setMenu={setMenu} sel={sel} />)}
        {rest > 0 && <button className="sess more-row" onClick={() => setShown((m) => ({ ...m, [k]: limit + PAGE_MORE }))}><Icon name="chevronDown" size={12} /> 展开更多（剩 {rest}）</button>}
        {!arr.length && emptyHint && <div className="sess" style={{ color: 'var(--ink-4)', fontSize: 12 }}>{ql ? '没有匹配的会话' : '还没有会话'}</div>}
      </>
    );
  };
  const panelOn = (p: 'config' | 'usage') => dock.open && dock.tabs.includes(p);

  return (
    <>
      <div className="sb-top">
        <span className="brand"><span className="logo"><Icon name="claude" size={17} /></span>Claude Web</span>
        <button className="icon-btn" title="收起侧栏 (Ctrl+B)" aria-label="收起侧栏" onClick={() => useStore.setState({ sidebarOpen: false })}><Icon name="restore" size={16} /></button>
      </div>
      <div className="sb-nav">
        <button className={clsx('nav', !activeId && 'active')} onClick={onNew}><span className="ic"><Icon name="plus" size={15} /></span>新会话<span className="k kbd">{desktop ? `${modKey} N` : 'Alt N'}</span></button>
        <button className="nav" onClick={() => useStore.setState({ paletteOpen: true })}><span className="ic"><Icon name="command" size={15} /></span>命令 / 搜索<span className="k kbd">{modKey} K</span></button>
        <button className={clsx('nav', panelOn('config') && 'active')} onClick={() => useStore.getState().openSettings()} onContextMenu={(e) => { e.preventDefault(); togglePanel('config'); }} title={`设置 (${modKey}+,) · 右键：在右侧面板打开`}><span className="ic"><Icon name="settings" size={15} /></span>设置<span className="k kbd">{modKey} ,</span></button>
        <button className={clsx('nav', panelOn('usage') && 'active')} onClick={() => togglePanel('usage')}><span className="ic"><Icon name="usage" size={15} /></span>用量</button>
      </div>
      {pending.length > 0 && <DiscoveryBanner pending={pending} />}
      {showChips && (
        <div className="sb-sources" role="tablist" aria-label="按来源筛选">
          <button role="tab" aria-selected={sourceFilter === 'all'} className={clsx('src-chip', sourceFilter === 'all' && 'active')} onClick={() => setSourceFilter('all')}>全部<span className="n">{total}</span></button>
          {chips.map((x) => (
            <button key={x.kind} role="tab" aria-selected={sourceFilter === x.kind} className={clsx('src-chip', sourceFilter === x.kind && 'active')} onClick={() => setSourceFilter(x.kind)} title={x.error ? `${x.name}：${x.error}` : x.loading ? `${x.name}：读取中` : x.name}>
              <Icon name={AGENT_ICONS[x.kind] ?? 'agent'} size={12} />{x.name}{x.loading && !counts[x.kind] ? <span className="spinner" aria-label="读取中" /> : <span className="n">{counts[x.kind] ?? 0}</span>}{x.error && <span className="warn-dot" />}
            </button>
          ))}
        </div>
      )}
      {showMachines && (
        <div className="sb-sources machines" role="tablist" aria-label="按机器筛选">
          <button role="tab" aria-selected={machine === 'all'} className={clsx('src-chip', machine === 'all' && 'active')} onClick={() => setMachine('all')}>所有机器</button>
          {machines.map((m) => (
            <button key={m.id} role="tab" aria-selected={machine === m.id} className={clsx('src-chip', machine === m.id && 'active', m.offline && 'off')} onClick={() => setMachine(m.id)} title={m.offline ? `${m.name}：离线（显示上次的列表，只读）` : m.name}>
              <Icon name={m.id === 'local' ? 'device' : 'machine'} size={12} />{m.name}<span className="n">{m.n}</span>{m.offline && <span className="warn-dot" />}
            </button>
          ))}
        </div>
      )}
      <div className="sb-search">
        <input placeholder="筛选会话…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className={clsx('btn sm ghost sel-toggle', selecting && 'active')} title="多选会话（批量归档 / 删除）" aria-pressed={selecting} onClick={() => (selecting ? endSelect() : setSelecting(true))}>{selecting ? '完成' : '选择'}</button>
      </div>
      {selecting && (
        <div className="sel-bar">
          <span className="n">已选 {selected.length}</span>
          <button className="btn sm ghost" title="只选当前显示出来的会话（展开的分组、已加载的行）" onClick={() => setPicked(allOn ? new Set() : new Set(rendered.map((s) => s.sessionId)))}>{allOn ? '全不选' : `全选 ${rendered.length}`}</button>
          <span className="grow" />
          {selCaps.archive && <button className="btn sm" onClick={async () => { await setArchived(selected, !allArchived); endSelect(); }}><Icon name="archive" size={12} /> {allArchived ? '取消归档' : '归档'}</button>}
          {selCaps.delete && <button className="btn sm danger" onClick={async () => { if (await deleteSessions(selected)) endSelect(); }}><Icon name="trash" size={12} /> 删除</button>}
          {selected.length > 0 && !selCaps.archive && !selCaps.delete && <span className="hint">选中的会话来源不支持批量操作</span>}
        </div>
      )}
      <div className="sb-list">
        {running.length > 0 && !ql && !selecting && (
          <div className="proj">
            <div className="proj-head" onClick={() => toggleGroup('__running')}><span className="ic"><Icon name={collapsed.__running ? 'chevronRight' : 'chevronDown'} size={13} /></span><span className="name">运行中</span><span className="cnt">{running.length}</span></div>
            {!collapsed.__running && running.map((o) => {
              const s = sessions.find((x) => x.sessionId === o.sessionId);
              return <RunningRow key={o.sessionId} sessionId={o.sessionId} cwd={o.cwd} state={o.state} title={s?.title ?? o.sessionId.slice(0, 8)} />;
            })}
          </div>
        )}
        {pinned.length > 0 && (
          <div className="proj">
            <div className="proj-head" onClick={() => toggleGroup('__pinned')}><span className="ic"><Icon name={collapsed.__pinned ? 'chevronRight' : 'chevronDown'} size={13} /></span><span className="name">置顶</span><span className="cnt">{pinned.length}</span></div>
            {!collapsed.__pinned && list(pinned, '__pinned', false)}
          </div>
        )}
        <div className="proj">
          <div className="proj-head" style={{ cursor: 'default' }}>
            <span className="name">工作区</span>
            <button className="icon-btn xs" title="添加工作区（文件夹）" aria-label="添加工作区" onClick={pickWorkspace}><Icon name="plus" size={14} /></button>
          </div>
          {!workspaces.length && (
            <div className="ws-empty">
              还没有工作区。工作区就是一个文件夹，会话在里面运行。
              <div><button className="btn sm" onClick={pickWorkspace}><Icon name="plus" size={13} /> 添加工作区</button></div>
            </div>
          )}
          {workspaces.map((w) => {
            const arr = grouped.byWs.get(w.id) ?? [];
            return (
              <div key={w.id} style={{ marginBottom: 6, position: 'relative' }}>
                <div className="ws-head" onClick={() => toggleGroup(w.id)} title={w.path}>
                  <span className="ic"><Icon name={collapsed[w.id] ? 'chevronRight' : 'chevronDown'} size={13} /></span>
                  <span className="name">{w.name}</span>
                  <span className="cnt">{arr.length}</span>
                  <button className="more" title="更多" onClick={(e) => { e.stopPropagation(); setWsMenu(wsMenu === w.id ? null : w.id); }}><Icon name="more" size={14} /></button>
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
                  <span className="ic"><Icon name={collapsed[cwd] ? 'chevronRight' : 'chevronDown'} size={13} /></span>
                  <span className="name">{basename(cwd) || cwd}</span>
                  <span className="cnt">{arr.length}</span>
                  <button className="more" title="设为工作区" onClick={(e) => { e.stopPropagation(); void addWorkspace(cwd); }}><Icon name="plus" size={13} /></button>
                </div>
                {!collapsed[cwd] && list(arr, cwd, false)}
              </div>
            ))}
          </div>
        )}
        {grouped.peers.map(([id, arr]) => {
          const k = `peer:${id}`;
          const p = arr[0]?.peer;
          return (
            <div key={k} className="proj peer">
              <div className="ws-head peer-head" onClick={() => toggleGroup(k)} title={p?.offline ? '离线：显示上次的列表，只读' : '在另一台机器上：打开、续聊、审批都经那台机器'}>
                <span className="ic"><Icon name={collapsed[k] ? 'chevronRight' : 'chevronDown'} size={13} /></span>
                <Icon name="machine" size={13} />
                <span className="name">{p?.name ?? id}</span>
                {p?.offline && <span className="badge">离线</span>}
                <span className="cnt">{arr.length}</span>
              </div>
              {!collapsed[k] && list(arr, k, false)}
            </div>
          );
        })}
        {!visible.length && <div className="empty">{ql || sourceFilter !== 'all' || machine !== 'all' ? '没有匹配的会话' : '没有会话'}</div>}
      </div>
      <div className="sb-foot">
        <span className={clsx('dot', connected ? 'idle' : 'error')} title={connected ? '已连接' : '连接断开，正在重连…'} />
        {!connected && <span>重连中…</span>}
        <UsageRing />
        <span style={{ flex: 1 }} />
        <button className={clsx('icon-btn xs', showArchived && 'active')} title="显示已归档" aria-label="显示已归档" onClick={() => useStore.setState({ showArchived: !showArchived })}><Icon name="archive" size={14} /></button>
        <button className="icon-btn xs" title={`主题 / 设置 (${modKey}+K)`} aria-label="主题" onClick={() => useStore.setState({ paletteOpen: true })}><Icon name="moon" size={14} /></button>
      </div>
    </>
  );
}
