import type { SessionSummary, Workspace } from '@shared';
import { useStore } from '@/store';
import { ws } from '@/ws/client';
import { dlg } from '@/ui/dialog';
import { clsx } from '@/util';
import { Icon, type IconName } from '@/ui/icons';
import { TERMS } from '@/ui/terms';
import { Menu, closeDrawer } from './menus';
import { SessionRow, type RowCtx } from './rows';
import { pageRows } from './status';
import type { ProjectMenuId, RowId } from './entries';
import { moveTo } from './reorder';
import { tr } from '@/i18n';
import { openProjectDialog } from './project-dialog-open';
import { useLongPress } from '@/ui/long-press';
import { haptic } from '@/ui/haptics';

/** A project's ··· / right-click menu (a project = a workspace folder; the data keeps calling it a workspace). */
export function ProjectMenu({ w, onClose }: { w: Workspace; onClose: () => void }) {
  const st = useStore();
  const act = (fn: () => unknown) => () => { onClose(); closeDrawer(); void fn(); };
  const id = (x: ProjectMenuId) => x;
  return (
    <Menu onClose={onClose} label={tr('项目 {name}', { name: w.name })}>
      <button data-id={id('new-here')} onClick={act(() => st.openSession({ cwd: w.path }).catch((e) => st.toast(e.message)))}><Icon name="plus" size={14} /> {tr('在这里新建对话')}</button>
      <button data-id={id('worktree')} onClick={act(async () => { const n = await dlg.prompt(tr('{worktree}的名称', { worktree: TERMS.worktree }), 'feature', { message: tr('在这个项目的一份独立副本里开一个新对话，改动不影响当前的工作目录。') }); if (n) await st.openSession({ cwd: w.path, worktree: n }).catch((e) => st.toast(e.message)); })}><Icon name="branch" size={14} /> {tr('在{worktree}里新建对话', { worktree: TERMS.worktree })}</button>
      <button data-id={id('terminal')} onClick={act(() => st.openTile({ id: `t${Date.now()}`, kind: 'term', cwd: w.path }, 'tab'))}><Icon name="terminal" size={14} /> {tr('在这里开终端')}</button>
      <div className="menu-sep" />
      {(() => {
        const ids = st.workspaces.map((x) => x.id);
        const at = ids.indexOf(w.id);
        const move = (to: number) => act(() => st.reorderWorkspaces(moveTo(ids, w.id, to)));
        return <>
          {at > 0 && <button data-id={id('move-top')} onClick={move(0)}><Icon name="chevronUp" size={14} /> {tr('移到最上面')}</button>}
          {at > 0 && <button data-id={id('move-up')} onClick={move(at - 1)}><Icon name="arrowUp" size={14} /> {tr('上移')}</button>}
          {at >= 0 && at < ids.length - 1 && <button data-id={id('move-down')} onClick={move(at + 2)}><Icon name="arrowDown" size={14} /> {tr('下移')}</button>}
        </>;
      })()}
      <button data-id={id('edit')} onClick={act(() => openProjectDialog(w))}><Icon name="settings" size={14} /> {tr('项目页…')}</button>
      <button data-id={id('rename')} onClick={act(async () => { const n = await dlg.prompt(tr('项目名称'), w.name); if (n) await ws.request({ kind: 'workspaces.rename', id: w.id, name: n }); })}><Icon name="edit" size={14} /> {tr('重命名')}</button>
      <button data-id={id('explorer')} onClick={act(() => ws.request({ kind: 'shell.open', path: w.path }).catch((e) => useStore.getState().toast(e.message)))}><Icon name="folder" size={14} /> {tr('在资源管理器打开')}</button>
      <button data-id={id('vscode')} onClick={act(() => ws.request({ kind: 'shell.open', path: w.path, app: 'code' }).catch((e) => useStore.getState().toast(e.message)))}><Icon name="keyboard" size={14} /> {tr('在 VS Code 打开')}</button>
      <div className="menu-sep" />
      <button data-id={id('remove')} className="danger" onClick={act(() => ws.request({ kind: 'workspaces.remove', id: w.id }))}><Icon name="close" size={14} /> {tr('从侧栏移除项目（不删文件）')}</button>
    </Menu>
  );
}

