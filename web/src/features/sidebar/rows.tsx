import { useMemo } from 'react';
import type { SessionSummary } from '@shared';
import { useStore } from '@/store';
import { ws } from '@/ws/client';
import { clsx } from '@/util';
import { Icon } from '@/ui/icons';
import { MIME_SESSION } from '@/features/workbench/dnd';
import { sessionDiffStat } from '@/model/diffstat';
import { TERMS } from '@/ui/terms';
import { isArchived } from './filter';
import { SessionMenu, effectiveCaps } from './session-actions';
import { closeDrawer } from './menus';
import { rowStatus, type RowStatus } from './status';
import type { RowId, RowMenuId } from './entries';

/** Sidebar-only entries of the session menu (where to open it, pin, folder); the rest is the shared SessionMenu. */
function SidebarMenuExtra({ s, onClose }: { s: SessionSummary; onClose: () => void }) {
  const st = useStore();
  const open = st.open[s.sessionId];
  const meta = st.sessionMeta[s.sessionId] ?? {};
  const act = (fn: () => unknown) => () => { onClose(); closeDrawer(); void fn(); };
  const openIn = (mode: 'tab' | 'replace') => act(() => (open ? st.openInPane(s.sessionId, mode) : st.loadHistory(s.sessionId, { mode })));
  const id = (x: RowMenuId) => x;
  const split = () => {
    const g = st.layout;
    const before = g;
    st.dispatchLayout({ t: 'pane.split', paneId: (g.groups.find((x) => x.id === g.activeGroupId) ?? g.groups[0]).focusedPaneId, dir: 'row' });
    if (useStore.getState().layout === before) return st.toast('最多 6 个分屏');
    open ? st.openInPane(s.sessionId, 'replace') : void st.loadHistory(s.sessionId);
  };
  return (
    <>
      <button data-id={id('open-tab')} onClick={openIn('tab')}><Icon name="board" size={14} /> 在新{TERMS.tile}打开</button>
      <button data-id={id('open-split')} onClick={act(split)}><Icon name="splitRight" size={14} /> 在右侧{TERMS.pane}打开</button>
      {effectiveCaps(s).resume && <button data-id={id('resume')} onClick={act(() => st.openSession({ sessionId: s.sessionId, cwd: s.cwd }).catch((e) => st.toast(e.message)))}><Icon name="play" size={14} /> 恢复运行</button>}
      <button data-id={id('pin')} onClick={act(() => st.setSessionMeta(s.sessionId, { pinned: !meta.pinned }))}><Icon name="pin" size={14} /> {meta.pinned ? '取消置顶' : '置顶'}</button>
      {!s.peer && <button data-id={id('explorer')} onClick={act(() => ws.request({ kind: 'shell.open', path: s.cwd }))}><Icon name="folder" size={14} /> 在资源管理器打开</button>}
      {!s.peer && <button data-id={id('vscode')} onClick={act(() => ws.request({ kind: 'shell.open', path: s.cwd, app: 'code' }))}><Icon name="keyboard" size={14} /> 在 VS Code 打开</button>}
      {open && open.state !== 'history' && <button data-id={id('stop')} onClick={act(() => st.closeSession(s.sessionId))}><Icon name="stop" size={14} /> 结束进程</button>}
      <div className="menu-sep" />
    </>
  );
}

/** Open a session from the sidebar: click → the focused pane (replace); Ctrl / middle click → a new tab. */
export function openFromSidebar(sessionId: string, mode: 'replace' | 'tab') {
  const st = useStore.getState();
  if (st.open[sessionId]) st.openInPane(sessionId, mode);
  else void st.loadHistory(sessionId, { mode });
  // the phone drawer gets out of the way of what was just opened
  if (st.mobile) setTimeout(() => useStore.setState({ sidebarOpen: false }), 50);
}

export interface Selection {
  on: boolean;
  ids: ReadonlySet<string>;
  /** plain click in select mode */
  toggle(id: string): void;
  /** Shift-click: select mode starts with this row, or extends from the last clicked one */
  range(id: string): void;
}

/** No multi-select (the 「需要你」 rows: their conversations are selectable where they are listed). */
export const NO_SELECTION: Selection = { on: false, ids: new Set(), toggle: () => {}, range: (id) => openFromSidebar(id, 'replace') };

export interface RowCtx {
  /** which list the rows are in: the same conversation can be in 「需要你」 and in its project at once */
  where: 'list' | 'attn';
  /** the sidebar's one open menu (`row:<where>:<id>`, `filter`, `auto`, `account`, `proj:<id>`), or null */
  menu: string | null;
  setMenu(v: string | null): void;
  sel: Selection;
  expanded: ReadonlySet<string>;
  toggleKids(id: string): void;
  /** gray text instead of the time: a non-Claude agent's name */
  tagFor(s: SessionSummary): string | null;
}

/** Key of a row's menu in the sidebar's one-menu state. */
export const rowMenuKey = (where: RowCtx['where'], sessionId: string) => `row:${where}:${sessionId}`;

/** The one status at the end of a row. */
export function StatusMark({ st }: { st: RowStatus }) {
  const id: RowId = 'status';
  switch (st.kind) {
    case 'confirm':
    case 'ask': return <span className="st need" data-id={id} title={st.title}>{st.label}</span>;
    case 'error': return <span className="st err" data-id={id} title={st.title}>{st.label}</span>;
    case 'running': return <span className="st run" data-id={id} title={st.title} aria-label={st.label}><span className="spin" /></span>;
    case 'diff': return <span className="st stat" data-id={id} title={st.title}><span className="a">+{st.added}</span> <span className="d">−{st.removed}</span></span>;
    default: return <span className="st" data-id={id} title={st.title}>{st.label}</span>;
  }
}

