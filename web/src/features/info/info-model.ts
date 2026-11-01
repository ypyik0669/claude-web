// 信息栏 (spec 2026-10-16 recording-ux §1; the official app's right column): what the cards are, in what order, which are
// folded (meta.json `ui.infoCards`), and the context breakdown grouped for the 上下文 card. Pure.
import { tr } from '@/i18n';

export const INFO_CARDS = ['env', 'context', 'connectors', 'changes', 'background', 'pins'] as const;
export type InfoCard = (typeof INFO_CARDS)[number];
export interface InfoLayout { order: InfoCard[]; collapsed: InfoCard[] }

const isCard = (x: unknown): x is InfoCard => typeof x === 'string' && (INFO_CARDS as readonly string[]).includes(x);

/** The stored layout, repaired: unknown ids dropped, duplicates removed, cards added since appended. */
export function normInfoLayout(v: unknown): InfoLayout {
  const o = (v && typeof v === 'object' ? v : {}) as { order?: unknown; collapsed?: unknown };
  const order = [...new Set((Array.isArray(o.order) ? o.order : []).filter(isCard))];
  for (const c of INFO_CARDS) if (!order.includes(c)) order.push(c);
  // folded by default: the context breakdown is long (the official app opens it on a click)
  const collapsed = Array.isArray(o.collapsed) ? [...new Set(o.collapsed.filter(isCard))] : ['context' as InfoCard];
  return { order, collapsed };
}

/** `card` moved to where `before` is (null: to the end). */
export function moveCard(l: InfoLayout, card: InfoCard, before: InfoCard | null): InfoLayout {
  if (card === before) return l;
  const rest = l.order.filter((c) => c !== card);
  const at = before ? rest.indexOf(before) : rest.length;
  rest.splice(at < 0 ? rest.length : at, 0, card);
  return { ...l, order: rest };
}

/** One step up (-1) or down (+1): the keyboard's Alt+↑ / Alt+↓ on a card's title. */
export function nudgeCard(l: InfoLayout, card: InfoCard, dir: -1 | 1): InfoLayout {
  const i = l.order.indexOf(card);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= l.order.length) return l;
  const order = [...l.order];
  [order[i], order[j]] = [order[j], order[i]];
  return { ...l, order };
}

export function toggleCard(l: InfoLayout, card: InfoCard): InfoLayout {
  return { ...l, collapsed: l.collapsed.includes(card) ? l.collapsed.filter((c) => c !== card) : [...l.collapsed, card] };
}

// ---------- the 上下文 card ----------

export interface CtxCategory { name: string; tokens: number; kind: 'used' | 'free' | 'buffer' | 'deferred'; color?: string }
export interface CtxBreakdown {
  percentage: number;
  total: number;
  max: number;
  used: (CtxCategory & { pct: number; tone: CtxTone })[];
  buffer: (CtxCategory & { pct: number })[];
  free: (CtxCategory & { pct: number })[];
  deferred: CtxCategory[];
  mcpTools: { name: string; server: string; tokens: number }[];
  memoryFiles: { path: string; tokens: number }[];
  agents: { name: string; tokens: number }[];
}

export type CtxTone = 'messages' | 'tools' | 'mcp' | 'skills' | 'other';
const TONES: Record<string, CtxTone> = { 'Messages': 'messages', 'System tools': 'tools', 'MCP tools': 'mcp', 'Skills': 'skills' };
/** The colour a category keeps in every conversation (the official card's: messages blue, tools orange, MCP teal, skills yellow, the rest grey). */
export function toneOf(name: string): CtxTone {
  return TONES[name.replace(/^\[ANT-ONLY\]\s*/, '')] ?? 'other';
}

const KINDS = new Set(['used', 'free', 'buffer', 'deferred']);
/** The row's `kind` as the SDK documents it. A CLI that answers without it (the fork we ran before 2026-11-01, seen
 *  live 2026-10-24: every row came as `used`, so 141k of free space sorted to the top): then `isDeferred`, and the two
 *  rows the CLI always names the same. */
