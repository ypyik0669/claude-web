import { useEffect, useRef, useState } from 'react';
import type { AgentKind, SourceStatus } from '@shared';
import { clsx } from '@/util';
import { Icon, AGENT_ICONS } from '@/ui/icons';
import { useStore } from '@/store';
import { Menu } from './menus';
import type { MachineCount } from './filter';
import type { ViewId } from './entries';
import type { GroupBy, PerGroup, SidebarView, SortBy } from './view';
import { tr } from '@/i18n';

export type SourceChip = Pick<SourceStatus, 'kind' | 'name' | 'error' | 'loading'>;

export interface ViewMenuProps {
  onClose(): void;
  view: SidebarView;
  setView(v: SidebarView): void;
  query: string;
  setQuery(q: string): void;
  sources: SourceChip[];
  counts: Record<string, number>;
  total: number;
  source: AgentKind | 'all';
  setSource(k: AgentKind | 'all'): void;
  machines: MachineCount[];
  machine: string;
  setMachine(id: string): void;
  showMachines: boolean;
  onSelect(): void;
  onNewSection(): void;
  onReset(): void;
  onAll(): void;
}

const GROUP_LABEL: Record<GroupBy, () => string> = { folder: () => tr('文件夹'), project: () => tr('项目'), date: () => tr('日期'), none: () => tr('不分组') };
const GROUP_ORDER: GroupBy[] = ['folder', 'project', 'date', 'none'];
const SORT_LABEL: Record<SortBy, () => string> = { updated: () => tr('最近更新'), created: () => tr('创建时间'), name: () => tr('名称') };
const SORT_ORDER: SortBy[] = ['updated', 'created', 'name'];
const PER_ORDER: PerGroup[] = [5, 10, 'all'];
const perLabel = (p: PerGroup) => (p === 'all' ? tr('全部') : String(p));

/**
 * The 显示 button's menu on the sidebar's header row (stage C3, spec C3): the old funnel's filters (the box, 来源,
 * 机器, 显示已归档, 选择) plus 分组方式 / 排序 / 每组, 新建分区, 恢复默认 and 查看全部 — one menu: the
 * choices of 分组方式 / 排序 / 每组 open in place under their row (only one anchored menu can be open at a time).
 * Choices apply at once and the menu stays open; 选择多个 / 新建分区 / 查看全部 / 管理对话来源 close it.
 */
