// 后台 · 网吧: the snapshot of every conversation's background (`background.changed`) as an internet cafe. A zone (区)
// is a conversation with background work: a row of PCs; its lead (the main conversation) is the zone's 网管 behind the
// front counter; every sub-agent / workflow agent is a customer at a PC (working / waiting / stuck), wandering off to
// the lounge (resting) or checking out and leaving (finished); a background command is a machine in a glass private
// room (包间). Pure — no store, no three.js — so node tests can import it.
import type { BgAgent, BgEvent, BgSession, BgTask } from '@shared';
import { sortSessions, taskTitle } from '@/features/background/model';
import { estimateUsd } from '@/features/cafe/money';
import { tr } from '@/i18n';

export type BotStatus = 'working' | 'waiting' | 'stuck' | 'resting' | 'finished';
/** The default figure's shape: sphere, cone, cube, capsule, star (the lead). */
export type BotShape = 0 | 1 | 2 | 3 | 4;

export interface OfficeBot {
  /** Unique in the building: `<sessionId>|lead`, `<sessionId>|<taskId>|<agentKey>`, `<sessionId>|<taskId>|shell`. */
  id: string;
  sessionId: string;
  taskId?: string;
  agentKey?: string;
  lead?: boolean;
  shell?: boolean;
  name: string;
  /** sub-agent type (for the character assignment); none for workflow agents and commands */
  type?: string;
  /** 1…10: --agent-n; 0: grey (a command) */
  color: number;
  shape: BotShape;
  status: BotStatus;
  /** what it is doing / why it waits / why it is stuck, in a line */
  line: string;
  task?: string;
  phase?: string;
  startedAt?: number;
  endedAt?: number;
  tokens?: number;
  toolCalls?: number;
  model?: string;
  usd?: number;
}

export interface OfficeZone {
  sessionId: string;
  /** 1 = the first zone (A区) */
  number: number;
  /** A, B, C … */
  letter: string;
  name: string;
  /** the zone's colour, 1…10 like the agents' */
  color: number;
  bots: OfficeBot[];
  working: number;
  waiting: number;
  stuck: number;
  done: number;
  total: number;
  live: boolean;
}

export interface WaitCard {
  key: string;
  sessionId: string;
  zone: number;
  botId: string;
  name: string;
  zoneName: string;
  kind: 'ask' | 'stuck';
  reason: string;
  /** a permission request this window can answer (allow / deny) */
  requestId?: string;
  question?: boolean;
}

export interface OfficeModel {
  zones: OfficeZone[];
  /** conversations with background work beyond the zones shown */
  more: number;
  counts: Record<'working' | 'waiting' | 'stuck' | 'resting', number>;
  /** ≈ USD of what the bots used (Claude models only), and whether some had no price */
  usd: number;
  unpriced: boolean;
  waiting: WaitCard[];
  finished: OfficeBot[];
  activity: (BgEvent & { sessionId: string; zone: number })[];
}

/** What the cafe needs of a conversation's own state (store `open[sid]`). */
export interface LeadInfo { state?: string; pending?: { requestId: string; toolName: string }[]; error?: string }

export const MAX_ZONES = 8;
export const zoneLetter = (n: number) => String.fromCharCode(64 + Math.max(1, Math.min(26, n)));

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export const shapeOf = (key: string): BotShape => (hash(key) % 4) as BotShape;

function agentStatus(a: BgAgent): BotStatus {
  switch (a.state) {
    case 'running': return 'working';
    case 'failed': return 'stuck';
    case 'done': return 'finished';
    default: return 'resting';
  }
}

function taskStatus(t: BgTask): BotStatus {
  return t.status === 'running' ? 'working' : t.status === 'failed' ? 'stuck' : t.status === 'completed' ? 'finished' : 'resting';
}

const firstLine = (s: string | undefined) => (s ?? '').split('\n')[0].trim();
const cut = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function statusWord(s: BotStatus): string {
  switch (s) {
    case 'working': return tr('在干活');
    case 'waiting': return tr('等你');
    case 'stuck': return tr('卡住了');
    case 'finished': return tr('完成');
    case 'resting': return tr('歇着');
  }
}

