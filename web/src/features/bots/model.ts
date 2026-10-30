// 值班 Bot (spec 2026-10-30-duty-bots-design): the pure bits the Bot page draws with — labels, order, money, the
// inbox grouped by kind, a routine's monthly cost. No store, no wire.
import type { ActionClass, BotDraft, BotOutput, BotStatus, BotTemplate, InboxItem, InboxKind, PolicyLevel, Routine } from '@shared';
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

// ---- the create flow (Task 18) ----

/** What one model wake-up costs, roughly — the month estimate of the create preview. */
export const PER_RUN_USD = 0.05;
/** A generated routine never wakes more often than this (the server's generate clamps the same). */
export const MIN_EVERY_MINUTES = 15;

/** Wakes more often than once an hour: the preview shows its month estimate. */
export function fasterThanHourly(r: Pick<Routine, 'cron' | 'everyMinutes'>): boolean {
  return runsPerMonth(r) > 30 * 24;
}

/**
 * A draft as the preview edits it: every routine complete (id may stay '' — the server mints it), every interval at
 * least MIN_EVERY_MINUTES (`clamped` says one was raised), the inbox always among the outputs.
 */
export function normalizeDraft(d: BotDraft['bot']): { draft: BotDraft['bot']; clamped: boolean } {
  let clamped = false;
  const routines = (d.routines ?? []).map((r) => {
    let everyMinutes = r.everyMinutes;
    if (everyMinutes !== undefined && everyMinutes > 0 && everyMinutes < MIN_EVERY_MINUTES) { everyMinutes = MIN_EVERY_MINUTES; clamped = true; }
    return { ...r, id: r.id ?? '', name: r.name ?? '', prompt: r.prompt ?? '', enabled: r.enabled ?? true, onFail: r.onFail ?? 'inbox', acceptance: r.acceptance ?? { kind: 'none' }, everyMinutes } as Routine;
  });
  const outputs: BotOutput[] = (d.outputs ?? []).some((o) => o.kind === 'inbox') ? d.outputs : [{ kind: 'inbox' }, ...(d.outputs ?? [])];
  const charter = { ...d.charter, role: d.charter?.role ?? '', sources: Array.isArray(d.charter?.sources) ? d.charter.sources : [] };
  return {
    draft: { ...d, name: d.name ?? '', cwd: d.cwd ?? '', tier: d.tier ?? 'balanced', policy: d.policy ?? { rules: [] }, budget: d.budget ?? {}, charter, routines, outputs },
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
    if (!r.prompt.trim()) return tr('写一下例行「{name}」要做什么', { name: r.name || '?' });
    if (r.cron !== undefined && !r.everyMinutes && r.cron.trim().split(/\s+/).length !== 5) return tr('cron 要五段：分 时 日 月 周');
    if (r.everyMinutes !== undefined && !(r.everyMinutes >= 1)) return tr('间隔至少 1 分钟');
  }
  return null;
}

/** The text of the latest prompt the user typed in a conversation (not a meta one, not one from another conversation). */
export function lastUserText(items: readonly { kind: string; text?: string; meta?: boolean; from?: unknown }[]): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === 'user' && !it.meta && !it.from && it.text?.trim()) return it.text.trim();
  }
  return '';
}
