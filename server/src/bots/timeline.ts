import { randomBytes } from 'node:crypto';
import type { BotRun, BotTimelineEntry, InboxItem } from '../protocol.js';

/**
 * The bot's timeline: what happened around its own conversation (runs finished, approvals asked and answered, system
 * lines). Entries point at runs / inbox items by id; the UI draws them live from those. Pure: the store persists them.
 */

const DETAIL_MAX = 2000;

/** one entry per finished, non-skipped run; the id is stable (`run:<runId>`), so a re-emitted run replaces its entry */
export function entryForRun(run: BotRun, routineName: string): BotTimelineEntry | undefined {
  if (run.skipped || run.endedAt == null) return undefined;
  return { id: `run:${run.id}`, botId: run.botId, at: run.endedAt, kind: 'run', text: routineName, runId: run.id, routineId: run.routineId };
}

/** approval / draft / proposal → an entry carrying the itemId; a finding gets none (its run card carries it) */
export function entryForItem(item: InboxItem): BotTimelineEntry | undefined {
  if (item.kind === 'finding') return undefined;
  const e: BotTimelineEntry = { id: `item:${item.id}`, botId: item.botId, at: item.at, kind: item.kind, itemId: item.id };
  if (item.runId) e.runId = item.runId;
  if (item.routineId) e.routineId = item.routineId;
  return e;
}

export function systemEntry(botId: string, text: string, icon: NonNullable<BotTimelineEntry['icon']>, detail?: string): BotTimelineEntry {
  const at = Date.now();
  const e: BotTimelineEntry = { id: `sys:${at}-${randomBytes(3).toString('hex')}`, botId, at, kind: 'system', text, icon };
  if (detail) e.detail = detail.slice(0, DETAIL_MAX);
  return e;
}

const hm = (at: number) => { const d = new Date(at); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };
const oneLine = (s: string | undefined, max = 200) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
};

function lineFor(e: BotTimelineEntry, items: Map<string, InboxItem>, runs: Map<string, BotRun>): string | undefined {
  if (e.kind === 'system') return e.text ? oneLine(e.text) : undefined;
  if (e.kind === 'run') {
    const r = e.runId ? runs.get(e.runId) : undefined;
    if (!r) return undefined;
    const name = `例行「${e.text ?? r.routineId}」`;
    return r.ok === false ? `${name}失败：${oneLine(r.error ?? r.verified?.note) || '原因未知'}` : `${name}完成：${oneLine(r.said) || '（没有说明）'}`;
  }
  const it = e.itemId ? items.get(e.itemId) : undefined;
  if (!it) return undefined;
  const title = oneLine(it.title);
  const answer = it.done?.answer;
  if (e.kind === 'approval') {
    if (answer === 'approve' || answer === 'approve_scope') return `你批准了：${title}`;
    if (answer === 'reject') return `你拒绝了：${title}`;
    if (answer) return `已关闭（没批准）：${title}${it.done?.note ? `（${oneLine(it.done.note, 80)}）` : ''}`;
    return `等你批准：${title}`;
  }
  if (e.kind === 'draft') {
    if (answer === 'send') return `你发出了草稿：${title}`;
    if (answer) return `草稿没发：${title}`;
    return `草稿等你看：${title}`;
  }
  if (answer === 'adopt') return `你采纳了提议：${title}`;
  if (answer) return `提议没采纳：${title}`;
  return `提议等你看：${title}`;
}

/**
 * The block prepended to the bot's next turn so the model knows what happened since it last spoke. Lists only the
 * entries it is given (the caller picks which are new); '' when none of them has anything to say. For the model only,
 * so it is not translated.
 */
export function eventsBlock(entries: BotTimelineEntry[], items: Map<string, InboxItem>, runs: Map<string, BotRun>): string {
  const lines: string[] = [];
  for (const e of entries) {
    const l = lineFor(e, items, runs);
    if (l) lines.push(`- ${hm(e.at)} ${l}`);
  }
  return lines.length ? `<cw-bot-events>\n${lines.join('\n')}\n</cw-bot-events>\n\n` : '';
}
