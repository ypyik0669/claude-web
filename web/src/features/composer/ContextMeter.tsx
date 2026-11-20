import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSettledSession, useStore } from '@/store';
import { usePaneCtx } from '@/store/paneContext';
import { clsx } from '@/util';
import { useDropdown } from '@/ui/menus';
import { ActionSheet } from '@/ui/ActionSheet';
import { leftInside } from '@/features/models/place';
import { convStats } from '@/model/conv-stats';
import { estimateContext, meterMode, ringLevel, sessionTotals, usageCard, type UsageCard } from './stats';
import { resumeView } from '@/store/reopen';
import { BAR_ID, PHONE_SHEET_ID } from './ids';
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

/** The card's body: the context with its bar, the numbers, the footnote (the hover card and a phone's sheet). */
function CardBody({ card }: { card: UsageCard }) {
  const c = card.context;
  return (
    <>
      {c ? (
        <div className="ctx-card-ctx">
          <div className="ctx-card-h"><b>{c.estimated ? tr('上下文 {pct}%（按上一轮估）', { pct: c.pct }) : tr('上下文 {pct}%', { pct: c.pct })}</b><span className="w">{c.used} / {c.window}</span></div>
          <div className="ctx-bar" aria-hidden><i style={{ width: `${Math.min(100, Math.max(0, c.pct))}%` }} /></div>
        </div>
      ) : <div className="ctx-card-h"><b>{tr('本对话用量')}</b></div>}
      <dl className="ctx-rows">
        {card.rows.map(([k, v]) => <div key={k} className="ctx-row"><dt className="k">{k}</dt><dd className="v">{v}</dd></div>)}
      </dl>
      {c && <small className="ctx-note">{tr('快满时 Claude Code 会自动压缩')}</small>}
    </>
  );
}

/**
 * The context ring at the end of the line under the box (redesign 2026-11 「输入框下面这一行」 ⑥): always with its
 * percentage (it used to wait for 60 %); darker from 60 %, bold from 80 %, the error colour from 95 %. On hover, focus
 * or click a card: the context used of the window, 输入 / 输出, 缓存命中, 速度, 轮数 · 步数, 费用, 上一轮用时 — what the row
 * drops when it is narrow is all here. The header's ··· 「本对话用量」 opens the same card, anchored to the ring or,
 * without one, to this corner of the row. A phone: a tap opens the numbers as a sheet (no hover there).
 */
export function ContextMeter({ sessionId }: { sessionId: string }) {
  const o = useSettledSession(sessionId);
  const pane = usePaneCtx();
  const mobile = useStore((s) => s.mobile);
  const [pinned, setPinned] = useState(false);
  const [hover, setHover] = useState(false);
  // a phone's sheet of the numbers
  const [sheet, setSheet] = useState(false);
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
    const on = (e: Event) => {
      if (!pane || (e as CustomEvent<UsageCardDetail>).detail.tileId !== pane.tileId) return;
      if (useStore.getState().mobile) setSheet(true); else setAsked(true);
    };
    window.addEventListener(USAGE_CARD_EVENT, on);
    return () => window.removeEventListener(USAGE_CARD_EVENT, on);
  }, [pane?.tileId]);
  // the card's layout width (offsetWidth: while it scales in, its box on screen is smaller), measured before the paint:
  // it is placed by its left edge so that it stays inside the window. Its width does not depend on where it is
  // (`width: max-content`, capped at the window minus the gutters: styles.css), so one measure settles it
  const [cardW, setCardW] = useState(0);
  useLayoutEffect(() => {
    const w = card.current?.offsetWidth ?? 0;
    if (w && w !== cardW) setCardW(w);
  });
  const totals = useMemo(() => (o ? sessionTotals(o.conv.items) : null), [o?.version]);
  const stats = useMemo(() => (o ? convStats(o.conv.items) : null), [o?.version]);
  const cu = useContextUsage(sessionId);
  const pct = cu?.percentage;
  const level = ringLevel(pct);
  if (!o || !totals) return null;
  const ring = meterMode(pct) === 'ring';
  const tasks = [...o.conv.tasks.values()].filter((t) => t.status === 'running').length;
  const data = usageCard(totals, stats, { lastMs: o.conv.lastResult?.durationMs, context: cu ? { percentage: cu.percentage, totalTokens: cu.totalTokens, maxTokens: cu.maxTokens, estimated: cu.estimated } : undefined, tasks });
  const show = !mobile && (pinned || hover || asked);
  const r = 6, c = 2 * Math.PI * r, p = Math.min(100, Math.max(0, pct ?? 0));
  // the ring when there is one; else the right-hand group of the row (the card's corner is the same)
  const rect = show ? (ring ? btn.current : anchor.current?.parentElement)?.getBoundingClientRect() : undefined;
  // right-aligned to the ring (or the row's corner) when there is room to its left; else moved right, 8px in from the
  // window's edge. It still grows from the ring: the origin follows it along the bottom edge
  const vw = window.innerWidth;
  const left = rect ? leftInside(rect.right, cardW, vw) : 0;
  const origin = rect && cardW ? `${Math.round(Math.max(0, Math.min(cardW, (rect.left + rect.right) / 2 - left)))}px 100%` : undefined;
  return (
    <>
      <span ref={anchor} className="ctx-anchor" aria-hidden />
      {ring && (
        <button ref={btn} type="button" data-id={BAR_ID.meter} className={clsx('ctx-meter', level)} aria-label={tr('本对话用量，上下文 {pct}%', { pct })} aria-expanded={show || sheet} aria-haspopup={mobile ? 'dialog' : undefined}
          onClick={() => (mobile ? setSheet(true) : setPinned((v) => !v))} onMouseEnter={() => { if (!mobile) setHover(true); }} onMouseLeave={() => setHover(false)} onFocus={() => { if (!mobile) setHover(true); }} onBlur={() => { setHover(false); setPinned(false); }}>
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
            <circle cx="8" cy="8" r={r} fill="none" stroke="var(--edge-strong)" strokeWidth="2" />
            <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeWidth={level === 'quiet' || level === 'note' ? 2 : 2.6} strokeDasharray={`${(p / 100) * c} ${c}`} strokeLinecap="round" transform="rotate(-90 8 8)" />
          </svg>
          {/* always the number (redesign 2026-11: it used to wait for 60 %) */}
          <span className="pct">{pct}%</span>
        </button>
      )}
      {show && rect && createPortal(
        <div ref={card} className="ctx-card" role={asked ? 'dialog' : 'tooltip'} aria-label={tr('本对话用量')} style={{ position: 'fixed', left, bottom: window.innerHeight - rect.top + 6, transformOrigin: origin }}>
          <CardBody card={data} />
        </div>,
        document.body,
      )}
      {/* a phone (the mockup's 「点上下文小环」): the same numbers in a sheet from the bottom */}
      {sheet && mobile && (
        <ActionSheet onClose={() => setSheet(false)}>
          <div className="menu ctx-sheet" role="dialog" aria-label={tr('这个对话')} data-id={PHONE_SHEET_ID.ctxSheet}>
            <div className="ctx-sheet-h">{tr('这个对话')}</div>
            <CardBody card={data} />
          </div>
        </ActionSheet>
      )}
    </>
  );
}
