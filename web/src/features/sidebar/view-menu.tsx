import type { AgentKind, SourceStatus } from '@shared';
import { clsx } from '@/util';
import { Icon, AGENT_ICONS } from '@/ui/icons';
import { Segmented } from '@/ui/Segmented';
import { useStore } from '@/store';
import { Menu, SubMenu } from './menus';
import type { MachineCount } from './filter';
import type { ViewId } from './entries';
import type { GroupBy, PerGroup, SidebarView, SortBy } from './view';
import { tr } from '@/i18n';

export type SourceChip = Pick<SourceStatus, 'kind' | 'name' | 'error' | 'loading'>;

export interface ViewMenuProps {
  onClose(): void;
  /** the 显示 button it was opened from (the menu itself lives where a choice does not rebuild it) */
  anchor?: () => HTMLElement | null;
  view: SidebarView;
  setView(v: SidebarView): void;
  sources: SourceChip[];
  counts: Record<string, number>;
  total: number;
  source: AgentKind | 'all';
  setSource(k: AgentKind | 'all'): void;
  machines: MachineCount[];
  machine: string;
  setMachine(id: string): void;
  showMachines: boolean;
  onNewSection(): void;
  onReset(): void;
  onAll(): void;
}

const GROUP_LABEL: Record<GroupBy, () => string> = { folder: () => tr('文件夹'), project: () => tr('项目'), date: () => tr('日期'), none: () => tr('不分组') };
const GROUP_ORDER: GroupBy[] = ['folder', 'project', 'date', 'none'];
const SORT_LABEL: Record<SortBy, () => string> = { updated: () => tr('最近更新'), created: () => tr('创建时间'), name: () => tr('名称') };
const SORT_ORDER: SortBy[] = ['updated', 'created', 'name'];
const PER: { value: '5' | '10' | 'all'; per: PerGroup; label: () => string }[] = [
  { value: '5', per: 5, label: () => tr('5 条') },
  { value: '10', per: 10, label: () => tr('10 条') },
  { value: 'all', per: 'all', label: () => tr('全部') },
];

/** What 显示 › holds, in a few words (a phone writes it at the row's end, like the plan's sheet). */
function showSummary(archived: boolean, otherAgents: boolean): string {
  if (archived && otherAgents) return tr('已归档、其它 Agent');
  if (archived) return tr('已归档');
  return otherAgents ? tr('其它 Agent') : '';
}

/**
 * The 显示 menu (redesign 2026-11 stage 3, 图 7): six rows — 分组方式 › · 排序 › · 显示 › · 新建分区 · 恢复默认 · 查看全部.
 * The choices are submenus that fly out to the right (sidebar/menus.tsx `SubMenu`; a phone pushes them inside the same
 * sheet): 分组方式 (文件夹 · 项目 · 日期 · 不分组), 排序 (最近更新 · 创建时间 · 名称), 显示 (已归档的对话, 其它 Agent 的对话, 每组
 * 5 / 10 / 全部, 来源 › with 管理来源 at its end, 机器 › when another machine has conversations). A choice applies at once
 * and the menu stays open; 新建分区 / 查看全部 close it. What the stage C menu also held went elsewhere: the filter box
 * to 搜索 (Ctrl K) and the sidebar's own / filter, 选择多个 to Shift + click and the row's right-click › 选择.
 */
