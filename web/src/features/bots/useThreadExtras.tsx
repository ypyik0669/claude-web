// 值班 Bot thread: the bot's timeline as the cards ChatView puts between the turns (keyed by entry id). Rebuilt only
// when the bot's timeline, the inbox, its runs or the bot itself change.
import { useMemo } from 'react';
import type { BotRun, BotStatus, BotTimelineEntry } from '@shared';
import type { ChatExtra } from '@/features/chat/ChatView';
import { useBots } from './state';
import { threadRows } from './cards/thread-extras';
import { SystemLine } from './cards/SystemLine';
import { BotRunCard } from './cards/BotRunCard';
import { ApprovalCard } from './cards/ApprovalCard';
import { DraftCard } from './cards/DraftCard';
import { ProposalCard } from './cards/ProposalCard';

const NO_ENTRIES: BotTimelineEntry[] = [];
const NO_RUNS: BotRun[] = [];

export function useThreadExtras(bot: BotStatus | undefined): ChatExtra[] {
  const id = bot?.id ?? '';
  const timeline = useBots((s) => s.timeline[id] ?? NO_ENTRIES);
  const runs = useBots((s) => s.runs[id] ?? NO_RUNS);
  const inbox = useBots((s) => s.inbox);
  return useMemo(() => {
    if (!bot) return [];
    const routines = new Map(bot.routines.map((r) => [r.id, r.name] as const));
    return threadRows(timeline, inbox, runs).map((row) => {
      const e = row.entry;
      let node;
      switch (e.kind) {
        case 'system': node = <SystemLine entry={e} />; break;
        case 'run': node = <BotRunCard entry={e} run={row.run} routineName={routines.get(e.routineId ?? row.run?.routineId ?? '')} />; break;
        case 'approval': node = <ApprovalCard item={row.item!} botName={bot.name} />; break;
        case 'draft': node = <DraftCard item={row.item!} bot={bot} />; break;
        case 'proposal': node = <ProposalCard item={row.item!} />; break;
      }
      return { at: row.at, key: row.key, node };
    });
  }, [bot, timeline, inbox, runs]);
}
