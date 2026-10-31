// 值班 Bot (spec 2026-10-30-duty-bots-design): the pure bits the Bot page draws with — labels, order, money, the
// inbox grouped by kind, a routine's monthly cost. No store, no wire.
import type { ActionClass, BotRun, BotStatus, InboxItem, InboxKind, PolicyLevel, Routine } from '@shared';
import { tr } from '@/i18n';
import { scheduleText } from '@/features/automation/schedule-text';

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

/** a run's cost; an estimate (the model had no known price, its tokens were counted at a Sonnet-class price) says 约 */
export function runCost(run: Pick<BotRun, 'costUsd' | 'costEstimated'>): string {
  const n = usd(run.costUsd ?? 0);
  return run.costEstimated ? tr('约 {usd}', { usd: n }) : n;
}

// ---- the roster (chat-first redesign) ----

/** How many items wait for an answer, per bot (bots with none are left out). */
export function pendingByBot(inbox: InboxItem[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of inbox) if (!i.done) out[i.botId] = (out[i.botId] ?? 0) + 1;
  return out;
}

/** A roster row's state dot: needs you (amber + count) > error > working (the avatar moves) > something new (blue) > idle. */
export function rowState(b: BotStatus): 'attention' | 'fresh' | 'working' | 'error' | 'idle' {
  if (b.state === 'attention' || b.pendingInbox > 0) return 'attention';
  if (b.error) return 'error';
  if (b.state === 'running' || b.state === 'queued') return 'working';
  if (b.unseen > 0) return 'fresh';
  return 'idle';
}

/** Pinned first, then the latest line, then by name. */
const rosterOrder = (a: BotStatus, b: BotStatus) =>
  Number(!!b.pinned) - Number(!!a.pinned)
  || (b.lastLine?.at ?? 0) - (a.lastLine?.at ?? 0)
  || a.name.localeCompare(b.name);

/**
 * The roster's groups: who needs you (it says so, or has an open inbox item), the rest, the hidden ones (folded at
 * the bottom; even when they need you — they don't notify), and the manager (★) apart.
 */
export function rosterGroups(bots: BotStatus[], inbox: InboxItem[]): { attention: BotStatus[]; rest: BotStatus[]; hidden: BotStatus[]; manager?: BotStatus } {
  const waiting = pendingByBot(inbox);
  const attention: BotStatus[] = [], rest: BotStatus[] = [], hidden: BotStatus[] = [];
  let manager: BotStatus | undefined;
  for (const b of bots) {
    if (b.manager && !manager) manager = b;
    else if (b.hidden) hidden.push(b);
    else if (rowState(b) === 'attention' || waiting[b.id]) attention.push(b);
    else rest.push(b);
  }
  return { attention: attention.sort(rosterOrder), rest: rest.sort(rosterOrder), hidden: hidden.sort(rosterOrder), manager };
}

/** A row's second line: what waits for you, else the last thing it said, else its 职位. */
export function lastLineOf(b: BotStatus, pendingForBot: number): string {
  if (pendingForBot > 0) return tr('{n} 件事等你点头', { n: pendingForBot });
  return b.lastLine?.text || b.title || '';
}

/** A routine's rhythm in words (工作日 07:30 · 每小时); a cron that has no words reads as itself; none → ''. */
export function cadenceText(r: Pick<Routine, 'cron' | 'everyMinutes'>): string {
  if (r.cron?.trim()) return scheduleText({ cron: r.cron.trim(), everyMinutes: 0 }).text;
  if (r.everyMinutes && r.everyMinutes > 0) return scheduleText({ everyMinutes: r.everyMinutes }).text;
  return '';
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
    case 'deny': return tr('不许');
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

export const MONTH_MINUTES = 30 * 24 * 60;

/**
 * How many values one cron field takes in [lo, hi]: `*`, `n`, `a-b`, `a,b,…`, and a `/step` on `*`, a range or a
 * start (`5/15` = 5 to hi). null when it can't be read.
 */
export function cronFieldCount(f: string, lo: number, hi: number): number | null {
  return cronFieldValues(f, lo, hi)?.size ?? null;
}

function cronFieldValues(f: string, lo: number, hi: number): Set<number> | null {
  const seen = new Set<number>();
  for (const part of f.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) return null;
    const step = m[2] !== undefined ? Number(m[2]) : 1;
    if (!(step >= 1)) return null;
    let a = lo, b = hi;
    if (m[1] !== '*') {
      const [x, y] = m[1].split('-').map(Number);
      a = x; b = y ?? (m[2] !== undefined ? hi : x);
    }
    if (a < lo || b > hi || a > b) return null;
    for (let v = a; v <= b; v += step) seen.add(v);
  }
  return seen;
}

/**
 * How often a routine runs in 30 days. A cron: its minute × hour values a day, times the share of days its
 * day-of-month and day-of-week fields leave (both restricted: either one matches, as cron does). Unreadable → 30.
 */
export function runsPerMonth(r: Pick<Routine, 'cron' | 'everyMinutes'>): number {
  if (r.everyMinutes && r.everyMinutes > 0) return MONTH_MINUTES / r.everyMinutes;
  if (!r.cron) return 0;
  const [min = '', hour = '', dom = '*', , dow = '*'] = r.cron.trim().split(/\s+/);
  const mins = cronFieldCount(min, 0, 59);
  const hours = cronFieldCount(hour, 0, 23);
  if (mins === null || hours === null) return 30;
  // day of week 0–7: 0 and 7 are both Sunday (counted once)
  const dowVals = cronFieldValues(dow, 0, 7);
  const dowN = dowVals ? new Set([...dowVals].map((d) => d % 7)).size : null;
  const domN = cronFieldCount(dom, 1, 31);
  const domShare = dom === '*' || domN === null ? 1 : Math.min(1, domN / 30);
  const dowShare = dow === '*' || dowN === null ? 1 : dowN / 7;
  const dayShare = dom !== '*' && dow !== '*' ? Math.min(1, domShare + dowShare - domShare * dowShare) : domShare * dowShare;
  return mins * hours * 30 * dayShare;
}

export function monthlyEstimate(r: Routine, perRunUsd: number): number {
  return runsPerMonth(r) * perRunUsd;
}

/** What one model wake-up costs, roughly — the month estimate of a routine. */
export const PER_RUN_USD = 0.05;
