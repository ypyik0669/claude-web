// 值班 Bot 名册（spec 2026-10-31 聊天优先 §1）: the pure bits of the roster — the search box, the groups it draws, the
// time on the right of a row. No store, no wire.
import type { BotStatus, InboxItem } from '@shared';
import { dateLocale, tr } from '@/i18n';
import { rosterGroups } from './model';

/** Bots whose name or 职位 has the query (case-insensitive); an empty query is the same array. */
export function searchBots(bots: BotStatus[], q: string): BotStatus[] {
  const k = q.trim().toLowerCase();
  if (!k) return bots;
  return bots.filter((b) => b.name.toLowerCase().includes(k) || (b.title ?? '').toLowerCase().includes(k));
}

export interface RosterView extends ReturnType<typeof rosterGroups> {
  /** rows outside the hidden group (the manager counted) */
  shown: number;
  hiddenCount: number;
}

/** The roster's groups after the search: 需要你 first (never a hidden bot), the rest, the manager ★, the hidden ones. */
export function rosterView(bots: BotStatus[], inbox: InboxItem[], q: string): RosterView {
  const g = rosterGroups(searchBots(bots, q), inbox);
  return { ...g, shown: g.attention.length + g.rest.length + (g.manager ? 1 : 0), hiddenCount: g.hidden.length };
}

const dayStart = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** The time on a row: today → 9:41, yesterday → 昨天, earlier → the date; none → ''. */
export function rowTime(at: number | undefined, now = Date.now()): string {
  if (!at) return '';
  const today = dayStart(now);
  if (at >= today) return new Date(at).toLocaleTimeString(dateLocale(), { hour: 'numeric', minute: '2-digit' });
  if (at >= dayStart(today - 1)) return tr('昨天');
  return new Date(at).toLocaleDateString(dateLocale(), { month: 'numeric', day: 'numeric' });
}
