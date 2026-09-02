import { useEffect, useMemo, useState } from 'react';
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
import { ago, clsx } from '@/util';
import { CommandPalette } from '@/features/palette/CommandPalette';

const SHORTCUTS: [string, string][] = [
  ['Ctrl+K', '命令面板 / 全文搜索会话'],
  ['Alt+N', '新会话（Ctrl+N 被浏览器占用）'],
  ['Ctrl+B', '收起 / 展开侧栏'],
  ['Enter', '发送'],
  ['Shift+Enter', '换行'],
  ['Esc', '中断当前轮 / 关闭弹层'],
  ['/', '命令面板（输入框内）'],
  ['Tab', '补全命令'],
  ['Ctrl+V', '粘贴图片'],
  ['?', '本快捷键表'],
];

function ShortcutsModal() {
  const open = useStore((s) => s.shortcutsOpen);
  if (!open) return null;
  const close = () => useStore.setState({ shortcutsOpen: false });
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal">
        <h3>键盘快捷键</h3>
        <div className="shortcuts">
          {SHORTCUTS.map(([k, v]) => <div key={k}><span>{v}</span><span className="kbd">{k}</span></div>)}
        </div>
        <div className="actions"><button className="btn" onClick={close}>关闭</button></div>
      </div>
    </div>
  );
}

const PANEL_TITLES: Record<PanelId, string> = { tasks: '任务 / 子代理', files: '文件改动', usage: '用量', config: '配置中心', terminal: '终端', inspector: '详情' };

function Pane({ id }: { id: PanelId }) {
  const toggle = useStore((s) => s.togglePanel);
  const body = { tasks: <TasksPanel />, files: <FilesPanel />, usage: <UsagePanel />, config: <ConfigPanel />, terminal: <TerminalPanel />, inspector: <InspectorPanel /> }[id];
  return (
    <div className="pane">
      <div className="pane-head">
        <span>{PANEL_TITLES[id]}</span>
        <span className="grow" />
        <button className="icon-btn" title="关闭" onClick={() => (id === 'inspector' ? useStore.setState({ inspect: null }) : toggle(id))}>✕</button>
      </div>
      <div className="pane-body">{body}</div>
    </div>
  );
}

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? '夜深了' : h < 11 ? '早上好' : h < 14 ? '中午好' : h < 18 ? '下午好' : '晚上好';
}

function Welcome() {
  const sessions = useStore((s) => s.sessions);
  const open = useStore((s) => s.open);
  const loadHistory = useStore((s) => s.loadHistory);
  const setActive = useStore((s) => s.setActive);
  const recent = useMemo(() => sessions.slice(0, 6), [sessions]);
  return (
    <div className="welcome">
      <h1 className="greet"><span className="spark">✱</span>{greeting()}</h1>
      <Composer welcome />
      {recent.length > 0 && (
        <div className="recent">
          <h5>最近</h5>
          {recent.map((s) => (
            <div key={s.sessionId} className="sess" onClick={() => (open[s.sessionId] ? setActive(s.sessionId) : loadHistory(s.sessionId))}>
              <span className="t">{s.title}</span>
              <span className="ago">{s.cwd.split(/[\\/]/).pop()} · {ago(s.lastModified)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  if (!toasts.length) return null;
  return (
    <div className="toast-wrap">
      {toasts.map((t) => (
        <div key={t.id} className={clsx('toast', t.ok && 'ok')}>{t.text}</div>
      ))}
    </div>
  );
}

export function App() {
  const active = useActive();
  const tab = useStore((s) => s.tab);
  const panels = useStore((s) => s.panels);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const inspect = useStore((s) => s.inspect);
  const setActive = useStore((s) => s.setActive);
  const [rp, setRp] = useState<number>(() => Number(localStorage.getItem('cw.rp') ?? 440));

  const shown: PanelId[] = [...panels, ...(inspect && !panels.includes('inspector') ? (['inspector'] as PanelId[]) : [])];
  const rpWidth = shown.length ? rp : 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && e.key.toLowerCase() === 'n') { e.preventDefault(); setActive(null); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'b') { e.preventDefault(); useStore.setState((s) => ({ sidebarOpen: !s.sidebarOpen })); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); useStore.setState((s) => ({ paletteOpen: !s.paletteOpen })); }
      const inField = (e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA';
      if (e.key === '?' && !inField) useStore.setState({ shortcutsOpen: true });
      if (e.key === 'Escape') useStore.setState({ shortcutsOpen: false });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const startResize = (e: React.MouseEvent) => {
    const x0 = e.clientX;
    const w0 = rp;
    let cur = rp;
    const move = (ev: MouseEvent) => { cur = Math.max(300, Math.min(960, w0 - (ev.clientX - x0))); setRp(cur); };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); localStorage.setItem('cw.rp', String(cur)); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <div className={`app ${sidebarOpen ? '' : 'no-sidebar'}`} style={{ ['--rp' as any]: `${rpWidth}px` }}>
      <div className="sidebar" style={{ display: sidebarOpen ? undefined : 'none' }}>
        <Sidebar onNew={() => setActive(null)} />
      </div>
      <div className="center">
        <TopBar />
        {active ? (
          <>
            {tab === 'chat' ? <ChatView key={active.sessionId} /> : <TrajectoryView key={active.sessionId} />}
            <Composer key={`c-${active.sessionId}`} />
          </>
        ) : (
          <Welcome />
        )}
      </div>
      <div className="rpanel" style={{ display: rpWidth ? 'flex' : 'none', position: 'relative' }}>
        <div className="resizer" style={{ position: 'absolute', left: 0, top: 0, bottom: 0 }} onMouseDown={startResize} />
        {shown.map((p) => <Pane key={p} id={p} />)}
      </div>
      <Toasts />
      <CommandPalette />
      <ShortcutsModal />
    </div>
  );
}