export function ViewMenu(p: ViewMenuProps) {
  const id = (x: ViewId) => x;
  // focus after the menu is placed, without scrolling: an `autoFocus` runs while the menu is still in the list's flow,
  // scrolls the list to it — and a scroll that moves the anchor closes the menu
  const q = useRef<HTMLInputElement>(null);
  useEffect(() => { q.current?.focus({ preventScroll: true }); }, []);
  const [open, setOpen] = useState<'group' | 'sort' | 'per' | null>(null);
  const toggle = (k: 'group' | 'sort' | 'per') => setOpen((o) => (o === k ? null : k));
  const v = p.view;
  const showArchived = useStore((s) => s.showArchived);
  const openLibrary = () => { p.onClose(); useStore.getState().openSettings({ section: 'library' }); };
  const radio = (on: boolean, label: string, pick: () => void, key: string) => (
    <button key={key} role="menuitemradio" aria-checked={on} className={clsx('sb-view-opt', on && 'on')} onClick={pick}><Icon name="check" size={13} className="ck" /> {label}</button>
  );
  return (
    <Menu onClose={p.onClose} className="sb-view" label={tr('显示')}>
      <div className="sb-filter-q" data-id={id('query')}>
        <Icon name="search" size={13} />
        <input ref={q} placeholder={tr('筛选对话…')} value={p.query} onChange={(e) => p.setQuery(e.target.value)} aria-label={tr('按标题、首条消息或目录筛选')} />
        {p.query && <button className="icon-btn xs" title={tr('清空')} aria-label={tr('清空')} onClick={() => p.setQuery('')}><Icon name="close" size={12} /></button>}
      </div>
      <button data-id={id('group-by')} aria-expanded={open === 'group'} onClick={() => toggle('group')}>
        <Icon name="folder" size={13} /> {tr('分组方式')}<span className="n">{GROUP_LABEL[v.groupBy]()}</span><Icon name={open === 'group' ? 'chevronDown' : 'chevronRight'} size={12} className="sb-view-chev" />
      </button>
      {open === 'group' && <div role="group" aria-label={tr('分组方式')} className="sb-view-sub">{GROUP_ORDER.map((g) => radio(v.groupBy === g, GROUP_LABEL[g](), () => p.setView({ ...v, groupBy: g }), g))}</div>}
      <button data-id={id('sort-by')} aria-expanded={open === 'sort'} onClick={() => toggle('sort')}>
        <Icon name="arrowDown" size={13} /> {tr('排序')}<span className="n">{SORT_LABEL[v.sortBy]()}</span><Icon name={open === 'sort' ? 'chevronDown' : 'chevronRight'} size={12} className="sb-view-chev" />
      </button>
      {open === 'sort' && <div role="group" aria-label={tr('排序')} className="sb-view-sub">{SORT_ORDER.map((x) => radio(v.sortBy === x, SORT_LABEL[x](), () => p.setView({ ...v, sortBy: x }), x))}</div>}
      <div className="menu-label">{tr('显示')}</div>
      <button data-id={id('archived')} role="menuitemcheckbox" aria-checked={showArchived} className={clsx(showArchived && 'on')} onClick={() => useStore.getState().setShowArchived(!showArchived)}>
        <Icon name="check" size={13} className="ck" /> {tr('显示已归档的对话')}
      </button>
      <button data-id={id('per-group')} aria-expanded={open === 'per'} onClick={() => toggle('per')}>
        <Icon name="eye" size={13} /> {tr('每组')}<span className="n">{perLabel(v.show.perGroup)}</span><Icon name={open === 'per' ? 'chevronDown' : 'chevronRight'} size={12} className="sb-view-chev" />
      </button>
      {open === 'per' && <div role="group" aria-label={tr('每组')} className="sb-view-sub">{PER_ORDER.map((x) => radio(v.show.perGroup === x, perLabel(x), () => p.setView({ ...v, show: { ...v.show, perGroup: x } }), String(x)))}</div>}
      <div className="menu-label">{tr('来源')}</div>
      <div role="group" aria-label={tr('按来源筛选')} data-id={id('source')}>
        <button role="menuitemradio" aria-checked={p.source === 'all'} className={clsx(p.source === 'all' && 'on')} onClick={() => p.setSource('all')}>
          <Icon name="check" size={13} className="ck" /> {tr('全部')}<span className="n">{p.total}</span>
        </button>
        {p.sources.map((x) => (
          <button key={x.kind} role="menuitemradio" aria-checked={p.source === x.kind} className={clsx(p.source === x.kind && 'on')} onClick={() => p.setSource(x.kind)} title={x.error ? `${x.name}：${x.error}` : x.loading ? tr('{name}：读取中', { name: x.name }) : x.name}>
            <Icon name="check" size={13} className="ck" /><Icon name={AGENT_ICONS[x.kind] ?? 'agent'} size={13} /> {x.name}
            {x.error && <span className="warn-dot" />}
            {x.loading && !p.counts[x.kind] ? <span className="spinner" aria-label={tr('读取中')} /> : <span className="n">{p.counts[x.kind] ?? 0}</span>}
          </button>
        ))}
      </div>
      {p.showMachines && (
        <>
          <div className="menu-label">{tr('机器')}</div>
          <div role="group" aria-label={tr('按机器筛选')} data-id={id('machine')}>
            <button role="menuitemradio" aria-checked={p.machine === 'all'} className={clsx(p.machine === 'all' && 'on')} onClick={() => p.setMachine('all')}><Icon name="check" size={13} className="ck" /> {tr('所有机器')}</button>
            {p.machines.map((m) => (
              <button key={m.id} role="menuitemradio" aria-checked={p.machine === m.id} className={clsx(p.machine === m.id && 'on', m.offline && 'off')} onClick={() => p.setMachine(m.id)} title={m.offline ? tr('{name}：离线（显示上次的列表，只读）', { name: m.name }) : m.name}>
                <Icon name="check" size={13} className="ck" /><Icon name={m.id === 'local' ? 'device' : 'machine'} size={13} /> {m.name}{m.offline && <span className="warn-dot" />}<span className="n">{m.n}</span>
              </button>
            ))}
          </div>
        </>
      )}
      <div className="menu-sep" />
      <button data-id={id('select')} onClick={() => { p.onClose(); p.onSelect(); }} title={tr('也可以按住 Shift 点对话')}>
        <Icon name="checkCircle" size={13} /> {tr('选择多个…')}<span className="n">{tr('批量归档 / 删除')}</span>
      </button>
      <button data-id={id('new-section')} onClick={() => { p.onClose(); p.onNewSection(); }} title={tr('自己建一个分区，把对话拖进去')}><Icon name="plus" size={13} /> {tr('新建分区…')}</button>
      <button data-id={id('reset')} onClick={p.onReset} title={tr('分组、排序、每组和显示回到默认；自建的分区不动')}><Icon name="refresh" size={13} /> {tr('恢复默认')}</button>
      <button data-id={id('all')} onClick={() => { p.onClose(); p.onAll(); }}><Icon name="search" size={13} /> {tr('查看全部')}</button>
      <div className="menu-sep" />
      <button data-id={id('library')} onClick={openLibrary}><Icon name="settings" size={13} /> {tr('管理对话来源…')}</button>
    </Menu>
  );
}
