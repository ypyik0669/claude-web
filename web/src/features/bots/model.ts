// 值班 Bot (spec 2026-10-30-duty-bots-design): the pure bits the Bot page draws with — labels, order, money, the
// inbox grouped by kind, a routine's monthly cost. No store, no wire.
import type { ActionClass, BotDraft, BotGenerated, BotOutput, BotStatus, BotTemplate, BotTier, InboxItem, InboxKind, PolicyLevel, Routine } from '@shared';
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

// ---- the create flow (Task 18) ----

/** What one model wake-up costs, roughly — the month estimate of the create preview. */
export const PER_RUN_USD = 0.05;
/** A generated routine never wakes more often than this (the server's generate clamps the same). */
export const MIN_EVERY_MINUTES = 15;

/** Wakes more often than once an hour: the preview shows its month estimate. */
export function fasterThanHourly(r: Pick<Routine, 'cron' | 'everyMinutes'>): boolean {
  return runsPerMonth(r) > 30 * 24;
}

/** Wakes more often than every MIN_EVERY_MINUTES: the preview warns (a generated draft never asks for that). */
export function underMinimum(r: Pick<Routine, 'cron' | 'everyMinutes'>): boolean {
  return runsPerMonth(r) > MONTH_MINUTES / MIN_EVERY_MINUTES;
}

/**
 * A draft as the preview edits it: every routine complete (id may stay '' — the server mints it), the inbox always
 * among the outputs. `clamped`: the routines whose interval was raised to MIN_EVERY_MINUTES — named by the server's
 * bots.generate (it clamps first), plus any this still finds under it (an older server); the wire field is dropped.
 */
export function normalizeDraft(g: BotGenerated, defaultTier: BotTier = 'balanced'): { draft: BotDraft['bot']; clamped: string[] } {
  const { clamped: named, ...d } = g;
  const clamped = Array.isArray(named) ? named.map(String) : [];
  const routines = (d.routines ?? []).map((r) => {
    let everyMinutes = r.everyMinutes;
    if (everyMinutes !== undefined && everyMinutes > 0 && everyMinutes < MIN_EVERY_MINUTES) { everyMinutes = MIN_EVERY_MINUTES; if (!clamped.includes(r.name)) clamped.push(r.name ?? ''); }
    return { ...r, id: r.id ?? '', name: r.name ?? '', prompt: r.prompt ?? '', enabled: r.enabled ?? true, onFail: r.onFail ?? 'inbox', acceptance: r.acceptance ?? { kind: 'none' }, everyMinutes } as Routine;
  });
  const outputs: BotOutput[] = (d.outputs ?? []).some((o) => o.kind === 'inbox') ? d.outputs : [{ kind: 'inbox' }, ...(d.outputs ?? [])];
  const charter = { ...d.charter, role: d.charter?.role ?? '', sources: Array.isArray(d.charter?.sources) ? d.charter.sources : [] };
  return {
    draft: { ...d, name: d.name ?? '', cwd: d.cwd ?? '', tier: d.tier ?? defaultTier, policy: d.policy ?? { rules: [] }, budget: d.budget ?? {}, charter, routines, outputs },
    clamped,
  };
}

/** A template as a draft in `cwd`. */
export function draftFromTemplate(t: BotTemplate, cwd: string): BotDraft['bot'] {
  return normalizeDraft({ ...t.bot, cwd }).draft;
}

/** What is wrong with a draft before it can be created, or null. */
export function draftProblem(d: BotDraft['bot']): string | null {
  if (!d.name.trim()) return tr('Bot 需要一个名字');
  if (!d.cwd.trim()) return tr('选一个工作目录');
  if (!d.charter.role.trim()) return tr('写一下它的职责');
  for (const r of d.routines) {
    const name = r.name || '?';
    if (!r.prompt.trim()) return tr('写一下例行「{name}」要做什么', { name });
    if (r.everyMinutes !== undefined) {
      if (!(Number.isInteger(r.everyMinutes) && r.everyMinutes >= 1)) return tr('例行「{name}」的间隔要是至少 1 的整数分钟', { name });
    } else if (r.cron?.trim()) {
      if (r.cron.trim().split(/\s+/).length !== 5) return tr('例行「{name}」的 cron 要五段：分 时 日 月 周', { name });
    } else return tr('例行「{name}」还没定节奏', { name });
  }
  for (const o of d.outputs) {
    if (o.kind === 'file' && !isAbsolutePath(o.path)) return tr('写到文件要填完整路径（从盘符或 / 开始）');
  }
  return null;
}

/** C:\x, C:/x, \\server\x, /x — not ~/x: the server takes the path as typed (path.isAbsolute) and refuses that */
export const isAbsolutePath = (p: string): boolean => /^(?:[a-zA-Z]:[\\/]|[\\/])/.test(p.trim());

/** The text of the latest prompt the user typed in a conversation (not a meta one, not one from another conversation). */
export function lastUserText(items: readonly { kind: string; text?: string; meta?: boolean; from?: unknown }[]): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === 'user' && !it.meta && !it.from && it.text?.trim()) return it.text.trim();
  }
  return '';
}
