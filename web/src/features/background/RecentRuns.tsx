import { useEffect } from 'react';
import type { BgHistoryItem } from '@shared';
import { Icon } from '@/ui/icons';
import { agoText, kindText, rowTitle } from './history-model';
import { loadRecent, replayInCafe, useHistory } from './history-state';
import { openBackground, openHistory, setBgView } from './state';
import { tr } from '@/i18n';

const ICON = { workflow: 'workflow', agent: 'agent', shell: 'terminal' } as const;

/** 12 分钟前 · 9 个子代理 · 1 个失败 / 40 分钟前 · 子代理 Explore */
function recentLine(it: BgHistoryItem): string {
  return [
    agoText(it.endedAt ?? it.startedAt),
    it.kind === 'workflow' ? tr('{n} 个子代理', { n: it.agentCount ?? 0 }) : kindText(it),
    it.failed ? tr('{n} 个失败', { n: it.failed }) : it.status === 'failed' ? tr('失败') : '',
  ].filter(Boolean).join(' · ');
}

/**
 * The cafe with nobody in it (2026-11-19): the three runs that ended last, each with 回放 (played again in the
 * page's cafe), and 看全部跑过的 (the page's 跑过的). Read when it shows — each time the cafe empties.
 */
export function RecentRuns({ compact }: { compact?: boolean }) {
  const recent = useHistory((s) => s.recent);
  useEffect(() => { void loadRecent(); }, []);
  if (!recent?.length) return null;
  const replay = (it: BgHistoryItem) => {
    // the right panel's cafe is small: the page's plays it
    if (compact) openBackground();
    setBgView('live');
    void replayInCafe(it);
  };
  return (
    <div className="hx-recent" role="group" aria-label={tr('刚跑完的')}>
      <div className="rh">
        <span>{tr('刚跑完的')}</span>
        <span className="grow" />
        <button type="button" className="lk" onClick={() => openHistory()}>{tr('看全部跑过的')}<Icon name="chevronRight" size={12} /></button>
      </div>
      {recent.map((it) => (
        <div key={it.id} className="rr" data-hid={it.id}>
          <Icon name={ICON[it.kind]} size={14} />
          <button type="button" className="tx" title={tr('在「跑过的」里看')} onClick={() => openHistory(it.id)}><b>{rowTitle(it)}</b><small>{recentLine(it)}</small></button>
          <button type="button" className="btn sm" onClick={() => replay(it)}><Icon name="play" size={11} /><span className="l">{tr('回放')}</span></button>
        </div>
      ))}
    </div>
  );
}
