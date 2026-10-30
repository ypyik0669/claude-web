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
import { Inbox } from './Inbox';

/** A phone's first tab: the inbox (spec §6: 手机壳 Bot 分区以收件箱优先). */
const INBOX_TAB = '__inbox';

const stopCreate = () => useBots.setState({ creating: false });

/**
 * 值班 Bot (spec 2026-10-30-duty-bots-design): the page over the main area — the load bar on top, then the bots on
 * the left, the chosen one's detail in the middle, its run on the right. A phone gets one column (the bots as tabs),
 * the inbox first.
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
  const pending = useBots((s) => s.pending);
  // nothing but the manager yet: the empty state with three starter templates
  const firstTime = !bots.some((b) => !b.manager);
  // a phone has the inbox as its first tab — unless there is nothing yet at all (then the starters show)
  const inboxTab = mobile && !(firstTime && !pending);
  const tabs = useMemo(() => {
    const own = botTabs(sorted);
    return inboxTab ? [{ id: INBOX_TAB, label: tr('收件箱'), icon: 'approval' as const, count: pending ? <span className="count">{pending}</span> : undefined }, ...own] : own;
  }, [sorted, inboxTab, pending]);
  // a phone opens on the inbox; picking a bot's tab shows that bot
  const onInbox = useBots((s) => s.phoneInbox);
  const showInbox = inboxTab && onInbox;
  const newBtn = <button className="btn primary" onClick={() => startCreate()}>{tr('新建 Bot')}</button>;
  return (
    <OverPage
      name="bots"
      label={tr('Bot')}
      open={open}
      onClose={closeBots}
      title={tr('Bot')}
      desc={tr('住在你电脑里的值班队友')}
      tab={showInbox ? INBOX_TAB : bot?.id ?? ''}
      tabs={tabs}
      showTabs={mobile && tabs.length > 0}
      onTab={(id) => { useBots.setState({ phoneInbox: id === INBOX_TAB }); if (id !== INBOX_TAB) selectBot(id); }}
      actions={newBtn}
      onEscape={() => { if (useBots.getState().creating) { stopCreate(); return true; } return false; }}
    >
      <LoadBar />
      {showInbox ? (
        <div className="over-body bots-inbox-page"><Inbox empty={tr('收件箱是空的：没有等你批的、也没有新的发现和草稿')} /></div>
      ) : firstTime ? (
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