function botLine(status: BotStatus, o: { summary?: string; tool?: string; error?: string; reason?: string; queued?: boolean; stopped?: boolean }): string {
  switch (status) {
    case 'working': return cut(firstLine(o.summary) || (o.tool ? tr('在用 {tool}', { tool: o.tool }) : tr('在干活')));
    case 'stuck': return cut(firstLine(o.error) || firstLine(o.reason) || tr('失败了'));
    case 'finished': return cut(firstLine(o.summary) || tr('完成'));
    case 'waiting': return cut(firstLine(o.reason) || tr('等你确认'));
    default: return o.queued ? tr('排队') : o.stopped ? tr('已停止') : tr('歇着');
  }
}

function leadOf(sid: string, info: LeadInfo | undefined): OfficeBot {
  const p = info?.pending?.[0];
  const status: BotStatus = p || info?.state === 'waiting' ? 'waiting' : info?.state === 'running' || info?.state === 'starting' ? 'working' : info?.state === 'error' ? 'stuck' : 'resting';
  const reason = p ? (p.toolName === 'AskUserQuestion' ? tr('有问题要问你') : tr('等你确认：{tool}', { tool: p.toolName })) : undefined;
  return {
    id: `${sid}|lead`, sessionId: sid, lead: true, name: tr('前台网管'), color: 1, shape: 4, status,
    line: status === 'working' ? tr('主对话在回答') : botLine(status, { reason, error: info?.error }),
  };
}

function botsOf(s: BgSession, lead: OfficeBot): OfficeBot[] {
  const out: OfficeBot[] = [lead];
  for (const t of s.tasks) {
    if (t.kind === 'shell' || (!t.agents.length && t.kind !== 'workflow')) {
      const st = taskStatus(t);
      out.push({
        id: `${s.sessionId}|${t.id}|shell`, sessionId: s.sessionId, taskId: t.id, shell: true, name: cut(taskTitle(t), 32), color: 0, shape: 2, status: st,
        line: botLine(st, { summary: t.summary, tool: t.lastTool, reason: t.reason, stopped: t.status === 'stopped' }),
        task: taskTitle(t), startedAt: t.startedAt, endedAt: t.endedAt, tokens: t.tokens, toolCalls: t.toolUses,
      });
      continue;
    }
    for (const a of t.agents) {
      const st = agentStatus(a);
      out.push({
        id: `${s.sessionId}|${t.id}|${a.key}`, sessionId: s.sessionId, taskId: t.id, agentKey: a.key, name: a.label || tr('子代理'), type: a.agentType,
        color: a.color, shape: shapeOf(a.agentType || a.label || a.key), status: st,
        line: botLine(st, { summary: a.lastSummary, tool: a.lastTool, error: a.error ?? (st === 'stuck' ? t.reason : undefined), queued: a.state === 'queued', stopped: a.state === 'stopped' }),
        task: taskTitle(t), phase: a.phaseTitle, startedAt: a.startedAt, endedAt: a.endedAt, tokens: a.tokens, toolCalls: a.toolCalls, model: a.model,
        usd: estimateUsd(a.tokens, a.model),
      });
    }
  }
  return out;
}

/**
 * The cafe: the conversations with background work (running ones first, newest change first; at most MAX_ZONES,
 * the first of them is A区), their people, the counts of the top pill, the left panel's lists.
 */
