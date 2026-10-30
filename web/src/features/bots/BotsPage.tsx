import { useMemo } from 'react';
import { useStore } from '@/store';
import { EmptyState } from '@/ui/EmptyState';
import { EMPTY } from '@/ui/terms';
import { OverPage } from '@/features/sections/OverPage';
import { tr } from '@/i18n';
import { sortBots } from './model';
import { botTabs } from './BotsSide';
import { closeBots, selectBot, startCreate, useBots } from './state';
import { LoadBar } from './LoadBar';
import { BotList } from './BotList';
import { BotDetail } from './BotDetail';
import { RunPane } from './RunPane';
import { CreateBot, StarterTemplates } from './CreateBot';

const stopCreate = () => useBots.setState({ creating: false });

/**
 * 值班 Bot (spec 2026-10-30-duty-bots-design): the page over the main area — the load bar on top, then the bots on
 * the left, the chosen one's detail in the middle, its run on the right. A phone gets one column (the bots as tabs).
 */
export function BotsPage() {
  const open = useBots((s) => s.open);
  const bots = useBots((s) => s.bots);
  const selected = useBots((s) => s.selected);
  const tab = useBots((s) => s.tab);
  const creating = useBots((s) => s.creating);
  const mobile = useStore((s) => s.mobile);
  const sorted = useMemo(() => sortBots(bots), [bots]);
  const bot = sorted.find((b) => b.id === selected) ?? sorted[0];
  const tabs = useMemo(() => botTabs(sorted), [sorted]);
  // nothing but the manager yet: the empty state with three starter templates
  const firstTime = !bots.some((b) => !b.manager);
  const newBtn = <button className="btn primary" onClick={() => startCreate()}>{tr('新建 Bot')}</button>;
  return (
    <OverPage
      name="bots"
      label={tr('Bot')}
      open={open}
      onClose={closeBots}
      title={tr('Bot')}
      desc={tr('住在你电脑里的值班队友')}
      tab={bot?.id ?? ''}
      tabs={tabs}
      showTabs={mobile && tabs.length > 0}
      onTab={selectBot}
      actions={newBtn}
      onEscape={() => { if (useBots.getState().creating) { stopCreate(); return true; } return false; }}
    >
      <LoadBar />
      {firstTime ? (
        <div className="over-body bots-empty"><EmptyState e={EMPTY.bots} action={newBtn} /><StarterTemplates /></div>
      ) : (
        <div className="bots-body">
          {!mobile && <BotList bots={sorted} selected={bot?.id} />}
          {bot && <BotDetail bot={bot} tab={tab} />}
          {bot && !mobile && <RunPane bot={bot} />}
        </div>
      )}
      {creating && <CreateBot onClose={stopCreate} />}
    </OverPage>
  );
}
