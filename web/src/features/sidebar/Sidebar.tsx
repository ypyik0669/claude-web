import { openDispatch } from '@/features/cloud/cloud-open';
import { modKey } from '@/features/workbench/shortcuts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '@/store';
import { desktop } from '@/desktop';
import { clsx } from '@/util';
import { folderLabels, splitFolders } from './folders';
import { dropOrder } from './reorder';

/** What a dragged project header carries (session rows carry their own type, so they never land here). */
const PROJECT_DRAG = 'application/x-cw-project';
import type { AgentKind, SessionSummary } from '@shared';
import { AppLogo } from '@/ui/AppLogo';
import { navGo, useNav } from '@/features/workbench/nav-history';
import { Icon } from '@/ui/icons';
import { projectFor } from '@/features/paths';
import { agentOf, childrenOf, filterSessions, filterSummary, isArchived, machineCounts, renderedRows, sourceCounts } from './filter';
import { capsIntersection, deleteSessions, saveSections, setArchived } from './session-actions';
import { rangeIds } from './status';
import { SessionRow, type RowCtx, type Selection } from './rows';
import { Group, ProjectMenu } from './groups';
import { NeedsYou } from './attention';
import { ViewMenu, type SourceChip } from './view-menu';
import { addAllToSection, addSection, addToSection, DEFAULT_VIEW, deleteSection, groupSessions, perGroupLimit, readSections, readView, removeFromSection, renameSection, SECTIONS_KEY, sortSessions, VIEW_KEY, type DateBucket } from './view';
import { MIME_SESSION } from '@/features/workbench/dnd';
import { dlg } from '@/ui/dialog';
import { AccountRow } from './account';
import { DiscoveryHint } from './hint';
import { hintReady, makeProjectSpelled, projectsEmpty } from './newcomer';
import { CHECKLIST_KEY } from '@/features/home/model';
import { Menu, closeDrawer } from './menus';
import { anchoredMenuOpen } from '@/ui/menus';
import { openAutomation } from '@/features/automation/state';
import { openExtensions } from '@/features/extensions/state';
import { openBackground } from '@/features/background/state';
import { openBots, useInboxPending } from '@/features/bots/state';
import { useSection } from '@/features/sections';
import type { CustomId, ProjectMenuId, ProjectsHeadId, RowId, SectionId, TopId } from './entries';
import { tr, trAs } from '@/i18n';
import { pickFolder } from '@/ui/pick-folder';

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
 * The sidebar (spec 2026-09-28 §5.1; structure round 2: at desktop width this is the 对话 section's sidebar, next to
 * the icon rail): 新对话 · 搜索 (· 自动化 · 扩展 on a phone); 「需要你」 while something waits; conversations by
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
  // the 显示 menu (stage C3): grouping / order / per group / other agents, and the user's own sections — meta.json
  const rawView = useStore((s) => s.settings[VIEW_KEY]);
  const view = useMemo(() => readView(rawView), [rawView]);
  const rawSections = useStore((s) => s.settings[SECTIONS_KEY]);
  const sections = useMemo(() => readSections(rawSections), [rawSections]);
  const setSetting = useStore((s) => s.setSetting);
  const first = perGroupLimit(view);
  const addWorkspace = useStore((s) => s.addWorkspace);
  const collapsed = useStore((s) => s.layout.sidebar.sections);
  const dispatch = useStore((s) => s.dispatchLayout);
  const toast = useStore((s) => s.toast);
  const sources = useStore((s) => s.librarySources);
  const agents = useStore((s) => s.agents);
  const sourceFilter = useStore((s) => s.sourceFilter);
  const setSourceFilter = useStore((s) => s.setSourceFilter);
  const busy = useStore(busyIds);
  const section = useSection();
  const inboxPending = useInboxPending();
  // at desktop width the icon rail has 搜索's neighbours (自动化 · 扩展), the sidebar's switch, 设置 and the account
  // (structure round 2); a phone has no rail: they stay in its drawer
  const mobile = useStore((s) => s.mobile);
  const [q, setQ] = useState('');
  // the sidebar's one open menu: `filter` · `account` · `proj:<id>` · `row:<list|attn>:<id>` (opening one closes the others)
  const [menu, setMenu] = useState<string | null>(null);
  const [shown, setShown] = useState<Record<string, number | undefined>>({});
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [machine, setMachine] = useState<string>('all');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  // projects reordered by dragging their header (2026-10-14 user report): which one is dragged, where it would land
  const [dragWs, setDragWs] = useState<string | null>(null);
  const [overWs, setOverWs] = useState<{ id: string; after: boolean } | null>(null);
  const toggleMenu = (k: string) => (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); setMenu((m) => (m === k ? null : k)); };
  // a menu closes only itself: a late close from the one being replaced must not shut the one that just opened
  const closeMenu = useCallback((k: string) => setMenu((m) => (m === k ? null : m)), []);

  const ql = q.trim();
  const visible = useMemo(() => filterSessions(sessions, { source: sourceFilter, query: q, showArchived, meta: sessionMeta, machine, otherAgents: view.show.otherAgents }), [sessions, sessionMeta, showArchived, q, sourceFilter, machine, view.show.otherAgents]);
  // counts follow the archive toggle but not the source filter itself
  const counts = useMemo(() => sourceCounts(filterSessions(sessions, { source: 'all', query: '', showArchived, meta: sessionMeta, machine })), [sessions, sessionMeta, showArchived, machine]);
  // machines (federation): 本机 + every other machine with sessions; follows the source filter, not itself
  const machines = useMemo(() => machineCounts(filterSessions(sessions, { source: sourceFilter, query: '', showArchived, meta: sessionMeta, otherAgents: view.show.otherAgents })), [sessions, sessionMeta, showArchived, sourceFilter, view.show.otherAgents]);
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
  // the 显示 button's dot (and the button staying shown at rest): something narrows, widens or hides part of the list.
  // A deliberate 分组 / 排序 / 每组几条 choice is not that — the list itself shows it — and lighting it for good would
  // add a control at rest (外框控件计数, 界面改版 阶段 0–1; stage C fix wave C-U4)
  const viewDot = narrowed || showArchived || !view.show.otherAgents;
  const clearFilters = () => { setQ(''); setSourceFilter('all'); setMachine('all'); };
  const pending = sources.filter((x) => x.kind !== 'claude' && x.detected && !x.joined && !x.dismissed);
  const pinned = visible.filter((s) => sessionMeta[s.sessionId]?.pinned);

  // grouped as the 显示 menu says (view.ts: by project — the folder it ran in, the rest by folder —, by folder, by
  // date or not at all), other machines by machine; pinned ones are in 置顶 only
  const vgroups = useMemo(() => groupSessions(visible, view, { workspaces, meta: sessionMeta, now: Date.now() }), [visible, view, workspaces, sessionMeta]);
  const grouped = useMemo(() => {
    const byWs = new Map<string, SessionSummary[]>();
    const other: [string, SessionSummary[]][] = [];
    const peers: [string, SessionSummary[]][] = [];
    const dates: { bucket: DateBucket; items: SessionSummary[] }[] = [];
    let all: SessionSummary[] = [];
    for (const g of vgroups) {
      if (g.kind === 'project') byWs.set(g.workspaceId!, g.items);
      else if (g.kind === 'folder') other.push([g.cwd || tr('(未知目录)'), g.items]);
      else if (g.kind === 'peer') peers.push([g.peerId!, g.items]);
      else if (g.kind === 'date') dates.push({ bucket: g.bucket!, items: g.items });
      else all = g.items;
    }
    return { byWs, other, peers, dates, all };
  }, [vgroups]);
  // the user's own sections: the conversations put there (still in their own group too), in the list's order
  const customs = useMemo(() => sections.map((c) => ({ c, items: sortSessions(visible.filter((s) => c.ids.includes(s.sessionId)), view.sortBy) })), [sections, visible, view.sortBy]);
  const byProject = view.groupBy === 'project';

  // 文件夹: every folder with conversations on its own, newest first (2026-10-14 user report — like Claude's own app);
  // past the first FOLDERS_SHOWN they wait under 「更早的文件夹」, folded unless the user opened it (`sections.__older`)
  // (re-review M-6: dozens of CLI folders or hundreds of joined Codex conversations must not bury 其它电脑)
  const folders = useMemo(() => splitFolders(grouped.other), [grouped]);
  const labels = useMemo(() => folderLabels(grouped.other.map(([cwd]) => cwd), workspaces.map((w) => w.name)), [grouped, workspaces]);
  const otherCollapsed = collapsed.__older ?? true;
  // projects / folders / machines start folded (GitHub issue #3) unless the user opened them, or the current conversation
  // is in there; a search shows every match
  const foldDefault = useStore((s) => s.settings['ui.sidebarFolded'] !== false);
  const folded = useCallback((k: string, items: SessionSummary[]) => collapsed[k] ?? (!ql && foldDefault && !items.some((s) => s.sessionId === activeId)), [collapsed, ql, foldDefault, activeId]);
  const busySet = useMemo(() => new Set(busy ? busy.split('|') : []), [busy]);
  const keep = useCallback((s: SessionSummary) => s.sessionId === activeId || busySet.has(s.sessionId) || s.live === 'running' || s.live === 'waiting', [activeId, busySet]);
  const kidsOf = useCallback((s: SessionSummary) => (expanded.has(s.sessionId) ? childrenOf(sessions, s.sessionId, { showArchived, meta: sessionMeta }) : []), [expanded, sessions, showArchived, sessionMeta]);
  const isBusy = useCallback((s: SessionSummary) => busySet.has(s.sessionId) || s.live === 'running' || s.live === 'waiting', [busySet]);
  // folded 更早的文件夹 still shows what must stay in view (the current conversation, running / waiting ones), like a
  // group's page cut does; its header spins while something in there runs
  const otherAll = useMemo(() => folders.older.flatMap(([, a]) => a), [folders]);
  const otherKept = useMemo(() => (otherCollapsed ? otherAll.filter(keep) : []), [otherCollapsed, otherAll, keep]);
  const otherBusy = otherAll.some(isBusy);
  // someone new (final review §9 #5): no project yet → the empty state points at 其它文件夹's folders, whose 设为项目
  // is written out; the library's discovery hint waits until the newcomer checklist is finished or closed
  const empty = byProject ? projectsEmpty({ projects: workspaces.length, otherFolders: grouped.other.length }) : null;
  const spellMake = makeProjectSpelled(workspaces.length);
  const hintOk = useStore((s) => hintReady(s.settings[CHECKLIST_KEY], Date.now()));

  // selection (全选, Shift ranges) only ever covers rows that are on screen: expanded groups, within their page limit
  // a folder's group key: by 文件夹, a project's own folder is that project's group (its name, menu, fold state)
  const fkey = (cwd: string) => (!byProject && projectFor(cwd, workspaces)?.id) || cwd;
  const rendered = useMemo(() => renderedRows([
    { key: '__pinned', items: pinned, collapsed: !!collapsed.__pinned },
    ...customs.map(({ c, items }) => ({ key: `custom:${c.id}`, items, collapsed: !!collapsed[`custom:${c.id}`] })),
    ...(view.groupBy === 'date' ? grouped.dates.map((d) => ({ key: `date:${d.bucket}`, items: d.items, collapsed: !!collapsed[`date:${d.bucket}`] }))
      : view.groupBy === 'none' ? [{ key: '__all', items: grouped.all, collapsed: !!collapsed.__all }]
      : [
        ...(byProject ? workspaces.map((w) => ({ key: w.id, items: grouped.byWs.get(w.id) ?? [], collapsed: folded(w.id, grouped.byWs.get(w.id) ?? []) })) : []),
        ...folders.recent.map(([cwd, arr]) => ({ key: fkey(cwd), items: arr, collapsed: folded(fkey(cwd), arr) })),
        ...folders.older.map(([cwd, arr]) => ({ key: fkey(cwd), items: arr, collapsed: otherCollapsed || folded(fkey(cwd), arr) })),
        { key: '__other_kept', items: otherKept, collapsed: false },
      ]),
    ...grouped.peers.map(([id, arr]) => ({ key: `peer:${id}`, items: arr, collapsed: folded(`peer:${id}`, arr) })),
  ], { ...(shown as Record<string, number>), ...Object.fromEntries(customs.map(({ c }) => [`custom:${c.id}`, Infinity])) }, first, { keep, kids: kidsOf }), [pinned, customs, view.groupBy, workspaces, grouped, folders, collapsed, otherCollapsed, otherKept, shown, first, keep, kidsOf, folded, byProject]);
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
  // a section's rows are also in their own group: a menu key of their own, or right-clicking one opened both menus
  // and they shut each other (stage C fix wave, found by the C-U3 ui-smoke check)
  const customCtx: RowCtx = { ...ctx, where: 'custom' };
  const toggleGroup = (k: string, cur = !!collapsed[k]) => dispatch({ t: 'sidebar.set', patch: { sections: { ...collapsed, [k]: !cur } } });
  const pickWorkspace = async () => {
    const p = await pickFolder().catch((e) => { toast((e as Error).message); return null; });
    if (p) await addWorkspace(p).catch((e) => toast(e.message));
  };
  const groupProps = (k: string, items: SessionSummary[]) => ({
    k, items, ctx, keep, kidsOf, first,
    collapsed: k === '__pinned' ? !!collapsed[k] : folded(k, items),
    onToggle: () => toggleGroup(k, k === '__pinned' ? !!collapsed[k] : folded(k, items)),
    shown: shown[k],
    setShown: (n: number | undefined) => setShown((m) => ({ ...m, [k]: n })),
    busy: items.some(isBusy),
    emptyText: ql ? tr('没有匹配的对话') : narrowed ? '' : tr('还没有对话'),
  });
  // one folder of 文件夹: named like the folder (its parent's name after it when another one has the same name)
  const folderGroup = (cwd: string, arr: SessionSummary[]) => {
    const w = byProject ? undefined : projectFor(cwd, workspaces);
    return w ? projectGroup(w, arr) : (
    <Group
      key={cwd}
      {...groupProps(cwd, arr)}
      name={labels.get(cwd) ?? cwd}
      icon="folder"
      title={cwd}
      className={clsx('other', spellMake && 'spelled')}
      actions={spellMake
        ? <button className="mk-proj" data-id={pm('make-project')} title={tr('设为项目：{cwd} 钉在「项目」里', { cwd })} onClick={() => void addWorkspace(cwd).catch((e) => toast(e.message))}>{tr('设为项目')}</button>
        : <>
          <button className="icon-btn xs" data-id={pm('new-here')} title={tr('在这里新建对话')} aria-label={tr('在这里新建对话')} onClick={() => { void useStore.getState().openSession({ cwd }).catch((e) => toast(e.message)); closeDrawer(); }}><Icon name="edit" size={13} /></button>
          <button className="icon-btn xs" data-id={pm('make-project')} title={tr('设为项目（钉在上面）')} aria-label={tr('设为项目')} onClick={() => void addWorkspace(cwd).catch((e) => toast(e.message))}><Icon name="pin" size={13} /></button>
        </>}
    />
  ); };
  // a project with its conversations (a header that can be dragged to reorder the projects, the project's menu)
  function projectGroup(w: (typeof workspaces)[number], arr: SessionSummary[]) {
    const mk = `proj:${w.id}`;
    const projMenu = toggleMenu(mk);
    const half = (e: React.DragEvent) => { const r = e.currentTarget.getBoundingClientRect(); return e.clientY > r.top + r.height / 2; };
    const drag = mobile || selecting || narrowed || !byProject || workspaces.length < 2 ? undefined : {
      onDragStart: (e: React.DragEvent) => { e.dataTransfer.setData(PROJECT_DRAG, w.id); e.dataTransfer.effectAllowed = 'move'; setDragWs(w.id); setMenu(null); },
      onDragEnd: () => { setDragWs(null); setOverWs(null); },
      onDragOver: (e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes(PROJECT_DRAG)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const after = half(e);
        if (overWs?.id !== w.id || overWs.after !== after) setOverWs({ id: w.id, after });
      },
      onDragLeave: () => setOverWs((o) => (o?.id === w.id ? null : o)),
      onDrop: (e: React.DragEvent) => {
        const id = e.dataTransfer.getData(PROJECT_DRAG);
        setDragWs(null);
        setOverWs(null);
        if (!id) return;
        e.preventDefault();
        const ids = workspaces.map((x) => x.id);
        const next = dropOrder(ids, id, w.id, half(e));
        if (next.join() !== ids.join()) void useStore.getState().reorderWorkspaces(next);
      },
      over: overWs?.id === w.id && dragWs !== w.id ? (overWs.after ? 'after' as const : 'before' as const) : null,
      dragging: dragWs === w.id,
    };
    return (
      <Group
        key={w.id}
        {...groupProps(w.id, arr)}
        name={w.name}
        icon="folder"
        title={drag ? tr("{path}\n拖动可以调整项目的顺序", { path: w.path }) : w.path}
        onContextMenu={projMenu}
        drag={drag}
        actions={<>
          <button className="icon-btn xs" data-id={pm('new-here')} title={tr('在这里新建对话')} aria-label={tr('在这里新建对话')} onClick={() => { void useStore.getState().openSession({ cwd: w.path }).catch((e) => toast(e.message)); closeDrawer(); }}><Icon name="edit" size={13} /></button>
          <button className="icon-btn xs" title={tr('更多')} aria-label={tr('项目菜单')} aria-haspopup="menu" aria-expanded={menu === mk} onClick={projMenu}><Icon name="more" size={14} /></button>
        </>}
        menu={menu === mk ? <ProjectMenu w={w} onClose={() => closeMenu(mk)} /> : undefined}
      />
    );
  }
  // 文件夹's groups: the recent ones, then 更早的文件夹 (folded)
  const foldersBlock = () => (
    <>
      {folders.recent.map(([cwd, arr]) => folderGroup(cwd, arr))}
      {folders.older.length > 0 && (
        <>
          <div className="sb-sec-h fold sb-older-h" data-id="older" role="button" tabIndex={0} aria-expanded={!otherCollapsed} onClick={() => toggleGroup('__older', otherCollapsed)} onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleGroup('__older', otherCollapsed); } }} title={tr('更早用过的文件夹')}>
            <Icon name={otherCollapsed ? 'chevronRight' : 'chevronDown'} size={12} className="sec-chev" />
            <span>{tr('更早的文件夹')}</span>
            {otherCollapsed && (otherBusy ? <span className="spin" title={tr('有对话在运行')} /> : <span className="n">{folders.older.length}</span>)}
          </div>
          {otherKept.length > 0 && (
            <div className="sb-rows sb-kept" role="group" aria-label={tr('更早的文件夹里当前 / 运行中的对话')}>
              {otherKept.map((s) => (
                <div key={s.sessionId} className="sb-row-wrap">
                  <SessionRow s={s} ctx={ctx} flat />
                  {expanded.has(s.sessionId) && kidsOf(s).map((k) => <SessionRow key={k.sessionId} s={k} ctx={ctx} depth={1} flat />)}
                </div>
              ))}
            </div>
          )}
          {!otherCollapsed && folders.older.map(([cwd, arr]) => folderGroup(cwd, arr))}
        </>
      )}
    </>
  );
  const top = (x: TopId) => x;
  const sec = (x: SectionId) => x;
  const head = (x: ProjectsHeadId) => x;
  const pm = (x: ProjectMenuId) => x;
  const cu = (x: CustomId) => x;
  const [dropOn, setDropOn] = useState<string | null>(null);
  const newSection = async () => {
    const name = (await dlg.prompt(tr('分区名称'), '', { placeholder: tr('比如：本周要交') }))?.trim();
    if (name) await saveSections(addSection(sections, `sec-${Date.now().toString(36)}`, name));
  };
  const DATE_NAME: Record<DateBucket, string> = { today: tr('今天'), yesterday: tr('昨天'), week: tr('最近 7 天'), month: tr('最近 30 天'), older: tr('更早') };
  const selBar: RowId = 'select-bar';
  const selSec: RowId = 'select-section';

  return (
    <>
      <div className="sb-top">
        <span className="brand"><span className="logo"><AppLogo size={20} /></span>Claude Web</span>
        {!mobile && <NavButtons />}
        {mobile
          ? <button className="icon-btn" data-id={top('collapse')} title={tr('收起侧栏 ({modKey}+B)', { modKey })} aria-label={tr('收起侧栏')} onClick={() => useStore.setState({ sidebarOpen: false })}><Icon name="sidebar" size={16} /></button>
          : <button className="icon-btn sb-find" data-id={top('search')} title={tr('搜索对话、命令和设置 ({modKey}+K)', { modKey })} aria-label={tr('搜索')} onClick={() => useStore.setState({ paletteOpen: true })}><Icon name="search" size={16} /></button>}
      </div>
      <nav className="sb-nav" aria-label={tr('导航')}>
        <button className={clsx('nav', !activeId && section === 'chat' && 'active')} data-id={top('new')} onClick={() => { onNew(); closeDrawer(); }}><Icon name="edit" size={16} />{tr('新对话')}<span className="k">{desktop ? `${modKey} N` : 'Alt N'}</span></button>
        {mobile && <>
          <button className="nav" data-id={top('search')} title={tr('搜索对话、命令和设置')} onClick={() => { useStore.setState({ paletteOpen: true }); closeDrawer(); }}><Icon name="search" size={16} />{tr('搜索')}<span className="k">{modKey} K</span></button>
          {/* 派活 (stage F3): a task from the phone → a new conversation on a computer (phone only: not an entries.ts place) */}
          <button className="nav" data-act="dispatch" title={tr('一句话交代任务，电脑上开一个新对话去做')} onClick={() => { setMenu(null); closeDrawer(); openDispatch(); }}><Icon name="send" size={16} />{tr('派活')}</button>
          {/* 自动化 → the automation page (定时任务 · 目标 · 编排, spec §5.9) over the main area, on the tab shown last */}
          {/* 后台 → what runs besides the turns (sub-agents, workflows, background commands), spec 2026-10-12 */}
          <button className={clsx('nav', section === 'background' && 'active')} data-id={top('background')} title={tr('在跑的子代理、工作流和后台命令')} aria-pressed={section === 'background'} onClick={() => { setMenu(null); openBackground(); }}><Icon name="office" size={16} />{tr('后台')}</button>
          <button className={clsx('nav', section === 'automation' && 'active')} data-id={top('automation')} title={tr('定时任务、目标、编排')} aria-pressed={section === 'automation'} onClick={() => { setMenu(null); openAutomation(); }}><Icon name="tasks" size={16} />{tr('自动化')}</button>
          {/* Bot → the duty bots' page (spec 2026-10-30): on a phone it opens on the inbox */}
          <button className={clsx('nav', section === 'bots' && 'active')} data-id={top('bots')} title={tr('Bot：住在你电脑里的值班队友')} aria-pressed={section === 'bots'} onClick={() => { setMenu(null); openBots(); }}><Icon name="bot" size={16} />{tr('Bot')}{inboxPending > 0 && <span className="k">{inboxPending}</span>}</button>
          <button className={clsx('nav', section === 'extensions' && 'active')} data-id={top('extensions')} title={tr('连接器、Skills、插件')} aria-pressed={section === 'extensions'} onClick={() => { setMenu(null); openExtensions(); }}><Icon name="extensions" size={16} />{tr('扩展')}</button>
        </>}
      </nav>
      <NeedsYou ctx={ctx} />
      <div className={clsx('sb-list', selecting && 'selecting')}>
        {selecting && (
          <div className="sel-bar" data-id={selBar} role="toolbar" aria-label={tr('批量操作')}>
            <span className="n">{tr('已选 {selectedCount}', { selectedCount: selected.length })}</span>
            <button className="btn sm ghost" title={tr('只选当前显示出来的对话（展开的项目、已显示的行）')} onClick={() => setPicked(allOn ? new Set() : new Set(order))}>{allOn ? tr('全不选') : tr('全选 {renderedCount}', { renderedCount: rendered.length })}</button>
            <span className="grow" />
            {selCaps.archive && <button className="btn sm" onClick={async () => { await setArchived(selected, !allArchived); endSelect(); }}><Icon name="archive" size={12} /> {allArchived ? tr('取消归档') : tr('归档')}</button>}
            {selCaps.delete && <button className="btn sm danger" onClick={async () => { if (await deleteSessions(selected)) endSelect(); }}><Icon name="trash" size={12} /> {tr('删除')}</button>}
            {sections.length > 0 && selected.length > 0 && (
              <span className="anchor">
                <button className="btn sm" data-id={selSec} aria-haspopup="menu" aria-expanded={menu === 'sel-section'} onClick={toggleMenu('sel-section')}><Icon name="plus" size={12} /> {tr('加入分区')}</button>
                {menu === 'sel-section' && (
                  <Menu onClose={() => closeMenu('sel-section')} label={tr('加入分区')}>
                    {sections.map((c) => (
                      <button key={c.id} data-section={c.id} onClick={async () => { closeMenu('sel-section'); await saveSections(addAllToSection(sections, c.id, selected.map((x) => x.sessionId))); endSelect(); }}>{c.name}</button>
                    ))}
                  </Menu>
                )}
              </span>
            )}
            <button className="btn sm ghost" title={tr('退出多选 (Esc)')} onClick={endSelect}>{tr('完成')}</button>
            {selected.length > 0 && !selCaps.archive && !selCaps.delete && <span className="hint">{tr('选中的对话来源不支持批量操作')}</span>}
          </div>
        )}
        {narrowed && !selecting && (
          <div className="sb-filtered" role="status">
            <Icon name="filter" size={12} />
            <span className="what" title={summary.join(' · ')}>{summary.join(' · ')}</span>
            <button className="link" onClick={clearFilters}>{tr('清除')}</button>
          </div>
        )}
        {pinned.length > 0 && (
          <Group {...groupProps('__pinned', pinned)} section dataId={sec('pinned')} name={tr('置顶')} icon="pin" className="pinned" />
        )}
        {customs.map(({ c, items }) => {
          const k = `custom:${c.id}`;
          const shut = !!collapsed[k];
          const menuOpen = toggleMenu(k);
          return (
            <div key={c.id} className={clsx('sb-group sb-sec sb-custom', shut && 'collapsed', dropOn === c.id && 'drop-on')} data-group={k} data-section={c.id} data-id={sec('custom')}>
              {/* the heading is the drop target; its title is a real button (fold), the ⋯ button sits beside it — no control
                  nested inside a role=button (stage C fix wave C-U4) */}
              <div className="sb-sec-h fold" data-id={cu('custom-section')} title={tr('把对话拖到这里放进这个分区')}
                onClick={(e) => { if (e.target === e.currentTarget) toggleGroup(k, shut); }} onContextMenu={menuOpen}
                onDragOver={(e) => { if (!e.dataTransfer.types.includes(MIME_SESSION)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; if (dropOn !== c.id) setDropOn(c.id); }}
                onDragLeave={() => setDropOn((d) => (d === c.id ? null : d))}
                onDrop={(e) => { const sid = e.dataTransfer.getData(MIME_SESSION); setDropOn(null); if (!sid) return; e.preventDefault(); void saveSections(addToSection(sections, c.id, sid)); }}>
                <button type="button" className="sb-sec-t" aria-expanded={!shut} onClick={() => toggleGroup(k, shut)}>
                  <span className="name">{c.name}</span>
                  <Icon name={shut ? 'chevronRight' : 'chevronDown'} size={12} className="sec-chev" />
                  {shut && <span className="cnt">{items.length}</span>}
                </button>
                <span className="acts">
                  <button className="icon-btn xs" title={tr('更多')} aria-label={tr('分区菜单')} aria-haspopup="menu" aria-expanded={menu === k} onClick={menuOpen}><Icon name="more" size={14} /></button>
                </span>
                {menu === k && (
                  <Menu onClose={() => closeMenu(k)} className="sb-custom-menu" label={tr('分区 {name}', { name: c.name })}>
                    <button data-id={cu('custom-rename')} onClick={async () => { closeMenu(k); const n = (await dlg.prompt(tr('分区名称'), c.name))?.trim(); if (n) await saveSections(renameSection(sections, c.id, n)); }}><Icon name="edit" size={14} /> {tr('重命名')}</button>
                    <button data-id={cu('custom-delete')} className="danger" onClick={async () => { closeMenu(k); if (await dlg.confirm(tr('删除分区「{name}」？', { name: c.name }), { message: tr('只删除这个分区，对话还在原来的分组里'), danger: true })) await saveSections(deleteSection(sections, c.id)); }}><Icon name="trash" size={14} /> {tr('删除分区')}</button>
                  </Menu>
                )}
              </div>
              {!shut && (
                <div className="sb-rows">
                  {items.map((s) => (
                    <div key={s.sessionId} className="sb-row-wrap with-out">
                      <SessionRow s={s} ctx={customCtx} flat />
                      <button className="icon-btn xs sb-custom-out" data-id={cu('custom-out')} title={tr('移出分区')} aria-label={tr('移出分区')} onClick={() => void saveSections(removeFromSection(sections, c.id, s.sessionId))}><Icon name="close" size={12} /></button>
                    </div>
                  ))}
                  {!items.length && <div className="sb-empty-row">{tr('把对话拖到这里')}</div>}
                </div>
              )}
            </div>
          );
        })}
        <div className="sb-sec" data-id={sec('projects')}>
          <div className="sb-sec-h">
            <span>{byProject ? trAs('项目', 'Projects') : tr('对话')}</span>
            <span className="grow" />
            <span className="anchor">
              <button className={clsx('icon-btn xs', (viewDot || menu === 'view') && 'on')} data-id={head('view')} title={tr('显示：分组、排序、筛选、来源、已归档、选择多个')} aria-label={tr('显示')} aria-haspopup="menu" aria-expanded={menu === 'view'} onClick={toggleMenu('view')}>
                <Icon name="filter" size={14} />{viewDot && <span className="fdot" />}
              </button>
              {menu === 'view' && (
                <ViewMenu
                  onClose={() => closeMenu('view')}
                  view={view} setView={(v) => void setSetting(VIEW_KEY, v)}
                  query={q} setQuery={setQ}
                  sources={chips} counts={counts} total={total} source={sourceFilter} setSource={(k: AgentKind | 'all') => setSourceFilter(k)}
                  machines={machines} machine={machine} setMachine={setMachine} showMachines={showMachines}
                  onSelect={() => { setSelecting(true); closeMenu('view'); }}
                  onNewSection={() => void newSection()}
                  onReset={() => { void setSetting(VIEW_KEY, DEFAULT_VIEW); useStore.getState().setShowArchived(false); }}
                  onAll={() => useStore.setState({ paletteOpen: true })}
                />
              )}
            </span>
            <button className="icon-btn xs" data-id={head('add-project')} title={tr('打开文件夹（添加项目）')} aria-label={tr('打开文件夹')} onClick={pickWorkspace}><Icon name="plus" size={15} /></button>
          </div>
          {empty && (
            <div className="ws-empty sb-empty" data-empty={empty.openButton ? 'open' : 'make-project'}>
              {empty.text}
              {empty.openButton && <div><button className="btn sm primary" onClick={pickWorkspace}><Icon name="folder" size={13} /> {tr('打开文件夹')}</button></div>}
            </div>
          )}
          {byProject && workspaces.map((w) => {
            const arr = grouped.byWs.get(w.id) ?? [];
            return narrowed && !arr.length ? null : projectGroup(w, arr);
          })}
          {view.groupBy === 'folder' && foldersBlock()}
          {view.groupBy === 'date' && grouped.dates.map((d) => (
            <Group key={`date:${d.bucket}`} {...groupProps(`date:${d.bucket}`, d.items)} collapsed={!!collapsed[`date:${d.bucket}`]} onToggle={() => toggleGroup(`date:${d.bucket}`, !!collapsed[`date:${d.bucket}`])} name={DATE_NAME[d.bucket]} icon="calendar" className="date" />
          ))}
          {view.groupBy === 'none' && grouped.all.length > 0 && (
            <Group {...groupProps('__all', grouped.all)} collapsed={!!collapsed.__all} onToggle={() => toggleGroup('__all', !!collapsed.__all)} section name={tr('全部对话')} icon="chat" className="flat" />
          )}
        </div>
        {byProject && grouped.other.length > 0 && (
          <div className="sb-sec" data-id={sec('other')}>
            <div className="sb-sec-h" title={tr('不在项目里的对话，每个文件夹一组，最近用过的在上面')}><span>{tr('文件夹')}</span></div>
            {foldersBlock()}
          </div>
        )}
        {grouped.peers.length > 0 && (
          <div className="sb-sec" data-id={sec('peers')}>
            <div className="sb-sec-h"><span>{tr('其它电脑')}</span></div>
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
                  title={p?.offline ? tr('离线：显示上次的列表，只读') : tr('在另一台电脑上：打开、续聊、审批都经那台电脑')}
                  badge={p?.offline ? <span className="badge">{tr('离线')}</span> : undefined}
                />
              );
            })}
          </div>
        )}
        {!visible.length && narrowed && (
          <div className="empty sb-empty">{tr('没有匹配的对话')}<div><button className="btn sm" onClick={clearFilters}>{tr('清除筛选')}</button></div></div>
        )}
      </div>
      {pending.length > 0 && hintOk && <DiscoveryHint pending={pending} />}
      {mobile && <AccountRow open={menu === 'account'} setOpen={(v) => (v ? setMenu('account') : closeMenu('account'))} />}
    </>
  );
}

/** ← →: the conversations looked at before / after this one (workbench/nav-history.ts); the official title bar's pair. */
function NavButtons() {
  const back = useNav((n) => n.back.length > 0);
  const fwd = useNav((n) => n.forward.length > 0);
  return (
    <span className="sb-nav-arrows">
      <button className="icon-btn" data-id={'back' satisfies TopId} disabled={!back} title={tr('后退 (Alt+←)')} aria-label={tr('后退')} onClick={() => navGo(-1)}><Icon name="arrowLeft" size={15} /></button>
      <button className="icon-btn" data-id={'forward' satisfies TopId} disabled={!fwd} title={tr('前进 (Alt+→)')} aria-label={tr('前进')} onClick={() => navGo(1)}><Icon name="arrowRight" size={15} /></button>
    </span>
  );
}
