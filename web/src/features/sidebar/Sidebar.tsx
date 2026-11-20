import { modKey } from '@/features/workbench/shortcuts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { agentOf, families, filterSessions, filterSummary, isArchived, KIDS_SHOWN, machineCounts, renderedRows, sourceCounts, type SessionFilter } from './filter';
import { capsIntersection, deleteSessions, saveSections, setArchived } from './session-actions';
import { rangeIds } from './status';
import { SessionRow, type RowCtx, type Selection } from './rows';
import { FolderMenu, Group, ProjectMenu } from './groups';
import { NeedsYou } from './attention';
import { ViewMenu, type SourceChip } from './view-menu';
import { addAllToSection, addSection, addToSection, DEFAULT_VIEW, deleteSection, groupSessions, perGroupLimit, readSections, readView, removeFromSection, renameSection, SECTIONS_KEY, sortSessions, VIEW_KEY, type DateBucket } from './view';
import { MIME_SESSION } from '@/features/workbench/dnd';
import { dlg } from '@/ui/dialog';
import { imeComposing } from '@/ui/ime';
import { AccountRow } from './account';
import { DiscoveryHint } from './hint';
import { hintReady, makeProjectSpelled, projectsEmpty } from './newcomer';
import { Menu, closeDrawer } from './menus';
import { anchoredMenuOpen } from '@/ui/menus';
import { openExtensions } from '@/features/extensions/state';
import { openArtifacts } from '@/features/artifacts/state';
import { ARTIFACTS_TITLE } from '@/features/artifacts/page';
import { openFamily, useAutomationWaiting } from '@/features/automation/family';
import { AUTOMATION_TITLE } from '@/features/automation/page';
import { EXTENSIONS_TITLE } from '@/features/extensions/page';
import { useSection } from '@/features/sections';
import { AppMenu } from './AppMenu';
import type { CustomId, GroupHeadId, ProjectMenuId, ProjectsHeadId, RowId, SectionId, TopId } from './entries';
import { tr, trAs } from '@/i18n';
import { pickFolder } from '@/ui/pick-folder';

/** Ids of conversations that must stay in view past a group's cut: running / waiting ones (a stable string, not the `open` map). */
const busyIds = (s: ReturnType<typeof useStore.getState>) =>
  Object.values(s.open).filter((o) => o.state === 'running' || o.state === 'starting' || o.state === 'waiting' || o.pending.length).map((o) => o.sessionId).sort().join('|');

/**
 * What takes an Esc before the sidebar's multi-select besides a menu: a dialog or the shortcuts sheet, the command
 * palette, the full-window viewer (ui/Viewer: a picture, a node graph made big). Any `.menu` on screen counts too (a
 * menu that forgot to claim itself still gets its Esc first).
 */
const OVER_SIDEBAR = '.menu, .modal-bg, .palette-bg, .viewer';

/**
 * Esc ends multi-select only when it is meant for the sidebar: focus in the sidebar (or nowhere) and nothing that
 * takes the key first open — no anchored menu (`anchoredMenuOpen()`: the sidebar's own, the header ···, a composer /
 * right-panel popover, the model / directory menu, a workbench dropdown, the file tree's right-click menu…; polish P1:
 * with the focus on <body> the header ··· used to close and the selection went with it), nothing of OVER_SIDEBAR, no
 * settings page / image viewer, not the list's / filter box (it takes its own Esc). One Esc does one thing. Runs in
 * the capture phase on window — before anything else sees the key, so before those overlays close themselves on it —
 * and only reads, never stops the event.
 */
function escForSidebar(e: KeyboardEvent): boolean {
  if (e.key !== 'Escape') return false;
  const st = useStore.getState();
  if (st.paletteOpen || st.settingsOpen || st.shortcutsOpen || st.viewer) return false;
  if (anchoredMenuOpen() || document.querySelector(OVER_SIDEBAR)) return false;
  const a = document.activeElement;
  if (a?.closest('.sb-slash')) return false;
  return !a || a === document.body || !!a.closest('.sidebar');
}

