import { useEffect, useRef, useState } from 'react';
import { useStore } from '@/store';
import { clsx } from '@/util';
import type { LimitWindow } from '@shared';
import { PANELS } from '@/model/layout';
import { Icon } from '@/ui/icons';

function resetIn(iso: string | null) {
  if (!iso) return '';
  const s = Math.max(0, (Date.parse(iso) - Date.now()) / 1000);
  if (s < 3600) return `${Math.ceil(s / 60)} 分钟后重置`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时 ${Math.round((s % 3600) / 60)} 分后重置`;
  return `${Math.floor(s / 86400)} 天 ${Math.round((s % 86400) / 3600)} 小时后重置`;
}

function Ring({ percent, size = 14 }: { percent: number; size?: number }) {
  const r = size / 2 - 1.5, c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--edge-default)" strokeWidth="2" />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray={`${(percent / 100) * c} ${c}`} strokeLinecap="round" transform={`rotate(-90 ${size / 2} ${size / 2})`} />
    </svg>
  );
}

/**
 * Quota: one ring for the window closest to its limit, the full 5h / 7d breakdown on hover.
 * Three rings side by side read as noise at this size — the number that matters is the worst one.
 */
function UsageRings() {
  const limits = useStore((s) => s.limits);
  const [open, setOpen] = useState(false);
  if (!limits) return null;
  if (!limits.ok) return <span className="quota" title={limits.error}>额度 –</span>;
  const worst = limits.windows.reduce<LimitWindow | null>((a, w) => (!a || w.percent > a.percent ? w : a), null);
  if (!worst) return null;
  const tone = worst.percent >= 90 ? 'crit' : worst.percent >= 70 ? 'hot' : '';
  return (
    <span className={clsx('quota', tone)} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} title={`${worst.label}: 已用 ${worst.percent}%`}>
      <Ring percent={worst.percent} />
      <span className="pct">{worst.percent}%</span>
      {open && (
        <div className="tip">
          <div className="label" style={{ marginBottom: 6 }}>账号额度{limits.subscriptionType ? ` · ${limits.subscriptionType}` : ''}</div>
          {limits.windows.map((w) => (
            <div key={w.label} className="row" style={{ justifyContent: 'space-between', gap: 12, padding: '3px 0' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}><Ring percent={w.percent} size={12} />{w.label}</span>
              <span style={{ color: 'var(--ink-3)' }}>{w.percent}% · {resetIn(w.resetsAt)}</span>
            </div>
          ))}
          <div style={{ color: 'var(--ink-4)', fontSize: 'var(--fs-meta)', marginTop: 6 }}>每 90 秒刷新 · 来源 api.anthropic.com/api/oauth/usage</div>
        </div>
      )}
    </span>
  );
}

/** All panels behind one button; the rail-marked few also get a direct icon button. */
function PanelMenu() {
  const dock = useStore((s) => s.layout.dock);
  const togglePanel = useStore((s) => s.togglePanel);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', off);
    return () => document.removeEventListener('mousedown', off);
  }, [open]);
  const on = (id: string) => dock.open && dock.tabs.includes(id as never);
  return (
    <span ref={ref} style={{ position: 'relative' }}>
      <button className={clsx('icon-btn', open && 'active')} title="面板" aria-label="面板" onClick={() => setOpen(!open)}><Icon name="board" size={16} /></button>
      {open && (
        <div className="menu" style={{ top: 32, right: 0 }}>
          {PANELS.map((p) => (
            <button key={p.id} onClick={() => { togglePanel(p.id); setOpen(false); }}>
              <Icon name={p.icon} size={14} />
              <span style={{ flex: 1 }}>{p.title}</span>
              {on(p.id) && <Icon name="check" size={13} />}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/** Global strip (also the Electron drag region): sidebar · group · quota · panels · palette. */
export function TopBar() {
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const dock = useStore((s) => s.layout.dock);
  const dispatch = useStore((s) => s.dispatchLayout);
  const togglePanel = useStore((s) => s.togglePanel);
  const groupName = useStore((s) => s.layout.groups.find((g) => g.id === s.layout.activeGroupId)?.name ?? '');
  const running = useStore((s) => Object.values(s.open).filter((o) => o.state === 'running' || o.state === 'waiting').length);
  const rail = PANELS.filter((p) => p.rail);
  return (
    <div className="topbar slim">
      <button className={clsx('icon-btn', sidebarOpen && 'active')} onClick={() => useStore.setState({ sidebarOpen: !sidebarOpen })} title={sidebarOpen ? '收起侧栏 (Ctrl+B)' : '展开侧栏 (Ctrl+B)'} aria-label="侧栏"><Icon name="sidebar" size={16} /></button>
      <div className="title">
        <span className="cur">{groupName}</span>
        {running > 0 && <span className="badge run" title="运行中的会话">{running} 运行中</span>}
      </div>
      <span className="grow" />
      <UsageRings />
      <span className="topbar-sep" />
      <span className="panel-btns">
        {rail.map((p) => (
          <button key={p.id} className={clsx('icon-btn', dock.open && dock.tabs.includes(p.id) && 'active')} onClick={() => togglePanel(p.id)} title={p.title} aria-label={p.title}>
            <Icon name={p.icon} size={16} />
          </button>
        ))}
      </span>
      <PanelMenu />
      <button className={clsx('icon-btn', dock.open && 'active')} title="停靠面板 (Ctrl+J)" aria-label="停靠面板" onClick={() => dispatch({ t: 'dock.set', patch: { open: !dock.open, minimized: false } })}><Icon name="inspector" size={16} /></button>
      <button className="icon-btn" title="命令面板 (Ctrl+K)" aria-label="命令面板" onClick={() => useStore.setState({ paletteOpen: true })}><Icon name="command" size={16} /></button>
    </div>
  );
}
