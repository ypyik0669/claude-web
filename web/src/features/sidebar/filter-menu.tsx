import { useEffect, useRef } from 'react';
import type { AgentKind, SourceStatus } from '@shared';
import { clsx } from '@/util';
import { Icon, AGENT_ICONS } from '@/ui/icons';
import { useStore } from '@/store';
import { Menu } from './menus';
import type { MachineCount } from './filter';
import type { FilterId } from './entries';

export type SourceChip = Pick<SourceStatus, 'kind' | 'name' | 'error' | 'loading'>;

export interface FilterMenuProps {
  onClose(): void;
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
  showArchived: boolean;
  setShowArchived(v: boolean): void;
  onSelect(): void;
}

/**
 * The funnel on the 项目 row (spec §4.2): what used to sit above the list — the source chips, the machine chips,
 * the filter box, 显示已归档 and 选择 — in one menu. Choices apply at once and the menu stays open so they can be
 * combined; 选择多个 closes it and turns the rows into checkboxes.
 */
export function FilterMenu(p: FilterMenuProps) {
  const id = (x: FilterId) => x;
  // focus after the menu is placed, without scrolling: an `autoFocus` runs while the menu is still in the list's flow,
  // scrolls the list to it — and a scroll that moves the anchor closes the menu
  const q = useRef<HTMLInputElement>(null);
  useEffect(() => { q.current?.focus({ preventScroll: true }); }, []);
  const openLibrary = () => { p.onClose(); useStore.getState().openSettings({ section: 'library' }); };
  return (
    <Menu onClose={p.onClose} className="sb-filter" label="筛选对话">
      <div className="sb-filter-q" data-id={id('query')}>
        <Icon name="search" size={13} />
        <input ref={q} placeholder="筛选对话…" value={p.query} onChange={(e) => p.setQuery(e.target.value)} aria-label="按标题、首条消息或目录筛选" />
        {p.query && <button className="icon-btn xs" title="清空" aria-label="清空" onClick={() => p.setQuery('')}><Icon name="close" size={12} /></button>}
      </div>
      <div className="menu-label">来源</div>
      <div role="group" aria-label="按来源筛选" data-id={id('source')}>
        <button role="menuitemradio" aria-checked={p.source === 'all'} className={clsx(p.source === 'all' && 'on')} onClick={() => p.setSource('all')}>
          <Icon name="check" size={13} className="ck" /> 全部<span className="n">{p.total}</span>
        </button>
        {p.sources.map((x) => (
          <button key={x.kind} role="menuitemradio" aria-checked={p.source === x.kind} className={clsx(p.source === x.kind && 'on')} onClick={() => p.setSource(x.kind)} title={x.error ? `${x.name}：${x.error}` : x.loading ? `${x.name}：读取中` : x.name}>
            <Icon name="check" size={13} className="ck" /><Icon name={AGENT_ICONS[x.kind] ?? 'agent'} size={13} /> {x.name}
            {x.error && <span className="warn-dot" />}
            {x.loading && !p.counts[x.kind] ? <span className="spinner" aria-label="读取中" /> : <span className="n">{p.counts[x.kind] ?? 0}</span>}
          </button>
        ))}
      </div>
      {p.showMachines && (
        <>
          <div className="menu-label">机器</div>
          <div role="group" aria-label="按机器筛选" data-id={id('machine')}>
            <button role="menuitemradio" aria-checked={p.machine === 'all'} className={clsx(p.machine === 'all' && 'on')} onClick={() => p.setMachine('all')}><Icon name="check" size={13} className="ck" /> 所有机器</button>
            {p.machines.map((m) => (
              <button key={m.id} role="menuitemradio" aria-checked={p.machine === m.id} className={clsx(p.machine === m.id && 'on', m.offline && 'off')} onClick={() => p.setMachine(m.id)} title={m.offline ? `${m.name}：离线（显示上次的列表，只读）` : m.name}>
                <Icon name="check" size={13} className="ck" /><Icon name={m.id === 'local' ? 'device' : 'machine'} size={13} /> {m.name}{m.offline && <span className="warn-dot" />}<span className="n">{m.n}</span>
              </button>
            ))}
          </div>
        </>
      )}
      <div className="menu-sep" />
      <button data-id={id('archived')} role="menuitemcheckbox" aria-checked={p.showArchived} className={clsx(p.showArchived && 'on')} onClick={() => p.setShowArchived(!p.showArchived)}>
        <Icon name="check" size={13} className="ck" /> 显示已归档的对话
      </button>
      <button data-id={id('select')} onClick={() => { p.onClose(); p.onSelect(); }} title="也可以按住 Shift 点对话">
        <Icon name="checkCircle" size={13} /> 选择多个…<span className="n">批量归档 / 删除</span>
      </button>
      <div className="menu-sep" />
      <button data-id={id('library')} onClick={openLibrary}><Icon name="settings" size={13} /> 管理对话来源…</button>
    </Menu>
  );
}
