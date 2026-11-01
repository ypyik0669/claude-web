// What a conversation's history is sent to a window as (transcript.load). Pure.
//
// The line under each answer (time · steps · cost · tokens · cache) comes from the turn's `result`, and Claude Code
// writes no result lines into its transcript: every turn that did not run in this window had none (2026-10-14, a
// user's friend: 「有些又不显示」). `withTurnStats` puts one at the end of each finished turn — from the ledger when it
// recorded the turn (what the live line said), else from the answers' own usage (no cost then).
//
// A long conversation is several MB, and a phone on the slow relay sat minutes on 「加载历史…」 for one. `pageOf`
// cuts the newest page at a turn's start; the window asks for the rest with 「加载更早的记录」.
import type { LedgerEntry } from '../protocol.js';

type Msg = any;

const TAG_META = /^<(command-name|local-command|system-reminder|task-notification)/;

function text(m: Msg): string {
  const c = m?.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b: any) => (b?.type === 'text' ? b.text : '')).join('');
  return '';
}

const onlyToolResults = (m: Msg) => Array.isArray(m?.message?.content) && m.message.content.length > 0 && m.message.content.every((b: any) => b?.type === 'tool_result');

/**
 * A message the chat starts a turn at: one a person typed (the window's reducer keeps meta lines — reminders, command
 * output, task notifications — inside the turn they came in, and so does this).
 */
export function startsTurn(m: Msg): boolean {
  if (m?.type !== 'user' || m.parent_tool_use_id) return false;
  if (m.isMeta || m.is_meta || m.isSynthetic || m.isCompactSummary) return false;
  if (onlyToolResults(m)) return false;
  return !TAG_META.test(text(m).trim());
}

const tsOf = (m: Msg): number => {
  const t = typeof m?.timestamp === 'string' ? Date.parse(m.timestamp) : NaN;
  return Number.isNaN(t) ? NaN : t;
};

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The ledger rows of a session that are turns (not a retry). */
export const turnRows = (rows: LedgerEntry[]) => rows.filter((r) => !/^retry\b/.test(r.error ?? '') && r.model !== '');

/**
 * `msgs` with a `result` (marked `cw_history`) after each finished turn. `live`: the conversation is running here —
 * its last turn is not finished. A turn's last answer that stopped for a tool call and has no ledger row (cut off,
 * or a message typed into it while it ran) gets none.
 */
export function withTurnStats(msgs: Msg[], rows: LedgerEntry[], opts: { live?: boolean } = {}): Msg[] {
  const starts: number[] = [];
  msgs.forEach((m, i) => { if (startsTurn(m)) starts.push(i); });
  if (!starts.length) return msgs;
  const turns = turnRows(rows).slice().sort((a, b) => a.ts - b.ts);
  const out: Msg[] = msgs.slice(0, starts[0]);
  for (let k = 0; k < starts.length; k++) {
    const from = starts[k];
    const to = k + 1 < starts.length ? starts[k + 1] : msgs.length;
    const part = msgs.slice(from, to);
    out.push(...part);
    const last = k === starts.length - 1;
    if (last && opts.live) continue;
    const prompt = msgs[from];
    const answers = part.filter((m) => m.type === 'assistant' && !m.parent_tool_use_id && m.message);
    if (!answers.length) continue;
    const t0 = tsOf(prompt);
    const t1 = to < msgs.length ? tsOf(msgs[to]) : Infinity;
    const mine = Number.isNaN(t0) ? [] : turns.filter((r) => r.ts >= t0 && r.ts < t1);
    const end = answers[answers.length - 1];
    if (!mine.length && end.message.stop_reason === 'tool_use') continue;
    const result: Msg = {
      type: 'result',
      subtype: 'success',
      uuid: `cw-turn-${prompt.uuid ?? from}`,
      session_id: prompt.session_id,
      is_error: false,
      duration_api_ms: 0,
      timestamp: end.timestamp,
      cw_history: true,
    };
    if (mine.length) {
      result.duration_ms = mine.reduce((n, r) => n + num(r.durationMs), 0);
      // the model time, for tok/s (rows before 2026-10-17 hold the process's running total: the page sees it is more
      // than the turn took and counts the whole turn instead)
      result.duration_api_ms = mine.reduce((n, r) => n + num(r.apiMs), 0);
      result.num_turns = mine.reduce((n, r) => n + (num(r.turns) || 1), 0);
      result.total_cost_usd = mine.reduce((n, r) => n + num(r.costUsd), 0);
      if (mine.some((r) => r.costUnknown)) result.cost_unknown = true;
      result.usage = {
        input_tokens: mine.reduce((n, r) => n + num(r.input), 0),
        cache_read_input_tokens: mine.reduce((n, r) => n + num(r.cacheRead), 0),
        cache_creation_input_tokens: mine.reduce((n, r) => n + num(r.cacheWrite), 0),
        output_tokens: mine.reduce((n, r) => n + num(r.output), 0),
      };
    } else {
      // one API call per message id (its blocks come as several entries; the last one has the final usage)
      const calls = new Map<string, any>();
      for (const a of answers) calls.set(a.message.id ?? a.uuid, a.message.usage);
      const usage = { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 };
      let cacheKnown = false;
      for (const u of calls.values()) {
        if (!u) continue;
        usage.input_tokens += num(u.input_tokens);
        usage.output_tokens += num(u.output_tokens);
        if ('cache_read_input_tokens' in u || 'cache_creation_input_tokens' in u) cacheKnown = true;
        usage.cache_read_input_tokens += num(u.cache_read_input_tokens);
        usage.cache_creation_input_tokens += num(u.cache_creation_input_tokens);
      }
      const span = tsOf(end) - t0;
      result.duration_ms = Number.isNaN(span) || span < 0 ? 0 : span;
      result.num_turns = calls.size;
      result.total_cost_usd = 0;
      result.cost_unknown = true;
      result.cw_cost_absent = true;
      result.usage = cacheKnown ? usage : { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens };
    }
    out.push(result);
  }
  return out;
}

