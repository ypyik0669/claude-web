import { Icon } from '@/ui/icons';
import { dlg } from '@/ui/dialog';
import { tr } from '@/i18n';
import { usd } from './model';
import { stopAll, useBots } from './state';

/** The page's top line: what runs, what waits, what today and this week cost — and 全部停. */
export function LoadBar() {
  const load = useBots((s) => s.load);
  const stop = async () => { if (await dlg.confirm(tr('停下所有 Bot？'))) void stopAll(); };
  return (
    <div className="bots-load" role="status">
      <span className="bl-text">{tr('在跑 {running} · 排队 {queued} · 今天 {today} · 本周 {week}', { running: load.running, queued: load.queued, today: usd(load.todayUsd), week: usd(load.weekEstimateUsd) })}</span>
      <span className="grow" />
      <button className="btn sm" title={tr('全部停')} onClick={() => void stop()}><Icon name="stop" size={12} /><span className="l">{tr('全部停')}</span></button>
    </div>
  );
}
