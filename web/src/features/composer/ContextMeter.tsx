import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '@/store';
import { usePaneCtx } from '@/store/paneContext';
import { clsx } from '@/util';
import { useDropdown } from '@/ui/menus';
import { meterMode, ringLevel, sessionTotals, usageLines } from './stats';
import { BAR_ID } from './ids';

/** The header ··· 「本对话用量」 asks the composer of its tile for the card (`showUsageCard`). */
export const USAGE_CARD_EVENT = 'cw:usage-card';
export interface UsageCardDetail { tileId: string }
export function showUsageCard(tileId: string): void {
  window.dispatchEvent(new CustomEvent<UsageCardDetail>(USAGE_CARD_EVENT, { detail: { tileId } }));
}

/**
 * The composer's bottom-right context ring (spec §4.2 统计栏 / §5.4): only once the context is filling up (≥ 60 %,
 * spec §5.4 — final review I3: a ring or an unlabelled stats icon always in the corner was one control too many);
 * the percentage from 60 %, ink and bold from 80 %, the error colour from 95 %. On hover, focus or click it shows
 * every number the old stats bar under the composer showed (turns, tokens, cache, cost, last turn, context,
 * background tasks). The same card is always one menu away: the header's ··· 「本对话用量」 opens it here, anchored
 * to the ring or, without one, to this corner of the row.
 */
export function ContextMeter({ sessionId }: { sessionId: string }) {
  const o = useStore((s) => s.open[sessionId]);
  const pane = usePaneCtx();
  const [pinned, setPinned] = useState(false);
  const [hover, setHover] = useState(false);
  // asked for from the header's ··· (stays until a click outside, Esc or another menu)
  const [asked, setAsked] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const card = useRef<HTMLDivElement>(null);
  useDropdown(asked, () => setAsked(false), card);
  useEffect(() => {
    const on = (e: Event) => { if (pane && (e as CustomEvent<UsageCardDetail>).detail.tileId === pane.tileId) setAsked(true); };
    window.addEventListener(USAGE_CARD_EVENT, on);
    return () => window.removeEventListener(USAGE_CARD_EVENT, on);
  }, [pane?.tileId]);
  const totals = useMemo(() => (o ? sessionTotals(o.conv.items) : null), [o?.version]);
  const cu = o ? o.contextUsage ?? o.conv.contextUsage : undefined;
  const pct = cu?.percentage;
  const level = ringLevel(pct);
  if (!o || !totals) return null;
  const ring = meterMode(pct) === 'ring';
  const tasks = [...o.conv.tasks.values()].filter((t) => t.status === 'running').length;
  const lines = usageLines(totals, { lastMs: o.conv.lastResult?.durationMs, context: cu ? { percentage: cu.percentage, totalTokens: cu.totalTokens, maxTokens: cu.maxTokens } : undefined, tasks });
  const show = pinned || hover || asked;
  const r = 6, c = 2 * Math.PI * r, p = Math.min(100, Math.max(0, pct ?? 0));
  // the ring when there is one; else the right-hand group of the row (the card's corner is the same)
  const rect = show ? (ring ? btn.current : anchor.current?.parentElement)?.getBoundingClientRect() : undefined;
  return (
    <>
      <span ref={anchor} className="ctx-anchor" aria-hidden />
      {ring && (
        <button ref={btn} type="button" data-id={BAR_ID.meter} className={clsx('ctx-meter', level)} aria-label={`本对话用量，上下文 ${pct}%`} aria-expanded={show}
          onClick={() => setPinned((v) => !v)} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} onFocus={() => setHover(true)} onBlur={() => { setHover(false); setPinned(false); }}>
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
            <circle cx="8" cy="8" r={r} fill="none" stroke="var(--edge-strong)" strokeWidth="2" />
            <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeWidth={level === 'quiet' || level === 'note' ? 2 : 2.6} strokeDasharray={`${(p / 100) * c} ${c}`} strokeLinecap="round" transform="rotate(-90 8 8)" />
          </svg>
          <span className="pct">{pct}%</span>
        </button>
      )}
      {show && rect && createPortal(
        <div ref={card} className="ctx-card" role={asked ? 'dialog' : 'tooltip'} aria-label="本对话用量" style={{ position: 'fixed', right: Math.max(8, window.innerWidth - rect.right), bottom: window.innerHeight - rect.top + 6 }}>
          <div className="ctx-card-h">本对话用量</div>
          {lines.map(([k, v]) => <div key={k} className="ctx-row"><span className="k">{k}</span><span className="v">{v}</span></div>)}
        </div>,
        document.body,
      )}
    </>
  );
}
