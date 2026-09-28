// The sidebar's row model (spec 2026-09-28 §5.1): every row is a title plus ONE status at its end, and the
// 「需要你」 section lists what waits for a human. Pure — no store — so the priorities are unit-tested.
import type { RunnerState, SessionSummary } from '@shared';

export type RowStatusKind = 'confirm' | 'ask' | 'error' | 'running' | 'diff' | 'tag' | 'time';
export interface RowStatus { kind: RowStatusKind; label: string; title: string; added?: number; removed?: number }

export interface RowStatusInput {
  /** the runner state in this window (an open session), else the list's `live` */
  state?: RunnerState | 'history';
  pending?: readonly { toolName: string }[];
  error?: string;
  /** lines changed by the conversation's own edits (known only for a session loaded in this window) */
  diff?: { added: number; removed: number } | null;
  /** gray text instead of the time: a non-Claude agent's name */
  tag?: string | null;
  lastModified: number;
  now?: number;
}

const ASK_TOOLS = new Set(['AskUserQuestion']);

/** Priority: 等确认 > 提问 > 出错 > 运行中 > 改动行数 > agent 名 > 时间. */
export function rowStatus(i: RowStatusInput): RowStatus {
  const pending = i.pending ?? [];
  if (pending.length) {
    const onlyQuestions = pending.every((p) => ASK_TOOLS.has(p.toolName));
    return onlyQuestions
      ? { kind: 'ask', label: '提问', title: 'Claude 在问你一个问题' }
      : { kind: 'confirm', label: '待确认', title: pending.some((p) => p.toolName === 'ExitPlanMode') ? 'Claude 的方案等你确认' : 'Claude 等你确认一个操作' };
  }
  if (i.state === 'waiting') return { kind: 'confirm', label: '待确认', title: '等你确认一个操作' };
  if (i.state === 'error') return { kind: 'error', label: '出错', title: i.error ? `出错：${i.error}` : '进程异常退出' };
  if (i.state === 'running' || i.state === 'starting') return { kind: 'running', label: '运行中', title: i.state === 'starting' ? '启动中' : '运行中' };
  const d = i.diff;
  if (d && d.added + d.removed > 0) return { kind: 'diff', label: `+${d.added} −${d.removed}`, title: `这个对话改动了 +${d.added} −${d.removed} 行`, added: d.added, removed: d.removed };
  const time = shortAgo(i.lastModified, i.now);
  if (i.tag) return { kind: 'tag', label: i.tag, title: `${i.tag} · ${time}` };
  return { kind: 'time', label: time, title: i.lastModified ? new Date(i.lastModified).toLocaleString() : '' };
}

/** 刚刚 / 5 分钟 / 3 小时 / 6 天 / 2 周 / 2/3 (this year) / 2025/11 — short enough for the row's end. */
export function shortAgo(ts: number, now = Date.now()): string {
  if (!ts) return '';
  const d = now - ts;
  if (d < 60_000) return '刚刚';
  if (d < 3600_000) return `${Math.floor(d / 60_000)} 分钟`;
  if (d < 86400_000) return `${Math.floor(d / 3600_000)} 小时`;
  if (d < 7 * 86400_000) return `${Math.floor(d / 86400_000)} 天`;
  if (d < 30 * 86400_000) return `${Math.floor(d / (7 * 86400_000))} 周`;
  const t = new Date(ts), n = new Date(now);
  return t.getFullYear() === n.getFullYear() ? `${t.getMonth() + 1}/${t.getDate()}` : `${t.getFullYear()}/${t.getMonth() + 1}`;
}

export interface OpenLike { state: RunnerState | 'history'; pending: readonly { toolName: string }[]; error?: string }
export interface OrchWait { runId: string; runName: string; nodeId: string; title: string; kind: 'approval' | 'compare'; since?: number }

export type AttentionItem =
  | { kind: 'session'; sessionId: string; title: string; status: RowStatus; summary?: SessionSummary; at: number }
  | { kind: 'orch'; wait: OrchWait };

/** Key an error is dismissed under: the same session failing differently comes back. */
export const dismissKey = (sessionId: string, error?: string) => `${sessionId}:${error ?? ''}`;

/**
 * 「需要你」: sessions with a permission request / question (open here, or `live: 'waiting'` in the list — another
 * window or machine holds it), orchestration nodes waiting for an approval / a pick, and sessions whose process
 * died. Requests first (newest first), then orchestration, then errors. An offline machine's cached 'waiting'
 * can't be answered from here and is left out; a dismissed error hides until its message changes.
 */
