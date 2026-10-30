// 值班 Bot (spec 2026-10-30-duty-bots-design): the pure bits the Bot page draws with — labels, order, money, the
// inbox grouped by kind, a routine's monthly cost. No store, no wire.
import type { ActionClass, BotStatus, InboxItem, InboxKind, PolicyLevel, Routine } from '@shared';
import { tr } from '@/i18n';

export function stateLabel(s: BotStatus['state']): string {
  switch (s) {
    case 'idle': return tr('空闲');
    case 'running': return tr('在跑');
    case 'queued': return tr('排队');
    case 'paused': return tr('暂停');
    case 'attention': return tr('需要你');
  }
}

export function usd(n: number): string {
  return `$${(Number.isFinite(n) ? Math.max(0, n) : 0).toFixed(2)}`;
}

const STATE_ORDER: Record<BotStatus['state'], number> = { attention: 0, running: 1, queued: 2, idle: 3, paused: 4 };

/** The manager first, then who needs you, who runs, who waits, who idles, who is paused; by name within each. */
export function sortBots(bots: BotStatus[]): BotStatus[] {
  return [...bots].sort((a, b) =>
    Number(!!b.manager) - Number(!!a.manager)
    || STATE_ORDER[a.state] - STATE_ORDER[b.state]
    || a.name.localeCompare(b.name));
}

export const INBOX_KINDS: InboxKind[] = ['approval', 'finding', 'draft', 'proposal'];

export function inboxKindLabel(k: InboxKind): string {
  switch (k) {
    case 'approval': return tr('待批');
    case 'finding': return tr('发现');
    case 'draft': return tr('草稿');
    case 'proposal': return tr('提议');
  }
}

/** Every kind is there (an empty list when it has nothing), in the order the items came. */
export function groupInbox(items: InboxItem[]): Record<InboxKind, InboxItem[]> {
  const out = { approval: [], finding: [], draft: [], proposal: [] } as Record<InboxKind, InboxItem[]>;
  for (const i of items) out[i.kind]?.push(i);
  return out;
}

export function levelLabel(l: PolicyLevel): string {
  switch (l) {
    case 'do': return tr('直接做');
    case 'do_tell': return tr('做了告诉我');
    case 'ask': return tr('先问我');
    case 'deny': return tr('禁止');
  }
}

export function classLabel(c: ActionClass): string {
  switch (c) {
    case 'read': return tr('读');
    case 'write_local': return tr('写本地');
    case 'browser': return tr('浏览器与电脑');
    case 'send': return tr('对外发送');
    case 'pay': return tr('付款交易');
    case 'delete': return tr('不可恢复删除');
    case 'install': return tr('装东西');
  }
}

const MONTH_MINUTES = 30 * 24 * 60;

/** How often a routine runs in 30 days — approximate: only the minute / hour fields of a cron are looked at. */
export function runsPerMonth(r: Pick<Routine, 'cron' | 'everyMinutes'>): number {
  if (r.everyMinutes && r.everyMinutes > 0) return MONTH_MINUTES / r.everyMinutes;
  if (!r.cron) return 0;
  const [min = '', hour = ''] = r.cron.trim().split(/\s+/);
  const step = (f: string) => { const m = /^\*\/(\d+)$/.exec(f); return m && Number(m[1]) > 0 ? Number(m[1]) : null; };
  if (min === '*') return MONTH_MINUTES;
  const minStep = step(min);
  if (minStep) return MONTH_MINUTES / minStep;
  if (hour === '*') return 30 * 24;
  const hourStep = step(hour);
  if (hourStep) return (30 * 24) / hourStep;
  return 30;
}

export function monthlyEstimate(r: Routine, perRunUsd: number): number {
  return runsPerMonth(r) * perRunUsd;
}
