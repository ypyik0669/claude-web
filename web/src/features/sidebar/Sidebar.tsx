import { modKey } from '@/features/workbench/shortcuts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '@/store';
import { ws } from '@/ws/client';
import { desktop } from '@/desktop';
import { basename, clsx } from '@/util';
import type { AgentKind, SessionSummary } from '@shared';
import { Icon } from '@/ui/icons';
import { isWithin } from '@/features/paths';
import { agentOf, childrenOf, filterSessions, filterSummary, isArchived, machineCounts, renderedRows, sourceCounts } from './filter';
import { capsIntersection, deleteSessions, setArchived } from './session-actions';
import { rangeIds } from './status';
import { SessionRow, type RowCtx, type Selection } from './rows';
import { Group, PAGE_FIRST, ProjectMenu } from './groups';
import { NeedsYou } from './attention';
import { FilterMenu, type SourceChip } from './filter-menu';
import { AccountRow } from './account';
import { DiscoveryHint } from './hint';
import { hintReady, makeProjectSpelled, projectsEmpty } from './newcomer';
import { CHECKLIST_KEY } from '@/features/home/model';
import { closeDrawer } from './menus';
import { anchoredMenuOpen } from '@/ui/menus';
import { openAutomation, useAutomation } from '@/features/automation/state';
import type { ProjectMenuId, ProjectsHeadId, RowId, SectionId, TopId } from './entries';

/** Ids of conversations that must stay in view past a group's cut: running / waiting ones (a stable string, not the `open` map). */
const busyIds = (s: ReturnType<typeof useStore.getState>) =>
  Object.values(s.open).filter((o) => o.state === 'running' || o.state === 'starting' || o.state === 'waiting' || o.pending.length).map((o) => o.sessionId).sort().join('|');

/**
 * What takes an Esc before the sidebar's multi-select besides a menu: a dialog or the shortcuts sheet, the command
 * palette. Any `.menu` on screen counts too (a menu that forgot to claim itself still gets its Esc first).
 */
const OVER_SIDEBAR = '.menu, .modal-bg, .palette-bg';

/**
 * Esc ends multi-select only when it is meant for the sidebar: focus in the sidebar (or nowhere) and nothing that
 * takes the key first open — no anchored menu (`anchoredMenuOpen()`: the sidebar's own, the header ···, a composer /
 * right-panel popover, the model / directory menu, a workbench dropdown, the file tree's right-click menu…; polish P1:
 * with the focus on <body> the header ··· used to close and the selection went with it), nothing of OVER_SIDEBAR, no
 * settings page / image viewer. One Esc does one thing. Runs in the capture phase on window — before anything else
 * sees the key, so before those overlays close themselves on it — and only reads, never stops the event.
 */
function escForSidebar(e: KeyboardEvent): boolean {
  if (e.key !== 'Escape') return false;
  const st = useStore.getState();
  if (st.paletteOpen || st.settingsOpen || st.shortcutsOpen || st.viewer) return false;
  if (anchoredMenuOpen() || document.querySelector(OVER_SIDEBAR)) return false;
  const a = document.activeElement;
  return !a || a === document.body || !!a.closest('.sidebar');
}

/**
 * The sidebar (spec 2026-09-28 §5.1): 新对话 · 搜索 · 自动化; 「需要你」 while something waits; conversations by
 * project — each row a title and one status at its end; source / machine / archived / multi-select behind the
 * funnel on the 项目 row; the account row (quota ring, settings) at the bottom. Every entry point of the old sidebar
 * is listed in entries.ts (and asserted there and by ui-smoke).
 */