/**
 * A folder's right-click menu (redesign 2026-11 stage 3: its header shows 显示 and ＋ like a project's, so 设为项目 moved
 * in here — it stays written out on the header while there is no project yet). A folder is a project not pinned yet:
 * the same ways in, and 设为项目.
 */
export function FolderMenu({ cwd, name, onClose }: { cwd: string; name: string; onClose: () => void }) {
  const st = useStore();
  const act = (fn: () => unknown) => () => { onClose(); closeDrawer(); void fn(); };
  const id = (x: ProjectMenuId) => x;
  return (
    <Menu onClose={onClose} label={tr('文件夹 {name}', { name })}>
      <button data-id={id('new-here')} onClick={act(() => st.openSession({ cwd }).catch((e) => st.toast(e.message)))}><Icon name="plus" size={14} /> {tr('在这里新建对话')}</button>
      <button data-id={id('worktree')} onClick={act(async () => { const n = await dlg.prompt(tr('{worktree}的名称', { worktree: TERMS.worktree }), 'feature', { message: tr('在这个项目的一份独立副本里开一个新对话，改动不影响当前的工作目录。') }); if (n) await st.openSession({ cwd, worktree: n }).catch((e) => st.toast(e.message)); })}><Icon name="branch" size={14} /> {tr('在{worktree}里新建对话', { worktree: TERMS.worktree })}</button>
      <button data-id={id('terminal')} onClick={act(() => st.openTile({ id: `t${Date.now()}`, kind: 'term', cwd }, 'tab'))}><Icon name="terminal" size={14} /> {tr('在这里开终端')}</button>
      <div className="menu-sep" />
      <button data-id={id('make-project')} onClick={act(() => st.addWorkspace(cwd).catch((e) => st.toast(e.message)))}><Icon name="pin" size={14} /> {tr('设为项目')}</button>
      <button data-id={id('explorer')} onClick={act(() => ws.request({ kind: 'shell.open', path: cwd }).catch((e) => useStore.getState().toast(e.message)))}><Icon name="folder" size={14} /> {tr('在资源管理器打开')}</button>
      <button data-id={id('vscode')} onClick={act(() => ws.request({ kind: 'shell.open', path: cwd, app: 'code' }).catch((e) => useStore.getState().toast(e.message)))}><Icon name="keyboard" size={14} /> {tr('在 VS Code 打开')}</button>
    </Menu>
  );
}

export const PAGE_FIRST = 5;
export const PAGE_MORE = 20;

export interface GroupProps {
  k: string;
  name: string;
  icon: IconName;
  title?: string;
  items: SessionSummary[];
  collapsed: boolean;
  onToggle(): void;
  ctx: RowCtx;
  shown: number | undefined;
  setShown(n: number | undefined): void;
  keep(s: SessionSummary): boolean;
  kidsOf(s: SessionSummary): SessionSummary[];
  /** something in here is running (shown on the collapsed header instead of the count) */
  busy?: boolean;
  badge?: React.ReactNode;
  /** hover actions on the header (显示, ＋ new chat here); none on a phone */
  actions?: React.ReactNode;
  /** what a phone shows on the header instead (a newcomer's 「设为项目」) */
  phoneActions?: React.ReactNode;
  onContextMenu?(e: React.MouseEvent): void;
  /** the header's menu from a long press (a phone) or the keyboard's menu key */
  onHold?(): void;
  menu?: React.ReactNode;
  className?: string;
  emptyText?: string;
  /** rows shown before 「再显示 N 个」 (the 显示 menu's 每组; Infinity = all, no 收起) */
  first?: number;
  /** a section of its own (置顶): the header is a section label, the rows are not indented under a folder */
  section?: boolean;
  /** entry id (entries.ts) for a group that is itself a sidebar entry (置顶) */
  dataId?: string;
  /** a project's header can be dragged to reorder the projects; where a drop would land is drawn on the target */
  drag?: { onDragStart(e: React.DragEvent): void; onDragEnd(): void; onDragOver(e: React.DragEvent): void; onDragLeave(): void; onDrop(e: React.DragEvent): void; over?: 'before' | 'after' | null; dragging?: boolean };
}