export function officeModel(o: { sessions: Record<string, BgSession>; titleOf: (sid: string) => string; lead: (sid: string) => LeadInfo | undefined; max?: number }): OfficeModel {
  const max = o.max ?? MAX_ZONES;
  const list = sortSessions(Object.values(o.sessions).filter((s) => s.tasks.length > 0));
  const shown = list.slice(0, max);
  const zones: OfficeZone[] = shown.map((s, i) => {
    const name = o.titleOf(s.sessionId) || tr('对话');
    const bots = botsOf(s, leadOf(s.sessionId, o.lead(s.sessionId)));
    const n = (st: BotStatus) => bots.filter((b) => b.status === st).length;
    return {
      sessionId: s.sessionId, number: i + 1, letter: zoneLetter(i + 1), name, color: ((hash(s.sessionId) % 10) + 1), bots,
      working: n('working'), waiting: n('waiting'), stuck: n('stuck'), done: n('finished'), total: bots.length - 1,
      live: s.tasks.some((t) => t.status === 'running'),
    };
  });
  const all = zones.flatMap((f) => f.bots);
  const counts = {
    working: all.filter((b) => b.status === 'working').length,
    waiting: all.filter((b) => b.status === 'waiting').length,
    stuck: all.filter((b) => b.status === 'stuck').length,
    resting: all.filter((b) => b.status === 'resting' || b.status === 'finished').length,
  };
  let usd = 0, unpriced = false;
  for (const b of all) {
    if (b.lead || !b.tokens) continue;
    if (b.usd === undefined) unpriced = true;
    else usd += b.usd;
  }
  const waiting: WaitCard[] = [];
  for (const f of zones) {
    for (const b of f.bots) {
      if (b.status !== 'waiting' && b.status !== 'stuck') continue;
      const p = b.lead ? o.lead(f.sessionId)?.pending?.[0] : undefined;
      waiting.push({
        key: b.id, sessionId: f.sessionId, zone: f.number, botId: b.id, name: b.name, zoneName: f.name,
        kind: b.status === 'waiting' ? 'ask' : 'stuck', reason: b.line,
        ...(p ? { requestId: p.requestId, question: p.toolName === 'AskUserQuestion' } : {}),
      });
    }
  }
  waiting.sort((a, b) => Number(a.kind === 'stuck') - Number(b.kind === 'stuck'));
  const finished = all.filter((b) => b.status === 'finished').sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)).slice(0, 12);
  const activity = zones
    .flatMap((f) => (o.sessions[f.sessionId]?.events ?? []).map((e) => ({ ...e, sessionId: f.sessionId, zone: f.number })))
    .sort((a, b) => b.at - a.at)
    .slice(0, 30);
  return { zones, more: list.length - shown.length, counts, usd, unpriced, waiting, finished, activity };
}

// ---- the hall's layout (scene.ts draws it; the seats are decided here so they stay put across snapshots)

/** PCs in a zone's row */
export const PCS = 6;
/** a finished customer's "seat": no PC, they check out at the counter and leave */
export const EXIT = PCS;
/** the hall has at least this many rows (empty ones are just PCs nobody uses) */
export const MIN_ROWS = 3;
export const rowsFor = (zones: number) => Math.max(MIN_ROWS, Math.min(MAX_ZONES, zones));
/** the hall's depth (z) for so many rows: the lounge at the back, the rows, a walkway at the front */
export const hallDepth = (rows: number) => 4.8 + (rows - 1) * 2.5 + 2.4;
/** the glass private rooms (包间) along the left wall */
export const roomsFor = (zones: number) => Math.max(1, Math.floor((hallDepth(rowsFor(zones)) - 4.2) / 3));

const atWork = (b: OfficeBot) => b.status === 'working' || b.status === 'waiting' || b.status === 'stuck';

/**
 * A zone's PCs: every customer (not the lead, not a command) who is not finished keeps a PC (0…PCS-1) while there
 * is one — the ones at work first when the row is full; finished ones get EXIT. Stable: a customer keeps its PC
 * across snapshots. `prev`: botId → seat of the last call. Customers without a PC are on the zone's count only.
 */
export function seatBots(bots: OfficeBot[], prev: ReadonlyMap<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  const used = new Set<number>();
  const want = bots.filter((b) => !b.lead && !b.shell);
  for (const b of want) {
    if (b.status === 'finished') { out.set(b.id, EXIT); continue; }
    const p = prev.get(b.id);
    if (p !== undefined && p < PCS && !used.has(p)) { out.set(b.id, p); used.add(p); }
  }
  const free = () => { for (let i = 0; i < PCS; i++) if (!used.has(i)) return i; return -1; };
  for (const pass of [true, false]) {
    for (const b of want) {
      if (out.has(b.id) || atWork(b) !== pass) continue;
      const s = free();
      if (s < 0) break;
      out.set(b.id, s);
      used.add(s);
    }
  }
  return out;
}

/** The private rooms of the background commands, over every zone (rooms are the hall's): stable like the PCs. */
export function seatRooms(shells: OfficeBot[], prev: ReadonlyMap<string, number>, rooms: number): Map<string, number> {
  const out = new Map<string, number>();
  const used = new Set<number>();
  for (const b of shells) {
    const p = prev.get(b.id);
    if (p !== undefined && p < rooms && !used.has(p)) { out.set(b.id, p); used.add(p); }
  }
  // running ones first when the rooms are full
  const order = [...shells].sort((a, b) => Number(b.status === 'working') - Number(a.status === 'working'));
  for (const b of order) {
    if (out.has(b.id)) continue;
    let s = -1;
    for (let i = 0; i < rooms; i++) if (!used.has(i)) { s = i; break; }
    if (s < 0) break;
    out.set(b.id, s);
    used.add(s);
  }
  return out;
}