/** The page sizes (JSON bytes): a window on this machine, and one over the network (a phone, maybe on the relay). */
export const LOCAL_PAGE_BYTES = 8 * 1024 * 1024;
export const REMOTE_PAGE_BYTES = 768 * 1024;

/** `<index>:<uuid>` — the uuid finds the place again when the list before it changed (a compaction). */
function cursorOf(msgs: Msg[], at: number): string {
  return `${at}:${msgs[at]?.uuid ?? ''}`;
}
function endOf(msgs: Msg[], cursor: string | undefined): number {
  if (!cursor) return msgs.length;
  const sep = cursor.indexOf(':');
  const at = Number(sep < 0 ? cursor : cursor.slice(0, sep));
  const uuid = sep < 0 ? '' : cursor.slice(sep + 1);
  if (uuid) {
    if (msgs[at]?.uuid === uuid) return at;
    // gone from the list: nothing older to give
    const found = msgs.findIndex((m) => m?.uuid === uuid);
    return found >= 0 ? found : 0;
  }
  // not a cursor of ours: nothing older — never the newest page again (the window would put it in twice)
  return Number.isInteger(at) && at >= 0 && at <= msgs.length ? at : 0;
}

/** Where a new API call starts: an answer after a tool result (cutting there keeps every tool call with its result). */
const startsCall = (msgs: Msg[], i: number) => msgs[i]?.type === 'assistant' && !msgs[i].parent_tool_use_id && i > 0 && msgs[i - 1]?.type === 'user';

/**
 * The page of `msgs` that ends before `cursor` (none = the newest), about `budget` bytes, starting at a turn: the
 * whole newest turn even past the budget (up to 4×), past that at the start of an API call. `next`: the cursor of the
 * page before it (none = this is the oldest).
 */
export function pageOf(msgs: Msg[], cursor: string | undefined, budget: number): { messages: Msg[]; next?: string } {
  const end = endOf(msgs, cursor);
  let acc = 0;
  let over = -1;
  for (let i = end - 1; i >= 0; i--) {
    acc += JSON.stringify(msgs[i] ?? null).length;
    if (acc > budget) { over = i; break; }
  }
  if (over < 0) return { messages: msgs.slice(0, end) };
  let start = -1;
  for (let i = over + 1; i < end; i++) if (startsTurn(msgs[i])) { start = i; break; }
  if (start < 0) {
    // the newest turn alone is over the budget
    let turn = -1;
    for (let i = over; i >= 0; i--) if (startsTurn(msgs[i])) { turn = i; break; }
    let size = 0;
    if (turn >= 0) for (let i = turn; i < end && size <= budget * 4; i++) size += JSON.stringify(msgs[i] ?? null).length;
    if (turn >= 0 && size <= budget * 4) start = turn;
    else {
      for (let i = over + 1; i < end; i++) if (startsCall(msgs, i)) { start = i; break; }
      if (start < 0) start = Math.min(end - 1, over + 1);
    }
  }
  start = Math.max(0, start);
  return { messages: msgs.slice(start, end), ...(start > 0 ? { next: cursorOf(msgs, start) } : {}) };
}
