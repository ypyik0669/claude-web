import { useMemo } from 'react';
import type { BotStatus } from '@shared';
import { SectionSide } from '@/features/sections/SectionSide';
import type { OverTab } from '@/features/sections/OverPage';
import { Icon } from '@/ui/icons';
import { tr } from '@/i18n';
import { sortBots, stateLabel } from './model';
import { selectBot, useBots } from './state';

/** One row per bot — the page's tabs on a phone, the section sidebar's rows on a desktop (BotsSide). */
export function botTabs(sorted: BotStatus[]): OverTab[] {
  return sorted.map((b) => ({ id: b.id, label: b.name, icon: 'bot', count: b.pendingInbox ? <span className="count">{b.pendingInbox}</span> : undefined, title: stateLabel(b.state) }));
}

/** The sidebar while the Bot page is in front: one row per bot (the waiting inbox items as a count), and 新建. */
export function BotsSide() {
  const bots = useBots((s) => s.bots);
  const selected = useBots((s) => s.selected);
  const sorted = useMemo(() => sortBots(bots), [bots]);
  const tabs = useMemo(() => botTabs(sorted), [sorted]);
  return (
    <SectionSide
      name="bots"
      title={tr('Bot')}
      tab={selected ?? sorted[0]?.id ?? ''}
      tabs={tabs}
      onTab={selectBot}
      action={<button className="icon-btn" title={tr('新建 Bot')} aria-label={tr('新建 Bot')} onClick={() => useBots.setState({ creating: true })}><Icon name="plus" size={16} /></button>}
    />
  );
}