function kindOf(c: { name: string; kind?: unknown; isDeferred?: unknown }): CtxCategory['kind'] {
  if (typeof c.kind === 'string' && KINDS.has(c.kind)) return c.kind as CtxCategory['kind'];
  if (c.isDeferred) return 'deferred';
  if (/^free space$/i.test(c.name)) return 'free';
  if (/^(auto)?compact buffer$/i.test(c.name)) return 'buffer';
  return 'used';
}

/** getContextUsage's answer (`detail: 'full'`) → rows for the card, the used ones biggest first. `tone`: a fixed
 *  colour per category (toneOf; the CLI's colour names are its terminal theme's, not ours). Classified on `kind`
 *  (kindOf when an engine leaves it out). */
export function contextBreakdown(u: any): CtxBreakdown | null {
  if (!u || !Array.isArray(u.categories)) return null;
  const max = Number(u.rawMaxTokens ?? u.maxTokens ?? 0) || 0;
  const total = Number(u.totalTokens ?? 0) || 0;
  const pct = (t: number) => (max ? (t / max) * 100 : 0);
  const cats: CtxCategory[] = u.categories
    .filter((c: any) => c && typeof c.name === 'string' && Number.isFinite(c.tokens))
    .map((c: any) => ({ name: c.name, tokens: c.tokens, color: c.color, kind: kindOf(c) }));
  return {
    percentage: Number.isFinite(u.percentage) ? u.percentage : Math.round(pct(total)),
    total,
    max,
    used: cats.filter((c) => c.kind === 'used').sort((a, b) => b.tokens - a.tokens).map((c) => ({ ...c, pct: pct(c.tokens), tone: toneOf(c.name) })),
    buffer: cats.filter((c) => c.kind === 'buffer').map((c) => ({ ...c, pct: pct(c.tokens) })),
    free: cats.filter((c) => c.kind === 'free').map((c) => ({ ...c, pct: pct(c.tokens) })),
    deferred: cats.filter((c) => c.kind === 'deferred'),
    mcpTools: (u.mcpTools ?? []).map((t: any) => ({ name: String(t.name), server: String(t.serverName ?? ''), tokens: Number(t.tokens) || 0 })),
    memoryFiles: (u.memoryFiles ?? []).map((m: any) => ({ path: String(m.path), tokens: Number(m.tokens) || 0 })),
    agents: (u.agents ?? []).map((a: any) => ({ name: String(a.agentType), tokens: Number(a.tokens) || 0 })),
  };
}

/** The context card counts only a conversation running here: the engine does the counting. */
export function ctxLive(state: string | undefined): boolean {
  return state === 'idle' || state === 'running' || state === 'waiting';
}

/** 刷新 under a count: not for a closed conversation's last count (it asked the engine, failed, said nothing — review M3). */
export function ctxCanRefresh(state: string | undefined, busy: boolean): boolean {
  return ctxLive(state) && !busy;
}

/** 19.6k / 1.2M / 300 */
export function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}k`;
  return String(Math.round(n));
}

/** A context window as the title and the model menu say it: whole K (272K, 650K), M from 1M (1M, 1.5M). */
export function fmtWindow(n: number): string {
  const k = Math.round(n / 1000);
  if (k < 1000) return `${k}K`;
  return `${Math.round(n / 1e5) / 10}M`;
}

/**
 * The 上下文 card's title (A7): the window the model has in this conversation and, when the autocompact cap is below
 * it, where it compacts — 「窗口 1M · 700K 内压缩」. Both from the server (`SessionInfoSnapshot.contextWindow` /
 * `compactWindow`); nothing when the window is unknown.
 */
export function contextTitle(window?: number, cap?: number): string {
  if (!window || window <= 0) return '';
  const w = fmtWindow(window);
  return cap && cap > 0 && cap < window ? tr('窗口 {w} · {c} 内压缩', { w, c: fmtWindow(cap) }) : tr('窗口 {w}', { w });
}

/** 连接器: how many need a hand (failed or waiting for a login) and the rows to list. */
export function connectorSummary(servers: { name: string; status?: string }[] | undefined): { broken: number; rows: { name: string; status: string }[] } {
  const rows = (servers ?? []).filter((s) => s && s.name).map((s) => ({ name: s.name, status: s.status ?? 'pending' }));
  return { broken: rows.filter((r) => r.status === 'failed' || r.status === 'needs-auth').length, rows };
}
