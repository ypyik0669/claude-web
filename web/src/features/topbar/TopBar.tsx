import { useState } from 'react';
import { useStore, type PanelId } from '@/store';
import { clsx } from '@/util';
import type { LimitWindow } from '@shared';
import { PANEL_ICONS, PANEL_TITLES } from '@/features/workbench/Dock';

const PANELS: PanelId[] = ['mission', 'tasks', 'files', 'usage', 'config', 'terminal'];

function resetIn(iso: string | null) {
  if (!iso) return '';
  const s = Math.max(0, (Date.parse(iso) - Date.now()) / 1000);
  if (s < 3600) return `${Math.ceil(s / 60)} 分钟后重置`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时 ${Math.round((s % 3600) / 60)} 分后重置`;
  return `${Math.floor(s / 86400)} 天 ${Math.round((s % 86400) / 3600)} 小时后重置`;
}

function Ring({ w }: { w: LimitWindow }) {
  const r = 5.5, c = 2 * Math.PI * r;
  const tone = w.percent >= 90 ? 'crit' : w.percent >= 70 ? 'hot' : '';
  return (
    <span className={clsx('ring', tone)} title={`${w.label}: 已用 ${w.percent}% · ${resetIn(w.resetsAt)}`}>
      <svg width="14" height="14" viewBox="0 0 14 14">
        <circle cx="7" cy="7" r={r} fill="none" stroke="var(--bg-3)" strokeWidth="2" />
        <circle cx="7" cy="7" r={r} fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray={`${(w.percent / 100) * c} ${c}`} strokeLinecap="round" />
      </svg>
      <span>{w.percent}%</span>
      <span className="lbl">{w.label}</span>
    </span>
  );
}

/** Claude subscription quota rings — the same 5h / 7d windows the CLI's /usage shows. */
function UsageRings() {
  const limits = useStore((s) => s.limits);
  const [open, setOpen] = useState(false);
  if (!limits) return null;
  if (!limits.ok) return <span className="ring" title={limits.error}>额度 –</span>;
  const shown = limits.windows.slice(0, 3);
  return (
    <span className="rings" style={{ position: 'relative' }} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      {shown.map((w) => <Ring key={w.label} w={w} />)}
      {open && (
        <div className="tip">
          <div style={{ fontWeight: 600, marginBottom: 4 }}>账号额度 {limits.subscriptionType ? `· ${limits.subscriptionType}` : ''}</div>
          {limits.windows.map((w) => (
            <div key={w.label} className="row" style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
              <span>{w.label}</span>
              <span style={{ color: 'var(--fg-2)' }}>{w.percent}% · {resetIn(w.resetsAt)}</span>
            </div>
          ))}
          <div style={{ color: 'var(--fg-3)', fontSize: 11, marginTop: 6 }}>每 90 秒刷新 · 来源 api.anthropic.com/api/oauth/usage</div>
        </div>
      )}
    </span>
  );
}

/** Global strip (also the Electron drag region): sidebar toggle · active group name · quota rings · dock toggles · palette. */
export function TopBar() {
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const dock = useStore((s) => s.layout.dock);
  const togglePanel = useStore((s) => s.togglePanel);
  const groupName = useStore((s) => s.layout.groups.find((g) => g.id === s.layout.activeGroupId)?.name ?? '');
  const running = useStore((s) => Object.values(s.open).filter((o) => o.state === 'running' || o.state === 'waiting').length);
  return (
    <div className="topbar slim">
      {!sidebarOpen && <button className="icon-btn" onClick={() => useStore.setState({ sidebarOpen: true })} title="展开侧栏 (Ctrl+B)">☰</button>}
      <div className="title">
        <span className="cur">{groupName}</span>
        {running > 0 && <span className="badge" title="运行中的会话">{running} 运行中</span>}
      </div>
      <span className="grow" />
      <UsageRings />
      {PANELS.map((p) => (
        <button key={p} className={clsx('icon-btn', dock.open && dock.tabs.includes(p) && 'active')} onClick={() => togglePanel(p)} title={PANEL_TITLES[p]} style={{ fontSize: 12.5, gap: 5, padding: '4px 8px' }}>
          <span style={{ fontSize: 13 }}>{PANEL_ICONS[p]}</span> {PANEL_TITLES[p]}
        </button>
      ))}
      <button className="icon-btn" title="命令面板 (Ctrl+K)" onClick={() => useStore.setState({ paletteOpen: true })}>⌘</button>
    </div>
  );
}
