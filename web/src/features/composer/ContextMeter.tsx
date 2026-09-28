import { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '@/store';
import { clsx } from '@/util';
import { Icon } from '@/ui/icons';
import { meterMode, ringLevel, sessionTotals, usageLines } from './stats';
import { BAR_ID } from './ids';

/**
 * The composer's bottom-right context ring (spec §4.2 统计栏 / §5.4): how full the context is, and — on hover, focus
 * or click — every number the old stats bar under the composer showed (turns, tokens, cache, cost, last turn,
 * context, background tasks). Quiet grey under 60 %, the percentage from 60 %, ink and bold from 80 %, the error
 * colour from 95 %. A conversation whose agent reports no occupancy (ACP…, or one opened from history) gets no
 * ring — an empty circle reads as a radio button or a spinner — but once it has a turn, a plain stats icon in the
 * same place opens the same card.
 */
export function ContextMeter({ sessionId }: { sessionId: string }) {
  const o = useStore((s) => s.open[sessionId]);
  const [pinned, setPinned] = useState(false);
  const [hover, setHover] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const totals = useMemo(() => (o ? sessionTotals(o.conv.items) : null), [o?.version]);
  const cu = o ? o.contextUsage ?? o.conv.contextUsage : undefined;
  const pct = cu?.percentage;
  const level = ringLevel(pct);
  if (!o || !totals) return null;
  // no occupancy reported (ACP agents, a conversation opened from history): no ring, but the numbers stay one
  // hover away once there is something to count — a plain stats icon opening the same card
  const mode = meterMode(pct, totals.turns);
  if (!mode) return null;
  const ring = mode === 'ring';
  const tasks = [...o.conv.tasks.values()].filter((t) => t.status === 'running').length;
  const lines = usageLines(totals, { lastMs: o.conv.lastResult?.durationMs, context: ring && cu ? { percentage: cu.percentage, totalTokens: cu.totalTokens, maxTokens: cu.maxTokens } : undefined, tasks });
  const show = pinned || hover;
  const r = 6, c = 2 * Math.PI * r, p = Math.min(100, Math.max(0, pct ?? 0));
  const rect = show ? btn.current?.getBoundingClientRect() : undefined;
  return (
    <>
      <button ref={btn} type="button" data-id={BAR_ID.meter} className={clsx('ctx-meter', ring ? level : 'plain')} aria-label={ring ? `本对话用量，上下文 ${pct}%` : '本对话用量'} aria-expanded={show}
        onClick={() => setPinned((v) => !v)} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} onFocus={() => setHover(true)} onBlur={() => { setHover(false); setPinned(false); }}>
        {ring ? (
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
            <circle cx="8" cy="8" r={r} fill="none" stroke="var(--edge-strong)" strokeWidth="2" />
            <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeWidth={level === 'quiet' || level === 'note' ? 2 : 2.6} strokeDasharray={`${(p / 100) * c} ${c}`} strokeLinecap="round" transform="rotate(-90 8 8)" />
          </svg>
        ) : <Icon name="usage" size={14} />}
        {ring && level !== 'quiet' && <span className="pct">{pct}%</span>}
      </button>
      {show && rect && createPortal(
        <div className="ctx-card" role="tooltip" style={{ position: 'fixed', right: Math.max(8, window.innerWidth - rect.right), bottom: window.innerHeight - rect.top + 6 }}>
          <div className="ctx-card-h">本对话用量</div>
          {lines.map(([k, v]) => <div key={k} className="ctx-row"><span className="k">{k}</span><span className="v">{v}</span></div>)}
        </div>,
        document.body,
      )}
    </>
  );
}