export function ViewMenu(p: ViewMenuProps) {
  const id = (x: ViewId) => x;
  const v = p.view;
  const showArchived = useStore((s) => s.showArchived);
  const mobile = useStore((s) => s.mobile);
  const openLibrary = () => { p.onClose(); useStore.getState().openSettings({ section: 'library' }); };
  const radio = (on: boolean, label: React.ReactNode, pick: () => void, key: string, extra?: { title?: string; className?: string }) => (
    <button key={key} role="menuitemradio" aria-checked={on} className={clsx('sb-view-opt', on && 'on', extra?.className)} title={extra?.title} onClick={pick}><Icon name="check" size={13} className="ck" />{label}</button>
  );
  const sourceName = p.source === 'all' ? tr('全部') : p.sources.find((x) => x.kind === p.source)?.name ?? p.source;
  const machineName = p.machine === 'all' ? tr('所有机器') : p.machines.find((m) => m.id === p.machine)?.name ?? p.machine;
  return (
    <Menu onClose={p.onClose} className="sb-view" label={tr('显示')} title={tr('对话列表')} anchor={p.anchor}>
      <SubMenu id={id('group-by')} icon="folder" label={tr('分组方式')} value={GROUP_LABEL[v.groupBy]()}>
        {GROUP_ORDER.map((g) => radio(v.groupBy === g, GROUP_LABEL[g](), () => p.setView({ ...v, groupBy: g }), g))}
      </SubMenu>
      <SubMenu id={id('sort-by')} icon="arrowDown" label={tr('排序')} value={SORT_LABEL[v.sortBy]()}>
        {SORT_ORDER.map((x) => radio(v.sortBy === x, SORT_LABEL[x](), () => p.setView({ ...v, sortBy: x }), x))}
      </SubMenu>
      <SubMenu id={id('show')} icon="eye" label={tr('显示')} value={mobile ? showSummary(showArchived, v.show.otherAgents) : undefined} panelClass="sb-view-show">
        <button data-id={id('archived')} role="menuitemcheckbox" aria-checked={showArchived} className={clsx(showArchived && 'on')} onClick={() => useStore.getState().setShowArchived(!showArchived)}>
          <Icon name="check" size={13} className="ck" />{tr('已归档的对话')}
        </button>
        <button data-id={id('other-agents')} role="menuitemcheckbox" aria-checked={v.show.otherAgents} className={clsx(v.show.otherAgents && 'on')} onClick={() => p.setView({ ...v, show: { ...v.show, otherAgents: !v.show.otherAgents } })}>
          <Icon name="check" size={13} className="ck" />{tr('其它 Agent 的对话')}
        </button>
        <div className="sb-per" data-id={id('per-group')}>
          <span className="l">{tr('每组')}</span>
          <Segmented
            label={tr('每组显示几条')}
            value={PER.find((x) => x.per === v.show.perGroup)?.value ?? '5'}
            options={PER.map((x) => ({ value: x.value, label: x.label(), data: { 'data-per': x.value } }))}
            onChange={(val) => p.setView({ ...v, show: { ...v.show, perGroup: PER.find((x) => x.value === val)?.per ?? 5 } })}
          />
        </div>
        <SubMenu id={id('source')} icon="library" label={tr('来源')} value={sourceName}>
          {radio(p.source === 'all', <>{tr('全部')}<span className="n">{p.total}</span></>, () => p.setSource('all'), 'all')}
          {p.sources.map((x) => (
            <button key={x.kind} role="menuitemradio" aria-checked={p.source === x.kind} className={clsx(p.source === x.kind && 'on')} data-source={x.kind} onClick={() => p.setSource(x.kind)} title={x.error ? `${x.name}：${x.error}` : x.loading ? tr('{name}：读取中', { name: x.name }) : x.name}>
              <Icon name="check" size={13} className="ck" /><Icon name={AGENT_ICONS[x.kind] ?? 'agent'} size={13} /> {x.name}
              {x.error && <span className="warn-dot" />}
              {x.loading && !p.counts[x.kind] ? <span className="spinner" aria-label={tr('读取中')} /> : <span className="n">{p.counts[x.kind] ?? 0}</span>}
            </button>
          ))}
          <div className="menu-sep" />
          <button data-id={id('library')} onClick={openLibrary}><Icon name="settings" size={13} /> {tr('管理来源')}</button>
        </SubMenu>
        {p.showMachines && (
          <SubMenu id={id('machine')} icon="machine" label={tr('机器')} value={machineName}>
            {radio(p.machine === 'all', tr('所有机器'), () => p.setMachine('all'), 'all')}
            {p.machines.map((m) => (
              <button key={m.id} role="menuitemradio" aria-checked={p.machine === m.id} className={clsx(p.machine === m.id && 'on', m.offline && 'off')} data-machine={m.id} onClick={() => p.setMachine(m.id)} title={m.offline ? tr('{name}：离线（显示上次的列表，只读）', { name: m.name }) : m.name}>
                <Icon name="check" size={13} className="ck" /><Icon name={m.id === 'local' ? 'device' : 'machine'} size={13} /> {m.name}{m.offline && <span className="warn-dot" />}<span className="n">{m.n}</span>
              </button>
            ))}
          </SubMenu>
        )}
      </SubMenu>
      <div className="menu-sep" />
      <button data-id={id('new-section')} onClick={() => { p.onClose(); p.onNewSection(); }} title={tr('自己建一个分区，把对话拖进去')}><Icon name="plus" size={14} /> {tr('新建分区')}</button>
      <button data-id={id('reset')} onClick={p.onReset} title={tr('分组、排序、每组和显示回到默认；自建的分区不动')}><Icon name="refresh" size={14} /> {tr('恢复默认')}</button>
      <button data-id={id('all')} onClick={() => { p.onClose(); p.onAll(); }} title={tr('在搜索里看全部对话')}><Icon name="search" size={14} /> {tr('查看全部')}</button>
    </Menu>
  );
}
