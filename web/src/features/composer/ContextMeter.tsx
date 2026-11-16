import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSettledSession, useStore } from '@/store';
import { usePaneCtx } from '@/store/paneContext';
import { clsx } from '@/util';
import { useDropdown } from '@/ui/menus';
import { estimateContext, meterMode, ringLevel, sessionTotals, usageLines } from './stats';
import { resumeView } from '@/store/reopen';
import { BAR_ID } from './ids';
import { tr } from '@/i18n';
import type { ContextUsage } from '@/model/conversation';

/** The header ··· 「本对话用量」 asks the composer of its tile for the card (`showUsageCard`). */
export const USAGE_CARD_EVENT = 'cw:usage-card';
export interface UsageCardDetail { tileId: string }
export function showUsageCard(tileId: string): void {
  window.dispatchEvent(new CustomEvent<UsageCardDetail>(USAGE_CARD_EVENT, { detail: { tileId } }));
}

/**
 * How full a conversation's context is: what the process put on its messages, else read off the last answer's usage.
 * Not asked of the engine: its getContextUsage counts tokens part by part with the model's API (~15–30 requests), and
 * where a relay has no count_tokens the engine fell back to as many non-streaming generations with no system prompt —
 * asked at every turn end, that was a relay's log full of 「非流」 Claude calls and its fingerprint check's 403s
 * (2026-10-23 user report). The full breakdown is only fetched when the 信息栏's context card asks for it.
 */
export function useContextUsage(sessionId: string): ContextUsage | undefined {
  const o = useSettledSession(sessionId);
  const providers = useStore((s) => s.providers);
  const recorded = useStore((s) => s.sessionMeta[sessionId]);
  return useMemo(() => {
    if (!o) return undefined;
    if (o.conv.contextUsage) return o.conv.contextUsage;
    const v = resumeView(o, recorded);
    // another Claude account is the account: its windows are the account's (200K, 1M for a [1m] pick)
    const p = v.providerId !== 'claude' ? providers.find((x) => x.id === v.providerId) : undefined;
    // the engine's autocompact cap (the server reports it; review I3): the window this divides by is the one the card's
    // body counts against; and the model's window as the engine will use it (A7: the account's 200K / 1M pick, the
    // provider's setting) — the server's word over any guess here
    return estimateContext(o.conv.items, { provider: p?.type === 'claude-account' ? undefined : p, model: v.model, compactWindow: o.info?.compactWindow, contextWindow: o.info?.contextWindow });
  }, [o?.version, o?.info?.compactWindow, o?.info?.contextWindow, providers, recorded]);
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
  const o = useSettledSession(sessionId);
  const pane = usePaneCtx();
  const [pinned, setPinned] = useState(false);
  const [hover, setHover] = useState(false);
  // asked for from the header's ··· (stays until a click outside, Esc or another menu)
  const [asked, setAsked] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const card = useRef<HTMLDivElement>(null);
  useDropdown(asked, () => setAsked(false), card);
  // the ring's card (hovered or clicked open) is a tooltip: a press anywhere but the ring and the card closes it — a
  // mouseleave / blur that never came (the ring moved or remounted under a still pointer) left it over the menu the
  // press opened next (the tab strip's ＋, ui-smoke 2026-10-16). The ring's own press is its click's: it toggles.
  useEffect(() => {
    if (!(hover || pinned) || asked) return;
    const down = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (t && (btn.current?.contains(t) || card.current?.contains(t))) return;
      setHover(false);
      setPinned(false);
    };
    document.addEventListener('mousedown', down, true);
    return () => document.removeEventListener('mousedown', down, true);
  }, [hover, pinned, asked]);
  useEffect(() => {
    const on = (e: Event) => { if (pane && (e as CustomEvent<UsageCardDetail>).detail.tileId === pane.tileId) setAsked(true); };
    window.addEventListener(USAGE_CARD_EVENT, on);
    return () => window.removeEventListener(USAGE_CARD_EVENT, on);
  }, [pane?.tileId]);
  const totals = useMemo(() => (o ? sessionTotals(o.conv.items) : null), [o?.version]);
  const cu = useContextUsage(sessionId);
  const pct = cu?.percentage;
  const level = ringLevel(pct);
  if (!o || !totals) return null;
  const ring = meterMode(pct) === 'ring';
  const tasks = [...o.conv.tasks.values()].filter((t) => t.status === 'running').length;
  const lines = usageLines(totals, { lastMs: o.conv.lastResult?.durationMs, context: cu ? { percentage: cu.percentage, totalTokens: cu.totalTokens, maxTokens: cu.maxTokens, estimated: cu.estimated } : undefined, tasks });
  const show = pinned || hover || asked;
  const r = 6, c = 2 * Math.PI * r, p = Math.min(100, Math.max(0, pct ?? 0));
  // the ring when there is one; else the right-hand group of the row (the card's corner is the same)
  const rect = show ? (ring ? btn.current : anchor.current?.parentElement)?.getBoundingClientRect() : undefined;
  return (
    <>
      <span ref={anchor} className="ctx-anchor" aria-hidden />
      {ring && (
        <button ref={btn} type="button" data-id={BAR_ID.meter} className={clsx('ctx-meter', level)} aria-label={tr('本对话用量，上下文 {pct}%', { pct })} aria-expanded={show}
          onClick={() => setPinned((v) => !v)} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} onFocus={() => setHover(true)} onBlur={() => { setHover(false); setPinned(false); }}>
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
            <circle cx="8" cy="8" r={r} fill="none" stroke="var(--edge-strong)" strokeWidth="2" />
            <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeWidth={level === 'quiet' || level === 'note' ? 2 : 2.6} strokeDasharray={`${(p / 100) * c} ${c}`} strokeLinecap="round" transform="rotate(-90 8 8)" />
          </svg>
          {level !== 'quiet' && <span className="pct">{pct}%</span>}
        </button>
      )}
      {show && rect && createPortal(
        <div ref={card} className="ctx-card" role={asked ? 'dialog' : 'tooltip'} aria-label={tr('本对话用量')} style={{ position: 'fixed', right: Math.max(8, window.innerWidth - rect.right), bottom: window.innerHeight - rect.top + 6 }}>
          <div className="ctx-card-h">{tr('本对话用量')}</div>
          {lines.map(([k, v]) => <div key={k} className="ctx-row"><span className="k">{k}</span><span className="v">{v}</span></div>)}
        </div>,
        document.body,
      )}
    </>
  );
}
