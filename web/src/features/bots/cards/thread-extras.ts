// 值班 Bot thread: which timeline entries draw a card between the messages, and what each card draws from. Pure.
import type { BotRun, BotTimelineEntry, InboxItem } from '@shared';

export interface ThreadRow {
  key: string; at: number; entry: BotTimelineEntry;
  /** approval / draft / proposal: the inbox item, live */
  item?: InboxItem;
  /** run: the run, when it is loaded (else the card says the routine name and waits for the push) */
  run?: BotRun;
}

/**
 * The timeline as rows, oldest first. A card about an inbox item the inbox here doesn't have (pruned, or another
 * server's) is left out: it would have nothing to show and no answer to send.
 */
export function threadRows(entries: readonly BotTimelineEntry[], inbox: readonly InboxItem[], runs: readonly BotRun[]): ThreadRow[] {
  const items = new Map(inbox.map((i) => [i.id, i] as const));
  const byRun = new Map(runs.map((r) => [r.id, r] as const));
  const out: ThreadRow[] = [];
  for (const entry of entries) {
    const row: ThreadRow = { key: entry.id, at: entry.at, entry };
    if (entry.kind === 'approval' || entry.kind === 'draft' || entry.kind === 'proposal') {
      const item = entry.itemId ? items.get(entry.itemId) : undefined;
      if (!item) continue;
      row.item = item;
    } else if (entry.kind === 'run' && entry.runId) {
      row.run = byRun.get(entry.runId);
    }
    out.push(row);
  }
  return out.sort((a, b) => a.at - b.at);
}