export function Sidebar({ onNew }: { onNew: () => void }) {
  const sessions = useStore((s) => s.sessions);
  const activeId = useStore((s) => s.activeId);
  const workspaces = useStore((s) => s.workspaces);
  const sessionMeta = useStore((s) => s.sessionMeta);
  const showArchived = useStore((s) => s.showArchived);
  const addWorkspace = useStore((s) => s.addWorkspace);
  const collapsed = useStore((s) => s.layout.sidebar.sections);
  const dispatch = useStore((s) => s.dispatchLayout);
  const toast = useStore((s) => s.toast);
  const sources = useStore((s) => s.librarySources);
  const agents = useStore((s) => s.agents);
  const sourceFilter = useStore((s) => s.sourceFilter);
  const setSourceFilter = useStore((s) => s.setSourceFilter);
  const busy = useStore(busyIds);
  const autoOpen = useAutomation((s) => s.open);
  const [q, setQ] = useState('');
  // the sidebar's one open menu: `filter` · `account` · `proj:<id>` · `row:<list|attn>:<id>` (opening one closes the others)
  const [menu, setMenu] = useState<string | null>(null);
  const [shown, setShown] = useState<Record<string, number | undefined>>({});
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [machine, setMachine] = useState<string>('all');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const toggleMenu = (k: string) => (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); setMenu((m) => (m === k ? null : k)); };
  // a menu closes only itself: a late close from the one being replaced must not shut the one that just opened
  const closeMenu = useCallback((k: string) => setMenu((m) => (m === k ? null : m)), []);

  const ql = q.trim();
  const visible = useMemo(() => filterSessions(sessions, { source: sourceFilter, query: q, showArchived, meta: sessionMeta, machine }), [sessions, sessionMeta, showArchived, q, sourceFilter, machine]);
  // counts follow the archive toggle but not the source filter itself
  const counts = useMemo(() => sourceCounts(filterSessions(sessions, { source: 'all', query: '', showArchived, meta: sessionMeta, machine })), [sessions, sessionMeta, showArchived, machine]);
  // machines (federation): 本机 + every other machine with sessions; follows the source filter, not itself
  const machines = useMemo(() => machineCounts(filterSessions(sessions, { source: sourceFilter, query: '', showArchived, meta: sessionMeta })), [sessions, sessionMeta, showArchived, sourceFilter]);
  const showMachines = machines.length > 1 || machine !== 'all';
  const nameOf = useCallback((kind: string) => sources.find((x) => x.kind === kind)?.name ?? agents.find((a) => a.kind === kind)?.name ?? (kind === 'claude' ? 'Claude Code' : kind), [sources, agents]);
  // a source still on its first read has no sessions yet: it is listed with a spinner instead of a count
  const chips: SourceChip[] = sources.filter((x) => x.enabled && ((counts[x.kind] ?? 0) > 0 || x.loading));
  // the active filter stays listed even while the sources are (re)loading, so it can always be seen and cleared
  if (sourceFilter !== 'all' && !chips.some((x) => x.kind === sourceFilter)) chips.push({ kind: sourceFilter, name: nameOf(sourceFilter) });
  if (!chips.length) chips.push({ kind: 'claude', name: nameOf('claude') });
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  // what narrows the list (source / machine / text); 显示已归档 widens it, so it is not a filter: empty projects stay
  // listed, there is no 「已筛选」 row for it and 清除 leaves it on (it still lights the funnel: a non-default setting)
  const summary = filterSummary({ source: sourceFilter, machine, query: q }, nameOf, (m) => machines.find((x) => x.id === m)?.name ?? m);
  const narrowed = summary.length > 0;
  const clearFilters = () => { setQ(''); setSourceFilter('all'); setMachine('all'); };
  const pending = sources.filter((x) => x.kind !== 'claude' && x.detected && !x.joined && !x.dismissed);
  const pinned = visible.filter((s) => sessionMeta[s.sessionId]?.pinned);

  // group by project (longest matching path wins), the rest by folder, other machines by machine
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

  // 其它文件夹 starts folded when there are projects; with none it is all there is — always open, its header a plain
  // label (nothing to fold it away from)
  const otherFoldable = workspaces.length > 0;
  const otherCollapsed = otherFoldable && (collapsed.__other ?? true);
  const busySet = useMemo(() => new Set(busy ? busy.split('|') : []), [busy]);
  const keep = useCallback((s: SessionSummary) => s.sessionId === activeId || busySet.has(s.sessionId) || s.live === 'running' || s.live === 'waiting', [activeId, busySet]);
  const kidsOf = useCallback((s: SessionSummary) => (expanded.has(s.sessionId) ? childrenOf(sessions, s.sessionId, { showArchived, meta: sessionMeta }) : []), [expanded, sessions, showArchived, sessionMeta]);
  const isBusy = useCallback((s: SessionSummary) => busySet.has(s.sessionId) || s.live === 'running' || s.live === 'waiting', [busySet]);
  // folded 其它文件夹 still shows what must stay in view (the current conversation, running / waiting ones), like a
  // group's page cut does; its header spins while something in there runs
  const otherAll = useMemo(() => grouped.other.flatMap(([, a]) => a), [grouped]);
  const otherKept = useMemo(() => (otherCollapsed ? otherAll.filter(keep) : []), [otherCollapsed, otherAll, keep]);
  const otherBusy = otherAll.some(isBusy);
  // someone new (final review §9 #5): no project yet → the empty state points at 其它文件夹's folders, whose 设为项目
  // is written out; the library's discovery hint waits until the newcomer checklist is finished or closed
  const empty = projectsEmpty({ projects: workspaces.length, otherFolders: grouped.other.length });
  const spellMake = makeProjectSpelled(workspaces.length);
  const hintOk = useStore((s) => hintReady(s.settings[CHECKLIST_KEY]));

  // selection (全选, Shift ranges) only ever covers rows that are on screen: expanded groups, within their page limit
  const rendered = useMemo(() => renderedRows([
    { key: '__pinned', items: pinned, collapsed: !!collapsed.__pinned },
    ...workspaces.map((w) => ({ key: w.id, items: grouped.byWs.get(w.id) ?? [], collapsed: !!collapsed[w.id] })),
    ...grouped.other.map(([cwd, arr]) => ({ key: cwd, items: arr, collapsed: otherCollapsed || !!collapsed[cwd] })),
    { key: '__other_kept', items: otherKept, collapsed: false },
    ...grouped.peers.map(([id, arr]) => ({ key: `peer:${id}`, items: arr, collapsed: !!collapsed[`peer:${id}`] })),
  ], shown as Record<string, number>, PAGE_FIRST, { keep, kids: kidsOf }), [pinned, workspaces, grouped, collapsed, otherCollapsed, otherKept, shown, keep, kidsOf]);
  const order = useMemo(() => rendered.map((s) => s.sessionId), [rendered]);
  const selected = useMemo(() => rendered.filter((s) => picked.has(s.sessionId)), [rendered, picked]);
  const allOn = rendered.length > 0 && selected.length === rendered.length;
  const endSelect = () => { setSelecting(false); setPicked(new Set()); setAnchor(null); };
  const sel: Selection = {
    on: selecting,
    ids: picked,
    toggle: (id) => { setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; }); setAnchor(id); },
    range: (id) => {
      if (!selecting) { setSelecting(true); setPicked(new Set([id])); setAnchor(id); setMenu(null); return; }
      const r = rangeIds(order, anchor, id);
      setPicked((p) => new Set([...p, ...r]));
      setAnchor(id);
    },
  };
  useEffect(() => {
    if (!selecting) return;
    const k = (e: KeyboardEvent) => { if (escForSidebar(e)) endSelect(); };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [selecting]);
  const selCaps = capsIntersection(selected);
  const allArchived = selected.length > 0 && selected.every((s) => isArchived(s, sessionMeta));

  const ctx: RowCtx = {
    where: 'list', menu, setMenu, closeMenu, sel, expanded,
    toggleKids: (id) => setExpanded((e) => { const n = new Set(e); if (n.has(id)) n.delete(id); else n.add(id); return n; }),
    tagFor: (s) => { const k = agentOf(s); return k === 'claude' ? null : nameOf(k); },
  };
  const toggleGroup = (k: string, cur = !!collapsed[k]) => dispatch({ t: 'sidebar.set', patch: { sections: { ...collapsed, [k]: !cur } } });
  const pickWorkspace = async () => {
    const p = desktop ? await desktop.pickDir() : await ws.request<string | null>({ kind: 'fs.pickDir' });
    if (p) await addWorkspace(p).catch((e) => toast(e.message));
  };
  const groupProps = (k: string, items: SessionSummary[]) => ({
    k, items, ctx, keep, kidsOf,
    collapsed: !!collapsed[k],
    onToggle: () => toggleGroup(k),
    shown: shown[k],
    setShown: (n: number | undefined) => setShown((m) => ({ ...m, [k]: n })),
    busy: items.some(isBusy),
    emptyText: ql ? '没有匹配的对话' : narrowed ? '' : '还没有对话',
  });
  const top = (x: TopId) => x;
  const sec = (x: SectionId) => x;
  const head = (x: ProjectsHeadId) => x;
  const pm = (x: ProjectMenuId) => x;
  const selBar: RowId = 'select-bar';

  return (
    <>
      <div className="sb-top">
        <span className="brand"><span className="logo"><Icon name="claude" size={18} /></span>Claude Web</span>
        <button className="icon-btn" data-id={top('collapse')} title={`收起侧栏 (${modKey}+B)`} aria-label="收起侧栏" onClick={() => useStore.setState({ sidebarOpen: false })}><Icon name="sidebar" size={16} /></button>
      </div>
      <nav className="sb-nav" aria-label="导航">
        <button className={clsx('nav', !activeId && !autoOpen && 'active')} data-id={top('new')} onClick={() => { onNew(); closeDrawer(); }}><Icon name="edit" size={16} />新对话<span className="k">{desktop ? `${modKey} N` : 'Alt N'}</span></button>
        <button className="nav" data-id={top('search')} title="搜索对话、命令和设置" onClick={() => { useStore.setState({ paletteOpen: true }); closeDrawer(); }}><Icon name="search" size={16} />搜索<span className="k">{modKey} K</span></button>
        {/* 自动化 → the automation page (定时任务 · 目标 · 编排, spec §5.9) over the main area, on the tab shown last */}
        <button className={clsx('nav', autoOpen && 'active')} data-id={top('automation')} title="定时任务、目标、编排" aria-pressed={autoOpen} onClick={() => { setMenu(null); openAutomation(); }}><Icon name="tasks" size={16} />自动化</button>
      </nav>
      <NeedsYou ctx={ctx} />
      <div className={clsx('sb-list', selecting && 'selecting')}>
        {selecting && (
          <div className="sel-bar" data-id={selBar} role="toolbar" aria-label="批量操作">
            <span className="n">已选 {selected.length}</span>
            <button className="btn sm ghost" title="只选当前显示出来的对话（展开的项目、已显示的行）" onClick={() => setPicked(allOn ? new Set() : new Set(order))}>{allOn ? '全不选' : `全选 ${rendered.length}`}</button>
            <span className="grow" />
            {selCaps.archive && <button className="btn sm" onClick={async () => { await setArchived(selected, !allArchived); endSelect(); }}><Icon name="archive" size={12} /> {allArchived ? '取消归档' : '归档'}</button>}
            {selCaps.delete && <button className="btn sm danger" onClick={async () => { if (await deleteSessions(selected)) endSelect(); }}><Icon name="trash" size={12} /> 删除</button>}
            <button className="btn sm ghost" title="退出多选 (Esc)" onClick={endSelect}>完成</button>
            {selected.length > 0 && !selCaps.archive && !selCaps.delete && <span className="hint">选中的对话来源不支持批量操作</span>}
          </div>
        )}
        {narrowed && !selecting && (
          <div className="sb-filtered" role="status">
            <Icon name="filter" size={12} />
            <span className="what" title={summary.join(' · ')}>{summary.join(' · ')}</span>
            <button className="link" onClick={clearFilters}>清除</button>
          </div>
        )}
        {pinned.length > 0 && (
          <Group {...groupProps('__pinned', pinned)} section dataId={sec('pinned')} name="置顶" icon="pin" className="pinned" />
        )}
        <div className="sb-sec" data-id={sec('projects')}>
          <div className="sb-sec-h">
            <span>项目</span>
            <span className="grow" />
            <span className="anchor">
              <button className={clsx('icon-btn xs', (narrowed || showArchived || menu === 'filter') && 'on')} data-id={head('filter')} title="筛选：来源 / 机器 / 已归档 / 选择多个" aria-label="筛选" aria-haspopup="menu" aria-expanded={menu === 'filter'} onClick={toggleMenu('filter')}>
                <Icon name="filter" size={14} />{(narrowed || showArchived) && <span className="fdot" />}
              </button>
              {menu === 'filter' && (
                <FilterMenu
                  onClose={() => closeMenu('filter')}
                  query={q} setQuery={setQ}
                  sources={chips} counts={counts} total={total} source={sourceFilter} setSource={(k: AgentKind | 'all') => setSourceFilter(k)}
                  machines={machines} machine={machine} setMachine={setMachine} showMachines={showMachines}
                  showArchived={showArchived} setShowArchived={(v) => useStore.setState({ showArchived: v })}
                  onSelect={() => { setSelecting(true); closeMenu('filter'); }}
                />
              )}
            </span>
            <button className="icon-btn xs" data-id={head('add-project')} title="打开文件夹（添加项目）" aria-label="打开文件夹" onClick={pickWorkspace}><Icon name="plus" size={15} /></button>
          </div>
          {empty && (
            <div className="ws-empty sb-empty" data-empty={empty.openButton ? 'open' : 'make-project'}>
              {empty.text}
              {empty.openButton && <div><button className="btn sm primary" onClick={pickWorkspace}><Icon name="folder" size={13} /> 打开文件夹</button></div>}
            </div>
          )}
          {workspaces.map((w) => {
            const arr = grouped.byWs.get(w.id) ?? [];
            if (narrowed && !arr.length) return null;
            const mk = `proj:${w.id}`;
            const projMenu = toggleMenu(mk);
            return (
              <Group
                key={w.id}
                {...groupProps(w.id, arr)}
                name={w.name}
                icon="folder"
                title={w.path}
                onContextMenu={projMenu}
                actions={<>
                  <button className="icon-btn xs" data-id={pm('new-here')} title="在这里新建对话" aria-label="在这里新建对话" onClick={() => { void useStore.getState().openSession({ cwd: w.path }).catch((e) => toast(e.message)); closeDrawer(); }}><Icon name="edit" size={13} /></button>
                  <button className="icon-btn xs" title="更多" aria-label="项目菜单" aria-haspopup="menu" aria-expanded={menu === mk} onClick={projMenu}><Icon name="more" size={14} /></button>
                </>}
                menu={menu === mk ? <ProjectMenu w={w} onClose={() => closeMenu(mk)} /> : undefined}
              />
            );
          })}
        </div>
        {grouped.other.length > 0 && (
          <div className="sb-sec" data-id={sec('other')}>
            {otherFoldable ? (
              <div className="sb-sec-h fold" role="button" tabIndex={0} aria-expanded={!otherCollapsed} onClick={() => toggleGroup('__other', otherCollapsed)} onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleGroup('__other', otherCollapsed); } }} title="不在任何项目里的对话，按文件夹">
                <span>其它文件夹</span>
                {otherCollapsed && (otherBusy ? <span className="spin" title="有对话在运行" /> : <span className="n">{otherAll.length}</span>)}
                <Icon name={otherCollapsed ? 'chevronRight' : 'chevronDown'} size={12} className="sec-chev" />
              </div>
            ) : (
              <div className="sb-sec-h" title="不在任何项目里的对话，按文件夹"><span>其它文件夹</span></div>
            )}
            {otherKept.length > 0 && (
              <div className="sb-rows sb-kept" role="group" aria-label="其它文件夹里当前 / 运行中的对话">
                {otherKept.map((s) => (
                  <div key={s.sessionId} className="sb-row-wrap">
                    <SessionRow s={s} ctx={ctx} flat />
                    {expanded.has(s.sessionId) && kidsOf(s).map((k) => <SessionRow key={k.sessionId} s={k} ctx={ctx} depth={1} flat />)}
                  </div>
                ))}
              </div>
            )}
            {!otherCollapsed && grouped.other.map(([cwd, arr]) => (
              <Group
                key={cwd}
                {...groupProps(cwd, arr)}
                name={basename(cwd) || cwd}
                icon="folder"
                title={cwd}
                className={clsx('other', spellMake && 'spelled')}
                actions={spellMake
                  ? <button className="mk-proj" data-id={pm('make-project')} title={`设为项目：${cwd} 里的对话归到「项目」下`} onClick={() => void addWorkspace(cwd).catch((e) => toast(e.message))}>设为项目</button>
                  : <button className="icon-btn xs" data-id={pm('make-project')} title="设为项目" aria-label="设为项目" onClick={() => void addWorkspace(cwd).catch((e) => toast(e.message))}><Icon name="plus" size={13} /></button>}
              />
            ))}
          </div>
        )}
        {grouped.peers.length > 0 && (
          <div className="sb-sec" data-id={sec('peers')}>
            <div className="sb-sec-h"><span>其它电脑</span></div>
            {grouped.peers.map(([id, arr]) => {
              const k = `peer:${id}`;
              const p = arr[0]?.peer;
              return (
                <Group
                  key={k}
                  {...groupProps(k, arr)}
                  name={p?.name ?? id}
                  icon="machine"
                  className="peer"
                  title={p?.offline ? '离线：显示上次的列表，只读' : '在另一台电脑上：打开、续聊、审批都经那台电脑'}
                  badge={p?.offline ? <span className="badge">离线</span> : undefined}
                />
              );
            })}
          </div>
        )}
        {!visible.length && narrowed && (
          <div className="empty sb-empty">没有匹配的对话<div><button className="btn sm" onClick={clearFilters}>清除筛选</button></div></div>
        )}
      </div>
      {pending.length > 0 && hintOk && <DiscoveryHint pending={pending} />}
      <AccountRow open={menu === 'account'} setOpen={(v) => (v ? setMenu('account') : closeMenu('account'))} />
    </>
  );
}
