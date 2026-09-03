import { useRef } from 'react';
import { useStore, type PanelId } from '@/store';
import { clsx } from '@/util';
import { TasksPanel } from '@/features/panels/TasksPanel';
import { FilesPanel } from '@/features/panels/FilesPanel';
import { UsagePanel } from '@/features/panels/UsagePanel';
import { ConfigPanel } from '@/features/panels/ConfigPanel';
import { TerminalPanel } from '@/features/panels/TerminalPanel';
import { InspectorPanel } from '@/features/panels/InspectorPanel';
import { MissionPanel } from '@/features/panels/MissionPanel';
import { GoalsPanel } from '@/features/goals/GoalsPanel';
import { AndroidPanel } from '@/features/android/AndroidPanel';
import { MIME_PANEL } from './dnd';

export const PANEL_TITLES: Record<PanelId, string> = { tasks: '任务', files: '文件改动', usage: '用量', config: '配置中心', terminal: '终端', inspector: '详情', mission: '总览', goals: '目标', android: 'Android' };
export const PANEL_ICONS: Record<PanelId, string> = { tasks: '◔', files: '≡', usage: '▤', config: '⚙', terminal: '▣', inspector: '◎', mission: '◉', goals: '🎯', android: '🤖' };
export const DOCK_DEFAULT_WIDTH = 440;

export function PanelBody({ id }: { id: PanelId }) {
  switch (id) {
    case 'tasks': return <TasksPanel />;
    case 'files': return <FilesPanel />;
    case 'usage': return <UsagePanel />;
    case 'config': return <ConfigPanel />;
    case 'terminal': return <TerminalPanel />;
    case 'inspector': return <InspectorPanel />;
    case 'mission': return <MissionPanel />;
    case 'goals': return <GoalsPanel />;
    case 'android': return <AndroidPanel />;
  }
}

/**
 * Right-hand dock: one tab strip, one visible panel (others stay mounted but hidden so the terminal and
 * config forms keep their state), minimizes to a 36px icon rail, drag to resize, double-click the edge to reset.
 */
export function Dock() {
  const dock = useStore((s) => s.layout.dock);
  const inspect = useStore((s) => s.inspect);
  const dispatch = useStore((s) => s.dispatchLayout);
  const drag = useRef<{ x0: number; w0: number } | null>(null);
  const tabs: PanelId[] = [...dock.tabs, ...(inspect && !dock.tabs.includes('inspector') ? (['inspector'] as PanelId[]) : [])];
  const active: PanelId | null = inspect && dock.active !== 'inspector' && !dock.tabs.includes('inspector') ? 'inspector' : dock.active && tabs.includes(dock.active) ? dock.active : tabs[0] ?? null;
  if (!tabs.length || !dock.open) return null;

  const close = (id: PanelId) => (id === 'inspector' ? useStore.setState({ inspect: null }) : dispatch({ t: 'dock.toggle', panel: id }));
  const onDown = (e: React.PointerEvent) => {
    drag.current = { x0: e.clientX, w0: dock.width };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    dispatch({ t: 'dock.set', patch: { width: Math.max(300, Math.min(960, drag.current.w0 - (e.clientX - drag.current.x0))) } });
  };
  const onUp = () => { drag.current = null; };

  if (dock.minimized)
    return (
      <div className="dock rail">
        {tabs.map((id) => (
          <button key={id} className={clsx('icon-btn', active === id && 'active')} title={PANEL_TITLES[id]} onClick={() => dispatch({ t: 'dock.set', patch: { minimized: false, active: id } })}>{PANEL_ICONS[id]}</button>
        ))}
        <span className="grow" />
        <button className="icon-btn" title="还原停靠面板 (Ctrl+Shift+J)" onClick={() => dispatch({ t: 'dock.set', patch: { minimized: false } })}>⇤</button>
      </div>
    );

  return (
    <div className="dock">
      <div className="resizer" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onDoubleClick={() => dispatch({ t: 'dock.set', patch: { width: DOCK_DEFAULT_WIDTH } })} title="拖动调整 · 双击复位" />
      <div className="dock-tabs">
        {tabs.map((id) => (
          <div
            key={id}
            className={clsx('tab', active === id && 'active')}
            draggable={id !== 'inspector'}
            onDragStart={(e) => { e.dataTransfer.setData(MIME_PANEL, id); e.dataTransfer.effectAllowed = 'copyMove'; }}
            onClick={() => dispatch({ t: 'dock.set', patch: { active: id } })}
            onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); close(id); } }}
            title={`${PANEL_TITLES[id]} · 可拖到窗格里`}
          >
            <span className="ic">{PANEL_ICONS[id]}</span>
            <span className="t">{PANEL_TITLES[id]}</span>
            <button className="x" title="关闭" onClick={(e) => { e.stopPropagation(); close(id); }}>✕</button>
          </div>
        ))}
        <span className="grow" />
        <button className="icon-btn" title="最小化 (Ctrl+Shift+J)" onClick={() => dispatch({ t: 'dock.set', patch: { minimized: true } })}>⇥</button>
        <button className="icon-btn" title="隐藏停靠面板 (Ctrl+J)" onClick={() => dispatch({ t: 'dock.set', patch: { open: false } })}>✕</button>
      </div>
      <div className="dock-body">
        {tabs.map((id) => (
          <div key={id} className="dock-panel" style={{ display: active === id ? undefined : 'none' }}>
            <PanelBody id={id} />
          </div>
        ))}
      </div>
    </div>
  );
}