/**
 * A project (or folder / machine / 置顶) with its conversations: folder icon (a chevron on hover) + name; collapsed
 * shows the count (a spinner while something inside runs). The first PAGE_FIRST rows, then 「再显示 N 个」; the active
 * row and running ones stay in view past the cut. Each row's forks / side conversations right under it, one level in
 * (`kidsOf`: none while folded, but the current / running ones).
 */
export function Group(p: GroupProps) {
  const first = p.first ?? PAGE_FIRST;
  const limit = p.shown ?? first;
  const { rows, hidden } = pageRows(p.items, limit, p.keep);
  const more: RowId = 'more', less: RowId = 'less';
  const mobile = useStore((s) => s.mobile);
  // a phone has no hover: holding the header opens its menu (the project's / folder's), like a row's
  const hold = useLongPress(() => { haptic('menu'); p.onHold?.(); }, mobile && !!p.onHold);
  return (
    <div className={clsx('sb-group', p.section && 'sb-sec', p.className, p.collapsed && 'collapsed', p.drag?.dragging && 'dragging', p.drag?.over && `drop-${p.drag.over}`)} data-group={p.k} data-id={p.dataId}>
      <div className={clsx(p.section ? 'sb-sec-h fold' : 'ws-head sb-group-head')} {...hold.handlers} draggable={!!p.drag || undefined} onDragStart={p.drag?.onDragStart} onDragEnd={p.drag?.onDragEnd} onDragOver={p.drag?.onDragOver} onDragLeave={p.drag?.onDragLeave} onDrop={p.drag?.onDrop} onClick={p.onToggle}
        onContextMenu={p.onContextMenu ? (e) => { if (hold.trigger()) { e.preventDefault(); e.stopPropagation(); return; } p.onContextMenu?.(e); } : undefined}
        title={p.title} role="button" tabIndex={0} aria-expanded={!p.collapsed}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); p.onToggle(); }
          else if (p.onHold && (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))) { e.preventDefault(); p.onHold(); }
        }}>
        {!p.section && <span className="ic"><Icon name={p.icon} size={15} className="gi" /><Icon name={p.collapsed ? 'chevronRight' : 'chevronDown'} size={13} className="gc" /></span>}
        <span className="name">{p.name}</span>
        {p.section && <Icon name={p.collapsed ? 'chevronRight' : 'chevronDown'} size={12} className="sec-chev" />}
        {p.badge}
        {p.collapsed && (p.busy ? <span className="spin" title={tr('有对话在运行')} /> : <span className="cnt">{p.items.length}</span>)}
        {(mobile ? p.phoneActions : p.actions) && <span className="acts" onClick={(e) => e.stopPropagation()}>{mobile ? p.phoneActions : p.actions}</span>}
        {p.menu}
      </div>
      {!p.collapsed && (
        <div className="sb-rows">
          {rows.map((s) => (
            <div key={s.sessionId} className="sb-row-wrap">
              <SessionRow s={s} ctx={p.ctx} flat={p.section} />
              {p.kidsOf(s).map((k) => <SessionRow key={k.sessionId} s={k} ctx={p.ctx} depth={1} flat={p.section} />)}
            </div>
          ))}
          {!p.items.length && p.emptyText && <div className="sb-empty-row">{p.emptyText}</div>}
          {(hidden > 0 || limit > first) && (
            <div className="sb-more">
              {hidden > 0 && <button className="link" data-id={more} title={tr('还有 {hidden} 个对话', { hidden })} onClick={() => p.setShown(limit + PAGE_MORE)}>{tr('再显示 {hidden} 个', { hidden: Math.min(hidden, PAGE_MORE) })}</button>}
              {limit > first && <button className="link" data-id={less} onClick={() => p.setShown(undefined)}>{tr('收起')}</button>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
