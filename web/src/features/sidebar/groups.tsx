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

/** A project's ··· / right-click menu (a project = a workspace folder; the data keeps calling it a workspace). */
export function ProjectMenu({ w, onClose }: { w: Workspace; onClose: () => void }) {
  const st = useStore();
  const act = (fn: () => unknown) => () => { onClose(); closeDrawer(); void fn(); };
  const id = (x: ProjectMenuId) => x;
  return (
    <Menu onClose={onClose} label={`项目 ${w.name}`}>
      <button data-id={id('new-here')} onClick={act(() => st.openSession({ cwd: w.path }).catch((e) => st.toast(e.message)))}><Icon name="plus" size={14} /> 在这里新建对话</button>
      <button data-id={id('worktree')} onClick={act(async () => { const n = await dlg.prompt(`${TERMS.worktree}的名称`, 'feature', { message: '在这个项目的一份独立副本里开一个新对话，改动不影响当前的工作目录。' }); if (n) await st.openSession({ cwd: w.path, worktree: n }).catch((e) => st.toast(e.message)); })}><Icon name="branch" size={14} /> 在{TERMS.worktree}里新建对话</button>
      <button data-id={id('terminal')} onClick={act(() => st.openTile({ id: `t${Date.now()}`, kind: 'term', cwd: w.path }, 'tab'))}><Icon name="terminal" size={14} /> 在这里开终端</button>
      <div className="menu-sep" />
      <button data-id={id('rename')} onClick={act(async () => { const n = await dlg.prompt('项目名称', w.name); if (n) await ws.request({ kind: 'workspaces.rename', id: w.id, name: n }); })}><Icon name="edit" size={14} /> 重命名</button>
      <button data-id={id('explorer')} onClick={act(() => ws.request({ kind: 'shell.open', path: w.path }))}><Icon name="folder" size={14} /> 在资源管理器打开</button>
      <button data-id={id('vscode')} onClick={act(() => ws.request({ kind: 'shell.open', path: w.path, app: 'code' }))}><Icon name="keyboard" size={14} /> 在 VS Code 打开</button>
      <div className="menu-sep" />
      <button data-id={id('remove')} className="danger" onClick={act(() => ws.request({ kind: 'workspaces.remove', id: w.id }))}><Icon name="close" size={14} /> 从侧栏移除项目（不删文件）</button>
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
  /** hover actions on the header (new chat here, ···) */
  actions?: React.ReactNode;
  onContextMenu?(e: React.MouseEvent): void;
  menu?: React.ReactNode;
  className?: string;
  emptyText?: string;
  /** a section of its own (置顶): the header is a section label, the rows are not indented under a folder */
  section?: boolean;
  /** entry id (entries.ts) for a group that is itself a sidebar entry (置顶) */
  dataId?: string;
}

/**
 * A project (or folder / machine / 置顶) with its conversations: folder icon (a chevron on hover) + name; collapsed
 * shows the count (a spinner while something inside runs). The first PAGE_FIRST rows, then 「再显示 N 个」; the active
 * row and running ones stay in view past the cut.
 */
export function Group(p: GroupProps) {
  const limit = p.shown ?? PAGE_FIRST;
  const { rows, hidden } = pageRows(p.items, limit, p.keep);
  const more: RowId = 'more', less: RowId = 'less';
  return (
    <div className={clsx('sb-group', p.section && 'sb-sec', p.className, p.collapsed && 'collapsed')} data-group={p.k} data-id={p.dataId}>
      <div className={clsx(p.section ? 'sb-sec-h fold' : 'ws-head sb-group-head')} onClick={p.onToggle} onContextMenu={p.onContextMenu} title={p.title} role="button" tabIndex={0} aria-expanded={!p.collapsed} onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); p.onToggle(); } }}>
        {!p.section && <span className="ic"><Icon name={p.icon} size={15} className="gi" /><Icon name={p.collapsed ? 'chevronRight' : 'chevronDown'} size={13} className="gc" /></span>}
        <span className="name">{p.name}</span>
        {p.section && <Icon name={p.collapsed ? 'chevronRight' : 'chevronDown'} size={12} className="sec-chev" />}
        {p.badge}
        {p.collapsed && (p.busy ? <span className="spin" title="有对话在运行" /> : <span className="cnt">{p.items.length}</span>)}
        {p.actions && <span className="acts" onClick={(e) => e.stopPropagation()}>{p.actions}</span>}
        {p.menu}
      </div>
      {!p.collapsed && (
        <div className="sb-rows">
          {rows.map((s) => (
            <div key={s.sessionId} className="sb-row-wrap">
              <SessionRow s={s} ctx={p.ctx} flat={p.section} />
              {p.ctx.expanded.has(s.sessionId) && p.kidsOf(s).map((k) => <SessionRow key={k.sessionId} s={k} ctx={p.ctx} depth={1} flat={p.section} />)}
            </div>
          ))}
          {!p.items.length && p.emptyText && <div className="sb-empty-row">{p.emptyText}</div>}
          {(hidden > 0 || limit > PAGE_FIRST) && (
            <div className="sb-more">
              {hidden > 0 && <button className="link" data-id={more} title={`还有 ${hidden} 个对话`} onClick={() => p.setShown(limit + PAGE_MORE)}>再显示 {Math.min(hidden, PAGE_MORE)} 个</button>}
              {limit > PAGE_FIRST && <button className="link" data-id={less} onClick={() => p.setShown(undefined)}>收起</button>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
