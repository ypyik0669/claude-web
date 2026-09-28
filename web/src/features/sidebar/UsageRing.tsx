import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '@/store';
import { clsx } from '@/util';
import type { LimitWindow } from '@shared';

function resetIn(iso: string | null) {
  if (!iso) return '';
  const s = Math.max(0, (Date.parse(iso) - Date.now()) / 1000);
  if (s < 3600) return `${Math.ceil(s / 60)} 分钟后重置`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时 ${Math.round((s % 3600) / 60)} 分后重置`;
  return `${Math.floor(s / 86400)} 天 ${Math.round((s % 86400) / 3600)} 小时后重置`;
}

export function Ring({ percent, size = 14 }: { percent: number; size?: number }) {
  const r = size / 2 - 1.5, c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--edge-default)" strokeWidth="2" />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray={`${(percent / 100) * c} ${c}`} strokeLinecap="round" transform={`rotate(-90 ${size / 2} ${size / 2})`} />
    </svg>
  );
}

/**
 * Account quota in the sidebar's bottom row (spec §4.2: the top bar's ring moved here). One ring for the window
 * closest to its limit + 「已用 N%」; the full 5h / 7d breakdown opens upwards on hover — in a portal, fixed to the
 * viewport: the sidebar column clips its overflow (and is narrower than the tip).
 * The usage endpoint 429s readily and the server backs off for 15 minutes — no reading is not an alarm.
 */
export function UsageRing() {
  const limits = useStore((s) => s.limits);
  const [at, setAt] = useState<{ left: number; bottom: number } | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setAt({ left: Math.max(8, Math.min(r.left, window.innerWidth - 300)), bottom: window.innerHeight - r.top + 6 });
  };
  if (!limits) return null;
  if (!limits.ok) return <span className="quota unknown" title={limits.error ?? '暂时读不到账号额度'}>额度 –</span>;
  const worst = limits.windows.reduce<LimitWindow | null>((a, w) => (!a || w.percent > a.percent ? w : a), null);
  if (!worst) return null;
  const tone = worst.percent >= 90 ? 'crit' : worst.percent >= 70 ? 'hot' : '';
  return (
    <span ref={ref} className={clsx('quota', tone)} onMouseEnter={show} onMouseLeave={() => setAt(null)} title={`${worst.label}: 已用 ${worst.percent}%`}>
      <Ring percent={worst.percent} />
      <span className="pct">{limits.subscriptionType ? `${limits.subscriptionType} · ` : ''}已用 {worst.percent}%</span>
      {at && createPortal(
        <div className="tip up quota-tip" style={{ position: 'fixed', left: at.left, bottom: at.bottom, top: 'auto', right: 'auto', margin: 0 }}>
          <div className="label" style={{ marginBottom: 6 }}>账号额度{limits.subscriptionType ? ` · ${limits.subscriptionType}` : ''}</div>
          {limits.windows.map((w) => (
            <div key={w.label} className="row" style={{ justifyContent: 'space-between', gap: 12, padding: '3px 0' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}><Ring percent={w.percent} size={12} />{w.label}</span>
              <span style={{ color: 'var(--ink-3)' }}>{w.percent}% · {resetIn(w.resetsAt)}</span>
            </div>
          ))}
          <div style={{ color: 'var(--ink-4)', fontSize: 'var(--fs-meta)', marginTop: 6 }}>每 90 秒刷新 · 来源 api.anthropic.com/api/oauth/usage</div>
        </div>,
        document.body,
      )}
    </span>
  );
}