/** A text box, an editor or a terminal has the keys: a / typed there is text, not the sidebar's filter. */
const typing = (a: Element | null) => !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || (a as HTMLElement).isContentEditable || !!a.closest('.monaco-editor, .xterm'));

/**
 * The sidebar (spec 2026-09-28 §5.1; redesign 2026-11 stage 1: the window's one column of navigation — no icon rail;
 * stage 3: 图 7): the brand mark (the application menu), the sidebar's switch and ← →; the five entries 新对话 · 搜索 ·
 * Artifacts · 自动化 · 自定义; 「需要你」 while something waits; conversations by project — each row a title and one
 * status at its end, its forks / side conversations one level in under it; on hover a project / folder header shows
 * 显示 (how the list is shown: six rows, the choices fly out to the right) and ＋ (a new conversation there); / filters
 * the list in place; the account row (quota ring, settings, the account menu) at the bottom. A phone's drawer: the
 * name, a search box and four rows (新对话 · Artifacts · 自动化 · 自定义), the list's one ≡ (显示) on its header, rows with
 * their status only (a long press opens a row's menu, or a header's). Every entry point of the old sidebar and the rail
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
  // what waits for the user in 自动化 (the Bot inbox, the orchestra's approvals): a number on its entry
  const autoWaiting = useAutomationWaiting();
  const mobile = useStore((s) => s.mobile);
  const [q, setQ] = useState('');
  // the list's own filter box (stage 3: the 显示 menu's box moved to 搜索; / in the sidebar filters in place)
  const [slash, setSlash] = useState(false);
  const slashBox = useRef<HTMLInputElement>(null);
  // the sidebar's one open menu: `app` · `view` / `view:<group>` · `account` · `proj:<id>` · `folder:<cwd>` ·
  // `row:<list|attn|custom>:<id>` (opening one closes the others)
  const [menu, setMenu] = useState<string | null>(null);
  const [shown, setShown] = useState<Record<string, number | undefined>>({});
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [machine, setMachine] = useState<string>('all');
  // projects reordered by dragging their header (2026-10-14 user report): which one is dragged, where it would land
  const [dragWs, setDragWs] = useState<string | null>(null);
  const [overWs, setOverWs] = useState<{ id: string; after: boolean } | null>(null);
  const toggleMenu = (k: string) => (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); setMenu((m) => (m === k ? null : k)); };
  // a menu closes only itself: a late close from the one being replaced must not shut the one that just opened
  const closeMenu = useCallback((k: string) => setMenu((m) => (m === k ? null : m)), []);

  const ql = q.trim();
  const filterOpts = useMemo<SessionFilter>(() => ({ source: sourceFilter, query: q, showArchived, meta: sessionMeta, machine, otherAgents: view.show.otherAgents }), [sourceFilter, q, showArchived, sessionMeta, machine, view.show.otherAgents]);
  const visible = useMemo(() => filterSessions(sessions, filterOpts), [sessions, filterOpts]);
  // forks and side conversations sit one level under the conversation they came from (stage 3): the list's own rows
  // are the rest
  const fam = useMemo(() => families(sessions, visible, filterOpts), [sessions, visible, filterOpts]);
  const tops = useMemo(() => (fam.rootOf.size ? visible.filter((s) => !fam.rootOf.has(s.sessionId)) : visible), [visible, fam]);
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
  // listed, there is no 「已筛选」 row for it and 清除 leaves it on (it still lights the 显示 button: a non-default setting)
  const machineName = (m: string) => machines.find((x) => x.id === m)?.name ?? m;
  const narrowed = filterSummary({ source: sourceFilter, machine, query: q }, nameOf, machineName).length > 0;
  // the / box shows its own text: the 「已筛选」 row then says only what else narrows the list
  const slashOn = !mobile && (slash || !!ql);
  const summary = filterSummary({ source: sourceFilter, machine, query: slashOn ? '' : q }, nameOf, machineName);
  // the 显示 button's dot (and the button staying shown at rest): something narrows, widens or hides part of the list.
  // A deliberate 分组 / 排序 / 每组几条 choice is not that — the list itself shows it — and lighting it for good would
  // add a control at rest (外框控件计数, 界面改版 阶段 0–1; stage C fix wave C-U4)
  const viewDot = narrowed || showArchived || !view.show.otherAgents;
  const clearFilters = () => { setQ(''); setSlash(false); setSourceFilter('all'); setMachine('all'); };
  const pending = sources.filter((x) => x.kind !== 'claude' && x.detected && !x.joined && !x.dismissed);
  const pinned = tops.filter((s) => sessionMeta[s.sessionId]?.pinned);

  // grouped as the 显示 menu says (view.ts: by project — the folder it ran in, the rest by folder —, by folder, by
  // date or not at all), other machines by machine; pinned ones are in 置顶 only
  const vgroups = useMemo(() => groupSessions(tops, view, { workspaces, meta: sessionMeta, now: Date.now() }), [tops, view, workspaces, sessionMeta]);
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
  // the current conversation's row in the list: itself, or the conversation it was forked from (it sits under it)
  const activeRoot = activeId ? fam.rootOf.get(activeId) ?? activeId : null;
  // projects / folders / machines start folded (GitHub issue #3) unless the user opened them, or the current conversation
  // is in there; a search shows every match
  const foldDefault = useStore((s) => s.settings['ui.sidebarFolded'] !== false);
  const folded = useCallback((k: string, items: SessionSummary[]) => collapsed[k] ?? (!ql && foldDefault && !items.some((s) => s.sessionId === activeRoot)), [collapsed, ql, foldDefault, activeRoot]);
  const busySet = useMemo(() => new Set(busy ? busy.split('|') : []), [busy]);
  const keep = useCallback((s: SessionSummary) => s.sessionId === activeId || busySet.has(s.sessionId) || s.live === 'running' || s.live === 'waiting', [activeId, busySet]);
  const isBusy = useCallback((s: SessionSummary) => busySet.has(s.sessionId) || s.live === 'running' || s.live === 'waiting', [busySet]);
  // a row's forks / side conversations: shown unless folded (a root with more than KIDS_SHOWN starts folded; the
  // user's fold is kept as `kids:<id>` with the groups'); folded, the current / running ones still show
  const kidsFolded = useCallback((id: string, n: number) => collapsed[`kids:${id}`] ?? n > KIDS_SHOWN, [collapsed]);
  const kidsOf = useCallback((s: SessionSummary) => {
    const ks = fam.kids.get(s.sessionId);
    if (!ks) return [];
    return kidsFolded(s.sessionId, ks.length) ? ks.filter(keep) : ks;
  }, [fam, kidsFolded, keep]);
  const expanded = useMemo(() => new Set([...fam.kids].filter(([id, ks]) => !kidsFolded(id, ks.length)).map(([id]) => id)), [fam, kidsFolded]);
  // a root stays in view past a group's cut for what is under it too
  const keepFam = useCallback((s: SessionSummary) => keep(s) || !!fam.kids.get(s.sessionId)?.some(keep), [keep, fam]);
  const busyFam = useCallback((s: SessionSummary) => isBusy(s) || !!fam.kids.get(s.sessionId)?.some(isBusy), [isBusy, fam]);
  // folded 更早的文件夹 still shows what must stay in view (the current conversation, running / waiting ones), like a
  // group's page cut does; its header spins while something in there runs
  const otherAll = useMemo(() => folders.older.flatMap(([, a]) => a), [folders]);
  const otherKept = useMemo(() => (otherCollapsed ? otherAll.filter(keepFam) : []), [otherCollapsed, otherAll, keepFam]);
  const otherBusy = otherAll.some(busyFam);
  // someone new (final review §9 #5): no project yet → the empty state points at 其它文件夹's folders, whose 设为项目
  // is written out; the library's discovery hint waits out the first screen (no conversation here yet)
  const empty = byProject ? projectsEmpty({ projects: workspaces.length, otherFolders: grouped.other.length }) : null;
  const spellMake = makeProjectSpelled(workspaces.length);
  const hintOk = useStore((s) => hintReady({ listed: s.sessionsListed, sessions: s.sessions }));
  // 显示 (stage 3, 图 7): a desktop's is on each project / folder / date header (on hover); the 项目 row has it where no
  // header carries it — the flat list, an empty one, a newcomer's folders (their header says 设为项目) — and while it
  // has something to say (its dot). A phone: the list's one ≡, on this row
  const groupViews = !mobile && !spellMake && view.groupBy !== 'none';
  const hasGroupHeads = byProject ? workspaces.length + grouped.other.length > 0 : view.groupBy === 'folder' ? grouped.other.length > 0 : view.groupBy === 'date' && grouped.dates.length > 0;
  const headView = mobile || !groupViews || !hasGroupHeads || viewDot || menu === 'view';

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
  ], { ...(shown as Record<string, number>), ...Object.fromEntries(customs.map(({ c }) => [`custom:${c.id}`, Infinity])) }, first, { keep: keepFam, kids: kidsOf }), [pinned, customs, view.groupBy, workspaces, grouped, folders, collapsed, otherCollapsed, otherKept, shown, first, keepFam, kidsOf, folded, byProject]);
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
  // / in the sidebar (the focus there, or nowhere with the pointer over it) opens the list's filter box (a desktop:
  // a phone has no keys — its drawer's search box is the search). Not over a menu, a dialog, the palette or settings
  useEffect(() => {
    if (mobile) return;
    const k = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || imeComposing(e)) return;
      const st = useStore.getState();
      if (st.paletteOpen || st.settingsOpen || st.shortcutsOpen || st.viewer || !st.sidebarOpen) return;
      const a = document.activeElement;
      if (typing(a)) return;
      const here = !!a?.closest('.sidebar') || ((!a || a === document.body) && !!document.querySelector('.sidebar:hover'));
      if (!here || anchoredMenuOpen() || document.querySelector(OVER_SIDEBAR)) return;
      e.preventDefault();
      setSlash(true);
      requestAnimationFrame(() => slashBox.current?.focus({ preventScroll: true }));
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [mobile]);
  const selCaps = capsIntersection(selected);
  const allArchived = selected.length > 0 && selected.every((s) => isArchived(s, sessionMeta));

  const ctx: RowCtx = {
    where: 'list', menu, setMenu, closeMenu, sel, expanded,
    toggleKids: (id) => { const n = fam.kids.get(id)?.length ?? 0; dispatch({ t: 'sidebar.set', patch: { sections: { ...collapsed, [`kids:${id}`]: !kidsFolded(id, n) } } }); },
    kidCount: (s) => fam.kids.get(s.sessionId)?.length ?? 0,
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
  const newHere = (cwd: string) => { void useStore.getState().openSession({ cwd }).catch((e) => toast(e.message)); closeDrawer(); };
  const groupProps = (k: string, items: SessionSummary[]) => ({
    k, items, ctx, keep: keepFam, kidsOf, first,
    collapsed: k === '__pinned' ? !!collapsed[k] : folded(k, items),
    onToggle: () => toggleGroup(k, k === '__pinned' ? !!collapsed[k] : folded(k, items)),
    shown: shown[k],
    setShown: (n: number | undefined) => setShown((m) => ({ ...m, [k]: n })),
    busy: items.some(busyFam),
    emptyText: ql ? tr('没有匹配的对话') : narrowed ? '' : tr('还没有对话'),
  });
  const newSection = async () => {
    const name = (await dlg.prompt(tr('分区名称'), '', { placeholder: tr('比如：本周要交') }))?.trim();
    if (name) await saveSections(addSection(sections, `sec-${Date.now().toString(36)}`, name));
  };
  // the 显示 menu: one, whichever 显示 button opened it (a header's, or the 项目 row's) — it lives in the 项目 row,
  // which stays while a choice in it rebuilds the groups (by 日期 a project's header is gone; the menu stays open, as
  // a choice always left it), and is placed next to that button while the button is there
  const viewBtns = useRef(new Map<string, HTMLElement>());
  const viewKey = menu === 'view' || menu?.startsWith('view:') ? menu : null;
  const viewMenu = viewKey && (
    <ViewMenu
      onClose={() => closeMenu(viewKey)}
      anchor={() => viewBtns.current.get(viewKey) ?? null}
      view={view} setView={(v) => void setSetting(VIEW_KEY, v)}
      sources={chips} counts={counts} total={total} source={sourceFilter} setSource={(x: AgentKind | 'all') => setSourceFilter(x)}
      machines={machines} machine={machine} setMachine={setMachine} showMachines={showMachines}
      onNewSection={() => void newSection()}
      onReset={() => { void setSetting(VIEW_KEY, DEFAULT_VIEW); useStore.getState().setShowArchived(false); }}
      onAll={() => useStore.setState({ paletteOpen: true })}
    />
  );
  const viewButton = (k: string, dataId: 'view' | 'group-view') => (
    <button
      ref={(el) => { if (el) viewBtns.current.set(k, el); else viewBtns.current.delete(k); }}
      className={clsx('icon-btn xs', (viewDot || menu === k) && 'on')} data-id={dataId} title={tr('显示：分组方式、排序、已归档、来源、机器')} aria-label={tr('显示')} aria-haspopup="menu" aria-expanded={menu === k} onClick={toggleMenu(k)}
    >
      <Icon name="filter" size={14} />{viewDot && <span className="fdot" />}
    </button>
  );
  const gh = (x: GroupHeadId) => x;
  // a project / folder / date header's 显示 and ＋ (on hover; none on a phone, whose list has its one ≡)
  const headActs = (key: string, cwd?: string) => groupViews && (
    <>
      {viewButton(`view:${key}`, 'group-view')}
      {cwd !== undefined && <button className="icon-btn xs" data-id={gh('new-here')} title={tr('在这里新建对话')} aria-label={tr('在这里新建对话')} onClick={() => newHere(cwd)}><Icon name="plus" size={14} /></button>}
    </>
  );
  // one folder of 文件夹: named like the folder (its parent's name after it when another one has the same name)
  const folderGroup = (cwd: string, arr: SessionSummary[]) => {
    const w = byProject ? undefined : projectFor(cwd, workspaces);
    if (w) return projectGroup(w, arr);
    const mk = `folder:${cwd}`;
    const name = labels.get(cwd) ?? cwd;
    const spelled = spellMake && <button className="mk-proj" data-id={pm('make-project')} title={tr('设为项目：{cwd} 钉在「项目」里', { cwd })} onClick={() => void addWorkspace(cwd).catch((e) => toast(e.message))}>{tr('设为项目')}</button>;
    return (
      <Group
        key={cwd}
        {...groupProps(cwd, arr)}
        name={name}
        icon="folder"
        title={cwd}
        className={clsx('other', spellMake && 'spelled', menu === `view:${cwd}` && 'menu-on')}
        actions={spelled || headActs(cwd, cwd)}
        phoneActions={spelled}
        onContextMenu={toggleMenu(mk)}
        onHold={() => setMenu(mk)}
        menu={menu === mk ? <FolderMenu cwd={cwd} name={name} onClose={() => closeMenu(mk)} /> : undefined}
      />
    );
  };
  // a project with its conversations (a header that can be dragged to reorder the projects, the project's menu on a
  // right-click / a long press)
  function projectGroup(w: (typeof workspaces)[number], arr: SessionSummary[]) {
    const mk = `proj:${w.id}`;
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
        className={clsx(menu === `view:${w.id}` && 'menu-on')}
        title={drag ? tr("{path}\n拖动可以调整项目的顺序", { path: w.path }) : w.path}
        onContextMenu={toggleMenu(mk)}
        onHold={() => setMenu(mk)}
        drag={drag}
        actions={headActs(w.id, w.path)}
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
                  {kidsOf(s).map((k) => <SessionRow key={k.sessionId} s={k} ctx={ctx} depth={1} flat />)}
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
  // 自动化 is three pages behind one tab row (features/automation/family.tsx): any of them in front lights it
  const autoOn = section === 'automation' || section === 'background' || section === 'bots';
  const head = (x: ProjectsHeadId) => x;
  const pm = (x: ProjectMenuId) => x;
  const cu = (x: CustomId) => x;
  const [dropOn, setDropOn] = useState<string | null>(null);
  const DATE_NAME: Record<DateBucket, string> = { today: tr('今天'), yesterday: tr('昨天'), week: tr('最近 7 天'), month: tr('最近 30 天'), older: tr('更早') };
  const selBar: RowId = 'select-bar';
  const selSec: RowId = 'select-section';
  const slashId: RowId = 'filter';
  const closeSlash = () => { setQ(''); setSlash(false); };

  return (
    <>
      <div className="sb-top">
        {mobile
          ? <span className="brand"><span className="logo"><AppLogo size={20} /></span>Claude Web</span>
          : <BrandMenu open={menu === 'app'} toggle={toggleMenu('app')} close={() => closeMenu('app')} />}
        {/* a desktop: [logo ▾] [⧉] … [← →]; the phone's drawer closes with the × at its far end (the plan's drawer) */}
        {!mobile && <button className="icon-btn sb-collapse" data-id={top('collapse')} title={tr('收起侧栏 ({modKey}+B)', { modKey })} aria-label={tr('收起侧栏')} onClick={() => useStore.setState({ sidebarOpen: false })}><Icon name="sidebar" size={16} /></button>}
        <span className="grow" />
        {!mobile && <NavButtons />}
        {mobile && <button className="icon-btn sb-collapse" data-id={top('collapse')} aria-label={tr('收起侧栏')} onClick={() => useStore.setState({ sidebarOpen: false })}><Icon name="close" size={18} /></button>}
      </div>
      {/* a phone: the drawer opens with a search box (the palette: conversations, Artifacts, commands) */}
      {mobile && (
        <button type="button" className="sb-search" data-id={top('search')} onClick={() => { useStore.setState({ paletteOpen: true }); closeDrawer(); }}>
          <Icon name="search" size={16} /><span className="ph">{tr('搜索对话和 Artifacts')}</span>
        </button>
      )}
      <nav className="sb-nav" aria-label={tr('导航')}>
        {/* 新对话 · (搜索) · Artifacts · 自动化 · 自定义 (redesign 2026-11 stage 1). A phone's 新对话 also picks a computer
            and a folder on the page it opens: the old 派活 is in there (and in the palette) */}
        <button className={clsx('nav', !activeId && section === 'chat' && 'on')} data-id={top('new')} aria-current={!activeId && section === 'chat' ? 'page' : undefined} onClick={() => { onNew(); closeDrawer(); }}><Icon name="edit" size={16} />{tr('新对话')}{!mobile && <span className="k">{desktop ? `${modKey} N` : 'Alt N'}</span>}</button>
        {!mobile && <button className="nav" data-id={top('search')} title={tr('搜索对话、Artifacts、命令和设置；在侧栏里按 / 就地筛选')} onClick={() => useStore.setState({ paletteOpen: true })}><Icon name="search" size={16} />{tr('搜索')}<span className="k">{modKey} K</span></button>}
        <button className={clsx('nav', section === 'artifacts' && 'on')} data-id={top('artifacts')} title={tr('Claude 在最近的对话里做出来的网页、文档、图片和数据')} aria-current={section === 'artifacts' ? 'page' : undefined} onClick={() => { setMenu(null); openArtifacts(); }}><Icon name="works" size={16} />{ARTIFACTS_TITLE}</button>
        <button className={clsx('nav', autoOn && 'on')} data-id={top('automation')} title={tr('运行中、定时任务、Bot、目标、编排')} aria-current={autoOn ? 'page' : undefined} onClick={() => { setMenu(null); openFamily(); }}>
          <Icon name="workflow" size={16} />{AUTOMATION_TITLE}
          {autoWaiting > 0 && <span className="cnt" title={tr('{autoWaiting} 件事等你：Bot 收件箱、等你审批的编排', { autoWaiting })}>{autoWaiting}</span>}
        </button>
        <button className={clsx('nav', section === 'extensions' && 'on')} data-id={top('extensions')} title={tr('连接器、Skills、插件')} aria-current={section === 'extensions' ? 'page' : undefined} onClick={() => { setMenu(null); openExtensions(); }}><Icon name="extensions" size={16} />{EXTENSIONS_TITLE}</button>
      </nav>
      <NeedsYou ctx={ctx} />
      <div className={clsx('sb-list', selecting && 'selecting')}>
        {slashOn && !selecting && (
          <div className="sb-filter-q sb-slash" data-id={slashId}>
            <Icon name="search" size={13} />
            <input
              ref={slashBox}
              value={q}
              placeholder={tr('筛选对话…')}
              aria-label={tr('按标题或文件夹筛选侧栏里的对话')}
              onChange={(e) => setQ(e.target.value)}
              onBlur={() => { if (!q.trim()) setSlash(false); }}
              onKeyDown={(e) => {
                if (imeComposing(e.nativeEvent)) return;
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSlash(); }
                // ↓ / Enter: on to the list's first row
                else if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); document.querySelector<HTMLElement>('.sidebar .sb-list .sb-row[data-sid]')?.focus({ preventScroll: false }); }
              }}
            />
            <button className="icon-btn xs" title={tr('关闭筛选')} aria-label={tr('关闭筛选')} onClick={closeSlash}><Icon name="close" size={12} /></button>
          </div>
        )}
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
            <button className="btn sm ghost" title={mobile ? undefined : tr('退出多选 (Esc)')} onClick={endSelect}>{tr('完成')}</button>
            {selected.length > 0 && !selCaps.archive && !selCaps.delete && <span className="hint">{tr('选中的对话来源不支持批量操作')}</span>}
          </div>
        )}
        {summary.length > 0 && !selecting && (
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
            {headView && viewButton('view', 'view')}
            {/* (a desktop's ＋ on a project header is a new conversation there: this one is a folder icon) */}
            <button className="icon-btn xs" data-id={head('add-project')} title={tr('打开文件夹（添加项目）')} aria-label={tr('打开文件夹')} onClick={pickWorkspace}><Icon name={mobile ? 'plus' : 'folder'} size={mobile ? 15 : 14} /></button>
            <span className="anchor sb-view-host">{viewMenu}</span>
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
            <Group key={`date:${d.bucket}`} {...groupProps(`date:${d.bucket}`, d.items)} collapsed={!!collapsed[`date:${d.bucket}`]} onToggle={() => toggleGroup(`date:${d.bucket}`, !!collapsed[`date:${d.bucket}`])} name={DATE_NAME[d.bucket]} icon="calendar" className={clsx('date', menu === `view:date:${d.bucket}` && 'menu-on')} actions={headActs(`date:${d.bucket}`)} />
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
      <AccountRow open={menu === 'account'} setOpen={(v) => (v ? setMenu('account') : closeMenu('account'))} />
    </>
  );
}

/**
 * The brand mark is the application menu (redesign 2026-11 stage 1; the rail's ☰ before): the desktop pops up its
 * native menu (every item with its accelerator), a browser our own (AppMenu.tsx).
 */
function BrandMenu({ open, toggle, close }: { open: boolean; toggle: (e: React.MouseEvent) => void; close: () => void }) {
  return (
    <span className="anchor sb-brand-anchor">
      <button
        type="button"
        className={clsx('sb-brand', open && 'on')}
        data-id={'app-menu' satisfies TopId}
        title={tr('Claude Web 菜单')}
        aria-label={tr('Claude Web 菜单')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          if (desktop?.showAppMenu) { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); const z = desktop.getZoom?.() ?? 1; desktop.showAppMenu(r.left * z, (r.bottom + 4) * z); return; }
          toggle(e);
        }}
      >
        <AppLogo size={20} />
        <Icon name="chevronDown" size={11} className="chev" />
      </button>
      {open && <AppMenu onClose={close} />}
    </span>
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