/** A conversation's status from what this window knows: the open runner (requests, errors, edits) or the list's `live`. */
export function useRowStatus(s: SessionSummary, tag: string | null): RowStatus {
  const open = useStore((st) => st.open[s.sessionId]);
  const busy = !!open && (open.state === 'running' || open.state === 'starting' || open.pending.length > 0);
  // edits are counted only for a session loaded here, and not while it streams (a spinner shows then)
  const diff = useMemo(() => (open && !busy && open.conv ? sessionDiffStat(open.conv.items) : null), [open?.version, busy]);
  return rowStatus({ state: open ? open.state : s.live, pending: open?.pending, error: open?.error, diff, tag, lastModified: s.lastModified });
}

function rowTitle(s: SessionSummary, tag: string | null, st: RowStatus, sel: boolean): string {
  if (sel) return s.title;
  const lines = [s.firstPrompt ?? s.title];
  const where = [s.cwd, s.gitBranch].filter(Boolean).join(' · ');
  if (where) lines.push(where);
  if (tag) lines.push(tag);
  if (s.peer) lines.push(`在机器「${s.peer.name}」上${s.peer.offline ? '（离线，只读）' : ''}`);
  if (st.kind !== 'time') lines.push(st.title);
  lines.push(`点击打开 · Ctrl / 中键：新${TERMS.tile} · Shift：多选 · 右键：菜单 · 可拖到${TERMS.pane}`);
  return lines.join('\n');
}

/**
 * One conversation: title + one status at its end (spec §5.1). Hover shows ··· in the status' place; right-click
 * opens the same menu. A parent of forks / sub-agent threads has an arrow in front that lists them underneath.
 * A conversation on another machine carries the machine's name in gray before the status (hidden inside that
 * machine's own group, whose header already says it).
 */
export function SessionRow({ s, ctx, depth = 0, flat = false, pip = false }: { s: SessionSummary; ctx: RowCtx; depth?: number; flat?: boolean; pip?: boolean }) {
  const activeId = useStore((st) => st.activeId);
  const meta = useStore((st) => st.sessionMeta[s.sessionId]);
  const tag = ctx.tagFor(s);
  const st = useRowStatus(s, tag);
  const { sel, menu, setMenu } = ctx;
  const id = s.sessionId;
  const key = rowMenuKey(ctx.where, id);
  const checked = sel.on && sel.ids.has(id);
  const archived = isArchived(s, meta ? { [id]: meta } : {});
  const kids = !!s.childCount && depth === 0 && ctx.where === 'list';
  const open = ctx.expanded.has(id);
  const kidsId: RowId = 'kids';
  const onClick = (e: React.MouseEvent) => {
    if (sel.on) { if (e.shiftKey) sel.range(id); else sel.toggle(id); return; }
    if (e.shiftKey) { e.preventDefault(); sel.range(id); return; }
    openFromSidebar(id, e.ctrlKey || e.metaKey ? 'tab' : 'replace');
  };
  return (
    <div
      className={clsx('sess sb-row', flat && 'flat', depth > 0 && 'kid', activeId === id && !sel.on && 'active', checked && 'checked', archived && 'archived', s.peer?.offline && 'offline')}
      data-sid={id}
      // in select mode the row is a checkbox (it toggles, it does not open)
      role={sel.on ? 'checkbox' : 'button'}
      aria-checked={sel.on ? checked : undefined}
      tabIndex={0}
      onClick={onClick}
      // Shift-click: no text selection, but the row takes the focus (Esc then ends the multi-select from here)
      onMouseDown={(e) => { if (e.shiftKey) { e.preventDefault(); e.currentTarget.focus({ preventScroll: true }); } }}
      onAuxClick={(e) => { if (e.button !== 1 || sel.on) return; e.preventDefault(); openFromSidebar(id, 'tab'); }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (sel.on) sel.toggle(id); else openFromSidebar(id, e.ctrlKey || e.metaKey ? 'tab' : 'replace'); }
        else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) { e.preventDefault(); setMenu(key); }
      }}
      draggable={!sel.on}
      onDragStart={(e) => { e.dataTransfer.setData(MIME_SESSION, id); e.dataTransfer.effectAllowed = 'copyMove'; }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu(key); }}
      title={rowTitle(s, tag, st, sel.on)}
    >
      {kids && (
        <button className="kids-toggle" data-id={kidsId} aria-expanded={open} title={`${s.childCount} 个子对话（分叉 / 子代理）`} aria-label={open ? '收起子对话' : '展开子对话'} onClick={(e) => { e.stopPropagation(); ctx.toggleKids(id); }}>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
        </button>
      )}
      {sel.on && <input type="checkbox" className="sel-box" checked={checked} readOnly tabIndex={-1} aria-hidden />}
      {pip && <span className={clsx('pip', st.kind === 'error' && 'err')} />}
      <span className="t">{s.title}</span>
      {s.peer && <span className="peer-tag" title={`在机器「${s.peer.name}」上${s.peer.offline ? '（离线）' : ''}`}>{s.peer.name}</span>}
      <StatusMark st={st} />
      {!sel.on && <button className="more" title="更多" aria-label="更多" onClick={(e) => { e.stopPropagation(); setMenu(menu === key ? null : key); }}><Icon name="more" size={14} /></button>}
      {menu === key && <SessionMenu s={s} onClose={() => setMenu(null)} extra={<SidebarMenuExtra s={s} onClose={() => setMenu(null)} />} />}
    </div>
  );
}
