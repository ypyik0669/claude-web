import { useEffect, useMemo, useRef } from 'react';
import type { BgHistoryItem, BgHistoryKind } from '@shared';
import { useStore } from '@/store';
import { clsx } from '@/util';
import { Icon } from '@/ui/icons';
import { EmptyState } from '@/ui/EmptyState';
import { EMPTY } from '@/ui/terms';
import { imeComposing } from '@/ui/ime';
import { KIND_LABEL } from './model';
import { groupByDay, rowMeta, rowTitle, statusChip } from './history-model';
import { moreHistory, pickHistory, refreshHistory, reloadHistory, setHistoryQuery, useHistory } from './history-state';
import { pauseReplay, stopReplay, useReplay } from './replay';
import { closeAgent, useBackground } from './state';
import { HistoryDetail } from './HistoryDetail';
import { tr } from '@/i18n';

const KINDS: [BgHistoryKind | undefined, string][] = [[undefined, tr('全部')], ['workflow', KIND_LABEL.workflow], ['agent', KIND_LABEL.agent], ['shell', KIND_LABEL.shell]];
const ICON = { workflow: 'workflow', agent: 'agent', shell: 'terminal' } as const;

function HistoryRow({ it, on }: { it: BgHistoryItem; on: boolean }) {
  const chip = statusChip(it);
  return (
    <button type="button" className={clsx('hx-row', on && 'on')} data-hid={it.id} data-kind={it.kind} aria-current={on || undefined} onClick={() => { closeAgent(); pickHistory(it.id); }}>
      <Icon name={ICON[it.kind]} size={15} />
      <span className="tx"><b>{rowTitle(it)}</b><small>{rowMeta(it)}</small></span>
      <span className={clsx('hx-st', chip.tone)}>{chip.text}</span>
    </button>
  );
}

/** The rows by day, the words to look for, the kinds; the next page comes as the end scrolls into view. */
function HistoryList() {
  const items = useHistory((s) => s.items);
  const next = useHistory((s) => s.next);
  const loading = useHistory((s) => s.loading);
  const loaded = useHistory((s) => s.loaded);
  const error = useHistory((s) => s.error);
  const q = useHistory((s) => s.q);
  const only = useHistory((s) => s.only);
  const pick = useHistory((s) => s.pick);
  const groups = useMemo(() => groupByDay(items), [items]);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = end.current;
    if (!el || !next || typeof IntersectionObserver !== 'function') return;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) void moreHistory(); }, { rootMargin: '240px' });
    io.observe(el);
    return () => io.disconnect();
  }, [next, items.length]);
  return (
    <div className="hx-list">
      <label className="hx-search">
        <Icon name="search" size={14} />
        <input value={q} placeholder={tr('搜索跑过的…')} aria-label={tr('搜索跑过的')} onChange={(e) => setHistoryQuery({ q: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Escape' && !imeComposing(e.nativeEvent) && q) { e.preventDefault(); e.stopPropagation(); setHistoryQuery({ q: '' }); } }} />
      </label>
      <div className="hx-chips" role="radiogroup" aria-label={tr('类型')}>
        {KINDS.map(([k, label]) => <button key={k ?? 'all'} type="button" role="radio" aria-checked={only === k} className={clsx(only === k && 'on')} data-kind={k ?? 'all'} onClick={() => setHistoryQuery({ only: k ?? null })}>{label}</button>)}
      </div>
      <div className="hx-rows">
        {groups.map((g) => (
          <section key={g.key} className="hx-day-g" aria-label={g.label}>
            <div className="hx-day">{g.label}</div>
            {g.items.map((it) => <HistoryRow key={it.id} it={it} on={pick === it.id} />)}
          </section>
        ))}
        {loaded && !loading && !error && items.length === 0 && <EmptyState e={q.trim() || only ? EMPTY.historyNone : EMPTY.history} />}
        {error && <div className="hx-err">{tr('读不到跑过的：{error}', { error })}</div>}
        <div ref={end} className="hx-more">{loading ? tr('读取中…') : next ? tr('往下滑接着取') : items.length > 0 ? tr('没有更早的了') : ''}</div>
      </div>
    </div>
  );
}

/**
 * 后台 › 跑过的 (2026-11-19): every conversation's finished workflows, sub-agents and background commands — the list on
 * the left, the one picked on the right (its graph, its replay). A phone: the list is one screen, a run the next.
 * Asked for anew each time it comes on screen; nothing of it is pushed.
 */
export function HistoryView({ shown }: { shown: boolean }) {
  const mobile = useStore((s) => s.mobile);
  const pick = useHistory((s) => s.pick);
  const items = useHistory((s) => s.items);
  const recent = useHistory((s) => s.recent);
  useEffect(() => {
    if (shown) { void reloadHistory(); return; }
    // off screen: its replay stops playing (the cafe's goes on, it is on screen there)
    if (useReplay.getState().show?.where === 'graph') pauseReplay();
  }, [shown]);
  // something live ended while this is on screen: its row a moment later (a workflow's run file is written as it ends),
  // merged in on top — the live snapshot only says when, nothing of 跑过的 is pushed
  const ended = useBackground((s) => Object.values(s.sessions).reduce((n, x) => n + x.tasks.filter((t) => t.status !== 'running').length, 0));
  const seenEnded = useRef(ended);
  useEffect(() => {
    const more = ended > seenEnded.current;
    seenEnded.current = ended;
    if (!more || !shown) return;
    const t = setTimeout(() => void refreshHistory(), 1500);
    return () => clearTimeout(t);
  }, [ended, shown]);
  const item = pick ? items.find((i) => i.id === pick) ?? recent?.find((i) => i.id === pick) : undefined;
  // a desktop opens the newest when nothing (or a row no longer listed — another kind picked) is open
  useEffect(() => { if (shown && !mobile && !item && items.length) pickHistory(items[0].id); }, [shown, mobile, item, items]);
  // another row: the replay of the one before ends
  useEffect(() => { const s = useReplay.getState().show; if (s?.where === 'graph' && s.id !== pick) stopReplay(); }, [pick]);
  const back = () => { closeAgent(); pickHistory(undefined); };
  return (
    <div className={clsx('hx', mobile && 'phone', mobile && item && 'on-run')} hidden={!shown}>
      <div className="hx-col" hidden={mobile && !!item}><HistoryList /></div>
      {item
        ? <HistoryDetail key={item.id} item={item} onBack={mobile ? back : undefined} />
        : !mobile && <div className="hx-detail hx-detail-empty" aria-hidden />}
    </div>
  );
}
