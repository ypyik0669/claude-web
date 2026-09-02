import { useEffect, useState } from 'react';
import { useActive, useStore, type PanelId } from '@/store';
import { Sidebar } from '@/features/sidebar/Sidebar';
import { TopBar } from '@/features/topbar/TopBar';
import { ChatView } from '@/features/chat/ChatView';
import { TrajectoryView } from '@/features/trajectory/TrajectoryView';
import { Composer } from '@/features/composer/Composer';
import { TasksPanel } from '@/features/panels/TasksPanel';
import { FilesPanel } from '@/features/panels/FilesPanel';
import { UsagePanel } from '@/features/panels/UsagePanel';
import { ConfigPanel } from '@/features/panels/ConfigPanel';
import { TerminalPanel } from '@/features/panels/TerminalPanel';
import { InspectorPanel } from '@/features/panels/InspectorPanel';
import { NewSessionModal } from '@/features/sidebar/NewSessionModal';

const PANEL_TITLES: Record<PanelId, string> = { tasks: '任务 / 子代理', files: '文件改动', usage: '用量', config: '配置中心', terminal: '终端', inspector: '详情' };

function Pane({ id }: { id: PanelId }) {
  const toggle = useStore((s) => s.togglePanel);
  const body = { tasks: <TasksPanel />, files: <FilesPanel />, usage: <UsagePanel />, config: <ConfigPanel />, terminal: <TerminalPanel />, inspector: <InspectorPanel /> }[id];
  return (
    <div className="pane">
      <div className="pane-head">
        <span>{PANEL_TITLES[id]}</span>
        <span className="grow" />
        <button className="icon-btn" title="关闭" onClick={() => toggle(id)}>
          ✕
        </button>
      </div>
      <div className="pane-body">{body}</div>
    </div>
  );
}

export function App() {
  const active = useActive();
  const tab = useStore((s) => s.tab);
  const panels = useStore((s) => s.panels);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const inspect = useStore((s) => s.inspect);
  const [newOpen, setNewOpen] = useState(false);
  const [rp, setRp] = useState<number>(() => Number(localStorage.getItem('cw.rp') ?? 420));

  const shown: PanelId[] = [...panels, ...(inspect && !panels.includes('inspector') ? (['inspector'] as PanelId[]) : [])];
  const rpWidth = shown.length ? rp : 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
        e.preventDefault();
        setNewOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const startResize = (e: React.MouseEvent) => {
    const x0 = e.clientX;
    const w0 = rp;
    const move = (ev: MouseEvent) => setRp(Math.max(280, Math.min(900, w0 - (ev.clientX - x0))));
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      localStorage.setItem('cw.rp', String(rp));
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <div className={`app ${sidebarOpen ? '' : 'no-sidebar'}`} style={{ ['--rp' as any]: `${rpWidth}px` }}>
      <div className="sidebar" style={{ display: sidebarOpen ? undefined : 'none' }}>
        <Sidebar onNew={() => setNewOpen(true)} />
      </div>
      <div className="center">
        <TopBar onNew={() => setNewOpen(true)} />
        {active ? (
          <>
            {tab === 'chat' ? <ChatView key={active.sessionId} /> : <TrajectoryView key={active.sessionId} />}
            <Composer key={`c-${active.sessionId}`} />
          </>
        ) : (
          <div className="welcome">
            <h2>Claude Web</h2>
            <div>从左侧选择一个会话，或者新建一个 (Ctrl+N)</div>
            <button className="btn primary" onClick={() => setNewOpen(true)}>
              新会话
            </button>
          </div>
        )}
      </div>
      <div className="rpanel" style={{ display: rpWidth ? 'flex' : 'none', position: 'relative' }}>
        <div className="resizer" style={{ position: 'absolute', left: 0, top: 0, bottom: 0 }} onMouseDown={startResize} />
        {shown.map((p) => (
          <Pane key={p} id={p} />
        ))}
      </div>
      {newOpen && <NewSessionModal onClose={() => setNewOpen(false)} />}
    </div>
  );
}
