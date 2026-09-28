import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '@/store';
import { clsx } from '@/util';
import type { LimitWindow, Limits } from '@shared';
import { planLabel } from './status';

export function resetIn(iso: string | null) {
  if (!iso) return '';
  const s = Math.max(0, (Date.parse(iso) - Date.now()) / 1000);
  if (s < 3600) return `${Math.ceil(s / 60)} 分钟后重置`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分后重置`;
  return `${Math.floor(s / 86400)} 天 ${Math.floor((s % 86400) / 3600)} 小时后重置`;
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

/** The window closest to its limit (the one the ring shows). */
export const worstWindow = (limits: Limits | null): LimitWindow | null => (limits?.ok ? limits.windows.reduce<LimitWindow | null>((a, w) => (!a || w.percent > a.percent ? w : a), null) : null);

/** Every window: ring, label, % and when it resets (the account popover, the hover tip). */
export function QuotaWindows({ limits }: { limits: Limits }) {
  return (
    <>
      {limits.windows.map((w) => (
        <div key={w.label} className="quota-win">
          <span className="l"><Ring percent={w.percent} size={12} />{w.label}</span>
          <span className="v">{w.percent}% · {resetIn(w.resetsAt)}</span>
        </div>
      ))}
    </>
  );
}

/**
 * Account quota in the sidebar's bottom row (spec §4.2: the top bar's ring moved here): one ring for the window
 * closest to its limit + 「Max 套餐 · 已用 N%」. `tip`: the full 5h / 7d breakdown on hover, in a portal fixed to the
 * viewport (the sidebar clips its overflow) — off inside the account row, whose popover shows it on click.
 * The usage endpoint 429s readily and the server backs off for 15 minutes — no reading is not an alarm.
 */
export function UsageRing({ tip = true, fallbackPlan }: { tip?: boolean; fallbackPlan?: string }) {
  const limits = useStore((s) => s.limits);
  const [at, setAt] = useState<{ left: number; bottom: number } | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (r && tip) setAt({ left: Math.max(8, Math.min(r.left, window.innerWidth - 300)), bottom: window.innerHeight - r.top + 6 });
  };
  const plan = planLabel(limits?.subscriptionType ?? fallbackPlan);
  if (!limits) return plan ? <span className="quota unknown" data-id="quota">{plan}</span> : null;
  if (!limits.ok) return <span className="quota unknown" data-id="quota" title={limits.error ?? '暂时读不到账号额度'}>{plan ? `${plan} · ` : ''}额度 –</span>;
  const worst = worstWindow(limits);
  if (!worst) return plan ? <span className="quota unknown" data-id="quota">{plan}</span> : null;
  const tone = worst.percent >= 90 ? 'crit' : worst.percent >= 70 ? 'hot' : '';
  return (
    <span ref={ref} className={clsx('quota', tone)} data-id="quota" onMouseEnter={show} onMouseLeave={() => setAt(null)} title={tip ? `${worst.label}: 已用 ${worst.percent}%` : undefined}>
      <Ring percent={worst.percent} size={12} />
      <span className="pct">{plan ? `${plan} · ` : ''}已用 {worst.percent}%</span>
      {at && createPortal(
        <div className="tip up quota-tip" style={{ position: 'fixed', left: at.left, bottom: at.bottom, top: 'auto', right: 'auto', margin: 0 }}>
          <div className="label" style={{ marginBottom: 6 }}>账号额度{plan ? ` · ${plan}` : ''}</div>
          <QuotaWindows limits={limits} />
          <div style={{ color: 'var(--ink-4)', fontSize: 'var(--fs-meta)', marginTop: 6 }}>每 90 秒刷新 · 来源 api.anthropic.com/api/oauth/usage</div>
        </div>,
        document.body,
      )}
    </span>
  );
}