export function needsYou(o: { sessions: SessionSummary[]; open: Record<string, OpenLike>; orch: OrchWait[]; dismissed?: ReadonlySet<string> }): AttentionItem[] {
  const byId = new Map(o.sessions.map((s) => [s.sessionId, s]));
  const ids = new Set([...Object.keys(o.open), ...o.sessions.filter((s) => s.live === 'waiting' || s.live === 'error').map((s) => s.sessionId)]);
  const asks: AttentionItem[] = [];
  const errors: AttentionItem[] = [];
  for (const id of ids) {
    const s = byId.get(id);
    if (s?.peer?.offline) continue;
    const op = o.open[id];
    const st = rowStatus({ state: op ? op.state : s?.live, pending: op?.pending, error: op?.error, lastModified: s?.lastModified ?? 0 });
    if (st.kind !== 'confirm' && st.kind !== 'ask' && st.kind !== 'error') continue;
    if (st.kind === 'error' && o.dismissed?.has(dismissKey(id, op?.error))) continue;
    const item: AttentionItem = { kind: 'session', sessionId: id, title: s?.title ?? id.slice(0, 8), status: st, summary: s, at: s ? s.lastModified : Infinity };
    (st.kind === 'error' ? errors : asks).push(item);
  }
  const newest = (a: AttentionItem, b: AttentionItem) => { const x = a.kind === 'session' ? a.at : 0, y = b.kind === 'session' ? b.at : 0; return x === y ? 0 : y > x ? 1 : -1; };
  return [...asks.sort(newest), ...o.orch.map((wait): AttentionItem => ({ kind: 'orch', wait })), ...errors.sort(newest)];
}

/** A group's first `limit` rows, plus the ones beyond the cut that must stay in view (the active / a running one). */
export function pageRows<T>(items: readonly T[], limit: number, keep?: (x: T) => boolean): { rows: T[]; hidden: number } {
  const rows = items.slice(0, limit);
  if (keep) for (const x of items.slice(limit)) if (keep(x)) rows.push(x);
  return { rows, hidden: items.length - rows.length };
}

/** Shift-click: every id between the anchor and the target in on-screen order (just the target without a usable anchor). */
export function rangeIds(order: readonly string[], anchor: string | null, target: string): string[] {
  const a = anchor ? order.indexOf(anchor) : -1, b = order.indexOf(target);
  if (a < 0 || b < 0) return [target];
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/**
 * Today's spend for the account popover, from the ledger (`ledger.list`): this local day's session rows. A session
 * through the model gateway / cache shim has both kinds of row for the same traffic — the gateway rows are left out.
 * An unknown price is counted (「≥ $x」 / 「费用未知」 via `fmtCost`), never added as $0.
 */
export function todayCost(rows: readonly { ts: number; costUsd: number; costUnknown?: boolean; kind?: string; input: number; output: number; cacheRead: number }[], now = Date.now()): { cost: number; unknown: number; calls: number } {
  const d = new Date(now);
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  let cost = 0, unknown = 0, calls = 0;
  for (const r of rows) {
    if (r.ts < midnight || r.ts > now || r.kind === 'gateway') continue;
    calls++;
    if (r.costUnknown) { if (r.input || r.output || r.cacheRead) unknown++; }
    else cost += r.costUsd;
  }
  return { cost, unknown, calls };
}

/** Subscription type as people say it (`limits.subscriptionType` / `claude auth status`). */
export function planLabel(t: string | undefined | null): string {
  if (!t) return '';
  const k = t.toLowerCase();
  if (k === 'max') return 'Max 套餐';
  if (k === 'pro') return 'Pro 套餐';
  if (k === 'team') return 'Team 套餐';
  if (k === 'enterprise') return 'Enterprise';
  return t;
}

/** The account row's name and avatar letter from `config.auth` (claude auth status); no login → what can be used instead. */
export function accountName(auth: { loggedIn?: boolean; email?: string; orgName?: string } | null, providers: number): { name: string; initial: string; signedIn: boolean } {
  if (!auth) return { name: '账号', initial: '', signedIn: false };
  if (auth.loggedIn) {
    const name = auth.email?.split('@')[0] || auth.orgName || 'Claude 账号';
    return { name, initial: name.slice(0, 1).toUpperCase(), signedIn: true };
  }
  return { name: providers ? `${providers} 个供应商` : '未登录', initial: '', signedIn: false };
}
